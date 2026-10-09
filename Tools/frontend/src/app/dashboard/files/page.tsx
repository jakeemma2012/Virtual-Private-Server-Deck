'use client';

import { useEffect, useState, useRef, useCallback, useMemo, memo } from 'react';
import { createPortal } from 'react-dom';
import { useSearchParams } from 'next/navigation';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { useImeGuard } from '@/hooks/use-ime-guard';
import { Label } from '@/components/ui/label';
import { Icons } from '@/components/icons';
import { api, VpsServer, FileEntry, type FileSearchHit } from '@/lib/api';
import { PAGE_SIZE, type SortKey } from '@/hooks/use-dir-listing';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useNotify } from '@/components/ui/notify';
import { useUpload } from '@/components/ui/upload-manager';
import { useDownload } from '@/components/ui/download-manager';
import { BreadcrumbPath } from './components/breadcrumb-path';
import { FileOperations } from './components/file-operations';
import { TerminalPopup } from './components/terminal-popup';
import { LocalPane, LOCAL_DRAG_TYPE } from './components/local-pane';
import { formatBytes, cn } from '@/lib/utils';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue
} from '@/components/ui/select';

// ===== Helpers =====
const IMG_EXT = new Set(['png','jpg','jpeg','gif','bmp','webp','svg','ico']);
const VID_EXT = new Set(['mp4','webm','mov','avi','mkv']);
const BINARY_EXT = new Set([...IMG_EXT, ...VID_EXT, 'zip','tar','gz','bz2','7z','rar','exe','bin','so','dll','pdf','doc','docx','xls','xlsx','ppt']);
const getExt = (name: string) => (name.split('.').pop() || '').toLowerCase();
const isImage = (name: string) => IMG_EXT.has(getExt(name));
const isVideo = (name: string) => VID_EXT.has(getExt(name));
const isBinary = (name: string) => BINARY_EXT.has(getExt(name));

/**
 * mtime là epoch GIÂY (số), không phải chuỗi đã format như trước.
 *
 * Nhờ đổi sang số mà "sắp xếp theo ngày" mới đúng: bản cũ nhận chuỗi từ server
 * rồi so sánh bằng localeCompare, nên thứ tự thời gian hoàn toàn sai.
 * Việc format để đọc là việc của UI, làm ở đây.
 */
/** Chuẩn hoá đường dẫn giống hàm normalize_path phía server, để so sánh ghim
 *  không bị lệch chỉ vì một dấu `/` ở cuối. */
const files_normalize = (p: string) => {
  const t = (p || '').trim();
  if (!t) return '/';
  let out = t.replace(/\/{2,}/g, '/');
  while (out.length > 1 && out.endsWith('/')) out = out.slice(0, -1);
  return out.startsWith('/') ? out : '/' + out;
};

const formatMtime = (mtime: number) => {
  if (!mtime) return '';
  const d = new Date(mtime * 1000);
  const now = Date.now();
  const diff = now - d.getTime();
  // Trong 24h thì hiện giờ, xa hơn thì hiện ngày — đọc nhanh hơn ngày đầy đủ.
  if (diff >= 0 && diff < 86_400_000) {
    return d.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: '2-digit' })
    + ' ' + d.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
};

// ===== Context Menu (file or empty area) =====
function CtxMenu({ x, y, file, onAction, onClose }: {
  x: number; y: number; file: FileEntry | null;
  onAction: (action: string) => void; onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); };
    document.addEventListener('mousedown', h); return () => document.removeEventListener('mousedown', h);
  }, [onClose]);

  const items = file ? [
    ...(file.type === 'directory' ? [{ icon: Icons.folderOpen, label: 'Open', action: 'open' }] : []),
    ...(isImage(file.name) ? [{ icon: Icons.eye, label: 'Preview', action: 'preview' }] : []),
    ...(!isBinary(file.name) && file.type !== 'directory' ? [{ icon: Icons.edit, label: 'Edit', action: 'edit' }] : []),
    ...(file.type !== 'directory' ? [{ icon: Icons.download, label: 'Download', action: 'download' }] : []),
    { icon: Icons.copy, label: 'Copy Path', action: 'copypath' },
    { icon: Icons.edit, label: 'Rename', action: 'rename' },
    { icon: Icons.lock, label: 'Permissions', action: 'chmod' },
    ...(file.type !== 'directory' ? [{ icon: Icons.box, label: 'Compress', action: 'compress' }] : []),
    { icon: Icons.trash, label: 'Delete', action: 'delete' },
  ] : [
    // Empty area menu
    { icon: Icons.refresh, label: 'Refresh', action: 'refresh' },
    { icon: Icons.add, label: 'New File', action: 'newfile' },
    { icon: Icons.folder, label: 'New Folder', action: 'newfolder' },
    { icon: Icons.terminal, label: 'Open Terminal Here', action: 'terminal' },
    { icon: Icons.upload, label: 'Upload', action: 'upload' },
  ];

  return (
    <div ref={ref} className='fixed z-[9999] min-w-[180px] rounded-lg border bg-popover text-popover-foreground shadow-lg py-1 animate-in fade-in-0 zoom-in-95'
      style={{ left: Math.min(x, window.innerWidth - 190), top: Math.min(y, window.innerHeight - items.length * 36 - 16) }}>
      {items.map(item => (
        <button key={item.action} className={`flex w-full items-center gap-2.5 px-3 py-2 text-sm hover:bg-accent ${item.action === 'delete' ? 'text-destructive' : ''}`}
          onClick={() => { onAction(item.action); onClose(); }}><item.icon className='size-4' />{item.label}</button>
      ))}
    </div>
  );
}

// ===== Image/Video Preview (aaPanel style) =====
function MediaPreview({ serverId, path, type, files, currentPath, onClose }: {
  serverId: string; path: string; type: 'image' | 'video';
  files: FileEntry[]; currentPath: string; onClose: () => void;
}) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [zoom, setZoom] = useState(1);
  const [currentFile, setCurrentFile] = useState(path);

  // Get all previewable files for prev/next
  const mediaFiles = files.filter(f => f.type !== 'directory' && (isImage(f.name) || isVideo(f.name)));
  const currentIndex = mediaFiles.findIndex(f => {
    const fp = currentPath === '/' ? '/' + f.name : currentPath + '/' + f.name;
    return fp === currentFile;
  });

  const loadFile = useCallback(async (filePath: string) => {
    setLoading(true); setZoom(1);
    if (blobUrl) URL.revokeObjectURL(blobUrl);
    setBlobUrl(null);
    try {
      const token = localStorage.getItem('token') || '';
      const res = await fetch('/api/servers/' + serverId + '/files/download?path=' + encodeURIComponent(filePath), {
        headers: { Authorization: 'Bearer ' + token }
      });
      const blob = await res.blob();
      setBlobUrl(URL.createObjectURL(blob));
    } catch {} finally { setLoading(false); }
  }, [serverId]);

  useEffect(() => { loadFile(currentFile); }, [currentFile, loadFile]);
  useEffect(() => { return () => { if (blobUrl) URL.revokeObjectURL(blobUrl); }; }, []);

  const goPrev = () => {
    if (currentIndex > 0) {
      const f = mediaFiles[currentIndex - 1];
      setCurrentFile(currentPath === '/' ? '/' + f.name : currentPath + '/' + f.name);
    }
  };
  const goNext = () => {
    if (currentIndex < mediaFiles.length - 1) {
      const f = mediaFiles[currentIndex + 1];
      setCurrentFile(currentPath === '/' ? '/' + f.name : currentPath + '/' + f.name);
    }
  };

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowLeft') goPrev();
      if (e.key === 'ArrowRight') goNext();
      if (e.key === '+' || e.key === '=') setZoom(z => Math.min(z + 0.25, 5));
      if (e.key === '-') setZoom(z => Math.max(z - 0.25, 0.25));
    };
    window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h);
  });

  const curName = currentFile.split('/').pop() || '';
  const isImg = isImage(curName);

  return (
    <div className='fixed inset-0 z-[9998] flex flex-col' onClick={onClose}>
      <div className='absolute inset-0 bg-black/80' />

      {/* Top bar */}
      <div className='relative z-10 flex items-center justify-between px-4 py-2 bg-black/60 text-white shrink-0' onClick={e => e.stopPropagation()}>
        <span className='text-sm truncate'>{curName}</span>
        <span className='text-xs text-zinc-400'>{currentIndex + 1} / {mediaFiles.length}</span>
        <button onClick={onClose} className='hover:text-zinc-300'><Icons.close className='size-5' /></button>
      </div>

      {/* Image/Video */}
      <div className='relative flex-1 flex items-center justify-center overflow-hidden' onClick={e => e.stopPropagation()}>
        {loading ? (
          <Icons.spinner className='size-10 animate-spin text-white' />
        ) : blobUrl && isImg ? (
          <img src={blobUrl} alt={curName}
            className='max-w-full max-h-full object-contain transition-transform duration-200'
            style={{ transform: 'scale(' + zoom + ')' }}
            draggable={false} />
        ) : blobUrl ? (
          <video src={blobUrl} controls autoPlay className='max-w-full max-h-full' />
        ) : null}

        {/* Prev/Next arrows */}
        {currentIndex > 0 && (
          <button onClick={goPrev} className='absolute left-2 md:left-4 top-1/2 -translate-y-1/2 size-10 md:size-12 rounded-full bg-black/50 hover:bg-black/70 text-white flex items-center justify-center transition-colors'>
            <Icons.chevronLeft className='size-6' />
          </button>
        )}
        {currentIndex < mediaFiles.length - 1 && (
          <button onClick={goNext} className='absolute right-2 md:right-4 top-1/2 -translate-y-1/2 size-10 md:size-12 rounded-full bg-black/50 hover:bg-black/70 text-white flex items-center justify-center transition-colors'>
            <Icons.chevronRight className='size-6' />
          </button>
        )}
      </div>

      {/* Bottom controls */}
      {isImg && (
        <div className='relative z-10 flex items-center justify-center gap-2 py-3 bg-black/60 shrink-0' onClick={e => e.stopPropagation()}>
          <button onClick={goPrev} disabled={currentIndex <= 0} className='size-9 rounded-full bg-zinc-700 hover:bg-zinc-600 disabled:opacity-30 text-white flex items-center justify-center'>
            <Icons.chevronLeft className='size-5' />
          </button>
          <button onClick={() => setZoom(z => Math.max(z - 0.25, 0.25))} className='size-9 rounded-full bg-zinc-700 hover:bg-zinc-600 text-white flex items-center justify-center'>
            <Icons.minus className='size-4' />
          </button>
          <span className='text-white text-xs w-12 text-center'>{Math.round(zoom * 100)}%</span>
          <button onClick={() => setZoom(z => Math.min(z + 0.25, 5))} className='size-9 rounded-full bg-zinc-700 hover:bg-zinc-600 text-white flex items-center justify-center'>
            <Icons.add className='size-4' />
          </button>
          <button onClick={() => setZoom(1)} className='size-9 rounded-full bg-zinc-700 hover:bg-zinc-600 text-white flex items-center justify-center text-xs font-bold'>
            1:1
          </button>
          <button onClick={goNext} disabled={currentIndex >= mediaFiles.length - 1} className='size-9 rounded-full bg-zinc-700 hover:bg-zinc-600 disabled:opacity-30 text-white flex items-center justify-center'>
            <Icons.chevronRight className='size-5' />
          </button>
        </div>
      )}
    </div>
  );
}

