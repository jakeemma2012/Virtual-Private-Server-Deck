'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Icons } from '@/components/icons';
import { formatBytes, cn } from '@/lib/utils';
import {
  type LocalEntry,
  type LocalTree,
  ensureReadable,
  filesOf,
  fsaUnavailableReason,
  isLocalFsSupported,
  loadRootHandle,
  naturalCmp,
  pickDirectory,
  treeFromFileList,
  treeFromHandle,
} from '@/lib/local-fs';

/** Kiểu dữ liệu đặt vào dataTransfer khi kéo từ panel local sang panel VPS. */
export const LOCAL_DRAG_TYPE = 'application/x-jake-local';

const fmtTime = (t: number) => {
  if (!t) return '';
  const d = new Date(t * 1000);
  const diff = Date.now() - d.getTime();
  if (diff >= 0 && diff < 86_400_000) {
    return d.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: '2-digit' });
};

export function LocalPane({
  onUpload,
  onDragFiles,
  busy,
  autoRestore = false,
}: {
  /** Gửi các file đã chọn lên VPS (nút mũi tên). */
  onUpload: (files: File[]) => void;
  /** Đăng ký các file đang được kéo, để panel VPS lấy khi thả. */
  onDragFiles: (files: File[] | null) => void;
  busy?: boolean;
  /**
   * Có tự mở lại thư mục đã nhớ từ lần trước không.
   *
   * Chỉ bật cho tab ĐẦU TIÊN. Nếu mọi tab đều tự khôi phục thì mở tab mới sẽ
   * thấy đúng thư mục của tab cũ — mà mục đích của việc tách theo tab là để
   * mỗi tab có một thư mục riêng.
   */
  autoRestore?: boolean;
}) {
  const [tree, setTree] = useState<LocalTree | null>(null);
  const [parts, setParts] = useState<string[]>([]);
  const [entries, setEntries] = useState<LocalEntry[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  // Thiếu File System Access API KHÔNG chặn tính năng — chỉ mất khả năng nhớ
  // thư mục giữa các lần mở trang. Brave tắt sẵn API này.
  const fsaNote = useMemo(() => fsaUnavailableReason(), []);
  const hasFsa = useMemo(() => isLocalFsSupported(), []);
  const lastClicked = useRef<number | null>(null);
  const dirInputRef = useRef<HTMLInputElement>(null);

  // Khôi phục thư mục đã chọn lần trước. Không tự hỏi quyền ở đây: trình duyệt
  // chỉ cho hỏi khi có thao tác của người dùng, hỏi lúc mount sẽ bị chặn.
  useEffect(() => {
    if (!hasFsa || !autoRestore) return;
    void (async () => {
      const h = await loadRootHandle();
      if (h && (await ensureReadable(h, false))) setTree(treeFromHandle(h));
    })();
  }, [hasFsa, autoRestore]);

  const load = useCallback(async (t: LocalTree, p: string[]) => {
    setLoading(true);
    setErr(null);
    try {
      setEntries(await t.list(p));
      setSelected(new Set());
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'không đọc được thư mục');
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (tree) void load(tree, parts);
  }, [tree, parts, load]);

  /** Mở thư mục: ưu tiên API đầy đủ, không có thì dùng <input webkitdirectory>. */
  const choose = async () => {
    if (hasFsa) {
      const h = await pickDirectory();
      if (h) {
        setTree(treeFromHandle(h));
        setParts([]);
      }
      return;
    }
    dirInputRef.current?.click();
  };

  const onDirInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const t = e.target.files ? treeFromFileList(e.target.files) : null;
    if (t) {
      setTree(t);
      setParts([]);
    }
    // Cho phép chọn lại đúng thư mục đó lần nữa.
    e.target.value = '';
  };

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return q ? entries.filter((e) => e.name.toLowerCase().includes(q)) : entries;
  }, [entries, filter]);

  const selectedEntries = useMemo(
    () => shown.filter((e) => e.kind === 'file' && selected.has(e.name)),
    [shown, selected]
  );

  const toggle = (name: string, index: number, shift: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (shift && lastClicked.current !== null) {
        const [a, b] = [lastClicked.current, index].sort((x, y) => x - y);
        for (let i = a; i <= b; i++) {
          if (shown[i]?.kind === 'file') next.add(shown[i].name);
        }
      } else if (next.has(name)) {
        next.delete(name);
      } else {
        next.add(name);
      }
      return next;
    });
    lastClicked.current = index;
  };

  const startDrag = async (e: React.DragEvent, entry: LocalEntry) => {
    // Kéo một file chưa được chọn thì coi như chỉ kéo mỗi file đó.
    const batch = selected.has(entry.name) && selectedEntries.length > 0
      ? selectedEntries
      : [entry].filter((x) => x.kind === 'file');
    if (batch.length === 0) {
      e.preventDefault();
      return;
    }
    e.dataTransfer.effectAllowed = 'copy';
    // Đánh dấu để panel VPS nhận ra đây là kéo nội bộ, không phải kéo từ OS.
    e.dataTransfer.setData(LOCAL_DRAG_TYPE, String(batch.length));
    e.dataTransfer.setData('text/plain', batch.map((b) => b.name).join('\n'));
    // Đọc File() bất đồng bộ nên không kịp nhét vào dataTransfer; đẩy qua ref
    // của trang cha thay thế.
    onDragFiles(await filesOf(batch));
  };

  const uploadSelected = async () => {
    if (selectedEntries.length === 0) return;
    onUpload(await filesOf(selectedEntries));
  };

  // Input ẩn cho đường dự phòng: chạy ở MỌI trình duyệt, kể cả Brave.
  const dirInput = (
    <input
      ref={dirInputRef}
      type='file'
      className='hidden'
      multiple
      // @ts-expect-error: thuộc tính không chuẩn nhưng mọi trình duyệt đều hiểu
      webkitdirectory=''
      directory=''
      onChange={onDirInput}
    />
  );

  // ------------------------------------------------------- chưa chọn thư mục
  if (!tree) {
    return (
      <div className='flex h-full flex-col items-center justify-center gap-3 p-6 text-center'>
        {dirInput}
        <Icons.folder className='size-10 text-primary' />
        <p className='max-w-xs text-xs text-muted-foreground'>
          Chọn một thư mục trên máy bạn. Sau đó duyệt tự do bên trong nó và kéo
          file sang trái để tải lên VPS.
        </p>
        <p className='max-w-xs text-[11px] text-muted-foreground/70'>
          Trình duyệt không cho trang web tự gõ đường dẫn — phải chọn qua hộp
          thoại của hệ điều hành ít nhất một lần.
        </p>
        <Button size='sm' onClick={choose}>
          <Icons.folder className='mr-1.5 size-3.5' />
          Chọn thư mục
        </Button>
        {fsaNote && (
          <p className='max-w-xs text-[11px] leading-relaxed text-amber-600 dark:text-amber-500'>
            {fsaNote}
          </p>
        )}
      </div>
    );
  }

  const crumbs = [tree.rootName, ...parts];

  return (
    <div className='flex h-full min-h-0 flex-col'>
      {dirInput}
      {/* Thanh đường dẫn */}
      <div className='flex shrink-0 items-center gap-1 border-b px-2 py-1.5'>
        <Button
          variant='ghost' size='sm' className='h-7 w-7 shrink-0 p-0'
          disabled={parts.length === 0}
          title='Lên thư mục cha'
          onClick={() => setParts((p) => p.slice(0, -1))}
        >
          <Icons.chevronLeft className='size-3.5' />
        </Button>
        <div className='flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto text-xs'>
          {crumbs.map((c, i) => (
            <span key={i} className='flex shrink-0 items-center'>
              {i > 0 && <Icons.chevronRight className='size-3 text-muted-foreground' />}
              <button
                className={cn(
                  'rounded px-1 py-0.5 hover:bg-accent',
                  i === crumbs.length - 1 && 'font-medium text-foreground'
                )}
                onClick={() => setParts(parts.slice(0, i))}
              >
                {c}
              </button>
            </span>
          ))}
        </div>
        <Button
          variant='ghost' size='sm' className='h-7 w-7 shrink-0 p-0'
          title='Đổi thư mục gốc' onClick={choose}
        >
          <Icons.folder className='size-3.5' />
        </Button>
        <Button
          variant='ghost' size='sm' className='h-7 w-7 shrink-0 p-0'
          title='Làm mới' onClick={() => void load(tree, parts)}
        >
          <Icons.refresh className='size-3.5' />
        </Button>
      </div>

      {/* Lọc + nút tải lên */}
      <div className='flex shrink-0 items-center gap-1.5 border-b px-2 py-1.5'>
        <div className='relative flex-1'>
          <Icons.search className='absolute left-2 top-1/2 size-3 -translate-y-1/2 text-muted-foreground' />
          <Input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder='Lọc trong thư mục này…'
            className='h-7 pl-7 text-xs'
          />
        </div>
        <Button
          size='sm' className='h-7 shrink-0 gap-1 text-xs'
          disabled={selectedEntries.length === 0 || busy}
          title='Tải các file đã chọn lên VPS'
          onClick={uploadSelected}
        >
          <Icons.chevronLeft className='size-3.5' />
          Tải lên {selectedEntries.length > 0 && `(${selectedEntries.length})`}
        </Button>
      </div>

      {/* Danh sách */}
      <div className='min-h-0 flex-1 overflow-y-auto'>
        {loading ? (
          <div className='flex justify-center py-10'>
            <Icons.spinner className='size-6 animate-spin text-muted-foreground' />
          </div>
        ) : err ? (
          <div className='px-3 py-8 text-center text-xs text-destructive'>{err}</div>
        ) : shown.length === 0 ? (
          <div className='px-3 py-8 text-center text-xs text-muted-foreground'>
            {filter ? 'Không có kết quả' : 'Thư mục trống'}
          </div>
        ) : (
          <table className='w-full text-xs'>
            <tbody>
              {shown.map((e, i) => {
                const sel = selected.has(e.name);
                return (
                  <tr
                    key={e.name}
                    data-local-name={e.name}
                    draggable={e.kind === 'file'}
                    onDragStart={(ev) => void startDrag(ev, e)}
                    onDragEnd={() => onDragFiles(null)}
                    onClick={(ev) => {
                      if (e.kind === 'directory') setParts((p) => [...p, e.name]);
                      else toggle(e.name, i, ev.shiftKey);
                    }}
                    className={cn(
                      'cursor-pointer border-b transition-colors',
                      sel ? 'bg-primary/10 hover:bg-primary/15' : 'hover:bg-muted/30'
                    )}
                  >
                    <td className='w-7 px-2 py-1.5 text-center'>
                      {e.kind === 'file' && (
                        <input
                          type='checkbox' checked={sel} readOnly
                          className='size-3 cursor-pointer accent-primary'
                        />
                      )}
                    </td>
                    <td className='py-1.5 pr-2'>
                      <div className='flex items-center gap-1.5'>
                        {e.kind === 'directory' ? (
                          <Icons.folder className='size-3.5 shrink-0 text-amber-500' />
                        ) : (
                          <Icons.page className='size-3.5 shrink-0 text-muted-foreground' />
                        )}
                        <span className={cn('truncate', sel && 'font-medium text-primary')}>
                          {e.name}
                        </span>
                      </div>
                    </td>
                    <td className='w-16 py-1.5 pr-2 text-right text-muted-foreground'>
                      {e.kind === 'directory' ? '-' : formatBytes(e.size)}
                    </td>
                    <td className='hidden w-20 py-1.5 pr-2 text-muted-foreground lg:table-cell'>
                      {fmtTime(e.mtime)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <div className='shrink-0 border-t px-2 py-1 text-[11px] text-muted-foreground'>
        {entries.filter((e) => e.kind === 'directory').length} thư mục,{' '}
        {entries.filter((e) => e.kind === 'file').length} file
        {selectedEntries.length > 0 && ` · chọn ${selectedEntries.length}`}
      </div>
    </div>
  );
}

export { naturalCmp };
