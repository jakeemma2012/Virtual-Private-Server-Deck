'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { useSearchParams } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Icons } from '@/components/icons';
import { api, VpsServer } from '@/lib/api';
import { cn } from '@/lib/utils';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue
} from '@/components/ui/select';

// Lõi terminal (xterm + addon + giao thức WebSocket) nằm ở lib/terminal-core.ts
// để trang này và popup trong File manager dùng cùng một hành vi.
import {
  createTerminal, connectTerminal, buildXtermTheme, isMobileView, TERM_KEYS,
  type TermHandle, type TermSocket,
} from '@/lib/terminal-core';

interface TermTab {
  id: number;
  serverId: string;
  serverName: string;
  connected: boolean;
  label: string;
}

let tabIdCounter = 1;

// Trạng thái runtime của từng tab — giữ trong ref, không phải React state,
// để dữ liệu terminal không gây re-render.
interface TabRuntime {
  handle: TermHandle | null;
  sock: TermSocket | null;
  intentionalClose: boolean;
  reconnectTimer: NodeJS.Timeout | null;
  reconnectAttempt: number;
  resizeObserver: ResizeObserver | null;
  containerEl: HTMLDivElement | null;
  /** Nội dung màn hình lưu lại để dựng lại sau khi reconnect. */
  savedScreen: string;
}

