import { useAuthStore } from './auth-store';

const API_BASE = process.env.NEXT_PUBLIC_API_URL || '';

function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem('token');
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = {
    ...(options.headers as Record<string, string>),
  };

  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (!(options.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
  }

  const res = await fetch(`${API_BASE}${path}`, { ...options, headers });

  if (res.status === 401) {
    if (typeof window !== 'undefined' && !path.includes('/auth/')) {
      useAuthStore.getState().logout();
    }
    throw new Error('Unauthorized');
  }

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || err.message || res.statusText);
  }

  if (res.headers.get('content-type')?.includes('application/octet-stream')) {
    return res.blob() as unknown as T;
  }

  return res.json();
}

// Auth
export const api = {
  login: (username: string, password: string) =>
    request<{ token: string; username: string; role: string }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    }),

  // Servers
  getServers: () => request<VpsServer[]>('/api/servers'),
  getServer: (id: string) => request<VpsServer>(`/api/servers/${id}`),
  createServer: (data: ServerCreateRequest) =>
    request<VpsServer>('/api/servers', { method: 'POST', body: JSON.stringify(data) }),
  updateServer: (id: string, data: ServerCreateRequest) =>
    request<VpsServer>(`/api/servers/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteServer: (id: string) =>
    request(`/api/servers/${id}`, { method: 'DELETE' }),
  /**
   * Ghim một thư mục cho server. Truyền `null` để bỏ ghim.
   * Server kiểm thư mục có tồn tại thật không trước khi lưu.
   */
  setPinnedPath: (id: string, path: string | null) =>
    request<{ pinnedPath: string | null; message: string }>(`/api/servers/${id}/pin`, {
      method: 'PUT',
      body: JSON.stringify({ path }),
    }),

  testConnection: (id: string) =>
    request<{ connected: boolean }>(`/api/servers/${id}/test`, { method: 'POST' }),
  getServerStats: (id: string) =>
    request<ServerStats>(`/api/servers/${id}/stats`),

  // Execute command
  executeCommand: (serverId: string, command: string) =>
    request<CommandResponse>(`/api/servers/${serverId}/execute`, {
      method: 'POST',
      body: JSON.stringify({ command }),
    }),

  // Files
  //
  // listFiles trả về MỘT TRANG đã sắp xếp sẵn ở server, không phải cả thư mục.
  // Thư mục 50k file vì thế chỉ gửi ~1k dòng về browser; `total` cho biết còn
  // bao nhiêu để UI hiện đúng và tải thêm khi cuộn.
  listFiles: (serverId: string, opts: ListFilesOptions = {}) => {
    const p = new URLSearchParams({
      path: opts.path ?? '/',
      offset: String(opts.offset ?? 0),
      limit: String(opts.limit ?? 1000),
      sort: opts.sort ?? 'name',
      order: opts.order ?? 'asc',
    });
    if (opts.q) p.set('q', opts.q);
    if (opts.refresh) p.set('refresh', 'true');
    return request<FileListPage>(`/api/servers/${serverId}/files/list?${p}`);
  },

  // Tìm kiếm ĐỆ QUY trong cả subtree của thư mục đang đứng.
  // source='index' là lấy từ index đã quét; 'live' là chạy find trực tiếp
  // (chậm hơn nhưng luôn ra kết quả, không bắt người dùng chờ index xong).
  searchFiles: (serverId: string, path: string, q: string, limit = 500) => {
    const p = new URLSearchParams({ path, q, limit: String(limit) });
    return request<FileSearchResult>(`/api/servers/${serverId}/files/search?${p}`);
  },

  startIndex: (serverId: string, path: string) =>
    request<IndexStatus>(
      `/api/servers/${serverId}/files/index?path=${encodeURIComponent(path)}`,
      { method: 'POST' }
    ),

  getIndexStatus: (serverId: string, path: string) =>
    request<IndexStatus>(
      `/api/servers/${serverId}/files/index?path=${encodeURIComponent(path)}`
    ),
  downloadFile: (serverId: string, path: string) => {
    const token = getToken();
    const filename = path.split('/').pop() || 'download';
    const url = '/api/servers/' + serverId + '/files/download?path=' + encodeURIComponent(path);

    // Use hidden iframe + cookie-based auth fallback, or fetch with streaming
    fetch(url, { headers: { Authorization: 'Bearer ' + token } })
      .then(res => {
        if (!res.ok) throw new Error('Download failed: ' + res.status);
        const contentLength = res.headers.get('Content-Length');
        const size = contentLength ? parseInt(contentLength) : 0;

        // For large files (>500MB), use ReadableStream to avoid loading into memory
        if (size > 500 * 1024 * 1024 && 'showSaveFilePicker' in window) {
          // File System Access API - streams directly to disk
          return (window as any).showSaveFilePicker({ suggestedName: filename })
            .then((handle: any) => handle.createWritable())
            .then((writable: any) => {
              const reader = res.body!.getReader();
              function pump(): Promise<void> {
                return reader.read().then(({ done, value }: any) => {
                  if (done) { writable.close(); return; }
                  return writable.write(value).then(pump);
                });
              }
              return pump();
            });
        }

        // Fallback: blob download (works for smaller files or browsers without File System Access)
        return res.blob().then(blob => {
          const blobUrl = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = blobUrl; a.download = filename; a.click();
          URL.revokeObjectURL(blobUrl);
        });
      }).catch(() => {});
  },
  uploadFile: (serverId: string, path: string, file: File) => {
    const formData = new FormData();
    formData.append('file', file);
    return request(`/api/servers/${serverId}/files/upload?path=${encodeURIComponent(path)}`, {
      method: 'POST',
      body: formData,
    });
  },
  deleteFile: (serverId: string, path: string) =>
    request(`/api/servers/${serverId}/files?path=${encodeURIComponent(path)}`, { method: 'DELETE' }),
  mkdir: (serverId: string, path: string) =>
    request(`/api/servers/${serverId}/files/mkdir?path=${encodeURIComponent(path)}`, { method: 'POST' }),
  renameFile: (serverId: string, oldPath: string, newPath: string) =>
    request(`/api/servers/${serverId}/files/rename?oldPath=${encodeURIComponent(oldPath)}&newPath=${encodeURIComponent(newPath)}`, { method: 'POST' }),
  readFile: (serverId: string, path: string) =>
    request<{ content: string; path: string }>(`/api/servers/${serverId}/files/read?path=${encodeURIComponent(path)}`),
  writeFile: (serverId: string, path: string, content: string) =>
    request(`/api/servers/${serverId}/files/write?path=${encodeURIComponent(path)}`, {
      method: 'POST', body: JSON.stringify({ content }),
    }),
  chmod: (serverId: string, path: string, mode: string) =>
    request(`/api/servers/${serverId}/files/chmod?path=${encodeURIComponent(path)}&mode=${mode}`, { method: 'POST' }),
  compress: (serverId: string, path: string) =>
    request<{ taskId: string; message: string; path: string }>(`/api/servers/${serverId}/files/compress?path=${encodeURIComponent(path)}`, { method: 'POST' }),
  compressStatus: (serverId: string, taskId: string) =>
    request<{ taskId: string; status: string; message: string }>(`/api/servers/${serverId}/files/compress/status/${taskId}`),

  // System stats (host machine)
  getSystemStats: () =>
    request<SystemStats>('/api/system/stats'),

  // WebSocket terminal.
  //
  // Hai thứ đã sửa so với bản cũ:
  //  - `ws://` từng được hardcode, nên terminal chết ngay khi site bật HTTPS.
  //    Giờ suy ra từ protocol hiện tại.
  //  - Token đi qua **subprotocol**, không nhét vào query string: query nằm
  //    trong access log của proxy và trong history của browser. Browser không
  //    cho đặt header Authorization cho WebSocket nên subprotocol là chỗ đúng.
  getTerminalWs: (serverId: string, cols: number, rows: number) => {
    const loc = window.location;
    const scheme = loc.protocol === 'https:' ? 'wss:' : 'ws:';
    const base = API_BASE
      ? API_BASE.replace(/^http/, 'ws')
      : `${scheme}//${loc.host}`;
    const q = new URLSearchParams({
      serverId,
      cols: String(cols),
      rows: String(rows),
    });
    const token = getToken();
    return {
      url: `${base}/ws/terminal?${q}`,
      protocols: token ? [`jake-token.${token}`] : undefined,
    };
  },
};

