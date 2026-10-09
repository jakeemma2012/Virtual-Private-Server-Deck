/**
 * Test kéo-thả upload — đúng 3 lỗi đã báo:
 *   1. overlay "nháy nháy" khi rê chuột qua danh sách
 *   2. bảng upload nhấp nháy / spam khi kéo nhiều file
 *   3. buông tay ngoài vùng danh sách thì trình duyệt MỞ file thay vì upload
 *
 * BASE=... PW=... SID=... node e2e/upload.mjs
 */
import { chromium } from 'playwright';
import fs from 'node:fs';

const BASE = process.env.BASE || 'http://127.0.0.1:8099';
const PASS = process.env.PW;
const SID = process.env.SID;
const DIR = process.env.DIR || '/tmp/jake-upload-test';
const OUT = '/tmp/jake-e2e';
fs.mkdirSync(OUT, { recursive: true });

let pass = 0, fail = 0;
const ok = (n, x = '') => { pass++; console.log(`  OK   ${n}${x ? ' — ' + x : ''}`); };
const bad = (n, w) => { fail++; console.log(`  LỖI  ${n} — ${w}`); };

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 }, locale: 'vi-VN' });
const page = await ctx.newPage();
const navs = [];
page.on('framenavigated', (f) => { if (f === page.mainFrame()) navs.push(f.url()); });

await page.goto(`${BASE}/auth/`, { waitUntil: 'networkidle' });
await page.locator('input').first().fill('admin');
await page.locator('input[type="password"]').first().fill(PASS);
await page.keyboard.press('Enter');
await page.waitForURL(/dashboard/, { timeout: 15000 });

await page.goto(`${BASE}/dashboard/files/?serverId=${SID}`, { waitUntil: 'networkidle' });
await page.waitForTimeout(2500);

// Đi tới thư mục test (tạo sẵn bằng terminal ở bước chuẩn bị).
await page.locator('[title="Edit path"]').first().click();
await page.waitForTimeout(300);
const pathInput = page.locator('input.font-mono').first();
// Overlay phải test ở thư mục ĐÔNG dòng — đó là lúc dragleave bắn liên tục.
await pathInput.fill('/var/lib/dpkg/info');
await pathInput.press('Enter');
await page.waitForTimeout(6000);

/** Tạo một DataTransfer có file thật trong trang. */
const makeDT = (names) =>
  page.evaluateHandle((ns) => {
    const dt = new DataTransfer();
    for (const n of ns) {
      dt.items.add(new File([new Uint8Array(2048).fill(65)], n, { type: 'text/plain' }));
    }
    return dt;
  }, names);

// ---------------------------------------------------- 1. overlay không nháy
console.log('\n[1] Overlay khi rê chuột qua danh sách');
const dt1 = await makeDT(['a.txt']);
const zone = page.locator('[data-dropzone="files"]');

// Theo dõi overlay bật/tắt bao nhiêu lần trong lúc rê chuột.
await page.evaluate(() => {
  window.__ovToggles = 0;
  window.__ovLast = null;
  window.__ovObs = new MutationObserver(() => {
    const on = !!document.querySelector('.border-dashed.border-primary');
    if (on !== window.__ovLast) { window.__ovLast = on; window.__ovToggles++; }
  });
  window.__ovObs.observe(document.body, { childList: true, subtree: true });
});

await zone.dispatchEvent('dragenter', { dataTransfer: dt1 });
// Rê qua nhiều dòng của bảng: đây chính là lúc bản cũ nháy.
// Mô phỏng đúng chuỗi sự kiện của trình duyệt khi rê qua các dòng:
// dragleave(dòng cũ, relatedTarget = dòng mới) rồi dragenter(dòng mới).
const n = await page.evaluate(() => {
  const rows = [...document.querySelectorAll('tbody tr[data-name]')].slice(0, 12);
  const mk = (type, related) => {
    const ev = new DragEvent(type, { bubbles: true, cancelable: true, relatedTarget: related });
    Object.defineProperty(ev, 'dataTransfer', { value: new DataTransfer() });
    ev.dataTransfer.items.add(new File(['x'], 'a.txt'));
    return ev;
  };
  for (let i = 0; i < rows.length; i++) {
    const next = rows[i + 1] || rows[0];
    rows[i].dispatchEvent(mk('dragover', null));
    rows[i].dispatchEvent(mk('dragleave', next));
    next.dispatchEvent(mk('dragenter', rows[i]));
  }
  return rows.length;
});
await page.waitForTimeout(500);

const toggles = await page.evaluate(() => window.__ovToggles);
const visible = await page.evaluate(() => !!document.querySelector('.border-dashed.border-primary'));
if (visible && toggles <= 2) ok('overlay ổn định khi rê qua các dòng', `${toggles} lần đổi trạng thái / ${n} dòng`);
else bad('overlay nháy', `${toggles} lần bật-tắt khi rê qua ${n} dòng, đang hiện: ${visible}`);

