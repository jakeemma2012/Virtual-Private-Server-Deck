'use client';

import { createContext, useContext, useState, useCallback, useRef, memo } from 'react';
import { cn } from '@/lib/utils';
import { Icons } from '@/components/icons';

interface DownloadItem {
  id: number;
  name: string;
  size: number;    // total bytes (0 if unknown)
  loaded: number;  // bytes downloaded
  speed: number;
  status: 'downloading' | 'done' | 'error' | 'cancelled';
  error?: string;
  startTime: number;
  abortController?: AbortController;
}

interface DownloadContextType {
  download: (serverId: string, path: string) => void;
  downloads: DownloadItem[];
}

const DownloadContext = createContext<DownloadContextType | null>(null);

export function useDownload() {
  const ctx = useContext(DownloadContext);
  if (!ctx) throw new Error('useDownload must be used within DownloadProvider');
  return ctx;
}

let uid = 0;

const fmtSize = (b: number) => {
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
  if (b < 1073741824) return (b / 1048576).toFixed(1) + ' MB';
  return (b / 1073741824).toFixed(1) + ' GB';
};

const fmtSpeed = (b: number) => {
  if (b < 1024) return b.toFixed(0) + ' B/s';
  if (b < 1048576) return (b / 1024).toFixed(1) + ' KB/s';
  return (b / 1048576).toFixed(1) + ' MB/s';
};

const fmtEta = (remaining: number, speed: number) => {
  if (speed <= 0 || remaining <= 0) return '';
  const secs = Math.ceil(remaining / speed);
  if (secs < 60) return secs + 's';
  if (secs < 3600) return Math.floor(secs / 60) + 'm ' + (secs % 60) + 's';
  return Math.floor(secs / 3600) + 'h ' + Math.floor((secs % 3600) / 60) + 'm';
};

const DownloadRow = memo(function DownloadRow({ d, onCancel }: { d: DownloadItem; onCancel: (id: number) => void }) {
  const pct = d.size > 0 ? Math.round((d.loaded / d.size) * 100) : 0;
  const eta = d.size > 0 ? fmtEta(d.size - d.loaded, d.speed) : '';

  return (
    <div className='px-3 py-2 border-b last:border-b-0'>
      <div className='flex items-center justify-between mb-1'>
        <span className='text-xs font-medium truncate flex-1 mr-2'>{d.name}</span>
        {d.status === 'downloading' && (
          <button onClick={() => onCancel(d.id)} className='text-muted-foreground hover:text-destructive shrink-0'>
            <Icons.close className='size-3.5' />
          </button>
        )}
        {d.status === 'done' && <Icons.circleCheck className='size-3.5 text-emerald-500 shrink-0' />}
        {d.status === 'error' && <Icons.circleX className='size-3.5 text-red-500 shrink-0' />}
        {d.status === 'cancelled' && <Icons.minus className='size-3.5 text-muted-foreground shrink-0' />}
      </div>
      {d.status === 'downloading' && (
        <>
          <div className='h-1.5 w-full bg-blue-500/10 rounded-full overflow-hidden mb-1'>
            {d.size > 0 ? (
              <div className='h-full bg-blue-500 rounded-full' style={{ width: pct + '%', transition: 'width 0.15s linear' }} />
            ) : (
              <div className='h-full bg-blue-500 rounded-full animate-pulse' style={{ width: '100%' }} />
            )}
          </div>
          <div className='flex items-center justify-between text-[10px] text-muted-foreground'>
            <span>{fmtSize(d.loaded)}{d.size > 0 ? ' / ' + fmtSize(d.size) : ''}</span>
            <span>{fmtSpeed(d.speed)}{d.size > 0 ? ' · ' + pct + '%' : ''}{eta ? ' · ~' + eta : ''}</span>
          </div>
        </>
      )}
      {d.status === 'done' && <div className='text-[10px] text-emerald-500'>{fmtSize(d.loaded)} · Complete</div>}
      {d.status === 'error' && <div className='text-[10px] text-red-500'>{d.error}</div>}
    </div>
  );
});

