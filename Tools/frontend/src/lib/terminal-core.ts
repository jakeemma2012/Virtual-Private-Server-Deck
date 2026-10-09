/**
 * Lõi terminal dùng chung cho trang Terminal và popup trong File manager.
 *
 * Những gì đã sửa so với bản cũ, kèm lý do:
 *
 * 1. **WebGL renderer.** Trước đây chỉ load `addon-fit` + `addon-web-links`,
 *    nên xterm chạy DOM renderer: mỗi đoạn ký tự có style là một `<span>`.
 *    Đó là nguyên nhân chính của "không mượt" và nháy khi scroll.
 *
 * 2. **Dữ liệu đi bằng binary frame.** Trước đây server decode từng chunk 8KB
 *    thành String rồi gửi text — ký tự tiếng Việt 3 byte rơi đúng biên buffer
 *    là hỏng. Giờ byte thô đi thẳng và `term.write(Uint8Array)` dùng bộ decode
 *    UTF-8 **có trạng thái** của xterm, ghép đúng qua mọi ranh giới.
 *
 * 3. **Text frame chỉ dành cho lệnh điều khiển JSON.** Bỏ hẳn giao thức tự chế
 *    `__PING__` / `__RESIZE__:c:r` — chuỗi đó mà xuất hiện trong dữ liệu là
 *    nhiễu. Keepalive dùng WebSocket Ping chuẩn do server gửi, browser tự Pong.
 *
 * 4. **Không gọi `term.refresh()` theo MutationObserver.** Bản cũ refresh toàn
 *    màn hình mỗi lần class của `<html>` đổi -> nháy.
 *
 * 5. **Không tự gộp write bằng requestAnimationFrame.** xterm đã có bộ đệm ghi
 *    riêng; thêm một lớp nữa chỉ làm mỗi ký tự echo chậm thêm một frame.
 *
 * 6. **unicode11** cho bề rộng ký tự đúng (quan trọng với ký tự tổ hợp và emoji),
 *    **serialize** để giữ nội dung màn hình khi reconnect, **clipboard** cho
 *    copy/paste OSC 52, **search** cho Ctrl+F.
 */

import type { Terminal } from '@xterm/xterm';
import type { FitAddon } from '@xterm/addon-fit';
import type { SerializeAddon } from '@xterm/addon-serialize';
import type { SearchAddon } from '@xterm/addon-search';

export const isMobileView = () =>
  typeof window !== 'undefined' && window.matchMedia('(max-width: 767px)').matches;

/** Màu ANSI của nội dung chương trình — không đổi theo theme của app. */
export const TERM_ANSI = {
  black: '#18181b', red: '#ef4444', green: '#22c55e', yellow: '#eab308',
  blue: '#3b82f6', magenta: '#a855f7', cyan: '#06b6d4', white: '#e4e4e7',
  brightBlack: '#52525b', brightRed: '#f87171', brightGreen: '#4ade80', brightYellow: '#facc15',
  brightBlue: '#60a5fa', brightMagenta: '#c084fc', brightCyan: '#22d3ee', brightWhite: '#fafafa',
};

/**
 * Lấy font monospace thật đang được nạp.
 *
 * `next/font` hash tên family (thành `__JetBrains_Mono_a1b2c3`) nên viết
 * `'"JetBrains Mono"'` trong cấu hình xterm sẽ KHÔNG khớp và xterm âm thầm
 * rơi về Menlo. Đọc biến CSS `--font-jetbrains-mono` mới lấy được tên thật.
 */
export function resolveMonoFont(): string {
  const fallback = 'ui-monospace, Menlo, Monaco, "Courier New", monospace';
  if (typeof document === 'undefined' || !document.body) return fallback;
  // Đọc từ <body>, KHÔNG phải <html>: `fontVariables` của next/font được gắn
  // vào className của <body> (xem app/layout.tsx), và biến CSS chỉ kế thừa
  // xuống dưới. Đọc ở documentElement luôn ra chuỗi rỗng, nên terminal âm thầm
  // rơi về font mặc định — đúng cái lỗi mà bản này định sửa.
  const style = getComputedStyle(document.body);
  const named = ['--font-jetbrains-mono', '--font-noto-mono', '--font-space-mono']
    .map((v) => style.getPropertyValue(v).trim())
    .filter(Boolean);
  return named.length ? `${named.join(', ')}, ${fallback}` : fallback;
}

