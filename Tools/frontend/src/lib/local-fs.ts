'use client';

/**
 * Duyệt thư mục trên MÁY của người dùng, bằng File System Access API.
 *
 * Vì sao không cho gõ đường dẫn như FileZilla: trình duyệt cố tình cấm. Nếu
 * một trang web gõ được `/Users/...` rồi đọc, thì mọi trang web đều đọc được
 * ổ đĩa của bạn. Cách duy nhất là người dùng tự chọn thư mục gốc qua hộp thoại
 * của hệ điều hành; sau đó trang được quyền duyệt **tự do bên trong** cây đó.
 *
 * Quyền được ghi nhớ qua IndexedDB (handle serialize được), nên chọn một lần
 * là lần sau mở lại vẫn còn — chỉ cần bấm xác nhận lại nếu trình duyệt hỏi.
 *
 * Yêu cầu secure context: HTTPS, hoặc localhost. Chạy qua HTTP ở IP thật thì
 * `window.showDirectoryPicker` không tồn tại.
 */

// lib.dom của TypeScript chưa khai báo showDirectoryPicker (API còn mới và
// chỉ có ở Chromium). Khai báo tối thiểu ở đây thay vì rải `as any`.
declare global {
  interface Window {
    showDirectoryPicker?: (opts?: {
      mode?: 'read' | 'readwrite';
      startIn?: string;
      id?: string;
    }) => Promise<FileSystemDirectoryHandle>;
  }
}

export interface LocalEntry {
  name: string;
  kind: 'directory' | 'file';
  size: number;
  /** Epoch giây, 0 với thư mục (không API nào cho biết mtime của thư mục). */
  mtime: number;
  /** Có khi dùng File System Access API. */
  handle?: FileSystemHandle;
  /** Có khi dùng đường dự phòng <input webkitdirectory>. */
  file?: File;
}

/**
 * Nguồn file local. Hai hiện thực:
 *
 * - `showDirectoryPicker` (Chrome, Edge): đọc lười từng thư mục, nhớ được
 *   quyền giữa các lần mở trang.
 * - `<input webkitdirectory>` (chạy ở MỌI trình duyệt, kể cả Brave): trình
 *   duyệt đưa sẵn danh sách phẳng toàn bộ cây, ta dựng lại thành cây trong RAM.
 *   Chỉ metadata được đọc trước; nội dung file vẫn đọc lười khi upload.
 */
export interface LocalTree {
  rootName: string;
  list: (parts: string[]) => Promise<LocalEntry[]>;
  /** true nếu đây là đường dự phòng (không nhớ được giữa các lần mở trang). */
  transient: boolean;
}

export const isLocalFsSupported = () =>
  typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function';

/** Vì sao không dùng được, để hiện đúng thông báo cho người dùng. */
/**
 * Vì sao `showDirectoryPicker` không dùng được. Trả `null` khi dùng được.
 *
 * Đây chỉ là thông tin để hiển thị: thiếu API này KHÔNG chặn tính năng, vì
 * `<input webkitdirectory>` vẫn chạy (xem `treeFromFileList`).
 */
export function fsaUnavailableReason(): string | null {
  if (typeof window === 'undefined') return null;
  if (typeof window.showDirectoryPicker === 'function') return null;
  if (!window.isSecureContext) {
    return 'Trang đang chạy HTTP nên trình duyệt khoá API duyệt thư mục. '
      + 'Bật TLS (JAKE_TLS_CERT/JAKE_TLS_KEY) rồi vào bằng https:// để có bản đầy đủ.';
  }
  if (isBrave()) {
    return 'Brave tắt sẵn File System Access API để chống fingerprinting. '
      + 'Bật ở brave://flags/#file-system-access-api nếu muốn bản đầy đủ '
      + '(nhớ thư mục giữa các lần mở trang).';
  }
  return 'Trình duyệt này không có File System Access API '
    + '(Firefox, Safari chưa hỗ trợ).';
}

/** Brave phơi `navigator.brave.isBrave`. Chỉ dùng để hiện thông báo đúng. */
function isBrave(): boolean {
  const n = navigator as Navigator & { brave?: { isBrave?: () => Promise<boolean> } };
  return typeof n.brave?.isBrave === 'function';
}

// ---------------------------------------------------------------------------
// Ghi nhớ thư mục đã chọn giữa các lần mở trang
// ---------------------------------------------------------------------------

const DB = 'jake-local-fs';
const STORE = 'handles';
const KEY = 'root';

