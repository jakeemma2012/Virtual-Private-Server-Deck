import { chromium } from 'playwright';
const BASE=process.env.BASE, PASS=process.env.PW, SID=process.env.SID;
const b = await chromium.launch();
const p = await (await b.newContext({viewport:{width:1600,height:1000}})).newPage();
await p.goto(`${BASE}/auth/`,{waitUntil:'networkidle'});
await p.locator('input').first().fill('admin');
await p.locator('input[type="password"]').first().fill(PASS);
await p.keyboard.press('Enter');
await p.waitForURL(/dashboard/,{timeout:15000});
await p.goto(`${BASE}/dashboard/files/?serverId=${SID}`,{waitUntil:'networkidle'});
await p.waitForTimeout(3000);
await p.locator('[title="Edit path"]').first().click();
await p.waitForTimeout(300);
const inp = p.locator('input.font-mono').first();
await inp.fill('/var/lib/dpkg/info'); await inp.press('Enter');
await p.waitForTimeout(8000);

const chain = await p.evaluate(() => {
  let el = document.querySelector('table');
  const out = [];
  while (el && el !== document.documentElement && out.length < 12) {
    const s = getComputedStyle(el);
    out.push({
      tag: el.tagName.toLowerCase(),
      cls: (typeof el.className === 'string' ? el.className : '').slice(0, 46),
      display: s.display,
      overflowY: s.overflowY,
      minH: s.minHeight,
      h: Math.round(el.getBoundingClientRect().height),
      clientH: el.clientHeight,
      scrollH: el.scrollHeight,
    });
    el = el.parentElement;
  }
  return out;
});
console.log('từ <table> đi ngược lên:');
for (const c of chain) {
  console.log(`  ${c.tag.padEnd(5)} h=${String(c.h).padStart(6)} client=${String(c.clientH).padStart(6)} scroll=${String(c.scrollH).padStart(6)} ovY=${c.overflowY.padEnd(7)} minH=${c.minH.padEnd(6)} ${c.cls}`);
}
await b.close();
