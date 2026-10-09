'use client';

import { createContext, useContext, useState, useCallback, useRef, useEffect, memo } from 'react';
import { cn } from '@/lib/utils';
import { Icons } from '@/components/icons';

interface UploadItem {
  id: number;
  name: string;
  size: number;
  loaded: number;
  speed: number;
  status: 'queued' | 'uploading' | 'done' | 'error' | 'cancelled' | 'skipped';
  error?: string;
  xhr?: XMLHttpRequest;
  startTime: number;
}

interface PendingFile {
  serverId: string;
  path: string;
  file: File;
  existingSize?: number;
  onDone?: () => void;
}

interface QueueItem {
  /** Id cấp một lần lúc xếp hàng và GIỮ NGUYÊN tới khi xong.
   *  Trước đây startXhr cấp id mới, làm React key của dòng đổi giữa chừng ->
   *  dòng bị unmount rồi mount lại -> nháy. Kéo nhiều file là nháy liên tục. */
  id: number;
  serverId: string;
  path: string;
  file: File;
  fileName: string;
  onDone?: () => void;
}

interface UploadContextType {
  upload: (serverId: string, path: string, file: File, existingFiles: { name: string; size: number }[], onDone?: () => void) => void;
  uploads: UploadItem[];
}

const UploadContext = createContext<UploadContextType | null>(null);

export function useUpload() {
  const ctx = useContext(UploadContext);
  if (!ctx) throw new Error('useUpload must be used within UploadProvider');
  return ctx;
}

let uid = 0;
const MAX_CONCURRENT = 3;

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

// Memoized upload row - only re-renders when its own data changes
const UploadRow = memo(function UploadRow({ u, onCancel }: { u: UploadItem; onCancel: (id: number) => void }) {
  const pct = u.size > 0 ? Math.round((u.loaded / u.size) * 100) : 0;
  return (
    // data-upload-id: để test tự động đo được dòng có bị dựng lại hay không.
    // Dòng bị unmount/mount lại chính là hiện tượng "nháy" khi kéo nhiều file.
    <div data-upload-id={u.id} className='px-3 py-2 border-b last:border-b-0'>
      <div className='flex items-center justify-between mb-1'>
        <span className='text-xs font-medium truncate flex-1 mr-2'>{u.name}</span>
        {(u.status === 'uploading' || u.status === 'queued') && <button onClick={() => onCancel(u.id)} className='text-muted-foreground hover:text-destructive shrink-0'><Icons.close className='size-3.5' /></button>}
        {u.status === 'done' && <Icons.circleCheck className='size-3.5 text-emerald-500 shrink-0' />}
        {u.status === 'error' && <Icons.circleX className='size-3.5 text-red-500 shrink-0' />}
        {u.status === 'cancelled' && <Icons.minus className='size-3.5 text-muted-foreground shrink-0' />}
        {u.status === 'cancelled' && <span className='text-[10px] text-muted-foreground shrink-0'>Đã huỷ</span>}
        {u.status === 'skipped' && <span className='text-[10px] text-amber-500 shrink-0'>Đã bỏ qua</span>}
      </div>
      {u.status === 'uploading' && (
        <>
          <div className='h-1.5 w-full bg-primary/10 rounded-full overflow-hidden mb-1'>
            <div className='h-full bg-primary rounded-full' style={{ width: pct + '%', transition: 'width 0.15s linear' }} />
          </div>
          <div className='flex items-center justify-between text-[10px] text-muted-foreground'>
            <span>{fmtSize(u.loaded)} / {fmtSize(u.size)}</span>
            <span>{fmtSpeed(u.speed)} · {pct}%</span>
          </div>
        </>
      )}
      {u.status === 'queued' && <div className='text-[10px] text-muted-foreground'>Đang chờ…</div>}
      {u.status === 'done' && <div className='text-[10px] text-emerald-500'>{fmtSize(u.size)} · Xong</div>}
      {u.status === 'error' && <div className='text-[10px] text-red-500'>{u.error}</div>}
    </div>
  );
});

