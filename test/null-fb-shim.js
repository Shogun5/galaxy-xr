// 只用於測試:iwer 模擬器的 XRWebGLLayer.framebuffer 是 null(直接畫到畫布),
// 真機(Quest)回傳的是不透明的 WebGLFramebuffer。three 拿它當 WeakMap 的鍵,
// 所以把 null 鍵換成一個替身物件,模擬真機的行為。
(() => {
  const NULL_KEY = {};
  const fix = k => (k === null ? NULL_KEY : k);
  for (const m of ['get', 'set', 'has', 'delete']) {
    const orig = WeakMap.prototype[m];
    WeakMap.prototype[m] = function (k, ...rest) { return orig.call(this, fix(k), ...rest); };
  }
})();