export default function TerminalPage() {
  const searchParams = useSearchParams();
  const paramServerId = searchParams.get('serverId') || '';
  const paramCwd = searchParams.get('cwd') || '';

  const [servers, setServers] = useState<VpsServer[]>([]);
  const [tabs, setTabs] = useState<TermTab[]>([]);
  const [activeTabId, setActiveTabId] = useState(0);
  const runtimesRef = useRef<Map<number, TabRuntime>>(new Map());
  const containerRef = useRef<HTMLDivElement>(null);
  const serversRef = useRef<VpsServer[]>([]);
  serversRef.current = servers;

  // Terminal font size — user-adjustable (A-/A+), persisted. Mobile defaults smaller so
  // more columns fit and long lines wrap less (the "scaled down" feel).
  const termFontRef = useRef<number>(13);
  const [termFont, setTermFont] = useState<number>(() => {
    if (typeof window === 'undefined') return 13;
    const saved = Number(localStorage.getItem('term_fontsize'));
    const v = saved >= 4 && saved <= 28 ? saved : (window.matchMedia('(max-width: 767px)').matches ? 11 : 13);
    termFontRef.current = v;
    return v;
  });

  // Đổi cỡ chữ cho mọi terminal đang mở + ghi nhớ lựa chọn.
  useEffect(() => {
    termFontRef.current = termFont;
    runtimesRef.current.forEach((rt) => {
      if (!rt.handle) return;
      try {
        rt.handle.term.options.fontSize = termFont;
        rt.handle.fit.fit();
        rt.sock?.resize(rt.handle.term.cols, rt.handle.term.rows);
      } catch { /* tab chưa dựng xong */ }
    });
    if (typeof window !== 'undefined') localStorage.setItem('term_fontsize', String(termFont));
  }, [termFont]);

  // Đổi theme app -> gán lại theme cho terminal.
  //
  // Bản cũ gọi `term.refresh(0, rows-1)` ở đây, tức vẽ lại TOÀN BỘ màn hình mỗi
  // lần class của <html> thay đổi (next-themes, top-loader... đều chạm vào nó).
  // Đó là nguyên nhân trực tiếp của hiện tượng nháy. Gán `options.theme` là đủ:
  // xterm tự vẽ lại phần cần thiết.
  useEffect(() => {
    const apply = () => {
      const theme = buildXtermTheme();
      runtimesRef.current.forEach((rt) => {
        if (rt.handle) rt.handle.term.options.theme = theme;
      });
    };
    const obs = new MutationObserver(apply);
    obs.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'data-theme'],
    });
    return () => obs.disconnect();
  }, []);

  // Load servers
  useEffect(() => { api.getServers().then(setServers).catch(() => {}); }, []);

  // Create initial tab from URL params or localStorage
  useEffect(() => {
    if (servers.length === 0) return;
    if (tabs.length > 0) return; // already initialized
    const saved = localStorage.getItem('terminal_server');
    const sid = paramServerId || saved || '';
    if (sid) {
      const srv = servers.find(s => s.id === sid);
      if (srv) {
        addTab(sid, srv.name);
        return;
      }
    }
    // No saved server — create empty tab
    addTab('', '');
  }, [servers]);

  // ==================== Tab Management ====================

  const addTab = useCallback((serverId: string, serverName: string) => {
    const id = tabIdCounter++;
    const label = serverName || 'New Terminal';
    const tab: TermTab = { id, serverId, serverName, connected: false, label };
    setTabs(prev => [...prev, tab]);
    setActiveTabId(id);

    // Initialize terminal after DOM updates
    requestAnimationFrame(() => initTab(id, serverId));
  }, []);

  const closeTab = useCallback((tabId: number) => {
    destroyTab(tabId);
    setTabs(prev => {
      const next = prev.filter(t => t.id !== tabId);
      if (next.length === 0) {
        // Always keep at least 1 tab
        const id = tabIdCounter++;
        const tab: TermTab = { id, serverId: '', serverName: '', connected: false, label: 'New Terminal' };
        requestAnimationFrame(() => initTab(id, ''));
        setActiveTabId(id);
        return [tab];
      }
      return next;
    });
    setActiveTabId(prev => {
      // If closing active tab, switch to last remaining
      return prev === tabId
        ? (tabs.filter(t => t.id !== tabId).pop()?.id || 0)
        : prev;
    });
  }, [tabs]);

  const switchTab = useCallback((tabId: number) => {
    setActiveTabId(tabId);
    // Fit the terminal after visibility change
    requestAnimationFrame(() => {
      const rt = runtimesRef.current.get(tabId);
      if (rt?.handle) {
        try { rt.handle.fit.fit(); } catch { /* khung đang ẩn */ }
        rt.handle.term.focus();
      }
    });
  }, []);

  // ==================== Terminal Lifecycle ====================

  const initTab = async (tabId: number, serverId: string) => {
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

    const handle = await createTerminal(el, { fontSize: termFontRef.current });
    rt.handle = handle;
    if (!handle.webgl) {
      // Không im lặng chịu đựng: WebGL tắt là lý do duy nhất còn lại khiến
      // terminal chậm, và người dùng cần biết để không đi tìm nguyên nhân khác.
      console.warn('[terminal] WebGL không khả dụng, đang dùng renderer DOM (chậm hơn)');
    }

    // Đổi kích thước khung -> fit lại rồi báo PTY. Debounce vì ResizeObserver
    // bắn liên tục trong lúc kéo.
    let resizeTimer = 0;
    const ro = new ResizeObserver(() => {
      clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => {
        try {
          handle.fit.fit();
          rt.sock?.resize(handle.term.cols, handle.term.rows);
        } catch { /* khung đang ẩn */ }
      }, 100);
    });
    ro.observe(el);
    rt.resizeObserver = ro;

    if (serverId) {
      handle.term.writeln('\x1b[33mĐang kết nối...\x1b[0m');
      connectTab(tabId, serverId);
    } else {
      handle.term.writeln('\x1b[1;36m  VPSDeck — Web Terminal\x1b[0m');
      handle.term.writeln('\x1b[90m  Chọn một server ở ô bên trên\x1b[0m\n');
    }
  };

  const connectTab = (tabId: number, serverId: string) => {
    const rt = runtimesRef.current.get(tabId);
    if (!rt?.handle) return;
    const handle = rt.handle;

    // Dọn kết nối cũ của chính tab này trước khi mở cái mới.
    disconnectTab(tabId, false);
    rt.intentionalClose = false;

    try { handle.fit.fit(); } catch { /* khung chưa có kích thước */ }

    const conn = api.getTerminalWs(serverId, handle.term.cols || 120, handle.term.rows || 32);
    rt.sock = connectTerminal(handle, conn, {
      onOpen: () => {
        rt.reconnectAttempt = 0;
        updateTabState(tabId, true);
        if (!isMobileView()) handle.term.focus();

        // Dựng lại màn hình đã lưu thay vì `term.clear()`.
        // Bản cũ clear ở mỗi lần onopen, nên mỗi lần reconnect là mất sạch
        // những gì đang đọc — một phần của cảm giác "terminal nháy".
        if (rt.savedScreen) {
          handle.term.write(rt.savedScreen);
          rt.savedScreen = '';
        }

        if (paramCwd && serverId === paramServerId) {
          setTimeout(() => rt.sock?.send('cd ' + paramCwd + '\r'), 300);
        }
      },
      onClose: () => {
        updateTabState(tabId, false);
        if (rt.intentionalClose) {
          handle.term.writeln('\n\x1b[31m  Đã ngắt kết nối.\x1b[0m');
          return;
        }
        // Giữ lại màn hình để lần kết nối lại không mất ngữ cảnh.
        try { rt.savedScreen = handle.serialize.serialize(); } catch { /* bỏ qua */ }

        // Backoff tăng dần: 1s, 2s, 4s, 8s, tối đa 15s. Bản cũ cố định 3s nên
        // khi VPS sập thật thì nó gõ cửa mãi mỗi 3 giây.
        rt.reconnectAttempt += 1;
        const delay = Math.min(1000 * 2 ** (rt.reconnectAttempt - 1), 15000);
        handle.term.writeln(
          `\n\x1b[33m  Mất kết nối. Thử lại sau ${Math.round(delay / 1000)}s ` +
          `(lần ${rt.reconnectAttempt})...\x1b[0m`
        );
        rt.reconnectTimer = setTimeout(() => {
          if (!rt.intentionalClose) connectTab(tabId, serverId);
        }, delay);
      },
      onError: (msg) => {
        updateTabState(tabId, false);
        console.warn('[terminal]', msg);
      },
    });
  };

  const disconnectTab = (tabId: number, intentional = true) => {
    const rt = runtimesRef.current.get(tabId);
    if (!rt) return;
    if (intentional) rt.intentionalClose = true;
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

  // Handle server change for active tab
  const handleServerChange = useCallback((serverId: string) => {
    const srv = serversRef.current.find(s => s.id === serverId);
    if (!srv) return;
    localStorage.setItem('terminal_server', serverId);

    setTabs(prev => prev.map(t => t.id === activeTabId
      ? { ...t, serverId, serverName: srv.name, label: srv.name }
      : t));

    const rt = runtimesRef.current.get(activeTabId);
    if (rt?.handle) {
      // Đổi server là ngữ cảnh khác hẳn, nên ở đây clear là đúng
      // (khác với reconnect cùng server — chỗ đó phải giữ màn hình).
      rt.savedScreen = '';
      rt.handle.term.clear();
      rt.handle.term.writeln('\x1b[33mĐang kết nối tới ' + srv.name + '...\x1b[0m');
    }
    connectTab(activeTabId, serverId);
  }, [activeTabId]);

  // Cleanup all on unmount
  useEffect(() => () => {
    runtimesRef.current.forEach((_, id) => destroyTab(id));
  }, []);

  // Show/hide tab containers based on activeTabId
  useEffect(() => {
    runtimesRef.current.forEach((rt, id) => {
      if (rt.containerEl) {
        rt.containerEl.style.display = id === activeTabId ? '' : 'none';
      }
    });
    // Fit active tab
    const activeRt = runtimesRef.current.get(activeTabId);
    if (activeRt?.handle) {
      requestAnimationFrame(() => {
        try {
          activeRt.handle!.fit.fit();
          activeRt.sock?.resize(activeRt.handle!.term.cols, activeRt.handle!.term.rows);
        } catch { /* khung chưa có kích thước */ }
      });
    }
  }, [activeTabId]);

  const activeTab = tabs.find(t => t.id === activeTabId);
  const activeConnected = activeTab?.connected || false;
  // A tab that has a server selected but isn't connected yet is connecting/reconnecting.
  const activeConnecting = !activeConnected && !!activeTab?.serverId;

  // Mobile command entry. xterm can't reliably receive Gboard/soft-keyboard input:
  // predictive text + clearing the field mid-composition garbles it (e.g. "ls" -> "lipm2 lii").
  // So on mobile we use LINE MODE — type a whole line into a visible field (native IME,
  // nothing cleared mid-composition, so Vietnamese Telex works) and send it on Enter/Send.
  const cmdInputRef = useRef<HTMLInputElement>(null);

  const sendRaw = useCallback((data: string) => {
    runtimesRef.current.get(activeTabId)?.sock?.send(data);
  }, [activeTabId]);

  const sendLine = useCallback(() => {
    const el = cmdInputRef.current;
    if (!el) return;
    sendRaw(el.value + '\r');
    el.value = '';
    el.focus();
  }, [sendRaw]);

  return (
    <div className='animate-fade flex flex-col gap-3 h-[calc(100vh_-_4rem)] p-3 sm:p-4'>
      {/* Terminal chrome: soft rounded frame wrapping toolbar + terminal */}
      <div className='flex flex-1 min-h-0 flex-col overflow-hidden rounded-2xl border bg-card shadow-soft'>
      {/* Tab bar */}
      <div className='flex items-center border-b bg-muted/20 shrink-0'>
        <div className='flex items-center overflow-x-auto flex-1 px-1' style={{ WebkitOverflowScrolling: 'touch' }}>
          {tabs.map(tab => (
            <div key={tab.id}
              className={cn(
                'flex items-center gap-1.5 px-3 py-2 text-xs shrink-0 border-b-2 cursor-pointer group',
                tab.id === activeTabId
                  ? 'border-b-primary bg-background font-medium text-foreground'
                  : 'border-b-transparent text-muted-foreground hover:text-foreground hover:bg-muted/30'
              )}
              onClick={() => switchTab(tab.id)}>
              <Icons.terminal className='size-3.5' />
              <span className={cn('size-1.5 rounded-full shrink-0', tab.connected ? 'bg-emerald-500' : 'bg-zinc-400')} />
              <span className='max-w-[120px] truncate'>{tab.label}</span>
              {tabs.length > 1 && (
                <button className='ml-0.5 opacity-0 group-hover:opacity-100 hover:text-destructive shrink-0'
                  onClick={e => { e.stopPropagation(); closeTab(tab.id); }}>
                  <Icons.close className='size-3' />
                </button>
              )}
            </div>
          ))}
          {/* Add new tab */}
          <button className='px-2 py-2 text-muted-foreground hover:text-foreground shrink-0'
            onClick={() => {
              const saved = localStorage.getItem('terminal_server');
              const srv = saved ? serversRef.current.find(s => s.id === saved) : null;
              addTab(srv?.id || '', srv?.name || '');
            }}
            title='New Terminal'>
            <Icons.add className='size-3.5' />
          </button>
        </div>

        {/* Server selector + connection state + actions (right side) */}
        <div className='flex items-center gap-2 px-2 border-l shrink-0'>
          {/* Font size control — shrink to fit more columns (great on mobile) */}
          <div className='flex items-center rounded-md border'>
            <button type='button' aria-label='Giảm cỡ chữ'
              className='press px-1.5 py-0.5 text-xs text-muted-foreground hover:text-foreground'
              onClick={() => setTermFont(f => Math.max(4, f - 1))}>A−</button>
            <span className='min-w-4 text-center text-[10px] tabular-nums text-muted-foreground/70'>{termFont}</span>
            <button type='button' aria-label='Tăng cỡ chữ'
              className='press px-1.5 py-0.5 text-sm text-muted-foreground hover:text-foreground'
              onClick={() => setTermFont(f => Math.min(28, f + 1))}>A+</button>
          </div>
          {/* Connection state badge */}
          {activeConnected ? (
            <Badge variant='success' className='hidden sm:inline-flex'>
              <span className='status-dot size-1.5 rounded-full bg-emerald-500' />
              Connected
            </Badge>
          ) : activeConnecting ? (
            <Badge variant='warning' className='pulse-soft hidden sm:inline-flex'>
              <span className='size-1.5 rounded-full bg-amber-500' />
              Connecting
            </Badge>
          ) : (
            <Badge variant='destructive' className='hidden sm:inline-flex'>
              <span className='size-1.5 rounded-full bg-white/80' />
              Disconnected
            </Badge>
          )}
          <Select value={activeTab?.serverId || ''} onValueChange={handleServerChange}>
            <SelectTrigger className='h-7 text-[10px] w-auto gap-1 border-0 shadow-none px-2'>
              <Icons.server className='size-3 text-muted-foreground' />
              <SelectValue placeholder='Server' />
            </SelectTrigger>
            <SelectContent>
              {servers.filter(s => s.status === 'ONLINE').map(s => (
                <SelectItem key={s.id} value={s.id}>{s.name} ({s.ip})</SelectItem>
              ))}
            </SelectContent>
          </Select>
          {activeTab?.serverId && !activeConnected && (
            <Button variant='outline' size='sm' className='press h-7 text-[10px] px-2'
              onClick={() => { connectTab(activeTabId, activeTab.serverId); }}>
              <Icons.refresh className='size-3 mr-1' />Reconnect
            </Button>
          )}
          {activeConnected && (
            <Button variant='destructive' size='sm' className='press h-7 text-[10px] px-2'
              onClick={() => { disconnectTab(activeTabId); }}>
              <Icons.power className='size-3 mr-1' />Stop
            </Button>
          )}
        </div>
      </div>

      {/* Terminal area — all tab containers are rendered here, visibility toggled via style.display */}
      <div ref={containerRef} className='flex-1 min-h-0 relative bg-background'>
        {tabs.length === 0 && (
          <div className='flex items-center justify-center h-full text-muted-foreground text-sm'>
            No terminals open
          </div>
        )}
      </div>
      </div>{/* /chrome frame */}

      {/* Mobile helpers (hidden on desktop). Primary input on mobile = tap the terminal
          and type directly into xterm. These add the keys soft keyboards lack, plus a
          fallback line input for keyboards that garble direct typing. */}
      {activeConnected && (
        <div className='md:hidden flex shrink-0 flex-col gap-2 px-2'>
          <p className='text-muted-foreground/70 text-[10px] leading-tight'>
            Chạm vào màn hình để gõ trực tiếp. Phím dưới gửi Tab/Esc/Ctrl/mũi tên.
          </p>
          <div className='flex gap-1.5 overflow-x-auto pb-0.5' style={{ WebkitOverflowScrolling: 'touch' }}>
            {TERM_KEYS.map(k => (
              <button
                key={k.label}
                type='button'
                onClick={() => { sendRaw(k.seq); runtimesRef.current.get(activeTabId)?.handle?.term.focus(); }}
                className='press shrink-0 rounded-lg border bg-card px-2.5 py-1.5 text-xs font-mono text-muted-foreground active:bg-accent active:text-accent-foreground'
              >
                {k.label}
              </button>
            ))}
          </div>
          <div className='flex items-center gap-2'>
            <span className='text-primary shrink-0 font-mono text-sm'>❯</span>
            <input
              ref={cmdInputRef}
              className='flex-1 min-w-0 rounded-lg border bg-card px-3 py-2 text-base font-mono outline-none transition-[box-shadow,border-color] focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]'
              autoCapitalize='off'
              autoCorrect='off'
              autoComplete='off'
              spellCheck={false}
              inputMode='text'
              enterKeyHint='send'
              placeholder='Dự phòng: gõ cả dòng rồi Gửi…'
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing) return; // let Telex finish composing
                if (e.key === 'Enter') { e.preventDefault(); sendLine(); }
              }}
            />
            <Button type='button' size='sm' className='press shrink-0' onClick={sendLine}>
              Gửi
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