export interface ListFilesOptions {
  path?: string;
  offset?: number;
  limit?: number;
  sort?: 'name' | 'size' | 'mtime' | 'type';
  order?: 'asc' | 'desc';
  /** Lọc theo tên trong chính thư mục này (không đệ quy). */
  q?: string;
  /** Bỏ qua cache 15s của server và đọc lại từ VPS. */
  refresh?: boolean;
}

export interface FileListPage {
  path: string;
  /** Số entry khớp bộ lọc. */
  total: number;
  /** Số entry thật trong thư mục, chưa lọc. */
  totalUnfiltered: number;
  offset: number;
  limit: number;
  entries: FileEntry[];
  indexState: 'none' | 'running' | 'done' | 'failed';
  indexedEntries: number;
}

export interface FileSearchHit {
  path: string;
  name: string;
  parent: string;
  type: string;
  size: number;
  mtime: number;
}

export interface FileSearchResult {
  hits: FileSearchHit[];
  source: 'index' | 'live' | 'empty';
  truncated: boolean;
}

export interface IndexStatus {
  state: 'none' | 'running' | 'done' | 'failed';
  entries?: number;
  path: string;
}

// Types
export interface VpsServer {
  id: string;
  name: string;
  hostname: string;
  ip: string;
  port: number;
  os: string;
  status: 'ONLINE' | 'OFFLINE' | 'WARNING';
  location: string;
  provider: string;
  tags: string;
  sshUsername: string;
  /** Server KHÔNG trả về mật khẩu/khoá SSH nữa, chỉ cho biết có hay không. */
  hasPassword: boolean;
  hasPrivateKey: boolean;
  /** Thư mục đã ghim. File Manager mở thẳng vào đây thay vì /root. */
  pinnedPath: string | null;
  /** Epoch giây (trước đây là chuỗi ISO). */
  createdAt: number;
  updatedAt: number;
}