export function buildXtermTheme() {
  const fallback = {
    background: '#09090b', foreground: '#e4e4e7', cursor: '#22c55e',
    cursorAccent: '#09090b', selectionBackground: '#3f3f46', ...TERM_ANSI,
  };
  if (typeof document === 'undefined') return fallback;
  try {
    const probe = document.createElement('span');
    probe.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none';
    document.body.appendChild(probe);
    const read = (v: string, fb: string) => {
      probe.style.color = `var(${v})`;
      return getComputedStyle(probe).color || fb;
    };
    const theme = {
      background: read('--background', '#09090b'),
      foreground: read('--foreground', '#e4e4e7'),
      cursor: read('--primary', '#22c55e'),
      cursorAccent: read('--background', '#09090b'),
      selectionBackground: read('--accent', '#3f3f46'),
      ...TERM_ANSI,
    };
    probe.remove();
    return theme;
  } catch {
    return fallback;
  }
}

/** Phím điều khiển cho thanh lệnh — chuỗi byte thô gửi tới PTY. */
export const TERM_KEYS: { label: string; seq: string }[] = [
  { label: 'Tab', seq: '\t' },
  { label: 'Esc', seq: '\x1b' },
  { label: '^C', seq: '\x03' },
  { label: '^D', seq: '\x04' },
  { label: 'Clear', seq: '\x0c' },
  { label: '↑', seq: '\x1b[A' },
  { label: '↓', seq: '\x1b[B' },
  { label: '←', seq: '\x1b[D' },
  { label: '→', seq: '\x1b[C' },
  { label: '|', seq: '|' },
  { label: '/', seq: '/' },
  { label: '~', seq: '~' },
];

export interface TermHandle {
  term: Terminal;
  fit: FitAddon;
  serialize: SerializeAddon;
  search: SearchAddon;
  /** true nếu WebGL bật được; false là đã rơi về renderer DOM. */
  webgl: boolean;
  dispose: () => void;
}

/**
 * Tạo terminal trong `el`. Import động để xterm không nằm trong bundle đầu.
 */
export async function createTerminal(
  el: HTMLElement,
  opts: { fontSize: number }
): Promise<TermHandle> {
  const [
    { Terminal: Term },
    { FitAddon: Fit },
    { WebLinksAddon },
    { Unicode11Addon },
    { SerializeAddon: Serialize },
    { ClipboardAddon },
    { SearchAddon: Search },
  ] = await Promise.all([
    import('@xterm/xterm'),
    import('@xterm/addon-fit'),
    import('@xterm/addon-web-links'),
    import('@xterm/addon-unicode11'),
    import('@xterm/addon-serialize'),
    import('@xterm/addon-clipboard'),
    import('@xterm/addon-search'),
  ]);
  await import('@xterm/xterm/css/xterm.css');

  const term = new Term({
    cursorBlink: true,
    cursorStyle: 'block',
    fontSize: opts.fontSize,
    // lineHeight phải để 1: giá trị lẻ như 1.15 làm dòng rơi vào vị trí
    // subpixel, chữ mờ và renderer phải làm việc nhiều hơn.
    lineHeight: 1,
    fontFamily: resolveMonoFont(),
    theme: buildXtermTheme(),
    scrollback: 10000,
    convertEol: false,
    allowProposedApi: true,
    // Cho phép xterm xử lý tổ hợp ký tự đúng bề rộng.
    allowTransparency: false,
    macOptionIsMeta: true,
  });

  const fit = new Fit();
  const serialize = new Serialize();
  const search = new Search();
  term.loadAddon(fit);
  term.loadAddon(new WebLinksAddon());
  term.loadAddon(serialize);
  term.loadAddon(new ClipboardAddon());
  term.loadAddon(search);

  const uni = new Unicode11Addon();
  term.loadAddon(uni);
  term.unicode.activeVersion = '11';

  term.open(el);

  // WebGL phải load SAU open(). Một số máy/driver không dựng được context;
  // lúc đó xterm tự dùng renderer DOM, nên bọc try/catch và báo lại.
  let webgl = false;
  try {
    const { WebglAddon } = await import('@xterm/addon-webgl');
    const addon = new WebglAddon();
    // Context bị mất (đổi GPU, tab ngủ lâu) -> bỏ addon, đừng để màn hình đen.
    addon.onContextLoss(() => {
      try { addon.dispose(); } catch { /* đã dispose */ }
    });
    term.loadAddon(addon);
    webgl = true;
  } catch {
    webgl = false;
  }

  requestAnimationFrame(() => {
    try { fit.fit(); } catch { /* el chưa có kích thước */ }
  });

  const handle: TermHandle = {
    term,
    fit,
    serialize,
    search,
    webgl,
    dispose: () => {
      try { term.dispose(); } catch { /* đã dispose */ }
    },
  };

  // Móc cho test tự động. Với WebGL renderer, nội dung terminal nằm trong
  // canvas chứ không có text trong DOM, nên không có cách nào khác để kiểm
  // tự động xem chữ tiếng Việt có hiện đúng hay không.
  // Chỉ đọc; không ảnh hưởng gì tới hoạt động của app.
  if (typeof window !== 'undefined') {
    (window as unknown as {
      __jakeTerm?: () => { text: string; font: string; webgl: boolean };
    }).__jakeTerm = () => ({
      text: (() => {
        try { return handle.serialize.serialize(); } catch { return ''; }
      })(),
      // Với WebGL renderer, font nằm trong options của xterm (dùng để vẽ lên
      // canvas), KHÔNG phải trong CSS của phần tử .xterm — nên không kiểm
      // được bằng getComputedStyle.
      font: String(handle.term.options.fontFamily ?? ''),
      webgl: handle.webgl,
    });
  }

  return handle;
}

