// 銀河旋渦:three.js r187 WebGPURenderer + TSL compute,5 萬顆粒子 + bloom
// 瀏覽器沒有 WebGPU 時,WebGPURenderer 會自動改用 WebGL2 後端(同一份 TSL 程式)。
// XR 版:支援 WebXR(Quest 3 等頭盔)時改用 WebGL2 後端進 VR;另有左右並排(SBS)3D 模式給 XREAL 等眼鏡。
import * as THREE from 'three/webgpu';
import {
  Fn, If, instancedArray, instanceIndex, uniform, float, vec3, vec4, color,
  cos, sin, floor, mix, smoothstep, length, normalize, max, min, uv, pass, PI2,
} from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import GUI from 'three/addons/libs/lil-gui.module.min.js';

const MAX = 50000;          // 配置的粒子上限(也是預設數量)
const RADIUS = 6;           // 銀河半徑(世界單位)
const $ = id => document.getElementById(id);
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const forceWebGL = new URLSearchParams(location.search).has('webgl');

function fail(msg) {
  $('fallback').hidden = false;
  $('fallback-msg').textContent = msg;
  $('hud').hidden = true;
}

async function main() {
  // ---------- 渲染器 ----------
  // WebXR 目前以 WebGL2 後端最可靠,所以支援 VR 的瀏覽器(例如 Quest 瀏覽器)直接用 WebGL2。
  let xrSupported = false;
  try { xrSupported = !!navigator.xr && await navigator.xr.isSessionSupported('immersive-vr'); } catch { /* 不支援 */ }
  const renderer = new THREE.WebGPURenderer({ antialias: false, forceWebGL: forceWebGL || xrSupported });
  renderer.xr.enabled = true;
  try {
    await renderer.init();
  } catch (e) {
    console.warn(e);
    fail('這個瀏覽器既不支援 WebGPU,也無法建立 WebGL2。請改用新版 Chrome、Edge、Firefox 或 Safari。');
    return;
  }
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.domElement.id = 'view';
  document.body.prepend(renderer.domElement);
  const backendName = renderer.backend.isWebGPUBackend ? 'WebGPU' : 'WebGL2(退回模式)';

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x020308);
  const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.1, 200);
  const CAM_HOME = new THREE.Vector3(0, 7.5, 10.5);
  camera.position.copy(CAM_HOME);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.minDistance = 3;
  controls.maxDistance = 30;
  controls.autoRotateSpeed = 0.4;

  // ---------- 參數 ----------
  const params = {
    count: MAX, arms: 4, twist: 0.9, spread: 0.35, spin: 0.25, glow: 1.0,
    size: 1.0, stirRadius: 1.6, autoRotate: !reduceMotion, galaxySpin: !reduceMotion, dragStir: false,
  };
  const DEFAULTS = { ...params };

  const uArms = uniform(params.arms);
  const uTwist = uniform(params.twist);
  const uSpread = uniform(params.spread);
  const uSpin = uniform(0);          // 累積的自轉角(JS 端積分)
  const uDt = uniform(0);
  const uMouse = uniform(new THREE.Vector3(999, 0, 999));
  const uMouseOn = uniform(0);       // 0..1 推力強度
  const uStirR = uniform(params.stirRadius);
  const uBlast = uniform(0);         // 衝擊波的強度(只在觸發那一幀 > 0)
  const uBlastAt = uniform(new THREE.Vector3());
  const uSize = uniform(params.size);
  const uSpinRate = uniform(params.spin);

  // ---------- GPU 上的粒子資料 ----------
  // seed:半徑、旋臂亂數、高度、角度抖動;scatter:三軸散佈與大小
  const seed = instancedArray(MAX, 'vec4');
  const scatter = instancedArray(MAX, 'vec4');
  const offset = instancedArray(MAX, 'vec3');   // 被撥動後偏離原位的量
  const vel = instancedArray(MAX, 'vec3');

  {
    const s = seed.value.array, c = scatter.value.array;
    const gauss = () => (Math.random() + Math.random() + Math.random() - 1.5) / 1.5;
    for (let i = 0; i < MAX; i++) {
      const r = Math.pow(Math.random(), 1.6) * RADIUS + 0.05;   // 中心較密
      const thick = 0.12 + 0.5 * Math.exp(-r * 0.8);             // 核心較厚(凸核)
      s.set([r, Math.random(), gauss() * thick, gauss() * 0.35], i * 4);
      const k = Math.pow(Math.random(), 2.5);
      const sz = 0.025 + Math.pow(Math.random(), 6) * 0.09;       // 少數亮星較大
      c.set([gauss() * k * 2.2, gauss() * k * 0.5, gauss() * k * 2.2, sz], i * 4);
    }
    seed.value.needsUpdate = true;
    scatter.value.needsUpdate = true;
  }

  // ---------- TSL compute:每幀更新位置 ----------
  const homeOf = Fn(([s, c]) => {
    const r = s.x;
    const branch = floor(s.y.mul(uArms)).div(uArms).mul(PI2);
    const a = branch.add(r.mul(uTwist)).add(s.w).add(uSpin.mul(float(1.15).sub(r.div(RADIUS * 3))));
    const spreadScale = uSpread.mul(r.mul(0.35).add(0.3));
    return vec3(cos(a).mul(r), s.z, sin(a).mul(r)).add(c.xyz.mul(spreadScale));
  });

  const update = Fn(() => {
    const s = seed.element(instanceIndex);
    const c = scatter.element(instanceIndex);
    const o = offset.element(instanceIndex);
    const v = vel.element(instanceIndex);
    const home = homeOf(s, c);
    const p = home.add(o);

    // 滑鼠推開:半徑內依距離平方衰減
    const d = p.sub(uMouse);
    const dist = length(d).max(0.0001);
    const fall = max(float(1).sub(dist.div(uStirR)), 0);
    v.addAssign(normalize(d).mul(fall.mul(fall).mul(uMouseOn).mul(60).mul(uDt)));

    // 衝擊波(雙擊)
    const db = p.sub(uBlastAt);
    const bd = length(db).max(0.0001);
    v.addAssign(normalize(db).mul(uBlast.div(bd.mul(bd).add(0.6))));

    // 彈簧拉回 + 阻尼
    v.addAssign(o.mul(-2.2).mul(uDt));
    v.mulAssign(max(float(1).sub(uDt.mul(1.6)), 0));
    o.addAssign(v.mul(uDt));
  });
  const computeUpdate = update().compute(MAX);

  const resetKernel = Fn(() => {
    offset.element(instanceIndex).assign(vec3(0));
    vel.element(instanceIndex).assign(vec3(0));
  })().compute(MAX);

  // ---------- 粒子材質 ----------
  const mat = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  // WebGL2 退回模式用 transform feedback 跑 compute,輸出緩衝最多 4 個,
  // 所以最終位置不另存,在頂點著色器裡用同一個 homeOf() 再算一次。
  const sA = seed.toAttribute(), cA = scatter.toAttribute(), vA = vel.toAttribute();
  mat.positionNode = homeOf(sA, cA).add(offset.toAttribute());
  mat.scaleNode = cA.w.mul(uSize);
  const t = min(sA.x.div(RADIUS), 1).pow(0.55);
  const core = color(0xfff1d6).mul(3.2), mid = color(0xff8a4c).mul(1.4), outer = color(0x4f7dff).mul(1.3);
  const base = mix(mix(core, mid, smoothstep(0.0, 0.35, t)), outer, smoothstep(0.3, 0.85, t));
  const heat = min(length(vA).mul(0.35), 1);                      // 被撥動的粒子變亮、偏青白
  const col = mix(base, color(0xbff4ff).mul(3.5), heat);
  const disc = max(float(1).sub(length(uv().sub(0.5)).mul(2)), 0).pow(2.2);
  const uBright = uniform(0.55);   // 有 bloom 時 0.55;VR/SBS 沒有 bloom,改由 glowToBright() 提亮
  mat.colorNode = vec4(col.mul(disc).mul(uBright), disc);

  // 銀河與背景星空放在同一個群組:VR 時整組縮小並移到使用者面前
  const world = new THREE.Group();
  scene.add(world);
  const galaxy = new THREE.Sprite(mat);
  galaxy.count = params.count;
  galaxy.frustumCulled = false;
  world.add(galaxy);

  // 背景星空(靜態,少量)
  {
    const N = 1500, bg = instancedArray(N, 'vec4'), a = bg.value.array;
    for (let i = 0; i < N; i++) {
      const v = new THREE.Vector3().randomDirection().multiplyScalar(40 + Math.random() * 40);
      a.set([v.x, v.y, v.z, 0.08 + Math.random() * 0.18], i * 4);
    }
    bg.value.needsUpdate = true;
    const bm = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    const b = bg.toAttribute();
    bm.positionNode = b.xyz;
    bm.scaleNode = b.w;
    const dd = max(float(1).sub(length(uv().sub(0.5)).mul(2)), 0).pow(3);
    bm.colorNode = vec4(color(0xaab8ff).mul(dd).mul(0.6), dd);
    const stars = new THREE.Sprite(bm);
    stars.count = N;
    stars.frustumCulled = false;
    world.add(stars);
  }

  // ---------- Bloom 後製 ----------
  const pipeline = new THREE.RenderPipeline(renderer);
  const scenePass = pass(scene, camera);
  const beauty = scenePass.getTextureNode('output');
  const bloomNode = bloom(beauty, params.glow, 0.45, 0.25);
  pipeline.outputNode = beauty.add(bloomNode);

  // 沒有 bloom 後製時(VR、SBS),用粒子本身的亮度代替發光
  let mode = 'flat';                       // 'flat' | 'vr' | 'sbs'
  const glowToBright = () => (mode === 'flat' ? 0.55 : 0.75 + params.glow * 0.25);

  // ---------- 滑鼠/觸控:撥動粒子 ----------
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
  const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), hitP = new THREE.Vector3();
  let hover = false, dragging = false, lastMove = 0;
  const canvas = renderer.domElement;
  function toWorld(e) {
    const r = canvas.getBoundingClientRect();
    let x = (e.clientX - r.left) / r.width;
    if (mode === 'sbs') x = (x * 2) % 1;          // 左右兩半各是一隻眼睛的完整畫面
    ndc.set(x * 2 - 1, -(e.clientY - r.top) / r.height * 2 + 1);
    ray.setFromCamera(ndc, camera);
    return ray.ray.intersectPlane(plane, hitP);
  }
  canvas.addEventListener('pointermove', e => {
    const p = toWorld(e);
    if (p && p.length() < RADIUS * 1.6) { uMouse.value.copy(p); hover = true; lastMove = performance.now(); }
    else hover = false;
  });
  canvas.addEventListener('pointerleave', () => { hover = false; });
  canvas.addEventListener('pointerdown', e => {
    if (params.dragStir || e.shiftKey) { dragging = true; controls.enabled = false; canvas.setPointerCapture(e.pointerId); }
  });
  const endDrag = () => { if (dragging) { dragging = false; controls.enabled = true; } };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);

  let blasts = 0;
  function blastAt(p) { uBlastAt.value.copy(p); uBlast.value = 9; blasts++; }
  canvas.addEventListener('dblclick', e => { const p = toWorld(e); if (p) blastAt(p.clone()); });
  let lastTap = 0;   // 觸控雙擊
  canvas.addEventListener('pointerup', e => {
    if (e.pointerType !== 'touch') return;
    const now = performance.now();
    if (now - lastTap < 300) { const p = toWorld(e); if (p) blastAt(p.clone()); }
    lastTap = now;
  });

  // ---------- 介面 ----------
  const gui = new GUI({ title: '銀河參數' });
  gui.add(params, 'count', 1000, MAX, 1000).name('粒子數').onChange(v => { galaxy.count = v; });
  gui.add(params, 'arms', 2, 6, 1).name('旋臂數').onChange(v => { uArms.value = v; });
  gui.add(params, 'twist', 0, 2, 0.01).name('旋臂扭轉').onChange(v => { uTwist.value = v; });
  gui.add(params, 'spread', 0, 1, 0.01).name('星雲散佈').onChange(v => { uSpread.value = v; });
  gui.add(params, 'spin', -1, 1, 0.01).name('自轉速度').onChange(v => { uSpinRate.value = v; });
  gui.add(params, 'glow', 0, 3, 0.05).name('Bloom 發光').onChange(v => { bloomNode.strength.value = v; uBright.value = glowToBright(); });
  gui.add(params, 'size', 0.3, 3, 0.05).name('粒子大小').onChange(v => { uSize.value = v; });
  gui.add(params, 'stirRadius', 0.5, 4, 0.1).name('撥動半徑').onChange(v => { uStirR.value = v; });
  gui.add(params, 'galaxySpin').name('銀河自轉');
  gui.add(params, 'autoRotate').name('鏡頭自動環繞');
  gui.add(params, 'dragStir').name('拖曳=撥動(觸控用)');
  const actions = {
    blast() { blastAt(new THREE.Vector3((Math.random() - 0.5) * 6, 0, (Math.random() - 0.5) * 6)); },
    reset() {
      gui.controllersRecursive().forEach(c => { if (c.property in DEFAULTS) c.setValue(DEFAULTS[c.property]); });
      blasts = 0;
      uSpin.value = 0;
      camera.position.copy(CAM_HOME);
      controls.target.set(0, 0, 0);
      controls.update();
      renderer.compute(resetKernel);
    },
  };
  gui.add(actions, 'blast').name('💥 隨機衝擊波');
  gui.add(actions, 'reset').name('↺ 全部重設');
  if (innerWidth < 640) gui.close();

  $('backend').textContent = backendName;
  addEventListener('keydown', e => {
    if (e.key === 'Escape' && mode === 'sbs') { setSBS(false); return; }
    if (e.key === ' ') { params.galaxySpin = !params.galaxySpin; gui.controllersRecursive().forEach(c => c.updateDisplay()); }
    if (e.key === 'r' || e.key === 'R') actions.reset();
  });

  // ---------- VR(WebXR):Quest 3 等頭盔 ----------
  const VR_SCALE = 0.22;                         // 半徑 6 → 約 1.3 公尺
  const vrBtn = $('vr-btn');
  let vrScale = VR_SCALE;
  if (xrSupported) {
    vrBtn.hidden = false;
    vrBtn.onclick = async () => {
      if (renderer.xr.isPresenting) { renderer.xr.getSession().end(); return; }
      try {
        const session = await navigator.xr.requestSession('immersive-vr', { optionalFeatures: ['local-floor', 'hand-tracking'] });
        renderer.xr.setReferenceSpaceType('local-floor');
        await renderer.xr.setSession(session);
      } catch (e) { console.warn(e); $('xr-msg').textContent = '無法進入 VR:' + e.message; }
    };
  }
  renderer.xr.addEventListener('sessionstart', () => {
    mode = 'vr';
    vrScale = VR_SCALE;
    world.scale.setScalar(vrScale);
    world.position.set(0, 1.15, -1.5);           // 胸前稍遠處,站著或坐著都看得到
    world.rotation.set(0, 0, 0);
    uStirR.value = params.stirRadius;
    uBright.value = glowToBright();
    vrBtn.textContent = '離開 VR';
  });
  function leaveVR() {
    mode = 'flat';
    world.scale.setScalar(1);
    world.position.set(0, 0, 0);
    world.rotation.set(0, 0, 0);
    uBright.value = glowToBright();
    vrBtn.textContent = '進入 VR';
  }
  renderer.xr.addEventListener('sessionend', leaveVR);

  // 手把(或手勢):扳機/捏合 = 衝擊波;手伸進銀河 = 撥動星塵;握把 = 暫停自轉;搖桿 = 縮放與旋轉
  const rayGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 0, -1)]);
  const rayMat = new THREE.LineBasicNodeMaterial({ color: 0x9fe8ff, transparent: true, opacity: 0.6 });
  const tmpV = new THREE.Vector3(), tmpQ = new THREE.Quaternion(), tmpDir = new THREE.Vector3();
  const vrPlane = new THREE.Plane();
  const controllers = [0, 1].map(i => {
    const c = renderer.xr.getController(i);
    const line = new THREE.Line(rayGeo, rayMat);
    line.scale.z = 3;
    c.add(line);
    c.addEventListener('selectstart', () => {
      c.getWorldPosition(tmpV);
      c.getWorldQuaternion(tmpQ);
      tmpDir.set(0, 0, -1).applyQuaternion(tmpQ);
      // 射線打到銀河盤面就在那裡引爆;沒打到就在手前方 30 公分
      world.getWorldPosition(hitP);
      vrPlane.setFromNormalAndCoplanarPoint(new THREE.Vector3(0, 1, 0), hitP);
      ray.set(tmpV, tmpDir);
      const hit = ray.ray.intersectPlane(vrPlane, new THREE.Vector3());
      const target = hit && hit.distanceTo(tmpV) < 6 ? hit : tmpV.clone().addScaledVector(tmpDir, 0.3);
      blastAt(world.worldToLocal(target.clone()));
      const pad = c.userData.source?.gamepad;
      pad?.hapticActuators?.[0]?.pulse?.(0.6, 80);
    });
    c.addEventListener('squeezestart', () => { params.galaxySpin = !params.galaxySpin; gui.controllersRecursive().forEach(x => x.updateDisplay()); });
    c.addEventListener('connected', e => { c.userData.source = e.data; line.visible = e.data.targetRayMode === 'tracked-pointer'; });
    c.addEventListener('disconnected', () => { c.userData.source = null; });
    scene.add(c);
    return c;
  });
  const localHand = new THREE.Vector3();
  function updateVR(dt) {
    // 撥動:取最靠近銀河的那隻手
    let best = Infinity, on = false;
    for (const c of controllers) {
      if (!c.userData.source) continue;
      c.getWorldPosition(tmpV);
      const lp = world.worldToLocal(tmpV.clone());
      const d = Math.hypot(lp.x, lp.z);
      if (d < RADIUS * 1.3 && Math.abs(lp.y) < 2.5 && d < best) { best = d; localHand.copy(lp); on = true; }
    }
    if (on) uMouse.value.copy(localHand);
    // 搖桿:上下縮放(可以把銀河放大到包住自己),左右旋轉
    for (const c of controllers) {
      const ax = c.userData.source?.gamepad?.axes;
      if (!ax || ax.length < 4) continue;
      if (Math.abs(ax[3]) > 0.15) vrScale = THREE.MathUtils.clamp(vrScale * (1 - ax[3] * dt * 1.2), 0.08, 1.5);
      if (Math.abs(ax[2]) > 0.15) world.rotation.y -= ax[2] * dt * 1.5;
    }
    world.scale.setScalar(vrScale);
    return on;
  }

  // ---------- SBS 3D(XREAL One 等眼鏡:3D 模式選 Half SBS)----------
  const stereo = new THREE.StereoCamera();
  params.depth = 0.9;
  DEFAULTS.depth = 0.9;
  function setSBS(on) {
    mode = on ? 'sbs' : 'flat';
    document.body.classList.toggle('sbs', on);
    on ? gui.hide() : gui.show();
    uBright.value = glowToBright();
    if (on) document.documentElement.requestFullscreen?.().catch(() => {});
    else if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, innerWidth, innerHeight);
  }
  $('sbs-btn').onclick = () => setSBS(true);
  document.querySelectorAll('.sbs-exit').forEach(b => { b.onclick = () => setSBS(false); });
  document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement && mode === 'sbs') setSBS(false); });
  function renderSBS() {
    const w = innerWidth, h = innerHeight;
    camera.updateMatrixWorld();
    stereo.eyeSep = params.depth;
    camera.focus = camera.position.distanceTo(controls.target);   // 銀河中心在螢幕面:近的旋臂浮出、遠的退後
    stereo.update(camera);                      // 每眼仍用全畫面比例,半寬輸出 = Half SBS 的擠壓格式
    renderer.setScissorTest(true);
    renderer.setScissor(0, 0, w / 2, h);
    renderer.setViewport(0, 0, w / 2, h);
    renderer.render(scene, stereo.cameraL);
    renderer.setScissor(w / 2, 0, w / 2, h);
    renderer.setViewport(w / 2, 0, w / 2, h);
    renderer.render(scene, stereo.cameraR);
    renderer.setScissorTest(false);
  }
  const fx = gui.addFolder('XR / 3D 眼鏡');
  fx.add(params, 'depth', 0, 2.5, 0.01).name('SBS 立體深度');
  fx.close();

  // ---------- 動畫迴圈 ----------
  const timer = new THREE.Timer();
  timer.connect(document);
  let frames = 0, fpsT = performance.now(), fps = 0;
  let loopFrames = 0;
  renderer.setAnimationLoop(t => {
    loopFrames++;
    timer.update(t);
    const dt = Math.min(timer.getDelta(), 1 / 30);
    uDt.value = dt;
    if (params.galaxySpin) uSpin.value += dt * uSpinRate.value;

    if (mode === 'vr' && !renderer.xr.isPresenting) leaveVR();   // 保險:萬一沒收到 sessionend
    const vrStir = mode === 'vr' && updateVR(dt);
    const active = vrStir || dragging || (hover && performance.now() - lastMove < 1200 && !params.dragStir);
    uMouseOn.value += ((active ? 1 : 0) - uMouseOn.value) * Math.min(1, dt * 8);

    renderer.compute(computeUpdate);
    uBlast.value = 0;

    if (mode === 'vr') {
      renderer.render(scene, camera);             // VR 由頭盔決定視角;後製在 XR 中不可用
    } else {
      controls.autoRotate = params.autoRotate && !dragging;
      controls.update(dt);
      if (mode === 'sbs') renderSBS(); else pipeline.render();
    }

    frames++;
    const now = performance.now();
    if (now - fpsT > 500) {
      fps = frames * 1000 / (now - fpsT); frames = 0; fpsT = now;
      $('stats').textContent =
        `粒子 ${galaxy.count.toLocaleString()} 顆 · ${params.arms} 條旋臂 · ${fps.toFixed(0)} FPS · 發光 ${params.glow.toFixed(2)}`;
      $('stir').textContent = uMouseOn.value > 0.05 ? '正在撥動星塵…' : blasts ? `已引爆 ${blasts} 次衝擊波` : '';
    }
  });

  addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  });

  // 給自動測試用
  window.__galaxy = {
    params, gui, galaxy, renderer, backend: backendName, actions, world, controllers, setSBS,
    get mode() { return mode; }, xrSupported, get loopFrames() { return loopFrames; },
    readOffsets: async () => new Float32Array(await renderer.getArrayBufferAsync(offset.value)),
    get fps() { return fps; }, get spin() { return uSpin.value; }, get mouseOn() { return uMouseOn.value; },
  };
}

main().catch(e => { console.error(e); fail('初始化失敗:' + e.message); });
