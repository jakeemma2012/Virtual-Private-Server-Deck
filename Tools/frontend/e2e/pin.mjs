/**
 * Test tính năng ghim thư mục.
 *
 * Yêu cầu: ghim ở đâu thì lần sau vào VPS đó mở thẳng vào đó, không vào /root.
 *
 * BASE=... PW=... SID=... node e2e/pin.mjs
 */
import { chromium } from 'playwright';
import fs from 'node:fs';

const BASE = process.env.BASE || 'http://127.0.0.1:8099';
const PASS = process.env.PW;
const SID = process.env.SID;
const PIN_DIR = process.env.PIN_DIR || '/var/log';
const OUT = '/tmp/jake-e2e';
fs.mkdirSync(OUT, { recursive: true });

let pass = 0, fail = 0;
const ok = (n, x = '') => { pass++; console.log(`  OK   ${n}${x ? ' — ' + x : ''}`); };
const bad = (n, w) => { fail++; console.log(`  LỖI  ${n} — ${w}`); };

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 }, locale: 'vi-VN' });
const page = await ctx.newPage();

const login = async () => {
  await page.goto(`${BASE}/auth/`, { waitUntil: 'networkidle' });
  await page.locator('input').first().fill('admin');
  await page.locator('input[type="password"]').first().fill(PASS);
  await page.keyboard.press('Enter');
  await page.waitForURL(/dashboard/, { timeout: 15000 });
};

const goTo = async (dir) => {
  await page.locator('[title="Edit path"]').first().click();
  await page.waitForTimeout(300);
  const inp = page.locator('input.font-mono').first();
  await inp.fill(dir);
  await inp.press('Enter');
  await page.waitForTimeout(4000);
};

const currentDir = () =>
  page.evaluate(() => {
    const crumb = document.querySelector('[title="Edit path"]')?.closest('div');
    return crumb ? crumb.innerText.replace(/\s+/g, ' ').trim() : null;
  });

const pinButton = () => page.locator('[data-testid="pin-btn"]');

await login();

// Bắt đầu từ trạng thái chưa ghim.
await page.evaluate(
  async ([base, sid]) => {
    await fetch(`${base}/api/servers/${sid}/pin`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + localStorage.getItem('token'),
      },
      body: JSON.stringify({ path: null }),
    });
  },
  [BASE, SID]
);

// ------------------------------------------------- 1. chưa ghim -> vào /root
console.log('\n[1] Chưa ghim');
await page.evaluate((sid) => localStorage.removeItem('files_path_' + sid), SID);
await page.goto(`${BASE}/dashboard/files/?serverId=${SID}`, { waitUntil: 'networkidle' });
await page.waitForTimeout(3500);
let dir = await currentDir();
if (/root/.test(dir || '')) ok('mở vào /root như mặc định', dir);
else bad('mặc định', `đang ở ${dir}`);

// ------------------------------------------------------------- 2. bấm ghim
console.log(`\n[2] Ghim ${PIN_DIR}`);
await goTo(PIN_DIR);
const btn = pinButton();
if (await btn.count() === 0) {
  bad('tìm nút ghim', 'không thấy nút nào có title chứa "ghim"');
} else {
  await btn.click();
  await page.waitForTimeout(2500);
  const pinnedOnServer = await page.evaluate(
    async ([base, sid]) => {
      const r = await fetch(`${base}/api/servers`, {
        headers: { Authorization: 'Bearer ' + localStorage.getItem('token') },
      });
      const list = await r.json();
      return list.find((s) => s.id === sid)?.pinnedPath ?? null;
    },
    [BASE, SID]
  );
  if (pinnedOnServer === PIN_DIR) ok('ghim đã lưu ở SERVER', pinnedOnServer);
  else bad('ghim lưu ở server', `server trả về ${JSON.stringify(pinnedOnServer)}`);
}
await page.screenshot({ path: `${OUT}/P-pinned.png` });