// ===== Multi-Tab Editor =====
function FileEditorPopup({ serverId, initialPath, rootDir, onClose }: {
  serverId: string; initialPath: string; rootDir: string; onClose: () => void;
}) {
  const toast = useNotify();
  const [tabs, setTabs] = useState<string[]>([initialPath]);
  const [activeTab, setActiveTab] = useState(initialPath);
  const [contents, setContents] = useState<Record<string, string>>({});
  const [modifiedSet, setModifiedSet] = useState<Set<string>>(new Set());
  const [loadingSet, setLoadingSet] = useState<Set<string>>(new Set());
  const [showSidebar, setShowSidebar] = useState(typeof window !== 'undefined' && window.innerWidth > 768);
  const contentsRef = useRef<Record<string, string>>({});
  const [EditorComp, setEditorComp] = useState<any>(null);
  const [treeFiles, setTreeFiles] = useState<Record<string, FileEntry[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set([rootDir]));
  const [treeCtx, setTreeCtx] = useState<{ x: number; y: number; path: string; isDir: boolean } | null>(null);
  const [treeCreate, setTreeCreate] = useState<{ dir: string; type: 'file' | 'dir' } | null>(null);
  const [treeCreateName, setTreeCreateName] = useState('');
  const [treeRename, setTreeRename] = useState<{ path: string; name: string } | null>(null);
  const [treeRenameName, setTreeRenameName] = useState('');
  const treeRenameGuard = useImeGuard<HTMLInputElement>(e => setTreeRenameName(e.target.value));
  const treeCreateGuard = useImeGuard<HTMLInputElement>(e => setTreeCreateName(e.target.value));

  const handleTreeRename = async () => {
    if (!treeRename || !treeRenameName.trim()) { setTreeRename(null); return; }
    // If name unchanged, just cancel
    if (treeRenameName.trim() === treeRename.name) { setTreeRename(null); return; }
    const dir = treeRename.path.substring(0, treeRename.path.lastIndexOf('/'));
    const newPath = dir + '/' + treeRenameName.trim();
    try {
      await api.renameFile(serverId, treeRename.path, newPath);
      toast.success('Renamed');
      // Force reload: remove cache then reload
      setTreeFiles(prev => {
        const n = { ...prev };
        delete n[dir];
        return n;
      });
      setTimeout(() => loadTreeDir(dir), 100);
    } catch (e: any) { toast.error(e.message); }
    setTreeRename(null); setTreeRenameName('');
  };
  const treeCtxRef = useRef<HTMLDivElement>(null);

  // Close tree context menu on outside click
  useEffect(() => {
    if (!treeCtx) return;
    const h = (e: MouseEvent) => { if (treeCtxRef.current && !treeCtxRef.current.contains(e.target as Node)) setTreeCtx(null); };
    document.addEventListener('mousedown', h); return () => document.removeEventListener('mousedown', h);
  }, [treeCtx]);

  const handleTreeCreate = async () => {
    if (!treeCreate || !treeCreateName.trim()) return;
    const fullP = treeCreate.dir + '/' + treeCreateName.trim();
    try {
      if (treeCreate.type === 'dir') await api.mkdir(serverId, fullP);
      else await api.executeCommand(serverId, 'touch ' + fullP);
      toast.success('Created');
      // Refresh parent dir in tree
      setTreeFiles(prev => { const n = { ...prev }; delete n[treeCreate.dir]; return n; });
      setTimeout(() => { loadTreeDir(treeCreate.dir); setExpanded(prev => new Set(prev).add(treeCreate.dir)); }, 100);
    } catch (e: any) { toast.error(e.message); }
    setTreeCreate(null); setTreeCreateName('');
  };

  const handleTreeDelete = async (path: string) => {
    const dir = path.substring(0, path.lastIndexOf('/'));
    try {
      await api.deleteFile(serverId, path);
      toast.success('Deleted');
      setTreeFiles(prev => { const n = { ...prev }; delete n[dir]; return n; });
      setTimeout(() => loadTreeDir(dir), 100);
    } catch (e: any) { toast.error(e.message); }
  };
  const isMobile = typeof window !== 'undefined' && window.innerWidth < 768;

  useEffect(() => { if (!isMobile) import('@monaco-editor/react').then(m => setEditorComp(() => m.default)); }, [isMobile]);
  useEffect(() => { loadTreeDir(rootDir); }, [serverId, rootDir]);

  const loadTreeDir = async (dir: string) => {
    if (treeFiles[dir]) return;
    try {
      // Server đã sắp xếp: thư mục trước, rồi tên theo thứ tự tự nhiên
      // (file2 trước file10). Không sort lại ở đây.
      const page = await api.listFiles(serverId, { path: dir, limit: 2000 });
      setTreeFiles(prev => ({
        ...prev,
        [dir]: page.entries.filter(f => f.name !== '.' && f.name !== '..'),
      }));
    } catch { /* thư mục không đọc được -> để trống, cây vẫn mở được nhánh khác */ }
  };

  useEffect(() => {
    if (!activeTab || contents[activeTab] !== undefined || loadingSet.has(activeTab)) return;
    setLoadingSet(prev => new Set(prev).add(activeTab));
    api.readFile(serverId, activeTab)
      .then(r => { setContents(prev => { const n = { ...prev, [activeTab]: r.content }; contentsRef.current = n; return n; }); setLoadingSet(prev => { const n = new Set(prev); n.delete(activeTab); return n; }); })
      .catch(e => { toast.error('Cannot read: ' + e.message); closeTab(activeTab); });
  }, [activeTab, serverId]);

  const openFile = (path: string) => { if (isBinary(path)) return; if (!tabs.includes(path)) setTabs(prev => [...prev, path]); setActiveTab(path); };
  const closeTab = (path: string) => { const n = tabs.filter(t => t !== path); setTabs(n); if (activeTab === path) setActiveTab(n[n.length - 1] || ''); if (n.length === 0) onClose(); };

  const save = useCallback(async () => {
    if (!activeTab) return;
    try { await api.writeFile(serverId, activeTab, contentsRef.current[activeTab] || ''); setModifiedSet(prev => { const n = new Set(prev); n.delete(activeTab); return n; }); toast.success('Saved'); }
    catch (e: any) { toast.error(e.message); }
  }, [serverId, activeTab]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); save(); } if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h);
  }, [save, onClose]);

  const toggleTreeDir = (dir: string) => { setExpanded(prev => { const n = new Set(prev); if (n.has(dir)) n.delete(dir); else { n.add(dir); loadTreeDir(dir); } return n; }); };

  const getLang = (p: string) => {
    const ext = getExt(p);
    const m: Record<string, string> = { js:'javascript',jsx:'javascript',ts:'typescript',tsx:'typescript',py:'python',php:'php',java:'java',go:'go',rs:'rust',css:'css',scss:'scss',html:'html',htm:'html',xml:'xml',json:'json',yaml:'yaml',yml:'yaml',md:'markdown',sh:'shell',bash:'shell',sql:'sql',conf:'ini',ini:'ini',toml:'ini',env:'plaintext',txt:'plaintext',log:'plaintext' };
    return m[ext] || 'plaintext';
  };

  const renderTreeNode = (f: FileEntry, parentDir: string, depth: number): React.ReactNode => {
    const fp = parentDir === '/' ? '/' + f.name : parentDir + '/' + f.name;
    const isDir = f.type === 'directory';
    const isOpen = expanded.has(fp);
    return (
      <div key={fp}>
        <button className={cn('flex items-center gap-1 w-full text-left py-1 px-1 text-xs hover:bg-muted/50 rounded-sm', fp === activeTab && 'bg-primary/10 text-primary font-medium', isBinary(f.name) && !isDir && 'opacity-50')}
          style={{ paddingLeft: depth * 12 + 4 }}
          onClick={() => { if (isDir) toggleTreeDir(fp); else openFile(fp); }}
          onContextMenu={(e) => {
            e.preventDefault(); e.stopPropagation();
            setTreeCtx({ x: e.clientX, y: e.clientY, path: fp, isDir });
          }}>
          {isDir ? <Icons.chevronRight className={cn('size-3 shrink-0 transition-transform', isOpen && 'rotate-90')} /> : <span className='w-3' />}
          {isDir ? <Icons.folder className='size-3.5 text-amber-500 shrink-0' /> : <Icons.page className='size-3.5 text-muted-foreground shrink-0' />}
          {treeRename?.path === fp ? (
            <input value={treeRenameName} {...treeRenameGuard}
              onKeyDown={e => { e.stopPropagation(); if (e.nativeEvent.isComposing) return; if (e.key === 'Enter') handleTreeRename(); if (e.key === 'Escape') { setTreeRename(null); setTreeRenameName(''); } }}
              onBlur={() => { setTreeRename(null); setTreeRenameName(''); }}
              onClick={e => e.stopPropagation()}
              className='h-4 text-[11px] bg-muted/50 border rounded-md px-1 flex-1 min-w-0 focus:outline-none focus:ring-1 focus:ring-primary transition-[box-shadow,border-color]'
              autoFocus />
          ) : (
            <span className='truncate'>{f.name}</span>
          )}
        </button>
        {isDir && isOpen && treeFiles[fp]?.map(child => renderTreeNode(child, fp, depth + 1))}
      </div>
    );
  };

  const activeFilename = activeTab.split('/').pop() || '';
  const isActiveLoading = loadingSet.has(activeTab);

  if (typeof document === 'undefined') return null;
  return createPortal(
    <div className='fixed inset-0 z-[9998] flex flex-col md:flex-row md:justify-end'>
      <div className='hidden md:block absolute inset-0 bg-black/40' onClick={onClose} />
      <div className='relative flex w-full md:w-3/5 lg:w-1/2 h-full bg-background md:border-l shadow-2xl overflow-hidden'>
        {showSidebar && !isMobile && (
          <div className='w-48 border-r bg-muted/20 flex flex-col shrink-0'>
            <div className='flex items-center justify-between px-2 py-1.5 border-b shrink-0'>
              <span className='text-[10px] font-semibold text-muted-foreground truncate'>{rootDir}</span>
              <button onClick={() => setShowSidebar(false)} className='text-muted-foreground hover:text-foreground'><Icons.close className='size-3' /></button>
            </div>
            <div className='flex-1 overflow-y-auto p-0.5'
              onContextMenu={(e) => { e.preventDefault(); setTreeCtx({ x: e.clientX, y: e.clientY, path: rootDir, isDir: true }); }}>
              {treeFiles[rootDir]?.map(f => renderTreeNode(f, rootDir, 0))}
              {/* Inline create input */}
              {treeCreate && treeCreate.dir === rootDir && (
                <div className='flex items-center gap-1 px-1 py-1'>
                  {treeCreate.type === 'dir' ? <Icons.folder className='size-3.5 text-amber-500 shrink-0' /> : <Icons.page className='size-3.5 text-muted-foreground shrink-0' />}
                  <input value={treeCreateName} {...treeCreateGuard}
                    onKeyDown={e => { if (e.nativeEvent.isComposing) return; if (e.key === 'Enter') handleTreeCreate(); if (e.key === 'Escape') { setTreeCreate(null); setTreeCreateName(''); } }}
                    className='h-5 text-[11px] bg-muted/50 border rounded-md px-1 flex-1 min-w-0 focus:outline-none focus:ring-1 focus:ring-primary transition-[box-shadow,border-color]'
                    placeholder={treeCreate.type === 'dir' ? 'folder name' : 'file name'} autoFocus />
                </div>
              )}
            </div>
          </div>
        )}

        {/* Tree context menu */}
        {treeCtx && (
          <div ref={treeCtxRef} className='fixed z-[9999] min-w-[160px] rounded-lg border bg-popover text-popover-foreground shadow-lg py-1 animate-in fade-in-0 zoom-in-95'
            style={{ left: Math.min(treeCtx.x, window.innerWidth - 170), top: Math.min(treeCtx.y, window.innerHeight - 250) }}>
            {/* Show target name */}
            {treeCtx.path !== rootDir && (
              <div className='px-3 py-1.5 text-[10px] text-muted-foreground truncate border-b mb-1'>
                {treeCtx.path.split('/').pop()}
              </div>
            )}
            <button className='flex w-full items-center gap-2 px-3 py-2 text-xs hover:bg-accent transition-colors'
              onClick={() => { const dir = treeCtx.isDir ? treeCtx.path : treeCtx.path.substring(0, treeCtx.path.lastIndexOf('/')); setTreeCreate({ dir, type: 'file' }); setTreeCtx(null); }}>
              <Icons.page className='size-3.5' />New File
            </button>
            <button className='flex w-full items-center gap-2 px-3 py-2 text-xs hover:bg-accent transition-colors'
              onClick={() => { const dir = treeCtx.isDir ? treeCtx.path : treeCtx.path.substring(0, treeCtx.path.lastIndexOf('/')); setTreeCreate({ dir, type: 'dir' }); setTreeCtx(null); }}>
              <Icons.folder className='size-3.5 text-amber-500' />New Folder
            </button>
            {treeCtx.path !== rootDir && (
              <>
                <div className='my-0.5 border-t' />
                <button className='flex w-full items-center gap-2 px-3 py-2 text-xs hover:bg-accent transition-colors'
                  onClick={() => { setTreeRename({ path: treeCtx.path, name: treeCtx.path.split('/').pop() || '' }); setTreeRenameName(treeCtx.path.split('/').pop() || ''); setTreeCtx(null); }}>
                  <Icons.edit className='size-3.5' />Rename
                </button>
                <button className='flex w-full items-center gap-2 px-3 py-2 text-xs hover:bg-accent transition-colors text-destructive'
                  onClick={() => { handleTreeDelete(treeCtx.path); setTreeCtx(null); }}>
                  <Icons.trash className='size-3.5' />Delete
                </button>
              </>
            )}
          </div>
        )}
        <div className='flex-1 flex flex-col min-w-0 min-h-0'>
          <div className='flex items-center gap-1 px-2 py-1.5 border-b bg-muted/30 shrink-0'>
            {!isMobile && !showSidebar && <button onClick={() => setShowSidebar(true)} className='text-muted-foreground hover:text-foreground mr-1'><Icons.panelLeft className='size-3.5' /></button>}
            <Icons.page className='size-3 text-muted-foreground shrink-0' />
            <span className='text-xs font-semibold truncate'>{activeFilename}</span>
            {modifiedSet.has(activeTab) && <span className='size-1.5 rounded-full bg-amber-500 shrink-0 ml-1' />}
            <div className='ml-auto flex items-center gap-1.5 shrink-0'>
              <Button size='sm' className='h-6 text-[10px] px-2' onClick={save}><Icons.check className='size-3' /><span className='ml-0.5'>Lưu</span></Button>
              <button onClick={onClose} className='text-muted-foreground hover:text-foreground'><Icons.close className='size-4' /></button>
            </div>
          </div>
          <div className='flex items-center border-b bg-muted/10 shrink-0 overflow-x-auto' style={{ WebkitOverflowScrolling: 'touch' }}>
            {tabs.map(t => (
              <button key={t} className={cn('flex items-center gap-1 px-2 py-1 text-xs border-r whitespace-nowrap shrink-0', t === activeTab ? 'bg-background text-foreground border-b-2 border-b-primary' : 'text-muted-foreground hover:bg-muted/50')}
                onClick={() => setActiveTab(t)}>
                <span className='max-w-[80px] md:max-w-[120px] truncate'>{t.split('/').pop()}</span>
                {modifiedSet.has(t) && <span className='size-1.5 rounded-full bg-amber-500 shrink-0' />}
                <button className='ml-0.5 hover:text-destructive shrink-0' onClick={e => { e.stopPropagation(); closeTab(t); }}><Icons.close className='size-3' /></button>
              </button>
            ))}
          </div>
          <div className='flex-1 min-h-0 overflow-hidden'>
            {!activeTab ? <div className='flex items-center justify-center h-full text-muted-foreground text-sm'>Chọn một file</div>
            : isActiveLoading ? <div className='flex items-center justify-center h-full'><Icons.spinner className='size-6 animate-spin text-muted-foreground' /></div>
            : isMobile || !EditorComp ? (
              <Textarea value={contents[activeTab] || ''} onChange={e => { const v = e.target.value; contentsRef.current = { ...contentsRef.current, [activeTab]: v }; setContents(prev => ({ ...prev, [activeTab]: v })); setModifiedSet(prev => new Set(prev).add(activeTab)); }}
                className='w-full h-full min-h-0 resize-none rounded-none border-0 shadow-none bg-[#0a0a0a] text-zinc-100 font-mono text-xs p-3 focus-visible:ring-0 leading-relaxed' spellCheck={false} />
            ) : (
              <EditorComp key={activeTab} height='100%' width='100%' language={getLang(activeTab)} value={contents[activeTab] || ''} theme='vs-dark'
                onChange={(v: string | undefined) => { const val = v || ''; contentsRef.current = { ...contentsRef.current, [activeTab]: val }; setContents(prev => ({ ...prev, [activeTab]: val })); setModifiedSet(prev => new Set(prev).add(activeTab)); }}
                options={{ fontSize: 13, minimap: { enabled: false }, wordWrap: 'on', scrollBeyondLastLine: false, automaticLayout: true, tabSize: 2, padding: { top: 8 }, bracketPairColorization: { enabled: true } }} />
            )}
          </div>
          <div className='flex items-center px-2 py-0.5 border-t bg-muted/20 text-[10px] text-muted-foreground shrink-0'>
            <span className='truncate'>{activeTab}</span><span className='ml-auto'>{getLang(activeTab).toUpperCase()}</span>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}

