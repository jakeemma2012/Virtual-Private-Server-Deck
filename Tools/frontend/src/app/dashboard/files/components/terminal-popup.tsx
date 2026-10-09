'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { Icons } from '@/components/icons';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import {
  createTerminal, connectTerminal, buildXtermTheme,
  type TermHandle, type TermSocket,
} from '@/lib/terminal-core';


interface PopupTab {
  id: number;
  label: string;
  connected: boolean;
}

interface TabRuntime {
  handle: TermHandle | null;
  sock: TermSocket | null;
  intentionalClose: boolean;
  reconnectTimer: NodeJS.Timeout | null;
  reconnectAttempt: number;
  resizeObserver: ResizeObserver | null;
  containerEl: HTMLDivElement | null;
  savedScreen: string;
}

let popupTabId = 1;

export function TerminalPopup({ serverId, cwd, onClose }: {
  serverId: string; cwd: string; onClose: () => void;
}) {
  const [tabs, setTabs] = useState<PopupTab[]>([]);
  const [activeTabId, setActiveTabId] = useState(0);
  const runtimesRef = useRef<Map<number, TabRuntime>>(new Map());
  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 800, h: 500 });
  const dragging = useRef(false);
  const dragStart = useRef({ x: 0, y: 0, w: 0, h: 0 });
  const initDone = useRef(false);

  // Font size — user-adjustable (A-/A+), shared with the full-page terminal via localStorage.
  const termFontRef = useRef<number>(13);
  const [termFont, setTermFont] = useState<number>(() => {
    if (typeof window === 'undefined') return 13;
    const saved = Number(localStorage.getItem('term_fontsize'));
    const v = saved >= 4 && saved <= 28 ? saved : 13;
    termFontRef.current = v;
    return v;
  });

  // Apply font size to every live terminal + persist (shared key with the page).
  useEffect(() => {
    termFontRef.current = termFont;
    runtimesRef.current.forEach((rt) => {
      if (!rt.handle) return;
      try {
        rt.handle.term.options.fontSize = termFont;
        rt.handle.fit.fit();
        rt.sock?.resize(rt.handle.term.cols, rt.handle.term.rows);
      } catch { /* popup chưa dựng xong */ }
    });
    if (typeof window !== 'undefined') localStorage.setItem('term_fontsize', String(termFont));
  }, [termFont]);

  // Re-theme when the app theme (light/dark or accent) changes.
  useEffect(() => {
    const apply = () => {
      // Chỉ gán theme. Bản cũ còn gọi term.refresh() để vẽ lại toàn màn hình
      // mỗi lần class của <html> đổi — đó là nguồn gây nháy.
      const theme = buildXtermTheme();
      runtimesRef.current.forEach((rt) => {
        if (rt.handle) rt.handle.term.options.theme = theme;
      });
    };
    const obs = new MutationObserver(apply);
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme'] });
    return () => obs.disconnect();
  }, []);

  // Create first tab on mount
  useEffect(() => {
    if (initDone.current) return;
    initDone.current = true;
    addTab(cwd);
  }, []);

  // ==================== Tab Management ====================

  const addTab = useCallback((initialCwd?: string) => {
    const id = popupTabId++;
    const label = `Shell ${id}`;
    setTabs(prev => [...prev, { id, label, connected: false }]);
    setActiveTabId(id);
    requestAnimationFrame(() => initTab(id, initialCwd));
  }, [serverId]);

  const closeTab = useCallback((tabId: number) => {
    destroyTab(tabId);
    setTabs(prev => {
      const next = prev.filter(t => t.id !== tabId);
      if (next.length === 0) {
        // Close entire popup when last tab closed
        setTimeout(onClose, 0);
        return [];
      }
      return next;
    });
    setActiveTabId(prev => {
      if (prev !== tabId) return prev;
      const remaining = tabs.filter(t => t.id !== tabId);
      return remaining.length > 0 ? remaining[remaining.length - 1].id : 0;
    });
  }, [tabs, onClose]);

  const switchTab = useCallback((tabId: number) => {
    setActiveTabId(tabId);
    requestAnimationFrame(() => {
      const rt = runtimesRef.current.get(tabId);
      if (!rt?.handle) return;
      try { rt.handle.fit.fit(); } catch { /* đang ẩn */ }
      rt.handle.term.focus();
    });
  }, []);

  // ==================== Terminal Lifecycle ====================

  const initTab = async (tabId: number, initialCwd?: string) => {
    if (!containerRef.current) return;

    const el = document.createElement('div');
    el.className = 'absolute inset-0';
    el.setAttribute('data-tab-id', String(tabId));
    containerRef.current.appendChild(el);

    const rt: TabRuntime = {
      handle: null, sock: null, intentionalClose: false, reconnectTimer: null,
      reconnectAttempt: 0, resizeObserver: null, containerEl: el, savedScreen: '',
    };
    runtimesRef.current.set(tabId, rt);

    // Dùng cùng lõi với trang Terminal: WebGL renderer, unicode11, binary frame.
    const handle = await createTerminal(el, { fontSize: 12 });
    rt.handle = handle;

    let resizeTimer = 0;
    const ro = new ResizeObserver(() => {
      clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => {
        try {
          handle.fit.fit();
          rt.sock?.resize(handle.term.cols, handle.term.rows);
        } catch { /* popup đang ẩn */ }
      }, 100);
    });
    ro.observe(el);
    rt.resizeObserver = ro;

    connectTab(tabId, initialCwd);
  };

  const connectTab = (tabId: number, initialCwd?: string) => {
    const rt = runtimesRef.current.get(tabId);
    if (!rt?.handle) return;
    const handle = rt.handle;
    rt.intentionalClose = false;
    rt.sock?.close();

    try { handle.fit.fit(); } catch { /* chưa có kích thước */ }

    const conn = api.getTerminalWs(serverId, handle.term.cols || 120, handle.term.rows || 24);
    rt.sock = connectTerminal(handle, conn, {
      onOpen: () => {
        rt.reconnectAttempt = 0;
        updateTabState(tabId, true);
        handle.term.focus();
        if (rt.savedScreen) {
          handle.term.write(rt.savedScreen);
          rt.savedScreen = '';
        }
        if (initialCwd) setTimeout(() => rt.sock?.send('cd ' + initialCwd + '\r'), 300);
      },
      onClose: () => {
        updateTabState(tabId, false);
        if (rt.intentionalClose) {
          handle.term.writeln('\n\x1b[31m  Đã ngắt kết nối.\x1b[0m');
          return;
        }
        try { rt.savedScreen = handle.serialize.serialize(); } catch { /* bỏ qua */ }
        rt.reconnectAttempt += 1;
        const delay = Math.min(1000 * 2 ** (rt.reconnectAttempt - 1), 15000);
        handle.term.writeln(
          `\n\x1b[33m  Mất kết nối. Thử lại sau ${Math.round(delay / 1000)}s...\x1b[0m`
        );
        rt.reconnectTimer = setTimeout(() => {
          if (!rt.intentionalClose) connectTab(tabId, initialCwd);
        }, delay);
      },
      onError: (msg) => {
        updateTabState(tabId, false);
        console.warn('[terminal-popup]', msg);
      },
    });
  };

  const disconnectTab = (tabId: number) => {
    const rt = runtimesRef.current.get(tabId);
    if (!rt) return;
    rt.intentionalClose = true;
    if (rt.reconnectTimer) { clearTimeout(rt.reconnectTimer); rt.reconnectTimer = null; }
    rt.sock?.close();
    rt.sock = null;
    updateTabState(tabId, false);
  };

  const destroyTab = (tabId: number) => {
    disconnectTab(tabId);
    const rt = runtimesRef.current.get(tabId);
    if (!rt) return;
    rt.resizeObserver?.disconnect();
    rt.handle?.dispose();
    rt.containerEl?.remove();
    runtimesRef.current.delete(tabId);
  };


  const updateTabState = (tabId: number, connected: boolean) => {
    setTabs(prev => prev.map(t => t.id === tabId ? { ...t, connected } : t));
  };

  // Show/hide tab containers
  useEffect(() => {
    runtimesRef.current.forEach((rt, id) => {
      if (rt.containerEl) rt.containerEl.style.display = id === activeTabId ? '' : 'none';
    });
    const activeRt = runtimesRef.current.get(activeTabId);
    if (activeRt?.handle) {
      requestAnimationFrame(() => {
        try {
          activeRt.handle!.fit.fit();
          activeRt.sock?.resize(activeRt.handle!.term.cols, activeRt.handle!.term.rows);
        } catch { /* đang ẩn */ }
      });
    }
  }, [activeTabId]);

  // Cleanup all on unmount
  useEffect(() => () => {
    runtimesRef.current.forEach((_, id) => destroyTab(id));
  }, []);

  // Escape to close
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape' && e.ctrlKey) onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);

  // Resize handle (pointer events so it works with touch + mouse)
  const onResizeStart = (e: React.PointerEvent) => {
    e.preventDefault();
    try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch {}
    dragging.current = true;
    dragStart.current = { x: e.clientX, y: e.clientY, w: size.w, h: size.h };
    const onMove = (ev: PointerEvent) => {
      if (!dragging.current) return;
      setSize({
        w: Math.max(320, dragStart.current.w + (ev.clientX - dragStart.current.x)),
        h: Math.max(220, dragStart.current.h + (ev.clientY - dragStart.current.y)),
      });
    };
    const onUp = () => {
      dragging.current = false;
      // Kéo xong thì fit lại và báo PTY kích thước mới.
      const rt = runtimesRef.current.get(activeTabId);
      if (rt?.handle) {
        requestAnimationFrame(() => {
          try {
            rt.handle!.fit.fit();
            rt.sock?.resize(rt.handle!.term.cols, rt.handle!.term.rows);
          } catch { /* đang ẩn */ }
        });
      }
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  if (typeof document === 'undefined') return null;

  return createPortal(
    <div className='fixed inset-0 z-[9997] flex items-center justify-center'>
      <div className='absolute inset-0 bg-black/40' onClick={onClose} />
      <div className='relative bg-card text-card-foreground rounded-xl shadow-2xl border overflow-hidden flex flex-col'
        style={{ width: size.w, height: size.h, maxWidth: '95vw', maxHeight: '90vh' }}>

        {/* Title bar with tabs */}
        <div className='flex items-center bg-muted shrink-0 select-none'>
          {/* Tabs */}
          <div className='flex items-center overflow-x-auto flex-1' style={{ WebkitOverflowScrolling: 'touch' }}>
            {tabs.map(tab => (
              <div key={tab.id}
                className={cn(
                  'flex items-center gap-1.5 px-3 py-2 text-xs shrink-0 cursor-pointer group border-b-2',
                  tab.id === activeTabId
                    ? 'border-b-primary bg-background text-foreground'
                    : 'border-b-transparent text-muted-foreground hover:text-foreground hover:bg-accent/50'
                )}
                onClick={() => switchTab(tab.id)}>
                <Icons.terminal className='size-3' />
                <span className={cn('size-1.5 rounded-full shrink-0', tab.connected ? 'bg-emerald-500' : 'bg-muted-foreground')} />
                <span className='truncate max-w-[80px]'>{tab.label}</span>
                {tabs.length > 1 && (
                  <button className='opacity-0 group-hover:opacity-100 hover:text-destructive shrink-0 ml-0.5'
                    onClick={e => { e.stopPropagation(); closeTab(tab.id); }}>
                    <Icons.close className='size-3' />
                  </button>
                )}
              </div>
            ))}
            {/* Add tab */}
            <button className='press px-2 py-2 text-muted-foreground hover:text-foreground shrink-0'
              onClick={() => addTab(cwd)} title='New Shell'>
              <Icons.add className='size-3.5' />
            </button>
          </div>

          {/* Font size + close */}
          <div className='flex items-center gap-1 px-2 border-l shrink-0'>
            <button onClick={() => setTermFont(f => Math.max(4, f - 1))} aria-label='Giảm cỡ chữ'
              className='press size-6 rounded-md hover:bg-accent flex items-center justify-center text-xs text-muted-foreground hover:text-foreground'>A−</button>
            <span className='min-w-4 text-center text-[10px] tabular-nums text-muted-foreground/70'>{termFont}</span>
            <button onClick={() => setTermFont(f => Math.min(28, f + 1))} aria-label='Tăng cỡ chữ'
              className='press size-6 rounded-md hover:bg-accent flex items-center justify-center text-sm text-muted-foreground hover:text-foreground'>A+</button>
            <button onClick={onClose} aria-label='Đóng'
              className='press size-6 rounded-md hover:bg-accent flex items-center justify-center text-muted-foreground hover:text-foreground'>
              <Icons.close className='size-4' />
            </button>
          </div>
        </div>

        {/* Terminal area */}
        <div ref={containerRef} className='flex-1 min-h-0 relative bg-background' />

        {/* Resize handle */}
        <div className='absolute bottom-0 right-0 size-5 cursor-se-resize touch-none' onPointerDown={onResizeStart}>
          <svg className='size-3 text-muted-foreground absolute bottom-1 right-1' viewBox='0 0 10 10'>
            <path d='M9 1L1 9M9 5L5 9M9 9L9 9' stroke='currentColor' strokeWidth='1.5' fill='none' />
          </svg>
        </div>
      </div>
    </div>,
    document.body
  );
}