export function UploadProvider({ children }: { children: React.ReactNode }) {
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const uploadsRef = useRef<UploadItem[]>([]);
  uploadsRef.current = uploads;

  const [minimized, setMinimized] = useState(false);
  const [conflictQueue, setConflictQueue] = useState<PendingFile[]>([]);
  const [applyAll, setApplyAll] = useState(false);

  // Queue for sequential/limited concurrent uploads
  const uploadQueue = useRef<QueueItem[]>([]);
  const activeUploads = useRef(0);
  const pendingUpdates = useRef<Map<number, Partial<UploadItem>>>(new Map());
  const flushScheduled = useRef(false);

  // Throttled state update - batch all progress updates into requestAnimationFrame
  const scheduleFlush = () => {
    if (flushScheduled.current) return;
    flushScheduled.current = true;
    requestAnimationFrame(() => {
      flushScheduled.current = false;
      if (pendingUpdates.current.size === 0) return;
      const updates = pendingUpdates.current;
      pendingUpdates.current = new Map();
      setUploads(prev => prev.map(u => {
        const patch = updates.get(u.id);
        return patch ? { ...u, ...patch } : u;
      }));
    });
  };

  const update = (id: number, patch: Partial<UploadItem>) => {
    const existing = pendingUpdates.current.get(id) || {};
    pendingUpdates.current.set(id, { ...existing, ...patch });
    scheduleFlush();
  };

  // Process queue - start uploads up to MAX_CONCURRENT
  const processQueue = useCallback(() => {
    while (activeUploads.current < MAX_CONCURRENT && uploadQueue.current.length > 0) {
      const item = uploadQueue.current.shift()!;
      activeUploads.current++;
      startXhr(item);
    }
  }, []);

  const startXhr = (item: QueueItem) => {
    const { id, serverId, path, file, fileName, onDone } = item;
    const token = localStorage.getItem('token') || '';
    const fd = new FormData();
    fd.append('file', fileName !== file.name ? new File([file], fileName, { type: file.type }) : file);

    const xhr = new XMLHttpRequest();
    const t0 = Date.now();

    // Chuyển dòng đã có từ 'queued' sang 'uploading'. Tìm theo ID, không theo
    // tên: hai file cùng tên trong một lần kéo sẽ khớp nhầm dòng của nhau.
    setUploads(prev => {
      const idx = prev.findIndex(u => u.id === id);
      if (idx >= 0) {
        const copy = [...prev];
        copy[idx] = { ...copy[idx], xhr, status: 'uploading', startTime: t0 };
        return copy;
      }
      return [...prev, { id, name: fileName, size: file.size, loaded: 0, speed: 0, status: 'uploading', xhr, startTime: t0 }];
    });

    let lastUpdate = 0;
    xhr.upload.onprogress = (e) => {
      if (!e.lengthComputable) return;
      const now = Date.now();
      // Throttle: max 10 updates/sec per file
      if (now - lastUpdate < 100 && e.loaded < e.total) return;
      lastUpdate = now;
      const el = (now - t0) / 1000;
      update(id, { loaded: e.loaded, speed: el > 0 ? e.loaded / el : 0 });
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) { update(id, { status: 'done', loaded: file.size }); onDone?.(); }
      else update(id, { status: 'error', error: 'HTTP ' + xhr.status });
      activeUploads.current--;
      processQueue();
    };
    xhr.onerror = () => { update(id, { status: 'error', error: 'Lỗi mạng' }); activeUploads.current--; processQueue(); };
    xhr.onabort = () => { update(id, { status: 'cancelled' }); activeUploads.current--; processQueue(); };

    xhr.open('POST', '/api/servers/' + serverId + '/files/upload?path=' + encodeURIComponent(path));
    xhr.setRequestHeader('Authorization', 'Bearer ' + token);
    xhr.send(fd);
  };

  const doUpload = useCallback((serverId: string, path: string, file: File, fileName: string, onDone?: () => void) => {
    // Add to queue, show as 'queued' immediately
    const queueId = ++uid;
    setUploads(prev => [...prev, { id: queueId, name: fileName, size: file.size, loaded: 0, speed: 0, status: 'queued', startTime: Date.now() }]);
    uploadQueue.current.push({ id: queueId, serverId, path, file, fileName, onDone });
    processQueue();
  }, [processQueue]);

  const addSkipped = (name: string) => {
    const id = ++uid;
    setUploads(prev => [...prev, { id, name, size: 0, loaded: 0, speed: 0, status: 'skipped', startTime: Date.now() }]);
  };

  const handleDecision = useCallback((action: 'overwrite' | 'skip', forAll: boolean) => {
    const current = conflictQueue[0];
    if (!current) return;
    if (action === 'overwrite') doUpload(current.serverId, current.path, current.file, current.file.name, current.onDone);
    else addSkipped(current.file.name);
    if (forAll) {
      conflictQueue.slice(1).forEach(f => {
        if (action === 'overwrite') doUpload(f.serverId, f.path, f.file, f.file.name, f.onDone);
        else addSkipped(f.file.name);
      });
      setConflictQueue([]); setApplyAll(false);
    } else setConflictQueue(prev => prev.slice(1));
  }, [conflictQueue, doUpload]);

  const upload = useCallback((serverId: string, path: string, file: File, existingFiles: { name: string; size: number }[], onDone?: () => void) => {
    const existing = existingFiles.find(f => f.name === file.name);
    if (!existing) doUpload(serverId, path, file, file.name, onDone);
    else setConflictQueue(prev => [...prev, { serverId, path, file, existingSize: existing.size, onDone }]);
  }, [doUpload]);

  const cancelUpload = useCallback((id: number) => {
    const item = uploadsRef.current.find(u => u.id === id);
    if (item?.xhr && item.status === 'uploading') item.xhr.abort();
    else if (item?.status === 'queued') {
      // Remove from queue
      setUploads(prev => prev.filter(u => u.id !== id));
    }
  }, []);

  const clearDone = () => setUploads(prev => prev.filter(u => u.status === 'uploading' || u.status === 'queued'));
  const activeCount = uploads.filter(u => u.status === 'uploading').length;
  const queuedCount = uploads.filter(u => u.status === 'queued').length;
  const hasUploads = uploads.length > 0;
  const currentConflict = conflictQueue[0] || null;
  const remainingConflicts = conflictQueue.length - 1;

  return (
    <UploadContext.Provider value={{ upload, uploads }}>
      {children}

      {/* Conflict dialog */}
      {currentConflict && (
        <div className='fixed inset-0 z-[99998] flex items-center justify-center'>
          <div className='absolute inset-0 bg-black/40 backdrop-blur-[2px]' />
          <div className='relative bg-card text-card-foreground border rounded-xl shadow-2xl w-full max-w-lg mx-4 animate-in fade-in-0 zoom-in-95'>
            <div className='flex items-center justify-between px-5 py-3 border-b'>
              <h3 className='font-semibold text-sm'>File Conflict Confirmation</h3>
              <button onClick={() => handleDecision('skip', true)} className='text-muted-foreground hover:text-foreground'><Icons.close className='size-5' /></button>
            </div>
            <div className='p-5'>
              <div className='flex items-start gap-3 mb-4'>
                <div className='flex size-9 shrink-0 items-center justify-center rounded-full bg-amber-500/10'><Icons.warning className='size-5 text-amber-500' /></div>
                <div>
                  <p className='text-sm'>Duplicate file detected. Do you want to overwrite?</p>
                  {remainingConflicts > 0 && <p className='text-xs text-muted-foreground mt-1'>{remainingConflicts} more pending</p>}
                </div>
              </div>
              <div className='rounded-md border overflow-hidden'>
                <div className='grid grid-cols-[1fr_auto] gap-2 px-3 py-2 bg-muted/50 text-xs font-medium text-muted-foreground'>
                  <div>Tên file</div><div>Local → Online</div>
                </div>
                <div className='grid grid-cols-[1fr_auto] gap-2 px-3 py-2.5 text-sm items-center'>
                  <div className='font-mono text-xs truncate'>{currentConflict.path}{currentConflict.file.name}</div>
                  <div className='text-xs text-muted-foreground'>{fmtSize(currentConflict.file.size)}→{currentConflict.existingSize ? fmtSize(currentConflict.existingSize) : '?'}</div>
                </div>
              </div>
              {remainingConflicts > 0 && (
                <label className='flex items-center gap-2 mt-4 cursor-pointer'>
                  <input type='checkbox' checked={applyAll} onChange={e => setApplyAll(e.target.checked)} className='size-4 accent-primary rounded' />
                  <span className='text-xs'>Apply to all ({remainingConflicts + 1} files)</span>
                </label>
              )}
            </div>
            <div className='flex items-center justify-end gap-2 px-5 py-3 border-t bg-muted/30 rounded-b-xl'>
              <button onClick={() => handleDecision('skip', applyAll)} className='px-4 py-1.5 text-sm rounded-md border hover:bg-muted'>Bỏ qua</button>
              <button onClick={() => handleDecision('overwrite', applyAll)} className='px-4 py-1.5 text-sm rounded-md bg-emerald-600 text-white hover:bg-emerald-700 font-medium'>Ghi đè</button>
            </div>
          </div>
        </div>
      )}

      {/* Upload popup */}
      {hasUploads && (
        <div className='fixed bottom-4 right-4 z-[9990] w-80 max-h-[60vh] flex flex-col rounded-xl border bg-card text-card-foreground shadow-2xl overflow-hidden'>
          <div className='flex items-center justify-between px-3 py-2 border-b bg-muted/30 shrink-0'>
            <div className='flex items-center gap-2'>
              <Icons.upload className='size-4 text-primary' />
              <span className='text-xs font-semibold'>Tải lên {activeCount > 0 && `(${activeCount} đang chạy${queuedCount > 0 ? ', ' + queuedCount + ' chờ' : ''})`}</span>
            </div>
            <div className='flex items-center gap-1'>
              {uploads.some(u => u.status !== 'uploading' && u.status !== 'queued') && <button onClick={clearDone} className='text-[10px] text-muted-foreground hover:text-foreground px-1'>Xoá xong</button>}
              <button onClick={() => setMinimized(!minimized)} className='text-muted-foreground hover:text-foreground'>{minimized ? <Icons.chevronUp className='size-3.5' /> : <Icons.chevronDown className='size-3.5' />}</button>
              <button onClick={() => setUploads([])} className='text-muted-foreground hover:text-foreground'><Icons.close className='size-3.5' /></button>
            </div>
          </div>
          {!minimized && (
            <div className='overflow-y-auto max-h-[50vh]'>
              {uploads.slice(-50).map(u => <UploadRow key={u.id} u={u} onCancel={cancelUpload} />)}
              {uploads.length > 50 && <div className='px-3 py-2 text-[10px] text-muted-foreground text-center border-t'>Hiện 50 mục mới nhất trong {uploads.length}</div>}
            </div>
          )}
        </div>
      )}
    </UploadContext.Provider>
  );
}