// ===== File Row =====
const FileRow = memo(function FileRow({ file, selected, index, onSelect, onClick, onContextMenu, renaming, renameValue, onRenameChange, onRenameSubmit, onRenameCancel }: {
  file: FileEntry; selected: boolean; index: number;
  onSelect: () => void; onClick: () => void; onContextMenu: (e: React.MouseEvent) => void;
  renaming: boolean; renameValue: string;
  onRenameChange: (v: string) => void; onRenameSubmit: () => void; onRenameCancel: () => void;
}) {
  const canCheck = file.name !== '..' && file.name !== '.';
  const ext = getExt(file.name);
  const fileIcon = file.type === 'directory' ? <Icons.folder className='size-4 text-amber-500' />
    : isImage(file.name) ? <Icons.eye className='size-4 text-pink-500' />
    : isVideo(file.name) ? <Icons.play className='size-4 text-blue-500' />
    : <Icons.page className='size-4 text-muted-foreground' />;

  return (
    <div data-index={index} data-name={file.name}
      className={cn('file-row flex items-center gap-1.5 md:gap-2 px-2 md:px-3 py-1.5 md:py-2 text-sm border-b last:border-b-0 cursor-pointer transition-colors',
        selected ? 'bg-primary/10 hover:bg-primary/15' : 'hover:bg-muted/30')}
      onClick={onClick} onContextMenu={onContextMenu}>
      <div className='w-4 shrink-0 flex items-center justify-center'>
        {canCheck ? <input type='checkbox' checked={selected} onChange={onSelect} onClick={e => e.stopPropagation()} className='size-3.5 rounded accent-primary cursor-pointer' /> : <span className='w-3.5' />}
      </div>
      <div className='w-4 shrink-0'>{fileIcon}</div>
      <div className='flex-1 min-w-0'>
        {renaming ? (
          <div className='flex items-center gap-1' onClick={e => e.stopPropagation()}>
            <Input value={renameValue} onChange={e => onRenameChange(e.target.value)} onKeyDown={e => { if (e.nativeEvent.isComposing) return; if (e.key === 'Enter') onRenameSubmit(); if (e.key === 'Escape') onRenameCancel(); }} className='h-6 text-xs flex-1' autoFocus />
            <Button size='sm' className='h-6 text-[10px] px-1.5' onClick={onRenameSubmit}>OK</Button>
          </div>
        ) : <span className={cn('truncate text-xs md:text-sm block', selected && 'text-primary font-medium')}>{file.name}</span>}
      </div>
      <div className='text-muted-foreground text-xs hidden md:block w-[70px] shrink-0 text-right'>{file.type === 'directory' ? '-' : formatBytes(file.size)}</div>
      <span className='text-[10px] text-muted-foreground md:hidden shrink-0'>{file.type !== 'directory' && file.name !== '..' ? formatBytes(file.size) : ''}</span>
      <div className='text-muted-foreground text-[11px] hidden md:block w-[130px] shrink-0 truncate'>{formatMtime(file.mtime)}</div>
      <div className='font-mono text-[10px] text-muted-foreground hidden lg:block w-[85px] shrink-0'>{file.permissions}</div>
    </div>
  );
});

