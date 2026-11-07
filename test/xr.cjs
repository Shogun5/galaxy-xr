// 用 iwer 模擬 Quest 3,在無頭 Chrome 裡測 VR 流程與 SBS 模式
const http = require('http'), fs = require('fs'), path = require('path');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');
const server = http.createServer((q, r) => {
  const f = path.join(root, q.url === '/' ? 'index.html' : q.url.split('?')[0]);
  if (!fs.existsSync(f)) { r.writeHead(404).end(); return; }
  r.writeHead(200, { 'content-type': f.endsWith('.html') ? 'text/html' : 'text/javascript' }); fs.createReadStream(f).pipe(r);
});
const out = {};
const check = (k, v) => { out[k] = v; console.log((v ? 'PASS ' : 'FAIL ') + k); };
(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--use-gl=angle', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const errors = [];
  // ---------- VR ----------
  {
    const page = await browser.newPage({ viewport: { width: 960, height: 600 } });
    page.on('pageerror', e => errors.push('vr: ' + e));
    page.on('console', m => { if (m.type() === 'error') errors.push('vr: ' + m.text()); });
    await page.addInitScript({ path: path.join(__dirname, 'null-fb-shim.js') });
    await page.addInitScript({ path: path.join(__dirname, 'iwer.js') });
    await page.goto(url);
    await page.waitForFunction(() => window.__galaxy, null, { timeout: 120000 });
    const g = await page.evaluate(() => ({ xr: __galaxy.xrSupported, backend: __galaxy.backend, btn: !document.getElementById('vr-btn').hidden }));
    check('偵測到 VR 並顯示「進入 VR」', g.xr && g.btn);
    check('VR 時使用 WebGL2 後端', /WebGL2/.test(g.backend));
    await page.click('#vr-btn');
    await page.waitForFunction(() => __galaxy.mode === 'vr', null, { timeout: 60000 });
    const s = await page.evaluate(() => ({ sc: __galaxy.world.scale.x, y: __galaxy.world.position.y }));
    check('進入 VR:銀河縮小並移到面前', Math.abs(s.sc - 0.22) < 1e-6 && s.y > 1);
    const frames = async n => { const f0 = await page.evaluate(() => __galaxy.loopFrames); await page.waitForFunction(([f, k]) => __galaxy.loopFrames >= f + k, [f0, n], { timeout: 120000 }); };
    await page.waitForTimeout(3000);
    console.log('debug', await page.evaluate(() => ({ lf: __galaxy.loopFrames, pres: __galaxy.renderer.xr.isPresenting, s: !!__galaxy.renderer.xr.getSession() })));
    await frames(3);
    // 右手伸進銀河
    await page.evaluate(() => { const c = __xrdev.controllers.right; c.position.set(0.35, 1.15, -1.45); c.quaternion.set(0, 0, 0, 1); __xrdev.controllers.left.position.set(-2, 0.5, 1); });
    await frames(8);
    const stir = await page.evaluate(async () => { const o = await __galaxy.readOffsets(); let n = 0; for (let i = 0; i < o.length; i += 3) if (Math.hypot(o[i], o[i + 1], o[i + 2]) > 0.05) n++; return { n, on: __galaxy.mouseOn }; });
    check(`手伸進銀河會撥動星塵(${stir.n} 顆被推開)`, stir.n > 200 && stir.on > 0.3);
    // 手移開、扳機引爆
    await page.evaluate(() => { __xrdev.controllers.right.position.set(0.2, 1.6, -0.3); });
    await page.evaluate(async () => { await __galaxy.renderer.compute; });
    await frames(30);
    const before = await page.evaluate(async () => { const o = await __galaxy.readOffsets(); let n = 0; for (let i = 0; i < o.length; i += 3) if (Math.hypot(o[i], o[i + 1], o[i + 2]) > 0.1) n++; return n; });
    await page.evaluate(() => { const c = __xrdev.controllers.right; c.quaternion.set(-0.38, 0, 0, 0.92); c.updateButtonValue('trigger', 1); });
    await frames(3);
    await page.evaluate(() => __xrdev.controllers.right.updateButtonValue('trigger', 0));
    await frames(6);
    const after = await page.evaluate(async () => { const o = await __galaxy.readOffsets(); let m = 0, n = 0; for (let i = 0; i < o.length; i += 3) { const d = Math.hypot(o[i], o[i + 1], o[i + 2]); m = Math.max(m, d); if (d > 0.1) n++; } return { m, n }; });
    check(`扳機引爆衝擊波(被推開的粒子 ${before} → ${after.n} 顆)`, after.n > before + 2000);
    // 搖桿往上推 = 放大
    await page.evaluate(() => __xrdev.controllers.right.updateAxes('thumbstick', 0, -1));
    await frames(10);
    await page.evaluate(() => __xrdev.controllers.right.updateAxes('thumbstick', 0, 0));
    const sc2 = await page.evaluate(() => __galaxy.world.scale.x);
    check(`搖桿縮放(0.22 → ${sc2.toFixed(3)})`, sc2 > 0.225);
    // 握把 = 暫停自轉
    const spin0 = await page.evaluate(() => __galaxy.params.galaxySpin);
    await page.evaluate(() => __xrdev.controllers.right.updateButtonValue('squeeze', 1));
    await frames(3);
    await page.evaluate(() => __xrdev.controllers.right.updateButtonValue('squeeze', 0));
    await frames(2);
    check('握把切換自轉', (await page.evaluate(() => __galaxy.params.galaxySpin)) !== spin0);
    await page.screenshot({ path: path.join(root, 'test/vr.png'), timeout: 180000 });
    await page.evaluate(() => { window.__ended = 0; const ss = __galaxy.renderer.xr.getSession(); ss.addEventListener('end', () => window.__ended++); return ss.end(); });
    await page.waitForTimeout(4000);
    console.log('errs', errors.length, errors.map(e=>e.split('\n')[0]+' | '+e.split('\n').slice(1,14).map(l=>l.trim().split(' ')[1]).join('<')).slice(0,4)); console.log('debug-end', await page.evaluate(() => ({ ended: __ended, pres: __galaxy.renderer.xr.isPresenting, mode: __galaxy.mode, lf: __galaxy.loopFrames })));
    await page.waitForFunction(() => __galaxy.mode === 'flat', null, { timeout: 60000 });
    const back = await page.evaluate(() => ({ sc: __galaxy.world.scale.x, t: document.getElementById('vr-btn').textContent }));
    check('離開 VR 後恢復桌面版', back.sc === 1 && back.t === '進入 VR');
    await page.close();
  }
  // ---------- SBS ----------
  {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    page.on('pageerror', e => errors.push('sbs: ' + e));
    page.on('console', m => { if (m.type() === 'error') errors.push('sbs: ' + m.text()); });
    await page.goto(url);
    await page.waitForFunction(() => window.__galaxy, null, { timeout: 120000 });
    check('沒有 VR 的瀏覽器不顯示「進入 VR」', await page.evaluate(() => document.getElementById('vr-btn').hidden));
    await page.evaluate(() => { __galaxy.params.autoRotate = false; __galaxy.params.galaxySpin = false; });
    await page.click('#sbs-btn');
    await page.waitForTimeout(4000);
    const ui = await page.evaluate(() => ({ mode: __galaxy.mode, hud: getComputedStyle(document.getElementById('hud')).display, exit: getComputedStyle(document.getElementById('sbs-exit-l')).display }));
    check('SBS:隱藏介面、顯示離開鈕', ui.mode === 'sbs' && ui.hud === 'none' && ui.exit === 'block');
    await page.evaluate(() => document.querySelectorAll('.sbs-exit').forEach(b => b.style.visibility = 'hidden'));
    await page.screenshot({ path: path.join(root, 'test/sbs.png'), timeout: 180000 });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
    check('Esc 離開 SBS', await page.evaluate(() => __galaxy.mode === 'flat' && getComputedStyle(document.getElementById('hud')).display !== 'none'));
    await page.close();
  }
  check('沒有錯誤訊息', errors.length === 0);
  if (errors.length) console.log(errors.slice(0, 8));
  await browser.close(); server.close();
  process.exit(Object.values(out).every(Boolean) ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
