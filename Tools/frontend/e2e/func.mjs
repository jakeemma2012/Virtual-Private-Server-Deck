/**
 * Vòng test CHỨC NĂNG: phân trang, sắp xếp, tìm kiếm, và terminal tiếng Việt.
 * Chạy sau test.mjs (test.mjs lo phần trang có load được không).
 *
 * BASE=http://127.0.0.1:8099 PW=... SID=<serverId> node func.mjs
 */
import { chromium } from 'playwright';
import fs from 'node:fs';

const BASE = process.env.BASE || 'http://127.0.0.1:8099';
const PASS = process.env.PW;
const SID = process.env.SID;
const DIR = process.env.DIR || '/var/lib/dpkg/info';
const OUT = '/tmp/jake-e2e';
fs.mkdirSync(OUT, { recursive: true });

let pass = 0, fail = 0;
const ok = (n, x = '') => { pass++; console.log(`  OK   ${n}${x ? ' — ' + x : ''}`); };
const bad = (n, w) => { fail++; console.log(`  LỖI  ${n} — ${w}`); };

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, locale: 'vi-VN' });
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(String(e).slice(0, 300)));

// --- đăng nhập ---
await page.goto(`${BASE}/auth/`, { waitUntil: 'networkidle' });
await page.locator('input').first().fill('admin');
await page.locator('input[type="password"]').first().fill(PASS);
await page.keyboard.press('Enter');
await page.waitForURL(/dashboard/, { timeout: 15000 });

// ===================================================== FILE MANAGER
console.log('\n[A] File manager');
// Đặt sẵn thư mục đích vào localStorage rồi mới mở trang — ổn định hơn nhiều
// so với việc tìm và điền ô đường dẫn.
await page.goto(`${BASE}/dashboard/files/?serverId=${SID}`, { waitUntil: 'domcontentloaded' });
await page.evaluate(([sid, d]) => {
  localStorage.setItem('files_server', sid);
  localStorage.setItem('files_path_' + sid, d);
}, [SID, DIR]);
await page.goto(`${BASE}/dashboard/files/?serverId=${SID}`, { waitUntil: 'networkidle' });
await page.waitForTimeout(5000);

// Ô đường dẫn chỉ tồn tại ở chế độ sửa; bấm nút 'Edit path' của breadcrumb.
const editBtn = page.locator('[title="Edit path"]').first();
if (await editBtn.count() > 0) {
  await editBtn.click();
  await page.waitForTimeout(400);
  const pathInput = page.locator('input.font-mono').first();
  await pathInput.fill(DIR);
  await pathInput.press('Enter');
  await page.waitForTimeout(7000);
  ok('điều hướng tới thư mục lớn', DIR);
} else {
  bad('mở ô đường dẫn', "không thấy nút [title='Edit path']");
}

const rowsOf = () => page.evaluate(() =>
  [...document.querySelectorAll('tbody tr[data-name]')].map((r) => r.dataset.name)
);

let names = await rowsOf();
if (names.length > 0) ok('render dòng file', `${names.length} dòng trong DOM`);
else bad('render dòng file', 'vẫn 0 dòng');

// Virtualize: DOM phải ÍT hơn nhiều so với tổng số file.
const footerTxt = await page.evaluate(() => {
  const el = [...document.querySelectorAll('div')].reverse().find((d) =>
    /mục/.test(d.innerText || '') && d.children.length < 6
  );
  return el ? el.innerText.replace(/\s+/g, ' ').trim().slice(0, 70) : null;
});
if (footerTxt) ok('chỉ báo đã nạp/tổng', footerTxt); else bad('chỉ báo đã nạp/tổng', 'không thấy');

if (names.length > 0 && names.length < 300) {
  ok('virtualize hoạt động', `chỉ ${names.length} <tr> trong DOM cho thư mục ~5000 file`);
} else if (names.length >= 300) {
  bad('virtualize', `${names.length} <tr> trong DOM — quá nhiều`);
}

// Thư mục đứng trước file.
const firstNonDotdot = names.filter((n) => n !== '..');
const types = await page.evaluate(() =>
  [...document.querySelectorAll('tbody tr[data-name]')].map((r) => ({
    name: r.dataset.name,
    dir: !!r.querySelector('svg.text-amber-500'),
  }))
);
const lastDir = types.map((t) => t.dir).lastIndexOf(true);
const firstFile = types.map((t) => t.dir).indexOf(false);
if (lastDir === -1 || firstFile === -1 || lastDir < firstFile) ok('thư mục xếp trước file');
else bad('thư mục xếp trước file', `dir cuối ở ${lastDir}, file đầu ở ${firstFile}`);