export function DownloadProvider({ children }: { children: React.ReactNode }) {
  const [downloads, setDownloads] = useState<DownloadItem[]>([]);
  const downloadsRef = useRef<DownloadItem[]>([]);
  downloadsRef.current = downloads;
  const [minimized, setMinimized] = useState(false);
  const pendingUpdates = useRef<Map<number, Partial<DownloadItem>>>(new Map());
  const flushScheduled = useRef(false);

  const scheduleFlush = () => {
    if (flushScheduled.current) return;
    flushScheduled.current = true;
    requestAnimationFrame(() => {
      flushScheduled.current = false;
      if (pendingUpdates.current.size === 0) return;
      const updates = pendingUpdates.current;
      pendingUpdates.current = new Map();
      setDownloads(prev => prev.map(d => {
        const patch = updates.get(d.id);
        return patch ? { ...d, ...patch } : d;
      }));
    });
  };

  const update = (id: number, patch: Partial<DownloadItem>) => {
    const existing = pendingUpdates.current.get(id) || {};
    pendingUpdates.current.set(id, { ...existing, ...patch });
    scheduleFlush();
  };

  const download = useCallback((serverId: string, path: string) => {
    const id = ++uid;
    const filename = path.split('/').pop() || 'download';
    const token = localStorage.getItem('token') || '';
    const t0 = Date.now();
    const abortController = new AbortController();

    setDownloads(prev => [...prev, {
      id, name: filename, size: 0, loaded: 0, speed: 0,
      status: 'downloading', startTime: t0, abortController
    }]);

    (async () => {
      try {
        const res = await fetch(
          '/api/servers/' + serverId + '/files/download?path=' + encodeURIComponent(path),
          { headers: { Authorization: 'Bearer ' + token }, signal: abortController.signal }
        );

        if (!res.ok) {
          update(id, { status: 'error', error: 'HTTP ' + res.status });
          return;
        }

        const contentLength = parseInt(res.headers.get('content-length') || '0', 10);
        if (contentLength > 0) {
          update(id, { size: contentLength });
        }

        const reader = res.body?.getReader();
        if (!reader) {
          const blob = await res.blob();
          update(id, { status: 'done', loaded: blob.size, size: blob.size });
          triggerDownload(blob, filename);
          return;
        }

        // Large files (>500MB): stream to disk via File System Access API
        const LARGE_THRESHOLD = 500 * 1024 * 1024;
        const isLarge = contentLength > LARGE_THRESHOLD;
        const canStreamToDisk = isLarge && 'showSaveFilePicker' in window;

        let writable: any = null;
        const chunks: ArrayBuffer[] = [];

        if (canStreamToDisk) {
          try {
            const handle = await (window as any).showSaveFilePicker({ suggestedName: filename });
            writable = await handle.createWritable();
          } catch {
            // User cancelled file picker - fall back to blob
          }
        }

        let loaded = 0;
        let lastUpdate = 0;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          if (writable) {
            await writable.write(value);
          } else {
            chunks.push(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
          }
          loaded += value.length;

          const now = Date.now();
          if (now - lastUpdate >= 100) {
            lastUpdate = now;
            const elapsed = (now - t0) / 1000;
            const speed = elapsed > 0 ? loaded / elapsed : 0;
            update(id, { loaded, speed, size: contentLength || 0 });
          }
        }

        if (writable) {
          await writable.close();
          update(id, { status: 'done', loaded, size: contentLength || loaded });
        } else {
          const blob = new Blob(chunks);
          update(id, { status: 'done', loaded: blob.size, size: blob.size });
          triggerDownload(blob, filename);
        }

      } catch (err: any) {
        if (err.name === 'AbortError') {
          update(id, { status: 'cancelled' });
        } else {
          update(id, { status: 'error', error: err.message || 'Download failed' });
        }
      }
    })();
  }, []);

  const triggerDownload = (blob: Blob, filename: string) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  const cancelDownload = useCallback((id: number) => {
    const item = downloadsRef.current.find(d => d.id === id);
    if (item?.abortController && item.status === 'downloading') {
      item.abortController.abort();
    }
  }, []);

  const clearDone = () => setDownloads(prev => prev.filter(d => d.status === 'downloading'));
  const activeCount = downloads.filter(d => d.status === 'downloading').length;
  const hasDownloads = downloads.length > 0;

  return (
    <DownloadContext.Provider value={{ download, downloads }}>
      {children}

      {/* Download popup */}
      {hasDownloads && (
        <div className='fixed bottom-4 left-4 z-[9990] w-80 max-h-[60vh] flex flex-col rounded-xl border bg-card text-card-foreground shadow-2xl overflow-hidden'>
          <div className='flex items-center justify-between px-3 py-2 border-b bg-muted/30 shrink-0'>
            <div className='flex items-center gap-2'>
              <Icons.download className='size-4 text-blue-500' />
              <span className='text-xs font-semibold'>
                Downloads{activeCount > 0 ? ` (${activeCount} active)` : ''}
              </span>
            </div>
            <div className='flex items-center gap-1'>
              {downloads.some(d => d.status !== 'downloading') && (
                <button onClick={clearDone} className='text-[10px] text-muted-foreground hover:text-foreground px-1'>Clear</button>
              )}
              <button onClick={() => setMinimized(!minimized)} className='text-muted-foreground hover:text-foreground'>
                {minimized ? <Icons.chevronUp className='size-3.5' /> : <Icons.chevronDown className='size-3.5' />}
              </button>
              <button onClick={() => setDownloads([])} className='text-muted-foreground hover:text-foreground'>
                <Icons.close className='size-3.5' />
              </button>
            </div>
          </div>
          {!minimized && (
            <div className='overflow-y-auto max-h-[50vh]'>
              {downloads.slice(-50).map(d => (
                <DownloadRow key={d.id} d={d} onCancel={cancelDownload} />
              ))}
              {downloads.length > 50 && (
                <div className='px-3 py-2 text-[10px] text-muted-foreground text-center border-t'>
                  Showing latest 50 of {downloads.length}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </DownloadContext.Provider>
  );
}