function withStore<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T | null> {
  return new Promise((resolve) => {
    let open: IDBOpenDBRequest;
    try {
      open = indexedDB.open(DB, 1);
    } catch {
      resolve(null);
      return;
    }
    open.onupgradeneeded = () => open.result.createObjectStore(STORE);
    open.onerror = () => resolve(null);
    open.onsuccess = () => {
      const db = open.result;
      try {
        const req = fn(db.transaction(STORE, mode).objectStore(STORE));
        req.onsuccess = () => resolve(req.result ?? null);
        req.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    };
  });
}

export const saveRootHandle = (h: FileSystemDirectoryHandle) =>
  withStore('readwrite', (s) => s.put(h, KEY) as IDBRequest<unknown>) as Promise<unknown>;

export const loadRootHandle = () =>
  withStore<FileSystemDirectoryHandle>('readonly', (s) => s.get(KEY));

export const clearRootHandle = () =>
  withStore('readwrite', (s) => s.delete(KEY) as IDBRequest<unknown>) as Promise<unknown>;

/** Quyền đọc còn hiệu lực không; `prompt` = hỏi lại người dùng nếu cần. */
export async function ensureReadable(
  handle: FileSystemDirectoryHandle,
  prompt: boolean
): Promise<boolean> {
  const h = handle as FileSystemDirectoryHandle & {
    queryPermission?: (d: { mode: string }) => Promise<PermissionState>;
    requestPermission?: (d: { mode: string }) => Promise<PermissionState>;
  };
  try {
    if ((await h.queryPermission?.({ mode: 'read' })) === 'granted') return true;
    if (!prompt) return false;
    return (await h.requestPermission?.({ mode: 'read' })) === 'granted';
  } catch {
    return false;
  }
}

/**
 * Dựng cây duyệt được từ `FileList` của `<input type="file" webkitdirectory>`.
 *
 * Mỗi File có `webkitRelativePath` dạng `goc/thu-muc-con/ten.txt`. Gom chúng
 * lại thành bảng "đường dẫn thư mục -> các mục bên trong".
 */
export function treeFromFileList(files: FileList | File[]): LocalTree | null {
  const arr = Array.from(files);
  if (arr.length === 0) return null;

  const rel = (f: File) =>
    (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name;

  const rootName = rel(arr[0]).split('/')[0] || 'Thư mục đã chọn';
  // key = đường dẫn thư mục tính từ gốc, '' là gốc
  const dirs = new Map<string, Map<string, LocalEntry>>();
  const at = (k: string) => {
    let m = dirs.get(k);
    if (!m) {
      m = new Map();
      dirs.set(k, m);
    }
    return m;
  };
  at('');

  for (const f of arr) {
    const segs = rel(f).split('/').slice(1); // bỏ tên thư mục gốc
    if (segs.length === 0) continue;
    // Ghi nhận các thư mục trung gian
    for (let i = 0; i < segs.length - 1; i++) {
      const parent = segs.slice(0, i).join('/');
      const name = segs[i];
      at(parent).set(name, { name, kind: 'directory', size: 0, mtime: 0 });
      at(segs.slice(0, i + 1).join('/'));
    }
    const parent = segs.slice(0, -1).join('/');
    const name = segs[segs.length - 1];
    at(parent).set(name, {
      name,
      kind: 'file',
      size: f.size,
      mtime: Math.floor(f.lastModified / 1000),
      file: f,
    });
  }

  return {
    rootName,
    transient: true,
    list: async (parts) => {
      const m = dirs.get(parts.join('/'));
      return m ? sortEntries([...m.values()]) : [];
    },
  };
}

/** Bọc một FileSystemDirectoryHandle thành LocalTree. */
export function treeFromHandle(root: FileSystemDirectoryHandle): LocalTree {
  return {
    rootName: root.name,
    transient: false,
    list: async (parts) => readDir(await resolvePath(root, parts)),
  };
}

function sortEntries(list: LocalEntry[]): LocalEntry[] {
  return list.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1;
    return naturalCmp(a.name, b.name);
  });
}

// ---------------------------------------------------------------------------
// Duyệt
// ---------------------------------------------------------------------------

export async function pickDirectory(): Promise<FileSystemDirectoryHandle | null> {
  const pick = window.showDirectoryPicker;
  if (!pick) return null;
  try {
    const h = await pick.call(window, { mode: 'read' });
    await saveRootHandle(h);
    return h;
  } catch {
    // Người dùng bấm Huỷ.
    return null;
  }
}

/**
 * Liệt kê một thư mục. Sắp xếp giống hệt phía VPS: thư mục trước, rồi tên theo
 * thứ tự tự nhiên — để hai bên nhìn nhất quán.
 */
export async function readDir(dir: FileSystemDirectoryHandle): Promise<LocalEntry[]> {
  const out: LocalEntry[] = [];
  // `values()` là async iterator, có ở Chromium.
  for await (const handle of (dir as unknown as {
    values: () => AsyncIterable<FileSystemHandle>;
  }).values()) {
    if (handle.kind === 'file') {
      try {
        const f = await (handle as FileSystemFileHandle).getFile();
        out.push({
          name: handle.name,
          kind: 'file',
          size: f.size,
          mtime: Math.floor(f.lastModified / 1000),
          handle,
        });
      } catch {
        // File bị xoá giữa chừng, hoặc không có quyền đọc.
      }
    } else {
      out.push({ name: handle.name, kind: 'directory', size: 0, mtime: 0, handle });
    }
  }
  return sortEntries(out);
}

/**
 * So sánh tên kiểu tự nhiên: cụm chữ số so theo GIÁ TRỊ, nên `file2` đứng
 * trước `file10`. Cùng quy ước với `natural_cmp` ở backend Rust.
 */
export function naturalCmp(a: string, b: string): number {
  return a.localeCompare(b, 'vi', { numeric: true, sensitivity: 'base' }) || a.localeCompare(b);
}

/** Đi theo chuỗi tên thư mục con, trả về handle ở cuối đường. */
export async function resolvePath(
  root: FileSystemDirectoryHandle,
  parts: string[]
): Promise<FileSystemDirectoryHandle> {
  let cur = root;
  for (const p of parts) {
    cur = await cur.getDirectoryHandle(p);
  }
  return cur;
}

/** Lấy `File` của những entry được chọn, để đẩy vào trình upload. */
export async function filesOf(entries: LocalEntry[]): Promise<File[]> {
  const out: File[] = [];
  for (const e of entries) {
    if (e.kind !== 'file') continue;
    if (e.file) {
      out.push(e.file);
      continue;
    }
    try {
      out.push(await (e.handle as FileSystemFileHandle).getFile());
    } catch {
      // Bỏ qua file không đọc được, đừng làm hỏng cả lô.
    }
  }
  return out;
}
