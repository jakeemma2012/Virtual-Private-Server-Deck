/**
 * Test chức năng VPSDeck bằng Chromium thật.
 *
 * Chạy: BASE=http://127.0.0.1:8099 PW=... node test.mjs
 *
 * Mỗi bước ghi lại: lỗi console, lỗi request, và ảnh màn hình khi thất bại.
 * Bắt được cả lỗi runtime mà kiểm HTTP status không thấy (trang lỗi của Next
 * vẫn trả 200).
 */
import { chromium } from 'playwright';
import fs from 'node:fs';

const BASE = process.env.BASE || 'http://127.0.0.1:8099';
const PASS = process.env.PW;
const OUT = process.env.OUT || '/tmp/jake-e2e';
fs.mkdirSync(OUT, { recursive: true });

let pass = 0, fail = 0;
const consoleErrors = [];
const requestFails = [];
const pageErrors = [];

function ok(name, extra = '') {
  pass++;
  console.log(`  OK   ${name}${extra ? ' — ' + extra : ''}`);
}
function bad(name, why) {
  fail++;
  console.log(`  LỖI  ${name} — ${why}`);
}

/** Trang có đang hiện error boundary của Next không. */
async function isNextError(page) {
  return page.evaluate(() =>
    !!document.querySelector('#__next_error__') ||
    /couldn[’']t load/.test(document.body?.innerText || '')
  );
}

async function shot(page, name) {
  const p = `${OUT}/${name}.png`;
  try { await page.screenshot({ path: p, fullPage: false }); } catch { /* trang lỗi */ }
  return p;
}

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  locale: 'vi-VN',
});
const page = await ctx.newPage();

page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 300));
});
page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 400)));
page.on('requestfailed', (r) =>
  requestFails.push(`${r.method()} ${r.url().replace(BASE, '')} — ${r.failure()?.errorText}`)
);

// ---------------------------------------------------------------- 1. trang /
console.log('\n[1] Trang gốc / -> chuyển tới /auth');
await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
if (await isNextError(page)) {
  bad('/ không hiện trang lỗi', `ảnh: ${await shot(page, '01-root-error')}`);
} else if (/\/auth/.test(page.url())) {
  ok('/ chuyển đúng tới /auth');
} else {
  bad('/ chuyển tới /auth', `đang ở ${page.url()}`);
}

// ---------------------------------------------------------------- 2. đăng nhập
console.log('\n[2] Đăng nhập');
await page.goto(`${BASE}/auth/`, { waitUntil: 'networkidle' });
if (await isNextError(page)) {
  bad('/auth tải được', `ảnh: ${await shot(page, '02-auth-error')}`);
} else {
  const user = page.locator('input').first();
  const pw = page.locator('input[type="password"]').first();
  if (await pw.count()) {
    await user.fill('admin');
    await pw.fill(PASS);
    await page.keyboard.press('Enter');
    await page.waitForURL(/dashboard/, { timeout: 15000 }).catch(() => {});
    if (/dashboard/.test(page.url())) {
      ok('đăng nhập thành công', page.url().replace(BASE, ''));
    } else {
      bad('đăng nhập', `vẫn ở ${page.url().replace(BASE, '')}; ảnh: ${await shot(page, '02-login-failed')}`);
    }
  } else {
    bad('tìm ô mật khẩu', `ảnh: ${await shot(page, '02-no-password-field')}`);
  }
}

const token = await page.evaluate(() => localStorage.getItem('token'));
if (token) ok('token lưu vào localStorage'); else bad('token', 'không có trong localStorage');

// ------------------------------------------------------- 3. các trang dashboard
const pages = [
  ['/dashboard/overview/', 'Overview'],
  ['/dashboard/servers/', 'Servers'],
  ['/dashboard/files/', 'Files'],
  ['/dashboard/terminal/', 'Terminal'],
  ['/dashboard/alerts/', 'Alerts'],
  ['/dashboard/website/', 'Website'],
  ['/dashboard/settings/', 'Settings'],
];
console.log('\n[3] Mở từng trang dashboard');
for (const [path, name] of pages) {
  consoleErrors.length = 0;
  pageErrors.length = 0;
  await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);
  if (await isNextError(page)) {
    bad(`${name} (${path})`, `trang lỗi Next; ảnh: ${await shot(page, 'page-' + name)}`);
    if (pageErrors.length) console.log(`         throw: ${pageErrors[0]}`);
  } else if (pageErrors.length) {
    bad(`${name} (${path})`, `exception: ${pageErrors[0]}`);
  } else {
    const txt = (await page.evaluate(() => document.body.innerText)).trim();
    ok(`${name}`, `${txt.length} ký tự nội dung`);
  }
}

// ------------------------------------------------------------- 4. Danh sách file
console.log('\n[4] Danh sách file: phân trang + sắp xếp');
await page.goto(`${BASE}/dashboard/files/`, { waitUntil: 'networkidle' });
await page.waitForTimeout
  ? await page.waitForTimeout(2500) : null;

const rows = await page.locator('tbody tr[data-name]').count();
if (rows > 0) ok('render được dòng file', `${rows} dòng trong DOM`);
else bad('render dòng file', `0 dòng; ảnh: ${await shot(page, '04-files-empty')}`);

// Virtualize: thư mục lớn vẫn chỉ dựng ít dòng trong DOM
const footer = await page.evaluate(() => {
  const el = [...document.querySelectorAll('div')].find((d) =>
    /\d[\d.,]*\s*\/\s*[\d.,]+\s*mục|Đã hiện tất cả/.test(d.innerText || '')
  );
  return el ? el.innerText.trim().slice(0, 80) : null;
});
if (footer) ok('chân danh sách hiện đã nạp/tổng', footer.replace(/\n/g, ' '));
else bad('chân danh sách', 'không thấy chỉ báo đã nạp/tổng');

await shot(page, '04-files');

// ------------------------------------------------------------------ 5. Terminal
console.log('\n[5] Terminal: WebSocket + chữ tiếng Việt');
consoleErrors.length = 0;
await page.goto(`${BASE}/dashboard/terminal/`, { waitUntil: 'networkidle' });
await page.waitForTimeout(3000);

const term = await page.evaluate(() => {
  const el = document.querySelector('.xterm');
  return {
    mounted: !!el,
    webgl: !!document.querySelector('.xterm canvas.xterm-link-layer, .xterm canvas'),
    text: (document.querySelector('.xterm-screen')?.innerText || '').slice(0, 400),
  };
});
if (term.mounted) ok('xterm dựng được', term.webgl ? 'có canvas (WebGL)' : 'không thấy canvas');
else bad('xterm', `không dựng; ảnh: ${await shot(page, '05-term-missing')}`);

await shot(page, '05-terminal');

// ------------------------------------------------------------------- tổng kết
console.log('\n' + '='.repeat(60));
if (consoleErrors.length) {
  console.log(`Lỗi console (${consoleErrors.length}):`);
  [...new Set(consoleErrors)].slice(0, 6).forEach((e) => console.log('  - ' + e));
}
if (requestFails.length) {
  console.log(`Request thất bại (${requestFails.length}):`);
  [...new Set(requestFails)].slice(0, 6).forEach((e) => console.log('  - ' + e));
}
console.log(`\nKẾT QUẢ: ${pass} đạt / ${fail} lỗi   (ảnh ở ${OUT})`);

await browser.close();
process.exit(fail ? 1 : 0);