// ---------------------------- 3. vào lại VPS -> mở thẳng vào thư mục đã ghim
console.log('\n[3] Vào lại VPS');
// Xoá cả ghi nhớ localStorage để chắc chắn là nhờ GHIM, không nhờ "lần trước".
await page.evaluate((sid) => localStorage.removeItem('files_path_' + sid), SID);
// domcontentloaded, KHÔNG networkidle: trang Overview poll stats của 11 VPS,
// có máy mất 12-14s rồi lỗi, nên mạng không bao giờ "idle".
await page.goto(`${BASE}/dashboard/overview/`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(800);
await page.goto(`${BASE}/dashboard/files/?serverId=${SID}`, { waitUntil: 'networkidle' });
await page.waitForTimeout(4000);
dir = await currentDir();
if (dir && dir.includes(PIN_DIR.split('/').filter(Boolean).pop())) {
  ok('mở thẳng vào thư mục đã ghim', dir);
} else {
  bad('không vào thư mục ghim', `đang ở ${dir}`);
}

// ------------------------------- 4. ghim theo TỪNG VPS, không dùng chung
console.log('\n[4] Ghim không rò sang VPS khác');
const other = await page.evaluate(
  async ([base, sid]) => {
    const r = await fetch(`${base}/api/servers`, {
      headers: { Authorization: 'Bearer ' + localStorage.getItem('token') },
    });
    const list = await r.json();
    const o = list.find((s) => s.id !== sid);
    return o ? { id: o.id, name: o.name, pinned: o.pinnedPath } : null;
  },
  [BASE, SID]
);
if (!other) bad('tìm VPS khác', 'chỉ có 1 server');
else if (other.pinned === null) ok('VPS khác vẫn chưa ghim', other.name);
else bad('ghim bị dùng chung', `${other.name} có pinnedPath=${other.pinned}`);

// ------------------------------------------- 5. bỏ ghim -> quay lại mặc định
console.log('\n[5] Bỏ ghim');
const btn2 = pinButton();
await btn2.click();
await page.waitForTimeout(2500);
const after = await page.evaluate(
  async ([base, sid]) => {
    const r = await fetch(`${base}/api/servers`, {
      headers: { Authorization: 'Bearer ' + localStorage.getItem('token') },
    });
    return (await r.json()).find((s) => s.id === sid)?.pinnedPath ?? null;
  },
  [BASE, SID]
);
if (after === null) ok('đã bỏ ghim'); else bad('bỏ ghim', `vẫn còn ${after}`);

await page.evaluate((sid) => localStorage.removeItem('files_path_' + sid), SID);
await page.goto(`${BASE}/dashboard/files/?serverId=${SID}`, { waitUntil: 'networkidle' });
await page.waitForTimeout(3500);
dir = await currentDir();
if (/root/.test(dir || '')) ok('quay lại /root sau khi bỏ ghim', dir);
else bad('sau khi bỏ ghim', `đang ở ${dir}`);

// ----------------------------------------- 6. từ chối ghim thư mục không có
console.log('\n[6] Ghim đường dẫn không tồn tại');
const resp = await page.evaluate(
  async ([base, sid]) => {
    const r = await fetch(`${base}/api/servers/${sid}/pin`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + localStorage.getItem('token'),
      },
      body: JSON.stringify({ path: '/khong-he-ton-tai-abc123' }),
    });
    return { status: r.status, body: await r.json() };
  },
  [BASE, SID]
);
if (resp.status === 400) ok('từ chối thư mục không tồn tại', resp.body.error?.slice(0, 50));
else bad('không kiểm tồn tại', `HTTP ${resp.status}`);

console.log('\n' + '='.repeat(58));
console.log(`\nKẾT QUẢ: ${pass} đạt / ${fail} lỗi   (ảnh ở ${OUT})`);
await browser.close();
process.exit(fail ? 1 : 0);