// ===== Main Page =====
export default function FilesPage() {
  const searchParams = useSearchParams();
  const initialServerId = searchParams.get('serverId') || '';
  const toast = useNotify();
  const { upload: startUpload } = useUpload();
  const { download: startDownload } = useDownload();
  const [servers, setServers] = useState<VpsServer[]>([]);
  const [selectedServer, setSelectedServer] = useState('');
  const [currentPath, setCurrentPath] = useState('/root');
  const currentPathRef = useRef('/root');
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [showCreate, setShowCreate] = useState<'file' | 'dir' | null>(null);
  const [newName, setNewName] = useState('');
  const [editingPath, setEditingPath] = useState(false);
  const [pathInput, setPathInput] = useState('/root');
  const [searchQuery, setSearchQuery] = useState('');
  const [dragging, setDragging] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; file: FileEntry | null } | null>(null);
  const [renameTarget, setRenameTarget] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set());
  const [editorPath, setEditorPath] = useState<string | null>(null);
  const [editorRootDir, setEditorRootDir] = useState('/root');
  const [previewMedia, setPreviewMedia] = useState<{ path: string; type: 'image' | 'video' } | null>(null);
  const [showTerminal, setShowTerminal] = useState(false);
  const [showRange, setShowRange] = useState(false);
  const [rangeMin, setRangeMin] = useState('');
  const [rangeMax, setRangeMax] = useState('');
  const [rangeFilter, setRangeFilter] = useState<{ min: number; max: number } | null>(null);
  // `split` nằm TRÊN TỪNG TAB: mỗi tab có panel local riêng, chọn thư mục
  // riêng. Để ở state chung thì mở split ở tab 1 là tab 2 cũng mở, và cùng
  // trỏ vào một thư mục — không phải điều người dùng muốn.
  const [tabs, setTabs] = useState<{
    id: number; path: string; label: string; files: FileEntry[]; split?: boolean;
  }[]>([]);
  const [activeTabId, setActiveTabId] = useState(0);
  const tabIdCounter = useRef(1);
  const activeTabIdRef = useRef(0);
  const [sortBy, setSortBy] = useState<SortKey>('name');
  const [sortAsc, setSortAsc] = useState(true);
  // Tổng số entry THẬT trong thư mục (files.length chỉ là số đã nạp về).
  const [totalEntries, setTotalEntries] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  // Server nào đã được mở tới thư mục khởi đầu rồi.
  const initializedServerRef = useRef('');
  // File đang được kéo từ panel local. Phải đi qua ref vì đọc File() là bất
  // đồng bộ, không kịp nhét vào dataTransfer trong lúc dragstart.
  const localDragFiles = useRef<File[] | null>(null);
  // Tab đầu tiên được phép khôi phục thư mục đã nhớ; các tab mở sau bắt đầu
  // trống để người dùng tự chọn, đúng như yêu cầu "ra tab 2 phải chọn lại".
  const firstTabIdRef = useRef<number | null>(null);
  const [indexState, setIndexState] = useState<'none' | 'running' | 'done' | 'failed'>('none');
  // Kết quả tìm kiếm ĐỆ QUY; null = đang ở chế độ xem thư mục bình thường.
  const [searchHits, setSearchHits] = useState<FileSearchHit[] | null>(null);
  const [searchSource, setSearchSource] = useState<'index' | 'live' | 'empty'>('empty');
  const [searching, setSearching] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Drag select
  const [isDragSel, setIsDragSel] = useState(false);
  const dragStart = useRef({ x: 0, y: 0 });
  const preDragSelection = useRef<Set<string>>(new Set());
  const [dragBox, setDragBox] = useState({ x: 0, y: 0, w: 0, h: 0 });

  // Persist server
  useEffect(() => { api.getServers().then(setServers).catch(() => {}); }, []);
  useEffect(() => {
    const saved = localStorage.getItem('files_server');
    const initial = initialServerId || saved || '';
    if (initial) setSelectedServer(initial);
  }, [initialServerId]);

  // Chưa chọn server nào thì lấy server ONLINE đầu tiên.
  //
  // Trước đây vào thẳng /dashboard/files lần đầu (chưa có ?serverId=, chưa có
  // localStorage) sẽ ra một trang TRẮNG hoàn toàn, không gợi ý gì — người dùng
  // không biết là phải tự mở dropdown chọn server.
  useEffect(() => {
    if (selectedServer || servers.length === 0) return;
    const first = servers.find((s) => s.status === 'ONLINE') ?? servers[0];
    if (first) setSelectedServer(first.id);
  }, [servers, selectedServer]);
  useEffect(() => { if (selectedServer) localStorage.setItem('files_server', selectedServer); }, [selectedServer]);

  // Persist path
  useEffect(() => {
    if (currentPath && selectedServer) localStorage.setItem('files_path_' + selectedServer, currentPath);
  }, [currentPath, selectedServer]);

  // Nạp MỘT TRANG đã sắp xếp sẵn ở server (mặc định 1000 dòng đầu), không phải
  // cả thư mục. `total` cho biết thực tế có bao nhiêu để UI hiện đúng và nạp
  // thêm khi cuộn. Thư mục 50k file vì thế không còn đẩy vài MB JSON về browser.
  const fetchFiles = useCallback(async (path?: string, opts?: { refresh?: boolean }) => {
    if (!selectedServer) return;
    setLoading(true);
    const p = path || currentPath;
    try {
      const page = await api.listFiles(selectedServer, {
        path: p,
        offset: 0,
        limit: PAGE_SIZE,
        sort: sortBy,
        order: sortAsc ? 'asc' : 'desc',
        refresh: opts?.refresh,
      });
      setFiles(page.entries);
      setTotalEntries(page.total);
      setIndexState(page.indexState);
      setCurrentPath(p); currentPathRef.current = p; setPathInput(p);
      setRangeFilter(null);
      setTabs(prev => prev.map(t => t.id === activeTabIdRef.current ? { ...t, path: p, label: p.split('/').pop() || '/', files: page.entries } : t));
      setSelectedFiles(new Set()); setRenameTarget(null); setSearchQuery('');
      setSearchHits(null);
    } catch (e: any) { toast.error(e.message || 'Không nạp được danh sách'); }
    finally { setLoading(false); }
  }, [selectedServer, currentPath, sortBy, sortAsc, toast]);

  // Cuộn tới cuối -> nạp trang kế. Không có thì người dùng chỉ thấy 1000 dòng
  // đầu mà không có cách nào xem phần còn lại.
  const loadMore = useCallback(async () => {
    if (!selectedServer || loadingMore || files.length >= totalEntries) return;
    setLoadingMore(true);
    try {
      const page = await api.listFiles(selectedServer, {
        path: currentPathRef.current,
        offset: files.length,
        limit: PAGE_SIZE,
        sort: sortBy,
        order: sortAsc ? 'asc' : 'desc',
        q: searchQuery.trim() || undefined,
      });
      setFiles(prev => [...prev, ...page.entries]);
      setTotalEntries(page.total);
    } catch (e: any) { toast.error(e.message || 'Không nạp thêm được'); }
    finally { setLoadingMore(false); }
  }, [selectedServer, files.length, totalEntries, loadingMore, sortBy, sortAsc, searchQuery, toast]);

  useEffect(() => {
    if (!selectedServer) return;
    // Chỉ nhảy tới thư mục khởi đầu MỘT LẦN cho mỗi server.
    //
    // Effect này phụ thuộc cả `servers.length` vì lúc vừa chọn server có thể
    // danh sách chưa tải xong nên chưa biết pinnedPath. Không có chốt này thì
    // khi danh sách về, người dùng đang duyệt ở thư mục khác sẽ bị kéo ngược
    // về chỗ ghim.
    if (initializedServerRef.current === selectedServer) return;
    {
      // Thứ tự ưu tiên: thư mục GHIM > thư mục vừa mở lần trước > /root.
      //
      // Ghim là lựa chọn tường minh của người dùng và lưu ở server (theo VPS),
      // nên nó phải thắng "lần trước mở ở đâu" — vốn chỉ là ghi nhớ ngầm trong
      // localStorage của riêng trình duyệt này.
      const srv = servers.find(sv => sv.id === selectedServer);
      // Chưa có danh sách server thì chờ, đừng vội nhảy vào /root rồi mới biết
      // là có ghim.
      if (!srv && servers.length === 0) return;
      initializedServerRef.current = selectedServer;
      const saved = localStorage.getItem('files_path_' + selectedServer);
      const p = srv?.pinnedPath || saved || '/root';
      setCurrentPath(p); currentPathRef.current = p; setPathInput(p);
      if (tabs.length === 0) {
        const label = p.split('/').pop() || '/';
        setTabs([{ id: 1, path: p, label, files: [] }]);
        firstTabIdRef.current = 1;
        setActiveTabId(1); activeTabIdRef.current = 1;
        tabIdCounter.current = 2;
      }
      fetchFiles(p);
    }
    // `servers` nằm trong deps: lúc chọn server xong mà danh sách chưa tải về
    // thì chưa biết pinnedPath, phải chạy lại khi có.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedServer, servers.length]);

  const navigateTo = useCallback((path: string) => { fetchFiles(path); }, [fetchFiles]);
  const navigateToName = useCallback((name: string) => {
    if (name === '..') { const parts = currentPath.split('/').filter(Boolean); parts.pop(); fetchFiles('/' + parts.join('/') || '/'); }
    else fetchFiles(currentPath === '/' ? `/${name}` : `${currentPath}/${name}`);
  }, [currentPath, fetchFiles]);

  const fullPath = useCallback((name: string) => { const cp = currentPathRef.current; return cp === '/' ? `/${name}` : `${cp}/${name}`; }, []);
  const toggleSelect = useCallback((name: string) => { setSelectedFiles(prev => { const n = new Set(prev); if (n.has(name)) n.delete(name); else n.add(name); return n; }); }, []);

  const selectAll = useCallback(() => {
    const s = files.filter(f => f.name !== '..').map(f => f.name);
    setSelectedFiles(prev => prev.size === s.length ? new Set() : new Set(s));
  }, [files]);

  const deleteSelected = useCallback(async () => {
    if (selectedFiles.size === 0 || !selectedServer) return;
    if (!(await toast.confirm(`Delete ${selectedFiles.size} items?`))) return;
    for (const name of selectedFiles) { try { await api.deleteFile(selectedServer, fullPath(name)); } catch {} }
    toast.success(`Deleted ${selectedFiles.size} items`); fetchFiles();
  }, [selectedFiles, selectedServer, fullPath, fetchFiles, toast]);

  const handleFileClick = useCallback((file: FileEntry) => {
    if (file.type === 'directory') { navigateToName(file.name); return; }
    if (file.name === '..') return;
    if (isImage(file.name)) { setPreviewMedia({ path: fullPath(file.name), type: 'image' as const }); }
    else if (isVideo(file.name)) { setPreviewMedia({ path: fullPath(file.name), type: 'video' as const }); }
    else if (!isBinary(file.name)) { setEditorPath(fullPath(file.name)); setEditorRootDir(currentPathRef.current); }
    else { startDownload(selectedServer, fullPath(file.name)); }
  }, [navigateToName, fullPath, selectedServer]);

  // Drag select
  const onMouseDown = useCallback((e: React.MouseEvent) => {
    const t = e.target as HTMLElement;
    if (t.closest('.file-row') || t.closest('input') || t.closest('button')) return;
    setIsDragSel(true);
    preDragSelection.current = new Set(selectedFiles);
    dragStart.current = { x: e.clientX, y: e.clientY };
    setDragBox({ x: e.clientX, y: e.clientY, w: 0, h: 0 });
  }, [selectedFiles]);

  useEffect(() => {
    if (!isDragSel) return;
    let rafId = 0;
    let lastEx = 0, lastEy = 0;

    const selectInRect = () => {
      const rect = { l: Math.min(dragStart.current.x, lastEx), r: Math.max(dragStart.current.x, lastEx), t: Math.min(dragStart.current.y, lastEy), b: Math.max(dragStart.current.y, lastEy) };
      if (rect.r - rect.l < 3 || rect.b - rect.t < 3 || !listRef.current) return;
      const rows = listRef.current.querySelectorAll('.file-row');
      const merged = new Set(preDragSelection.current);
      rows.forEach(row => {
        const r = row.getBoundingClientRect();
        if (r.bottom >= rect.t && r.top <= rect.b) {
          const name = row.getAttribute('data-name');
          if (name && name !== '..') merged.add(name);
        }
      });
      setSelectedFiles(merged);
    };

    const onMove = (e: MouseEvent) => {
      lastEx = e.clientX; lastEy = e.clientY;
      setDragBox({ x: Math.min(dragStart.current.x, e.clientX), y: Math.min(dragStart.current.y, e.clientY), w: Math.abs(e.clientX - dragStart.current.x), h: Math.abs(e.clientY - dragStart.current.y) });
      // Throttle DOM queries to once per frame
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(selectInRect);
    };
    const onUp = () => { cancelAnimationFrame(rafId); setIsDragSel(false); setDragBox({ x: 0, y: 0, w: 0, h: 0 }); };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => { cancelAnimationFrame(rafId); window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
  }, [isDragSel]);

  // Chặn hành vi mặc định của trình duyệt trên TOÀN cửa sổ.
  //
  // Thả file ra ngoài vùng danh sách (sidebar, thanh công cụ, breadcrumb, hay
  // mép trang) thì mặc định trình duyệt ĐIỀU HƯỚNG tới file đó — người dùng
  // mất luôn trang đang làm việc và file thì không được tải lên. Phải chặn ở
  // window vì không vùng nào khác trong app xử lý drop.
  useEffect(() => {
    const block = (e: DragEvent) => {
      if (!Array.from(e.dataTransfer?.types || []).includes('Files')) return;
      e.preventDefault();
      if (e.type === 'drop' && e.dataTransfer) e.dataTransfer.dropEffect = 'none';
    };
    window.addEventListener('dragover', block);
    window.addEventListener('drop', block);
    return () => {
      window.removeEventListener('dragover', block);
      window.removeEventListener('drop', block);
    };
  }, []);

  // Hiện/ẩn overlay kéo-thả.
  //
  // `dragleave` bắn MỖI LẦN con trỏ rời một phần tử con — mà bảng file có hàng
  // nghìn <tr>/<td>. Bản cũ bật ở `dragover` rồi tắt ở `dragleave`, nên rê
  // chuột qua danh sách là overlay bật/tắt liên tục: đúng hiện tượng "nháy".
  //
  // Cách sửa: ở `dragleave`, `relatedTarget` là phần tử SẮP được vào. Nếu nó
  // vẫn nằm trong vùng thả thì đây chỉ là đi từ con này sang con khác, bỏ qua.
  // Dùng cách này thay cho bộ đếm vào/ra vì bộ đếm lệch vĩnh viễn chỉ cần một
  // cặp enter/leave bị bỏ sót (xảy ra khi rê nhanh, hoặc khi kéo ra ngoài cửa sổ).
  const hasFiles = (e: React.DragEvent) => {
    const t = Array.from(e.dataTransfer?.types || []);
    return t.includes('Files') || t.includes(LOCAL_DRAG_TYPE);
  };

  const onDragEnter = useCallback((e: React.DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    setDragging(true);
  }, []);

  const onDragOver = useCallback((e: React.DragEvent) => {
    if (!hasFiles(e)) return;
    // preventDefault ở dragover là BẮT BUỘC, nếu không trình duyệt từ chối drop.
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    setDragging(true);
  }, []);

  const onDragLeave = useCallback((e: React.DragEvent) => {
    if (!hasFiles(e)) return;
    const zone = e.currentTarget as HTMLElement;
    const next = e.relatedTarget as Node | null;
    // Còn trong vùng thả -> không phải rời đi thật.
    if (next && zone.contains(next)) return;
    setDragging(false);
  }, []);

  // Đã nạp hết thư mục chưa (files.length chỉ là phần đã tải về).
  const loadedAll = files.length >= totalEntries;
  // Tab nào đang mở panel local.
  const splitOpen = tabs.some(t => t.id === activeTabId && t.split);
  const splitTabs = tabs.filter(t => t.split);

  /**
   * Danh sách file hiện có trong thư mục, dùng để phát hiện trùng tên.
   *
   * KHÔNG dùng state `files`: nó chỉ chứa trang đã nạp (1000 trên 4972), nên
   * file trùng nằm ngoài trang đầu sẽ không bị phát hiện và bị GHI ĐÈ im lặng.
   * Khi thư mục chưa nạp hết thì hỏi server một lần.
   */
  const existingNames = useCallback(async () => {
    const local = files.filter(f => f.type !== 'directory').map(f => ({ name: f.name, size: f.size }));
    if (loadedAll || !selectedServer) return local;
    try {
      const page = await api.listFiles(selectedServer, {
        path: currentPathRef.current,
        offset: 0,
        limit: 5000,
        sort: 'name',
        order: 'asc',
      });
      return page.entries
        .filter(f => f.type !== 'directory')
        .map(f => ({ name: f.name, size: f.size }));
    } catch {
      // Không hỏi được thì dùng tạm phần đã nạp — vẫn hơn là không kiểm gì.
      return local;
    }
  }, [files, loadedAll, selectedServer]);

  const uploadMany = useCallback(async (list: File[]) => {
    if (!selectedServer || list.length === 0) return;
    const p = currentPathRef.current.endsWith('/')
      ? currentPathRef.current
      : currentPathRef.current + '/';
    const existing = await existingNames();
    let done = 0;
    for (const file of list) {
      startUpload(selectedServer, p, file, existing, () => {
        done++;
        // Chỉ làm mới MỘT lần khi cả lô xong, không làm mới sau từng file.
        if (done === list.length) fetchFiles(currentPathRef.current, { refresh: true });
      });
    }
  }, [selectedServer, existingNames, startUpload, fetchFiles]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    if (!selectedServer) {
      toast.error('Chưa chọn server');
      return;
    }
    // Kéo từ panel local (bên phải): File() đã được đọc sẵn vào ref, vì đọc
    // chúng là bất đồng bộ nên không kịp nhét vào dataTransfer lúc dragstart.
    if (e.dataTransfer.types.includes(LOCAL_DRAG_TYPE)) {
      const local = localDragFiles.current;
      localDragFiles.current = null;
      if (local && local.length > 0) void uploadMany(local);
      return;
    }
    // Kéo từ hệ điều hành.
    const list = Array.from(e.dataTransfer.files);
    if (list.length === 0) return; // kéo thư mục hoặc kéo text
    void uploadMany(list);
  }, [selectedServer, uploadMany, toast]);

  const handleFileUpload = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files) return;
    void uploadMany(Array.from(e.target.files));
    e.target.value = ''; // cho phép chọn lại đúng file đó lần nữa
  }, [uploadMany]);

  const handleCtxAction = useCallback(async (action: string) => {
    if (!selectedServer) return;
    if (action === 'refresh') { fetchFiles(); return; }
    if (action === 'newfile') { setShowCreate('file'); return; }
    if (action === 'newfolder') { setShowCreate('dir'); return; }
    if (action === 'terminal') { window.location.href = `/dashboard/terminal?serverId=${selectedServer}&cwd=${encodeURIComponent(currentPathRef.current)}`; return; }
    if (action === 'terminal-popup') { setShowTerminal(true); return; }
    if (action === 'goto-root') { fetchFiles('/'); return; }
    if (action === 'remote-download') { toast.info('Enter URL in terminal: wget <url>'); setShowTerminal(true); return; }
    if (action === 'search-content') { toast.info('Use terminal: grep -r "text" .'); setShowTerminal(true); return; }
    if (action === 'upload') { fileInputRef.current?.click(); return; }
    if (!contextMenu?.file) return;
    const file = contextMenu.file; const fp = fullPath(file.name);
    switch (action) {
      case 'open': navigateToName(file.name); break;
      case 'preview':
        if (isImage(file.name)) setPreviewMedia({ path: fp, type: 'image' as const });
        else if (isVideo(file.name)) setPreviewMedia({ path: fp, type: 'video' as const });
        break;
      case 'edit': setEditorPath(fp); setEditorRootDir(currentPathRef.current); break;
      case 'download': startDownload(selectedServer, fp); break;
      case 'copypath': navigator.clipboard.writeText(fp).then(() => toast.success('Copied')); break;
      case 'rename': setRenameTarget(file.name); setRenameValue(file.name); break;
      case 'chmod': { const m = prompt('Permissions (e.g. 755):', '755'); if (m) { try { await api.chmod(selectedServer, fp, m); toast.success('OK'); fetchFiles(); } catch (e: any) { toast.error(e.message); } } break; }
      case 'compress': try {
        const r = await api.compress(selectedServer, fp);
        toast.success('Compressing in background...');
        const poll = setInterval(async () => {
          try {
            const s = await api.compressStatus(selectedServer, r.taskId);
            if (s.status === 'completed') { clearInterval(poll); toast.success('Compressed!'); fetchFiles(); }
            else if (s.status === 'failed') { clearInterval(poll); toast.error('Compress failed: ' + s.message); }
          } catch { clearInterval(poll); }
        }, 2000);
      } catch (e: any) { toast.error(e.message); } break;
      case 'delete': if (await toast.confirm(`Delete "${file.name}"?`)) { try { await api.deleteFile(selectedServer, fp); toast.success('Deleted'); fetchFiles(); } catch (e: any) { toast.error(e.message); } } break;
    }
  }, [contextMenu, selectedServer, fullPath, navigateToName, fetchFiles, toast]);

  const handleRename = useCallback(async () => {
    if (!renameTarget || !renameValue.trim() || !selectedServer) return;
    try { await api.renameFile(selectedServer, fullPath(renameTarget), fullPath(renameValue)); toast.success('Renamed'); setRenameTarget(null); fetchFiles(); }
    catch (e: any) { toast.error(e.message); }
  }, [renameTarget, renameValue, selectedServer, fullPath, fetchFiles, toast]);

  const handleCreate = useCallback(async () => {
    if (!newName.trim() || !selectedServer || !showCreate) return;
    try {
      if (showCreate === 'dir') await api.mkdir(selectedServer, fullPath(newName));
      else await api.executeCommand(selectedServer, `touch ${fullPath(newName)}`);
      toast.success('Created'); setNewName(''); setShowCreate(null); fetchFiles();
    } catch (e: any) { toast.error(e.message); }
  }, [newName, selectedServer, showCreate, fullPath, fetchFiles, toast]);

  // ===== Ghim thư mục =====
  //
  // Lưu ở SERVER theo từng VPS, không ở localStorage: ghim là thuộc tính của
  // máy chủ, nên nó phải theo người dùng sang trình duyệt và máy khác.
  const [pinning, setPinning] = useState(false);
  const pinnedPath = servers.find(sv => sv.id === selectedServer)?.pinnedPath ?? null;
  const isPinnedHere = !!pinnedPath && pinnedPath === files_normalize(currentPath);

  const togglePin = useCallback(async () => {
    if (!selectedServer) return;
    const target = isPinnedHere ? null : files_normalize(currentPathRef.current);
    setPinning(true);
    try {
      const r = await api.setPinnedPath(selectedServer, target);
      // Cập nhật tại chỗ, khỏi gọi lại cả danh sách server.
      setServers(prev =>
        prev.map(sv => (sv.id === selectedServer ? { ...sv, pinnedPath: r.pinnedPath } : sv))
      );
      toast.success(target ? `Đã ghim ${target}` : 'Đã bỏ ghim');
    } catch (e: any) {
      toast.error(e.message || 'Không ghim được');
    } finally {
      setPinning(false);
    }
  }, [selectedServer, isPinnedHere, toast]);

  const handlePathGo = useCallback(() => { if (pathInput.trim()) { fetchFiles(pathInput.trim()); setEditingPath(false); } }, [pathInput, fetchFiles]);

  // Server đã sắp xếp và đã lọc theo từ khoá rồi (xem fetchFiles/loadMore), nên
  // ở đây KHÔNG sort lại. Bản cũ sort toàn mảng ở client trong mỗi lần render —
  // với 50k file thì đó là một lần sort đầy đủ cho mỗi ký tự gõ vào ô tìm kiếm.
  //
  // Chỉ còn giữ rangeFilter (lọc theo khoảng số trong tên) vì nó là tính năng
  // riêng của UI này và luôn áp trên tập đã nạp.
  const sortedFiles = useMemo(() => {
    if (!rangeFilter) return files;
    return files.filter(f => {
      if (f.name === '..') return true;
      if (f.type === 'directory') return false;
      const m = f.name.match(/(\d+)/);
      if (!m) return false;
      const n = parseInt(m[1]);
      return n >= rangeFilter.min && n <= rangeFilter.max;
    });
  }, [files, rangeFilter]);

  // Đổi cột sắp xếp = nạp lại trang đầu từ server. Phải vậy vì server mới có
  // toàn bộ thư mục; sort trên 1000 dòng đã nạp sẽ cho thứ tự sai so với 50k.
  // ===== Virtual scrolling =====
  //
  // Bản cũ render MỌI dòng ra DOM. Thư mục chục nghìn file nghĩa là chục nghìn
  // <tr> cùng checkbox và icon — trình duyệt phải layout hết, nên vừa vào đã
  // treo. Ở đây chỉ dựng những dòng đang nhìn thấy (cộng một ít đệm), phần còn
  // lại thay bằng hai hàng spacer để thanh cuộn vẫn đúng chiều cao.
  const ROW_H = 37; // chiều cao thực đo của một <tr> ở cỡ chữ hiện tại
  const rowVirtualizer = useVirtualizer({
    count: sortedFiles.length,
    getScrollElement: () => listRef.current,
    estimateSize: () => ROW_H,
    overscan: 12,
  });
  const virtualRows = rowVirtualizer.getVirtualItems();
  const padTop = virtualRows.length ? virtualRows[0].start : 0;
  const padBottom = virtualRows.length
    ? rowVirtualizer.getTotalSize() - virtualRows[virtualRows.length - 1].end
    : 0;

  // Cuộn gần đáy -> nạp trang kế. Kiểm trên dòng ảo cuối nên không phụ thuộc
  // vào sự kiện scroll thô.
  useEffect(() => {
    const last = virtualRows[virtualRows.length - 1];
    if (!last) return;
    if (last.index >= sortedFiles.length - 50 && !loadedAll && !loadingMore && !rangeFilter) {
      void loadMore();
    }
  }, [virtualRows, sortedFiles.length, loadedAll, loadingMore, rangeFilter, loadMore]);

  const handleSort = useCallback((col: SortKey) => {
    if (sortBy === col) {
      setSortAsc(a => !a);
    } else {
      setSortBy(col);
      // Tên/kiểu thì a→z là tự nhiên; cỡ và ngày thì lớn/mới nhất trước.
      setSortAsc(col === 'name' || col === 'type');
    }
  }, [sortBy]);

  // sortBy/sortAsc đổi -> nạp lại. Bỏ lần chạy đầu vì fetchFiles đã làm rồi.
  const sortInitRef = useRef(true);
  useEffect(() => {
    if (sortInitRef.current) { sortInitRef.current = false; return; }
    if (selectedServer && currentPathRef.current) fetchFiles(currentPathRef.current);
    // fetchFiles phụ thuộc sortBy/sortAsc nên không đưa vào deps (sẽ lặp vô hạn).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sortBy, sortAsc]);

  // Tìm kiếm trong thư mục hiện tại: để SERVER lọc trên toàn bộ thư mục.
  // Bản cũ lọc trên mảng đã nạp, nên gõ từ khoá chỉ tìm được trong phần đã tải.
  const searchInitRef = useRef(true);
  useEffect(() => {
    if (searchInitRef.current) { searchInitRef.current = false; return; }
    if (!selectedServer) return;
    const q = searchQuery.trim();
    const t = setTimeout(async () => {
      setLoading(true);
      try {
        const page = await api.listFiles(selectedServer, {
          path: currentPathRef.current,
          offset: 0,
          limit: PAGE_SIZE,
          sort: sortBy,
          order: sortAsc ? 'asc' : 'desc',
          q: q || undefined,
        });
        setFiles(page.entries);
        setTotalEntries(page.total);
      } catch { /* giữ nguyên danh sách cũ */ }
      finally { setLoading(false); }
    }, 180);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchQuery]);

  // Tìm kiếm ĐỆ QUY cả subtree của thư mục đang đứng.
  const runRecursiveSearch = useCallback(async () => {
    const q = searchQuery.trim();
    if (!selectedServer || !q) { setSearchHits(null); return; }
    setSearching(true);
    try {
      const r = await api.searchFiles(selectedServer, currentPathRef.current, q, 500);
      setSearchHits(r.hits);
      setSearchSource(r.source);
      if (r.source === 'live') {
        // Chưa có index -> kết quả vẫn đúng nhưng chậm. Quét nền để lần sau nhanh.
        api.startIndex(selectedServer, currentPathRef.current).catch(() => {});
        setIndexState('running');
      }
    } catch (e: any) {
      toast.error(e.message || 'Tìm kiếm thất bại');
    } finally {
      setSearching(false);
    }
  }, [selectedServer, searchQuery, toast]);



  // Đếm trên phần ĐÃ NẠP. `totalEntries` mới là tổng thật của thư mục, và UI
  // hiện cả hai để không gây hiểu nhầm là thư mục chỉ có 1000 file.
  const { dirCount, fileCount, selectableCount } = useMemo(() => ({
    dirCount: files.filter(f => f.type === 'directory' && f.name !== '..').length,
    fileCount: files.filter(f => f.type !== 'directory').length,
    selectableCount: files.filter(f => f.name !== '..').length,
  }), [files]);

  const sortIcon = useCallback((col: string) => sortBy === col ? (sortAsc ? <Icons.chevronUp className='size-3' /> : <Icons.chevronDown className='size-3' />) : null, [sortBy, sortAsc]);

  return (
    // Cả trang là vùng thả, không chỉ riêng bảng danh sách: buông tay ở thanh
    // công cụ hay mép trang trước đây làm trình duyệt mở file thay vì tải lên.
    <div
      data-dropzone='files'
      className='relative flex flex-col gap-0 h-[calc(100vh_-_4rem)]'
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={handleDrop}
    >
      {dragging && (
        <div className='pointer-events-none absolute inset-2 z-[60] flex items-center justify-center rounded-xl border-2 border-dashed border-primary bg-primary/10 backdrop-blur-[1px]'>
          <div className='rounded-lg bg-background/90 px-6 py-4 text-center shadow-lg'>
            <Icons.upload className='mx-auto mb-2 size-10 text-primary' />
            <p className='text-sm font-medium text-primary'>Thả để tải lên</p>
            <p className='mt-0.5 font-mono text-xs text-muted-foreground'>{currentPath}</p>
          </div>
        </div>
      )}
      {/* Drag select rect */}
      {isDragSel && dragBox.w > 5 && dragBox.h > 5 && (
        <div className='fixed z-[9990] border-2 border-primary/60 bg-primary/10 rounded-sm pointer-events-none' style={{ left: dragBox.x, top: dragBox.y, width: dragBox.w, height: dragBox.h }} />
      )}

      {/* min-h-0 là bắt buộc: một flex item mặc định có min-height:auto, tức
          không co nhỏ hơn nội dung. Thiếu nó thì container danh sách bên dưới
          phình theo nội dung thay vì cuộn, và khi đó virtualizer thấy "viewport"
          cao bằng toàn bộ nội dung nên render HẾT mọi dòng — đúng cái nó sinh
          ra để tránh. */}
      <div className='flex flex-col h-full min-h-0 border-t'>
        {/* Folder tabs + server selector */}
        <div className='flex items-center border-b bg-muted/20 shrink-0'>
          <div className='flex items-center overflow-x-auto flex-1 px-1' style={{ WebkitOverflowScrolling: 'touch' }}>
            {tabs.map(tab => (
              <div key={tab.id}
                className={cn('flex items-center gap-1 px-3 py-2 text-xs shrink-0 border-b-2 cursor-pointer transition-colors group',
                  tab.id === activeTabId ? 'border-b-primary bg-background font-medium text-foreground' : 'border-b-transparent text-muted-foreground hover:text-foreground hover:bg-muted/30')}
                onClick={() => {
                  setActiveTabId(tab.id); activeTabIdRef.current = tab.id;
                  setCurrentPath(tab.path); currentPathRef.current = tab.path; setPathInput(tab.path);
                  if (tab.files && tab.files.length > 0) {
                    setFiles(tab.files);
                    setSelectedFiles(new Set()); setRenameTarget(null); setSearchQuery('');
                  } else {
                    fetchFiles(tab.path);
                  }
                }}>
                <Icons.folder className='size-3.5 text-amber-500' />
                <span className='max-w-[140px] truncate' title={tab.path}>{tab.label}</span>
                {tabs.length > 1 && (
                  <button className='ml-0.5 opacity-0 group-hover:opacity-100 hover:text-destructive' onClick={e => {
                    e.stopPropagation();
                    const newTabs = tabs.filter(t => t.id !== tab.id);
                    setTabs(newTabs);
                    if (activeTabId === tab.id && newTabs.length > 0) {
                      const last = newTabs[newTabs.length - 1];
                      setActiveTabId(last.id); activeTabIdRef.current = last.id;
                      setCurrentPath(last.path); currentPathRef.current = last.path; setPathInput(last.path);
                      if (last.files && last.files.length > 0) { setFiles(last.files); } else { fetchFiles(last.path); }
                    }
                  }}><Icons.close className='size-3' /></button>
                )}
              </div>
            ))}
            {/* Add new tab */}
            <button className='px-2 py-2 text-muted-foreground hover:text-foreground shrink-0' onClick={() => {
              const id = tabIdCounter.current++;
              const p = currentPathRef.current;
              setTabs(prev => [...prev, { id, path: p, label: p.split('/').pop() || '/', files: [...files] }]);
              setActiveTabId(id); activeTabIdRef.current = id;
            }}><Icons.add className='size-3.5' /></button>
          </div>
          {/* Server selector - right side */}
          <div className='px-2 border-l shrink-0'>
            <Select value={selectedServer} onValueChange={(v) => {
              setSelectedServer(v);
              const p = localStorage.getItem('files_path_' + v) || '/root';
              setCurrentPath(p); currentPathRef.current = p; setPathInput(p);
              setTabs([{ id: 1, path: p, label: p.split('/').pop() || '/', files: [] }]);
              firstTabIdRef.current = 1;
              setActiveTabId(1); activeTabIdRef.current = 1; tabIdCounter.current = 2;
              setFiles([]); setSelectedFiles(new Set());
            }}>
              <SelectTrigger className='h-7 text-[10px] w-auto gap-1 border-0 shadow-none px-2'>
                <Icons.server className='size-3 text-muted-foreground' />
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {servers.filter(s => s.status === 'ONLINE').map(s => (
                  <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {selectedServer && (
          <>
            {/* Breadcrumb path bar */}
            <div className='flex items-center gap-2 px-3 py-2 border-b shrink-0'>
              {editingPath ? (
                <div className='flex items-center gap-1 flex-1'>
                  <Input value={pathInput} onChange={e => setPathInput(e.target.value)}
                    onKeyDown={e => { if (e.nativeEvent.isComposing) return; if (e.key === 'Enter') handlePathGo(); if (e.key === 'Escape') setEditingPath(false); }}
                    className='h-8 text-xs font-mono flex-1' autoFocus />
                  <Button size='sm' className='h-8 text-xs' onClick={handlePathGo}>Go</Button>
                  <Button size='sm' variant='ghost' className='h-8' onClick={() => setEditingPath(false)}><Icons.close className='size-3.5' /></Button>
                </div>
              ) : (
                <>
                  <BreadcrumbPath path={currentPath} onNavigate={navigateTo} onEdit={() => setEditingPath(true)} />
                  <Button variant='outline' size='sm' className='h-8 w-8 p-0 shrink-0'
                    title='Làm mới' onClick={() => fetchFiles(undefined, { refresh: true })}>
                    <Icons.refresh className='size-3.5' />
                  </Button>
                  {/* Ghim thư mục: lần sau vào VPS này sẽ mở thẳng vào đây. */}
                  <Button
                    data-testid='pin-btn'
                    data-pinned={isPinnedHere ? 'true' : 'false'}
                    variant={isPinnedHere ? 'default' : 'outline'}
                    size='sm'
                    className='h-8 w-8 p-0 shrink-0'
                    disabled={pinning || !selectedServer}
                    title={
                      isPinnedHere
                        ? 'Bỏ ghim thư mục này'
                        : pinnedPath
                          ? `Ghim thư mục này (đang ghim ${pinnedPath})`
                          : 'Ghim thư mục này làm nơi mở mặc định cho VPS này'
                    }
                    onClick={togglePin}
                  >
                    {pinning
                      ? <Icons.spinner className='size-3.5 animate-spin' />
                      : isPinnedHere
                        ? <Icons.pinFilled className='size-3.5' />
                        : <Icons.pin className='size-3.5' />}
                  </Button>
                  {/* Hai cột: mở panel duyệt file trên máy bạn ở bên phải,
                      kéo sang trái là tải lên VPS. */}
                  <Button
                    data-testid='split-btn'
                    variant={splitOpen ? 'default' : 'outline'}
                    size='sm'
                    className='h-8 w-8 p-0 shrink-0'
                    title={splitOpen
                      ? 'Đóng panel máy local của tab này'
                      : 'Mở panel máy local cho tab này (mỗi tab có thư mục riêng)'}
                    onClick={() => setTabs(prev => prev.map(t =>
                      t.id === activeTabIdRef.current ? { ...t, split: !t.split } : t
                    ))}
                  >
                    <Icons.splitPane className='size-3.5' />
                  </Button>
                </>
              )}

              {rangeFilter && (
                <div className='flex items-center gap-1 bg-primary/10 border border-primary/30 text-primary rounded-md px-2 h-8 text-xs'>
                  <Icons.search className='size-3' />
                  <span>[{rangeFilter.min}–{rangeFilter.max}]</span>
                  <button onClick={() => setRangeFilter(null)} className='hover:text-destructive ml-1'>
                    <Icons.close className='size-3' />
                  </button>
                </div>
              )}
              {/* Tìm kiếm.
                  Gõ = server lọc trên TOÀN BỘ thư mục đang đứng (không chỉ phần
                  đã tải về như bản cũ). Enter hoặc nút = tìm đệ quy cả subtree,
                  dùng index nếu có, không thì chạy find trực tiếp. */}
              <div className='relative hidden md:flex items-center gap-1'>
                <div className='relative'>
                  <Icons.search className='absolute left-2 top-1/2 -translate-y-1/2 size-3 text-muted-foreground' />
                  <Input
                    placeholder='Tìm trong thư mục này…'
                    value={searchQuery}
                    onChange={e => { setSearchQuery(e.target.value); if (!e.target.value) setSearchHits(null); }}
                    onKeyDown={e => {
                      if (e.nativeEvent.isComposing) return; // để Telex gõ xong
                      if (e.key === 'Enter') { e.preventDefault(); void runRecursiveSearch(); }
                      if (e.key === 'Escape') { setSearchQuery(''); setSearchHits(null); }
                    }}
                    className='h-8 text-xs pl-7 w-44'
                  />
                </div>
                <Button
                  size='sm' variant={searchHits ? 'default' : 'outline'}
                  className='h-8 px-2 text-[10px] gap-1'
                  disabled={!searchQuery.trim() || searching}
                  onClick={() => (searchHits ? setSearchHits(null) : void runRecursiveSearch())}
                  title='Tìm đệ quy trong mọi thư mục con'
                >
                  {searching
                    ? <Icons.spinner className='size-3 animate-spin' />
                    : <Icons.search className='size-3' />}
                  {searchHits ? 'Thoát' : 'Đệ quy'}
                </Button>
              </div>
            </div>

            {/* Dải kết quả tìm đệ quy */}
            {searchHits && (
              <div className='border-b bg-muted/30 shrink-0 max-h-64 overflow-y-auto'>
                <div className='flex items-center justify-between px-3 py-1.5 text-[11px] text-muted-foreground sticky top-0 bg-muted/90 backdrop-blur'>
                  <span>
                    {searchHits.length} kết quả trong <span className='font-mono'>{currentPath}</span> và thư mục con
                    {searchSource === 'live' && ' — quét trực tiếp, đang dựng index để lần sau nhanh hơn'}
                    {searchSource === 'index' && ' — từ index'}
                  </span>
                  <button className='hover:text-foreground' onClick={() => setSearchHits(null)}>Đóng</button>
                </div>
                {searchHits.length === 0 ? (
                  <div className='px-3 py-6 text-center text-xs text-muted-foreground'>Không tìm thấy</div>
                ) : searchHits.map(h => (
                  <button
                    key={h.path}
                    className='flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-accent'
                    onClick={() => {
                      // Thư mục thì đi vào; file thì mở thư mục cha và chọn nó.
                      if (h.type === 'directory') fetchFiles(h.path);
                      else { fetchFiles(h.parent); setSelectedFiles(new Set([h.name])); }
                      setSearchHits(null);
                    }}
                  >
                    {h.type === 'directory'
                      ? <Icons.folder className='size-3.5 shrink-0 text-amber-500' />
                      : <Icons.page className='size-3.5 shrink-0 text-muted-foreground' />}
                    <span className='truncate'>{h.name}</span>
                    <span className='ml-auto truncate pl-3 font-mono text-[10px] text-muted-foreground'>{h.parent}</span>
                  </button>
                ))}
              </div>
            )}

            {/* Toolbar */}
            <div className='flex items-center justify-between px-3 py-1.5 border-b bg-card shrink-0'>
              <div className='flex items-center gap-1.5'>
                <input ref={fileInputRef} type='file' className='hidden' onChange={handleFileUpload} multiple />
                <FileOperations onAction={handleCtxAction} />
                {selectedFiles.size > 0 && (
                  <Button variant='destructive' size='sm' className='h-8 text-xs' onClick={deleteSelected}>
                    <Icons.trash className='size-3 mr-1' />Delete ({selectedFiles.size})
                  </Button>
                )}
                {/* Max# */}
                <Button variant='outline' size='sm' className='h-8 text-xs' onClick={() => {
                  const nums = files.filter(f => f.name !== '..' ).map(f => {
                    const match = f.name.match(/(\d+)/);
                    return match ? { name: f.name, num: parseInt(match[1]) } : null;
                  }).filter(Boolean) as { name: string; num: number }[];
                  if (nums.length === 0) { toast.info('No numbered files'); return; }
                  const max = nums.reduce((a, b) => a.num > b.num ? a : b);
                  toast.info(`Max: ${max.name} (${max.num})`);
                  setSelectedFiles(new Set([max.name]));
                }}><Icons.trendingUp className='size-3 mr-1' />Max#</Button>
              <Button variant='outline' size='sm' className='h-8 text-xs' onClick={() => setShowRange(true)}>
                <Icons.search className='size-3 mr-1' />Range
              </Button>
              <Button variant='outline' size='sm' className='h-8 text-xs' onClick={() => fetchFiles('/mnt')}>/mnt</Button>
              <Button variant='outline' size='sm' className='h-8 text-xs' onClick={() => fetchFiles('/www')}>/www</Button>
              </div>
            </div>

            {/* Create input */}
            {showCreate && (
              <div className='flex items-center gap-1.5 px-3 py-2 border-b bg-muted/5 shrink-0'>
                {showCreate === 'dir' ? <Icons.folder className='size-4 text-amber-500' /> : <Icons.page className='size-4 text-muted-foreground' />}
                <Input placeholder={showCreate === 'dir' ? 'Folder name' : 'File name'} value={newName} onChange={e => setNewName(e.target.value)}
                  onKeyDown={e => { if (e.nativeEvent.isComposing) return; if (e.key === 'Enter') handleCreate(); if (e.key === 'Escape') { setShowCreate(null); setNewName(''); } }}
                  className='h-8 text-sm flex-1 max-w-xs' autoFocus />
                <Button size='sm' className='h-8' onClick={handleCreate}>Tạo</Button>
                <Button size='sm' variant='ghost' className='h-8' onClick={() => { setShowCreate(null); setNewName(''); }}>Huỷ</Button>
              </div>
            )}

            {/* Hàng ngang: trái = VPS, phải = máy local (khi bật hai cột) */}
            <div className='flex min-h-0 flex-1'>

            {/* File table (VPS) */}
            <div ref={listRef} className='flex-1 min-h-0 overflow-y-auto select-none'
              onMouseDown={onMouseDown}
              onContextMenu={e => { e.preventDefault(); setContextMenu({ x: e.clientX, y: e.clientY, file: null }); }}>

              {loading ? (
                <div className='flex justify-center py-16'><Icons.spinner className='size-8 animate-spin text-muted-foreground' /></div>
              ) : (
                <table className='w-full text-sm'>
                  <thead className='bg-muted/50 sticky top-0 z-10'>
                    <tr className='border-b text-xs text-muted-foreground'>
                      <th className='w-10 px-2 py-2 text-center'>
                        <input type='checkbox' checked={selectedFiles.size === selectableCount && selectableCount > 0}
                          onChange={selectAll} className='size-3.5 accent-primary cursor-pointer' />
                      </th>
                      <th className='text-left py-2 px-2 cursor-pointer hover:text-foreground' onClick={() => handleSort('name')}>
                        <span className='flex items-center gap-1'>File Name {sortIcon('name')}</span>
                      </th>
                      <th className='text-left py-2 px-2 hidden lg:table-cell w-24'>Quyền</th>
                      <th className='text-left py-2 px-2 cursor-pointer hover:text-foreground w-20 hidden md:table-cell' onClick={() => handleSort('size')}>
                        <span className='flex items-center gap-1'>Size {sortIcon('size')}</span>
                      </th>
                      <th className='text-left py-2 px-2 cursor-pointer hover:text-foreground w-36 hidden md:table-cell' onClick={() => handleSort('mtime')}>
                        <span className='flex items-center gap-1'>Modified {sortIcon('mtime')}</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {padTop > 0 && <tr style={{ height: padTop }} aria-hidden />}
                    {virtualRows.map(vr => {
                      const i = vr.index;
                      const file = sortedFiles[i];
                      if (!file) return null;
                      const sel = selectedFiles.has(file.name);
                      const canCheck = file.name !== '..';
                      const ext = getExt(file.name);
                      return (
                        <tr key={file.name} data-index={i} data-name={file.name}
                          style={{ height: ROW_H }}
                          className={cn('file-row border-b cursor-pointer transition-colors',
                            sel ? 'bg-primary/10 hover:bg-primary/15' : 'hover:bg-muted/30')}
                          onClick={() => handleFileClick(file)}
                          onContextMenu={e => { if (canCheck) { e.preventDefault(); e.stopPropagation(); setContextMenu({ x: e.clientX, y: e.clientY, file }); }}}>
                          <td className='w-10 px-2 py-2 text-center'>
                            {canCheck ? <input type='checkbox' checked={sel} onChange={() => toggleSelect(file.name)}
                              onClick={e => e.stopPropagation()} className='size-3.5 accent-primary cursor-pointer' /> : null}
                          </td>
                          <td className='py-2 px-2'>
                            {renameTarget === file.name ? (
                              <div className='flex items-center gap-1' onClick={e => e.stopPropagation()}>
                                <Input value={renameValue} onChange={e => setRenameValue(e.target.value)}
                                  onKeyDown={e => { if (e.nativeEvent.isComposing) return; if (e.key === 'Enter') handleRename(); if (e.key === 'Escape') setRenameTarget(null); }}
                                  className='h-7 text-xs' autoFocus />
                                <Button size='sm' className='h-7 text-xs' onClick={handleRename}>OK</Button>
                              </div>
                            ) : (
                              <div className='flex items-center gap-2'>
                                {file.type === 'directory' ? <Icons.folder className='size-4 text-amber-500 shrink-0' />
                                  : isImage(file.name) ? <Icons.eye className='size-4 text-pink-500 shrink-0' />
                                  : isVideo(file.name) ? <Icons.play className='size-4 text-blue-500 shrink-0' />
                                  : <Icons.page className='size-4 text-muted-foreground shrink-0' />}
                                <span className={cn('truncate text-xs md:text-sm hover:text-primary', sel && 'text-primary font-medium')}>{file.name}</span>
                                <span className='text-[10px] text-muted-foreground md:hidden'>{file.type !== 'directory' ? formatBytes(file.size) : ''}</span>
                              </div>
                            )}
                          </td>
                          <td className='py-2 px-2 text-xs text-muted-foreground hidden lg:table-cell font-mono'>{file.permissions}</td>
                          <td className='py-2 px-2 text-xs text-muted-foreground hidden md:table-cell'>{file.type === 'directory' ? '-' : formatBytes(file.size)}</td>
                          <td className='py-2 px-2 text-xs text-muted-foreground hidden md:table-cell'>{formatMtime(file.mtime)}</td>
                        </tr>
                      );
                    })}
                    {padBottom > 0 && <tr style={{ height: padBottom }} aria-hidden />}
                  </tbody>
                </table>
              )}
              {!loading && sortedFiles.length === 0 && (
                <div className='text-center py-16 text-muted-foreground text-sm'>{searchQuery ? 'Không có kết quả' : 'Thư mục trống'}</div>
              )}

              {/* Chân danh sách: nói rõ đang xem bao nhiêu trên tổng bao nhiêu.
                  Không có dòng này, người dùng sẽ tưởng thư mục chỉ có 1000 file. */}
              {!loading && sortedFiles.length > 0 && (
                <div className='flex items-center justify-center gap-2 border-t py-3 text-[11px] text-muted-foreground'>
                  {loadingMore ? (
                    <>
                      <Icons.spinner className='size-3 animate-spin' />
                      Đang nạp thêm…
                    </>
                  ) : loadedAll ? (
                    <span>
                      Đã hiện tất cả {totalEntries.toLocaleString('vi-VN')} mục
                    </span>
                  ) : (
                    <>
                      <span>
                        {files.length.toLocaleString('vi-VN')} / {totalEntries.toLocaleString('vi-VN')} mục
                      </span>
                      <Button size='sm' variant='ghost' className='h-6 px-2 text-[11px]' onClick={() => void loadMore()}>
                        Nạp thêm {Math.min(PAGE_SIZE, totalEntries - files.length).toLocaleString('vi-VN')}
                      </Button>
                    </>
                  )}
                  {indexState === 'running' && (
                    <span className='ml-2 flex items-center gap-1 text-primary'>
                      <Icons.spinner className='size-3 animate-spin' />
                      đang index để tìm kiếm đệ quy
                    </span>
                  )}
                </div>
              )}
            </div>

            {/* Panel máy local — kéo từ đây sang trái là tải lên VPS */}
            {/* Container hiện khi CÓ BẤT KỲ tab nào mở panel, và chỉ bị ẩn đi
                khi tab đang xem không mở. Nếu đặt điều kiện theo tab đang xem
                thì chuyển sang tab chưa mở split sẽ unmount cả cột, xoá sạch
                thư mục đang đứng của những tab kia. */}
            {splitTabs.length > 0 && (
              <div
                className='flex w-[42%] min-w-[320px] shrink-0 flex-col border-l bg-muted/10'
                style={{ display: splitOpen ? undefined : 'none' }}
              >
                <div className='flex shrink-0 items-center justify-between border-b bg-muted/30 px-2 py-1.5'>
                  <span className='flex items-center gap-1.5 text-xs font-semibold'>
                    <Icons.folder className='size-3.5 text-primary' />
                    Máy của bạn
                  </span>
                  <span className='text-[10px] text-muted-foreground'>
                    Kéo sang trái để tải lên
                  </span>
                </div>
                {/* Giữ MỌI panel đã mở trong DOM, chỉ ẩn cái của tab khác.
                    Unmount rồi mount lại sẽ mất thư mục đang đứng và lựa chọn
                    của tab đó. */}
                {splitTabs.map(t => (
                  <div
                    key={t.id}
                    data-split-tab={t.id}
                    className='min-h-0 flex-1'
                    style={{ display: t.id === activeTabId ? undefined : 'none' }}
                  >
                    <LocalPane
                      busy={!selectedServer}
                      autoRestore={firstTabIdRef.current === t.id}
                      onUpload={(fs) => void uploadMany(fs)}
                      onDragFiles={(fs) => { localDragFiles.current = fs; }}
                    />
                  </div>
                ))}
              </div>
            )}

            </div>

            {/* Footer */}
            <div className='flex items-center justify-between px-3 py-1.5 border-t bg-muted/20 text-xs text-muted-foreground shrink-0'>
              {/* dirCount/fileCount chỉ đếm trên phần ĐÃ NẠP. Khi thư mục còn
                  trang chưa tải, phải nói rõ tổng thật, bằng không dòng này
                  báo "999 files" cho một thư mục 4.972 file. */}
              <span>
                {loadedAll
                  ? `${dirCount} thư mục, ${fileCount} file`
                  : `${dirCount} thư mục, ${fileCount} file đã nạp / ${totalEntries.toLocaleString('vi-VN')} tổng`}
                {selectedFiles.size > 0 ? ` · chọn ${selectedFiles.size}` : ''}
              </span>
              <span className='font-mono text-[10px]'>{currentPath}</span>
            </div>
          </>
        )}
      </div>

      {/* Popups */}
      {contextMenu && <CtxMenu x={contextMenu.x} y={contextMenu.y} file={contextMenu.file} onAction={handleCtxAction} onClose={() => setContextMenu(null)} />}
      {editorPath && selectedServer && <FileEditorPopup serverId={selectedServer} initialPath={editorPath} rootDir={editorRootDir} onClose={() => { setEditorPath(null); fetchFiles(); }} />}
      {/* Range filter dialog */}
      {showRange && (
        <div className='fixed inset-0 z-[99998] flex items-center justify-center'>
          <div className='absolute inset-0 bg-black/40 backdrop-blur-[2px]' onClick={() => setShowRange(false)} />
          <div className='relative bg-card text-card-foreground border rounded-xl shadow-2xl w-full max-w-md mx-4 animate-in fade-in-0 zoom-in-95'>
            <div className='flex items-center justify-between px-5 py-3 border-b'>
              <h3 className='font-semibold text-sm'>Find files in numeric range</h3>
              <button onClick={() => setShowRange(false)} className='text-muted-foreground hover:text-foreground'>
                <Icons.close className='size-5' />
              </button>
            </div>
            <div className='p-5 space-y-3'>
              <p className='text-xs text-muted-foreground'>Enter 2 numbers. All files with numeric name in this range will be selected.</p>
              <div className='grid grid-cols-2 gap-3'>
                <div>
                  <Label className='text-xs'>Từ</Label>
                  <Input type='number' value={rangeMin} onChange={e => setRangeMin(e.target.value)} placeholder='1' className='h-8' autoFocus />
                </div>
                <div>
                  <Label className='text-xs'>To</Label>
                  <Input type='number' value={rangeMax} onChange={e => setRangeMax(e.target.value)} placeholder='100' className='h-8' />
                </div>
              </div>
            </div>
            <div className='flex items-center justify-end gap-2 px-5 py-3 border-t bg-muted/30 rounded-b-xl'>
              <button onClick={() => setShowRange(false)} className='px-4 py-1.5 text-sm rounded-md border hover:bg-muted transition-colors'>Huỷ</button>
              <button onClick={() => {
                const min = parseInt(rangeMin); const max = parseInt(rangeMax);
                if (isNaN(min) || isNaN(max)) { toast.error('Enter valid numbers'); return; }
                const lo = Math.min(min, max); const hi = Math.max(min, max);
                setRangeFilter({ min: lo, max: hi });
                const matches = files.filter(f => {
                  if (f.name === '..' || f.type === 'directory') return false;
                  const m = f.name.match(/(\d+)/);
                  if (!m) return false;
                  const n = parseInt(m[1]);
                  return n >= lo && n <= hi;
                });
                if (matches.length === 0) { toast.info('No files in range [' + lo + '-' + hi + ']'); setShowRange(false); return; }
                setSelectedFiles(new Set(matches.map(f => f.name)));
                toast.success('Showing ' + matches.length + ' file(s) in [' + lo + '-' + hi + ']');
                setShowRange(false);
              }} className='px-4 py-1.5 text-sm rounded-md bg-primary text-primary-foreground hover:bg-primary/90 font-medium'>
                Find & Select
              </button>
            </div>
          </div>
        </div>
      )}

      {showTerminal && selectedServer && <TerminalPopup serverId={selectedServer} cwd={currentPathRef.current} onClose={() => setShowTerminal(false)} />}
      {previewMedia && selectedServer && <MediaPreview serverId={selectedServer} path={previewMedia.path} type={previewMedia.type} files={files} currentPath={currentPath} onClose={() => setPreviewMedia(null)} />}
    </div>
  );
}