export interface ServerCreateRequest {
  name: string;
  ip: string;
  port: number;
  hostname?: string;
  os?: string;
  location?: string;
  provider?: string;
  tags?: string;
  sshUsername: string;
  sshPassword?: string;
  sshPrivateKey?: string;
}

export interface ServerStats {
  cpuUsage: number;
  ramUsagePercent: number;
  ramTotalMb: number;
  ramUsedMb: number;
  diskUsagePercent: number;
  diskTotalGb: number;
  diskUsedGb: number;
  uptime: string;
  hostname: string;
  os: string;
}

export interface CommandResponse {
  exitCode: number;
  output: string;
  error: string;
}

export interface SystemStats {
  cpuUsage: number;
  ramTotal: number;
  ramUsed: number;
  ramUsagePercent: number;
  diskTotal: number;
  diskUsed: number;
  diskUsagePercent: number;
  uptime: string;
  hostname: string;
  os: string;
  kernel: string;
  loadAvg1: number;
  loadAvg5: number;
  loadAvg15: number;
  processCount: number;
  networkRxBytes: number;
  networkTxBytes: number;
}

export interface FileEntry {
  name: string;
  type: 'directory' | 'file' | 'link';
  size: number;
  /**
   * Epoch GIÂY, dạng số.
   *
   * Trường cũ là `modified: string` (chuỗi đã format sẵn từ server), và frontend
   * sắp xếp bằng `a.modified.localeCompare(b.modified)` — so sánh chuỗi trên
   * ngày tháng, nên "sắp theo thời gian" cho ra thứ tự sai hoàn toàn. Giờ là số
   * nên so sánh đúng, và việc format để hiển thị là việc của UI.
   */
  mtime: number;
  /** Quyền dạng octal, ví dụ "644". */
  permissions: string;
  owner: string;
  group: string;
}