await page.screenshot({ path: `${OUT}/U1-overlay.png` });
await zone.dispatchEvent('dragleave', { dataTransfer: dt1 });
await page.waitForTimeout(300);

// ------------------------------------- 2. thả NGOÀI danh sách: không điều hướng
// Chuyển sang thư mục rỗng cho phần upload.
await page.locator('[title="Edit path"]').first().click();
await page.waitForTimeout(300);
await page.locator('input.font-mono').first().fill(DIR);
await page.locator('input.font-mono').first().press('Enter');
await page.waitForTimeout(3500);

console.log('\n[2] Thả ngoài vùng danh sách');
navs.length = 0;
const dt2 = await makeDT(['ngoai-vung.txt']);
// Thả lên thanh công cụ (không phải bảng danh sách).
const toolbar = page.locator('[data-dropzone="files"] div.border-b').first();
await toolbar.dispatchEvent('dragenter', { dataTransfer: dt2 });
await toolbar.dispatchEvent('dragover', { dataTransfer: dt2 });
await toolbar.dispatchEvent('drop', { dataTransfer: dt2 });
await page.waitForTimeout(3500);

if (navs.length === 0) ok('không bị điều hướng khi thả ngoài bảng');
else bad('trình duyệt mở file', `đã điều hướng tới ${navs[navs.length - 1]}`);

const uploadedOutside = await page.evaluate(() =>
  [...document.querySelectorAll('*')].some((e) => (e.textContent || '').includes('ngoai-vung.txt'))
);
if (uploadedOutside) ok('thả ngoài bảng vẫn upload', 'ngoai-vung.txt xuất hiện');
else bad('thả ngoài bảng', 'file không được nhận');

// --------------------------------- 3. kéo nhiều file: bảng upload không spam
console.log('\n[3] Kéo 8 file cùng lúc');
const names = Array.from({ length: 8 }, (_, i) => `lo-${i + 1}.txt`);
const dt3 = await makeDT(names);

// Đếm số lần dòng upload bị unmount rồi mount lại (chính là "nháy").
// Đếm số lần một dòng upload bị GỠ khỏi DOM. Dòng bị gỡ rồi dựng lại giữa
// chừng chính là "nháy". Tám file thì được phép 0 lần gỡ cho tới khi xong.
await page.evaluate(() => {
  window.__rowRemovals = 0;
  window.__rowSeen = new Set();
  window.__rowObs = new MutationObserver((muts) => {
    for (const m of muts) {
      for (const node of m.addedNodes) {
        if (node.nodeType === 1 && node.getAttribute?.('data-upload-id')) {
          window.__rowSeen.add(node.getAttribute('data-upload-id'));
        }
      }
      for (const node of m.removedNodes) {
        if (node.nodeType === 1 && node.getAttribute?.('data-upload-id')) {
          window.__rowRemovals++;
        }
      }
    }
  });
  window.__rowObs.observe(document.body, { childList: true, subtree: true });
});

await zone.dispatchEvent('dragenter', { dataTransfer: dt3 });
await zone.dispatchEvent('dragover', { dataTransfer: dt3 });
await zone.dispatchEvent('drop', { dataTransfer: dt3 });
await page.waitForTimeout(9000);

const { seen, removals } = await page.evaluate(() => ({
  seen: window.__rowSeen ? window.__rowSeen.size : 0,
  removals: window.__rowRemovals ?? -1,
}));
if (seen >= 8 && removals === 0) {
  ok('dòng upload giữ nguyên, không dựng lại', `${seen} dòng, ${removals} lần bị gỡ`);
} else if (seen < 8) {
  bad('không thấy đủ dòng upload', `chỉ ${seen}/8 dòng xuất hiện`);
} else {
  bad('dòng upload bị dựng lại', `${removals} lần bị gỡ khỏi DOM giữa chừng`);
}

const overlayGone = await page.evaluate(() => !document.querySelector('.border-dashed.border-primary'));
if (overlayGone) ok('overlay tắt sau khi thả'); else bad('overlay', 'vẫn còn sau khi thả');

await page.screenshot({ path: `${OUT}/U3-uploads.png` });

// Kiểm file đã thật sự lên VPS: làm mới rồi tìm tên.
await page.waitForTimeout(2000);
const onServer = await page.evaluate(() =>
  [...document.querySelectorAll('tbody tr[data-name]')].map((r) => r.dataset.name)
);
const got = names.filter((nm) => onServer.includes(nm));
if (got.length === names.length) ok('cả 8 file đã lên VPS', got.length + '/8');
else bad('file trên VPS', `chỉ thấy ${got.length}/8: ${got.join(', ')}`);

console.log('\n' + '='.repeat(58));
console.log(`\nKẾT QUẢ: ${pass} đạt / ${fail} lỗi   (ảnh ở ${OUT})`);
await browser.close();
process.exit(fail ? 1 : 0);