export interface TermSocket {
  send: (data: string | Uint8Array) => void;
  resize: (cols: number, rows: number) => void;
  close: () => void;
  readonly isOpen: boolean;
}

/**
 * Nối terminal với WebSocket.
 *
 * Dữ liệu hai chiều là binary; text frame chỉ chở lệnh điều khiển JSON.
 */
export function connectTerminal(
  handle: TermHandle,
  conn: { url: string; protocols?: string[] },
  cb: {
    onOpen?: () => void;
    onClose?: (clean: boolean) => void;
    onError?: (msg: string) => void;
  }
): TermSocket {
  const ws = new WebSocket(conn.url, conn.protocols);
  // Bắt buộc: mặc định là 'blob', và blob phải await mới đọc được -> dữ liệu
  // terminal tới không theo thứ tự. ArrayBuffer đọc đồng bộ nên giữ đúng thứ tự.
  ws.binaryType = 'arraybuffer';

  const enc = new TextEncoder();
  let closedByUs = false;

  ws.onopen = () => {
    const { cols, rows } = handle.term;
    if (cols && rows) {
      ws.send(JSON.stringify({ t: 'resize', cols, rows }));
    }
    cb.onOpen?.();
  };

  ws.onmessage = (e) => {
    if (e.data instanceof ArrayBuffer) {
      // Ghi thẳng byte: xterm tự ghép UTF-8 qua các lần write.
      handle.term.write(new Uint8Array(e.data));
    } else if (typeof e.data === 'string') {
      // Server chỉ gửi text cho thông báo lỗi trước khi mở được SSH.
      handle.term.write(e.data);
    }
  };

  ws.onerror = () => cb.onError?.('lỗi kết nối WebSocket');
  ws.onclose = (e) => cb.onClose?.(closedByUs || e.wasClean);

  const dataSub = handle.term.onData((d) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(enc.encode(d));
  });
  // Dữ liệu dán/ghi nhiều byte một lúc đi đường riêng của xterm.
  const binarySub = handle.term.onBinary((d) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    const buf = new Uint8Array(d.length);
    for (let i = 0; i < d.length; i++) buf[i] = d.charCodeAt(i) & 0xff;
    ws.send(buf);
  });

  return {
    send: (data) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      ws.send(typeof data === 'string' ? enc.encode(data) : data);
    },
    resize: (cols, rows) => {
      if (ws.readyState === WebSocket.OPEN && cols > 0 && rows > 0) {
        ws.send(JSON.stringify({ t: 'resize', cols, rows }));
      }
    },
    close: () => {
      closedByUs = true;
      dataSub.dispose();
      binarySub.dispose();
      try { ws.close(); } catch { /* đã đóng */ }
    },
    get isOpen() {
      return ws.readyState === WebSocket.OPEN;
    },
  };
}
