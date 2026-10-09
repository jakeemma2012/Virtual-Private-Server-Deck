/**
 * Test panel hai cột: duyệt thư mục local và kéo file sang VPS.
 *
 * Playwright cho phép trả lời sẵn hộp thoại chọn thư mục của hệ điều hành,
 * nên luồng này test tự động được đầu-cuối.
 *
 * BASE=... PW=... SID=... node e2e/split.mjs
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BASE = process.env.BASE || 'http://127.0.0.1:8099';
const PASS = process.env.PW;
const SID = process.env.SID;
const VPS_DIR = process.env.VPS_DIR || '/tmp/jake-split-test';
const OUT = '/tmp/jake-e2e';
fs.mkdirSync(OUT, { recursive: true });

let pass = 0, fail = 0;
const ok = (n, x = '') => { pass++; console.log(`  OK   ${n}${x ? ' — ' + x : ''}`); };
const bad = (n, w) => { fail++; console.log(`  LỖI  ${n} — ${w}`); };

// --- Dựng một cây thư mục thật trên máy để duyệt ---
const localRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jake-local-'));
fs.mkdirSync(path.join(localRoot, 'con'));
fs.writeFileSync(path.join(localRoot, 'tai-lieu-1.txt'), 'A'.repeat(1500));
fs.writeFileSync(path.join(localRoot, 'tai-lieu-2.txt'), 'B'.repeat(2500));
fs.writeFileSync(path.join(localRoot, 'tai-lieu-10.txt'), 'C'.repeat(900));
fs.writeFileSync(path.join(localRoot, 'con', 'ben-trong.txt'), 'D'.repeat(300));
console.log(`thư mục local test: ${localRoot}`);

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1700, height: 1000 }, locale: 'vi-VN' });
const page = await ctx.newPage();

// Giả lập `showDirectoryPicker`.
//
// Headless Chromium không phát sự kiện filechooser cho API này, nên không lái
// được hộp thoại thật. Hộp thoại là code của TRÌNH DUYỆT — cái cần test là
// code của mình: liệt kê, sắp xếp, chọn, đọc File, upload. Mock dưới đây hiện
// thực đúng phần API mà lib/local-fs.ts dùng tới.
const tree = {
  name: 'jake-local-test',
  dirs: { con: { name: 'con', dirs: {}, files: { 'ben-trong.txt': 300 } } },
  files: { 'tai-lieu-1.txt': 1500, 'tai-lieu-2.txt': 2500, 'tai-lieu-10.txt': 900 },
};
await page.addInitScript((t) => {
  const mkFileHandle = (name, size) => ({
    kind: 'file',
    name,
    getFile: async () =>
      new File([new Uint8Array(size).fill(65)], name, {
        type: 'text/plain',
        lastModified: Date.now() - 86400000,
      }),
  });
  const mkDirHandle = (node) => ({
    kind: 'directory',
    name: node.name,
    queryPermission: async () => 'granted',
    requestPermission: async () => 'granted',
    getDirectoryHandle: async (n) => {
      if (!node.dirs[n]) throw new Error('NotFoundError');
      return mkDirHandle(node.dirs[n]);
    },
    values: async function* () {
      for (const d of Object.values(node.dirs)) yield mkDirHandle(d);
      for (const [n, size] of Object.entries(node.files)) yield mkFileHandle(n, size);
    },
  });
  window.showDirectoryPicker = async () => mkDirHandle(t);
}, tree);

await page.goto(`${BASE}/auth/`, { waitUntil: 'networkidle' });
await page.locator('input').first().fill('admin');
await page.locator('input[type="password"]').first().fill(PASS);
await page.keyboard.press('Enter');
await page.waitForURL(/dashboard/, { timeout: 15000 });

await page.goto(`${BASE}/dashboard/files/?serverId=${SID}`, { waitUntil: 'networkidle' });
await page.waitForTimeout(3000);

// Vào thư mục đích trên VPS.
await page.locator('[title="Edit path"]').first().click();
await page.waitForTimeout(300);
const pi = page.locator('input.font-mono').first();
await pi.fill(VPS_DIR);
await pi.press('Enter');
await page.waitForTimeout(3500);

// ------------------------------------------------------- 1. bật hai cột
console.log('\n[1] Bật chế độ hai cột');
const splitBtn = page.locator('[data-testid="split-btn"]');
if (await splitBtn.count() === 0) {
  bad('tìm nút hai cột', 'không thấy [data-testid="split-btn"]');
} else {
  await splitBtn.click();
  await page.waitForTimeout(800);
  const paneVisible = await page.evaluate(() =>
    [...document.querySelectorAll('*')].some((e) => (e.textContent || '').trim() === 'Máy của bạn')
  );
  if (paneVisible) ok('panel "Máy của bạn" hiện ra');
  else bad('panel local', 'không thấy');
}

// -------------------------------------------- 2. chọn thư mục trên máy
console.log('\n[2] Chọn thư mục trên máy');
await page.locator('button:has-text("Chọn thư mục")').first().click();
await page.waitForTimeout(2000);

const names = await page.evaluate(() =>
  [...document.querySelectorAll('[data-local-name]')].map((e) => e.getAttribute('data-local-name'))
);
if (names.length > 0) {
  ok('duyệt được thư mục local', `${names.length} mục: ${names.slice(0, 4).join(', ')}`);
} else {
  bad('duyệt thư mục local', 'không có mục nào — hộp thoại có thể không mở được trong headless');
}

// --------------------------------------- 3. sắp xếp: thư mục trước, số tự nhiên
if (names.length > 0) {
  console.log('\n[3] Thứ tự hiển thị');
  const idxCon = names.indexOf('con');
  const i1 = names.indexOf('tai-lieu-1.txt');
  const i2 = names.indexOf('tai-lieu-2.txt');
  const i10 = names.indexOf('tai-lieu-10.txt');
  if (idxCon === 0) ok('thư mục xếp trước file');
  else bad('thư mục xếp trước file', `'con' ở vị trí ${idxCon}`);
  if (i1 < i2 && i2 < i10) ok('sắp xếp tự nhiên', 'tai-lieu-1 < 2 < 10');
  else bad('sắp xếp tự nhiên', `thứ tự: 1=${i1}, 2=${i2}, 10=${i10}`);
}

await page.screenshot({ path: `${OUT}/S-split.png` });

// --------------------------------------------- 4. chọn file rồi bấm Tải lên
if (names.length > 0) {
  console.log('\n[4] Chọn file và tải lên VPS');
  await page.evaluate(() => {
    for (const n of ['tai-lieu-1.txt', 'tai-lieu-2.txt']) {
      document.querySelector(`[data-local-name="${n}"]`)?.dispatchEvent(
        new MouseEvent('click', { bubbles: true })
      );
    }
  });
  await page.waitForTimeout(400);
  const upBtn = page.locator('button:has-text("Tải lên")').first();
  if (await upBtn.count() > 0) {
    await upBtn.click();
    await page.waitForTimeout(7000);
    const onVps = await page.evaluate(() =>
      [...document.querySelectorAll('tbody tr[data-name]')].map((r) => r.dataset.name)
    );
    const got = ['tai-lieu-1.txt', 'tai-lieu-2.txt'].filter((n) => onVps.includes(n));
    if (got.length === 2) ok('2 file đã lên VPS', got.join(', '));
    else bad('tải lên VPS', `chỉ thấy ${got.length}/2 trên VPS: ${onVps.slice(0, 6).join(', ')}`);
  } else {
    bad('nút Tải lên', 'không thấy');
  }
}

// ------------------------------------------- 5. KÉO từ phải sang trái
if (names.length > 0) {
  console.log('\n[5] Kéo file từ panel local sang panel VPS');
  const before = await page.evaluate(() =>
    [...document.querySelectorAll('tbody tr[data-name]')].map((r) => r.dataset.name)
  );

  const dragged = await page.evaluate(async () => {
    const row = document.querySelector('[data-local-name="tai-lieu-10.txt"]');
    const zone = document.querySelector('[data-dropzone="files"]');
    if (!row || !zone) return 'không thấy row hoặc dropzone';

    const dt = new DataTransfer();
    const mk = (type) => {
      const ev = new DragEvent(type, { bubbles: true, cancelable: true });
      Object.defineProperty(ev, 'dataTransfer', { value: dt });
      return ev;
    };
    // Bỏ chọn hai file đã upload ở bước 4, để lô kéo chỉ có đúng một file mới
    // (nếu không sẽ dính hộp thoại trùng tên và làm nhiễu phép đo).
    for (const n of ['tai-lieu-1.txt', 'tai-lieu-2.txt']) {
      document.querySelector(`[data-local-name="${n}"]`)
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    }
    await new Promise((r) => setTimeout(r, 200));
    // Chọn file cần kéo, đúng như người dùng làm.
    row.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 200));

    row.dispatchEvent(mk('dragstart'));
    // startDrag đọc File() bất đồng bộ -> chờ nó nạp vào ref của trang cha.
    await new Promise((r) => setTimeout(r, 600));
    if (!dt.types.includes('application/x-jake-local')) {
      return 'dragstart không đặt được kiểu dữ liệu nội bộ';
    }
    zone.dispatchEvent(mk('dragenter'));
    zone.dispatchEvent(mk('dragover'));
    zone.dispatchEvent(mk('drop'));
    return 'ok';
  });

  if (dragged !== 'ok') {
    bad('kéo sang trái', dragged);
  } else {
    // Chờ CÓ ĐIỀU KIỆN, không chờ cứng: upload xong mới làm mới danh sách,
    // và thời gian phụ thuộc đường truyền tới VPS.
    let appeared = false;
    for (let i = 0; i < 30 && !appeared; i++) {
      await page.waitForTimeout(700);
      appeared = await page.evaluate(() =>
        [...document.querySelectorAll('tbody tr[data-name]')].some(
          (r) => r.dataset.name === 'tai-lieu-10.txt'
        )
      );
    }
    if (appeared && !before.includes('tai-lieu-10.txt')) {
      ok('kéo sang trái đã tải lên VPS', 'tai-lieu-10.txt');
    } else {
      const after = await page.evaluate(() =>
        [...document.querySelectorAll('tbody tr[data-name]')].map((r) => r.dataset.name)
      );
      bad('kéo sang trái', `VPS đang có: ${after.join(', ')}`);
    }
  }
  await page.screenshot({ path: `${OUT}/S-dragged.png` });
}

await page.screenshot({ path: `${OUT}/S-uploaded.png` });

// =====================================================================
// 6. ĐƯỜNG DỰ PHÒNG: giả lập Brave (không có showDirectoryPicker)
// =====================================================================
console.log('\n[6] Brave: không có File System Access API');
{
  const ctx2 = await browser.newContext({ viewport: { width: 1700, height: 1000 }, locale: 'vi-VN' });
  const p2 = await ctx2.newPage();
  // Đúng cách Brave làm: xoá hẳn API khỏi window.
  await p2.addInitScript(() => {
    delete window.showDirectoryPicker;
    Object.defineProperty(navigator, 'brave', {
      value: { isBrave: async () => true },
      configurable: true,
    });
  });

  await p2.goto(`${BASE}/auth/`, { waitUntil: 'networkidle' });
  await p2.locator('input').first().fill('admin');
  await p2.locator('input[type="password"]').first().fill(PASS);
  await p2.keyboard.press('Enter');
  await p2.waitForURL(/dashboard/, { timeout: 15000 });
  await p2.goto(`${BASE}/dashboard/files/?serverId=${SID}`, { waitUntil: 'networkidle' });
  await p2.waitForTimeout(2500);
  await p2.locator('[title="Edit path"]').first().click();
  await p2.waitForTimeout(300);
  const pi2 = p2.locator('input.font-mono').first();
  await pi2.fill(VPS_DIR);
  await pi2.press('Enter');
  await p2.waitForTimeout(3500);
  await p2.locator('[data-testid="split-btn"]').click();
  await p2.waitForTimeout(600);

  // Panel vẫn phải mở được, kèm ghi chú về Brave.
  const note = await p2.evaluate(() => document.body.innerText);
  if (/Brave tắt sẵn/.test(note)) ok('hiện đúng ghi chú về Brave');
  else bad('ghi chú Brave', 'không thấy');
  if (/Chọn thư mục/.test(note)) ok('nút "Chọn thư mục" vẫn dùng được');
  else bad('nút chọn thư mục', 'bị chặn mất');

  // Chọn thư mục qua <input webkitdirectory> — Playwright set được thẳng.
  const chooser2 = p2.waitForEvent('filechooser');
  await p2.locator('button:has-text("Chọn thư mục")').first().click();
  const fc2 = await chooser2;
  await fc2.setFiles(localRoot);
  await p2.waitForTimeout(2500);

  const names2 = await p2.evaluate(() =>
    [...document.querySelectorAll('[data-local-name]')].map((e) => e.getAttribute('data-local-name'))
  );
  if (names2.length >= 4) {
    ok('đường dự phòng duyệt được thư mục', `${names2.length} mục: ${names2.slice(0, 4).join(', ')}`);
  } else {
    bad('đường dự phòng', `chỉ thấy ${names2.length} mục: ${names2.join(', ')}`);
  }
  if (names2[0] === 'con') ok('thư mục con vẫn xếp trước'); else bad('thứ tự', `đầu danh sách là ${names2[0]}`);

  // Vào thư mục con rồi upload file bên trong.
  await p2.evaluate(() =>
    document.querySelector('[data-local-name="con"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  );
  await p2.waitForTimeout(1200);
  const inner = await p2.evaluate(() =>
    [...document.querySelectorAll('[data-local-name]')].map((e) => e.getAttribute('data-local-name'))
  );
  if (inner.includes('ben-trong.txt')) ok('vào được thư mục con', inner.join(', '));
  else bad('vào thư mục con', `thấy: ${inner.join(', ')}`);

  await p2.evaluate(() =>
    document.querySelector('[data-local-name="ben-trong.txt"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  );
  await p2.waitForTimeout(400);
  await p2.locator('button:has-text("Tải lên")').first().click();

  let up = false;
  for (let i = 0; i < 30 && !up; i++) {
    await p2.waitForTimeout(700);
    up = await p2.evaluate(() =>
      [...document.querySelectorAll('tbody tr[data-name]')].some((r) => r.dataset.name === 'ben-trong.txt')
    );
  }
  if (up) ok('đường dự phòng upload lên VPS được', 'ben-trong.txt');
  else bad('đường dự phòng upload', 'file không lên VPS');

  await p2.screenshot({ path: `${OUT}/S-brave.png` });
  await ctx2.close();
}

// =====================================================================
// 7. Split ĐỘC LẬP theo từng tab
// =====================================================================
console.log('\n[7] Mỗi tab có panel local riêng');
{
  const ctx3 = await browser.newContext({ viewport: { width: 1700, height: 1000 }, locale: 'vi-VN' });
  const p3 = await ctx3.newPage();
  await p3.addInitScript((t) => {
    const mkFileHandle = (name, size) => ({
      kind: 'file', name,
      getFile: async () => new File([new Uint8Array(size).fill(65)], name, { type: 'text/plain' }),
    });
    const mkDirHandle = (node) => ({
      kind: 'directory', name: node.name,
      queryPermission: async () => 'granted',
      requestPermission: async () => 'granted',
      getDirectoryHandle: async (n) => {
        if (!node.dirs[n]) throw new Error('NotFoundError');
        return mkDirHandle(node.dirs[n]);
      },
      values: async function* () {
        for (const d of Object.values(node.dirs)) yield mkDirHandle(d);
        for (const [n, size] of Object.entries(node.files)) yield mkFileHandle(n, size);
      },
    });
    window.showDirectoryPicker = async () => mkDirHandle(t);
  }, tree);

  await p3.goto(`${BASE}/auth/`, { waitUntil: 'networkidle' });
  await p3.locator('input').first().fill('admin');
  await p3.locator('input[type="password"]').first().fill(PASS);
  await p3.keyboard.press('Enter');
  await p3.waitForURL(/dashboard/, { timeout: 15000 });
  await p3.goto(`${BASE}/dashboard/files/?serverId=${SID}`, { waitUntil: 'networkidle' });
  await p3.waitForTimeout(3000);

  const paneCount = () => p3.evaluate(() => document.querySelectorAll('[data-split-tab]').length);
  const visiblePane = () =>
    p3.evaluate(() => {
      const el = [...document.querySelectorAll('[data-split-tab]')].find(
        (d) => d.style.display !== 'none'
      );
      return el ? el.getAttribute('data-split-tab') : null;
    });
  const paneHasFiles = () =>
    p3.evaluate(() => {
      const el = [...document.querySelectorAll('[data-split-tab]')].find(
        (d) => d.style.display !== 'none'
      );
      return el ? el.querySelectorAll('[data-local-name]').length : -1;
    });

  // Tab 1: mở split, chọn thư mục.
  await p3.locator('[data-testid="split-btn"]').click();
  await p3.waitForTimeout(500);
  await p3.locator('button:has-text("Chọn thư mục")').first().click();
  await p3.waitForTimeout(1500);
  const tab1Files = await paneHasFiles();
  if (tab1Files >= 4) ok('tab 1: đã chọn thư mục', `${tab1Files} mục`);
  else bad('tab 1 chọn thư mục', `${tab1Files} mục`);

  // Tạo tab 2.
  await p3.evaluate(() => {
    const btns = [...document.querySelectorAll('button')];
    const add = btns.find((b) => b.querySelector('svg') && b.closest('.overflow-x-auto'));
    add?.click();
  });
  await p3.waitForTimeout(2500);

  const vis2 = await visiblePane();
  if (vis2 === null) ok('tab 2: split mặc định ĐÓNG, không ăn theo tab 1');
  else bad('tab 2', `panel của tab ${vis2} đang mở sẵn`);

  // Bật split ở tab 2 -> phải trống, phải chọn lại thư mục.
  await p3.locator('[data-testid="split-btn"]').click();
  await p3.waitForTimeout(800);
  const n2 = await paneHasFiles();
  const total = await paneCount();
  if (n2 === 0) ok('tab 2: panel trống, phải chọn lại thư mục');
  else bad('tab 2 panel', `đã có sẵn ${n2} mục (ăn theo tab 1)`);
  if (total === 2) ok('hai panel tồn tại song song', `${total} panel trong DOM`);
  else bad('số panel', `${total} panel`);

  // Quay lại tab 1 -> thư mục cũ vẫn còn.
  const paneIdBefore = await visiblePane();
  await p3.evaluate(() => {
    // Thanh tab: mỗi tab là một div có icon thư mục + nhãn. Lấy cái đầu tiên.
    const bar = document.querySelector('.overflow-x-auto');
    const first = bar?.querySelector('div');
    first?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await p3.waitForTimeout(2500);
  const paneIdAfter = await visiblePane();
  const back = await paneHasFiles();
  if (paneIdAfter === paneIdBefore) {
    bad('chuyển về tab 1', `vẫn đang ở panel ${paneIdAfter} — test không bấm trúng tab`);
  } else if (back >= 4) {
    ok('quay lại tab 1: thư mục cũ còn nguyên', `panel ${paneIdAfter}, ${back} mục`);
  } else {
    bad('tab 1 sau khi quay lại', `panel ${paneIdAfter}, ${back} mục — trạng thái bị mất`);
  }

  await p3.screenshot({ path: `${OUT}/S-tabs.png` });
  await ctx3.close();
}

console.log('\n' + '='.repeat(58));
console.log(`\nKẾT QUẢ: ${pass} đạt / ${fail} lỗi   (ảnh ở ${OUT})`);
fs.rmSync(localRoot, { recursive: true, force: true });
await browser.close();
process.exit(fail ? 1 : 0);