// Sắp xếp theo Modified: phải ĐỔI thứ tự và gọi lại server.
const before = (await rowsOf()).slice(0, 5).join(',');
await page.evaluate(() => {
  const th = [...document.querySelectorAll('th')].find((t) => /Modified/i.test(t.innerText));
  th?.click();
});
await page.waitForTimeout(2500);
const after = (await rowsOf()).slice(0, 5).join(',');
if (before && after && before !== after) ok('sort theo Modified đổi thứ tự', `${after.split(',')[0]} lên đầu`);
else bad('sort theo Modified', `thứ tự không đổi (${before.slice(0, 40)})`);

// Tìm kiếm trong thư mục: server lọc trên TOÀN BỘ thư mục.
await page.evaluate(() => {
  const inp = [...document.querySelectorAll('input')].find((i) =>
    /Tìm trong thư mục/.test(i.placeholder || '')
  );
  if (inp) {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(inp, 'list');
    inp.dispatchEvent(new Event('input', { bubbles: true }));
  }
});
await page.waitForTimeout(2500);
const filtered = await rowsOf();
const allMatch = filtered.filter((n) => n !== '..').every((n) => /list/i.test(n));
if (filtered.length > 1 && allMatch) ok('tìm trong thư mục', `${filtered.length} dòng, đều khớp`);
else bad('tìm trong thư mục', `${filtered.length} dòng, khớp hết: ${allMatch}`);

await page.screenshot({ path: `${OUT}/A-files.png` });

// ===================================================== TERMINAL
console.log('\n[B] Terminal');
await page.goto(`${BASE}/dashboard/terminal/?serverId=${SID}`, { waitUntil: 'networkidle' });
await page.waitForTimeout(5000);

// WebGL renderer vẽ vào canvas, DOM không có text. Đọc qua serialize addon.
const screen = () => page.evaluate(() => {
  const f = window.__jakeTerm;
  return typeof f === 'function' ? f().text : (document.querySelector('.xterm-screen')?.innerText || '');
});

let s = await screen();
if (/[$#>]/.test(s)) ok('terminal có prompt', s.trim().split('\n').pop()?.slice(0, 50));
else bad('terminal có prompt', `màn hình: ${JSON.stringify(s.slice(0, 120))}`);

// Gõ tiếng Việt: ghép từ 2 phần để chuỗi đích KHÔNG nằm nguyên trong dòng lệnh
// echo lại, nếu không ta chỉ đang kiểm echo chứ không kiểm đường VPS -> browser.
const A = 'Tiếng Vi', B = 'ệt: ế ộ ữ ậ ằ đ';
await page.locator('.xterm').click();
await page.keyboard.type(`printf '%s%s\\n' '${A}' '${B}'`);
await page.keyboard.press('Enter');
await page.waitForTimeout(3000);

s = await screen();
if (s.includes(A + B)) ok('chữ tiếng Việt hiện đúng trên terminal', A + B);
else bad('chữ tiếng Việt', `không thấy chuỗi; màn hình đuôi: ${JSON.stringify(s.slice(-160))}`);

// Font: xterm phải dùng font đã nạp, không rơi về Menlo.
const info = await page.evaluate(() => window.__jakeTerm?.() ?? null);
if (info?.font && /JetBrains Mono/.test(info.font)) {
  ok('font terminal dùng webfont đã nạp', info.font.slice(0, 55));
} else {
  bad('font terminal', `không phải JetBrains Mono: ${info?.font}`);
}
if (info?.webgl) ok('WebGL renderer bật'); else bad('WebGL renderer', 'đang dùng renderer DOM (chậm)');

await page.screenshot({ path: `${OUT}/B-terminal.png` });

console.log('\n' + '='.repeat(60));
if (errs.length) {
  console.log('Exception trên trang:');
  [...new Set(errs)].slice(0, 5).forEach((e) => console.log('  - ' + e));
}
console.log(`\nKẾT QUẢ: ${pass} đạt / ${fail} lỗi   (ảnh ở ${OUT})`);
await browser.close();
process.exit(fail ? 1 : 0);
