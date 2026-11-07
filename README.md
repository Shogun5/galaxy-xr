# 銀河旋渦 XR

5 萬顆粒子的銀河旋渦,用 three.js r187 的 WebGPURenderer 與 TSL 寫成。單一 HTML 檔,不需要網路。

**線上版:** https://shogun5.github.io/galaxy-xr/

## 裝置

| 裝置 | 怎麼看 |
| --- | --- |
| 電腦、手機 | 直接開網頁。滑鼠撥動星塵、雙擊引爆衝擊波、右上角滑桿調參數。 |
| Meta Quest 3 | 在 Quest 瀏覽器開網址,按「進入 VR」。扳機(或捏合)引爆衝擊波,把手伸進銀河撥動星塵,搖桿上下縮放、左右旋轉,握把暫停自轉。 |
| XREAL One 等眼鏡 | 手機或電腦接上眼鏡,按「SBS 3D」,再在眼鏡選單開 3D 模式 → Half SBS。Esc 或下方按鈕離開。 |

VR 需要 HTTPS 網址,從本機檔案開啟無法進入 VR。

## 修改與重新打包

```bash
npm install
npm run build          # 產生 index.html
```

## 測試

`test/xr.cjs` 用 [iwer](https://github.com/meta-quest/immersive-web-emulation-runtime) 模擬 Quest 3,在無頭 Chrome 測 VR 流程與 SBS 模式。iwer 的 XR 畫面緩衝是 null,和真機不同,所以測試會載入 `test/null-fb-shim.js` 補上;這個補丁不在成品裡。
