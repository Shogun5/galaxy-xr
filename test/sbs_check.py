"""檢查 SBS 截圖:左右兩半都有畫面、亮度相近、有水平視差。"""
import sys
import numpy as np
from PIL import Image
a = np.asarray(Image.open(sys.argv[1]).convert('L')).astype(float)
h, w = a.shape
L, R = a[:, :w // 2], a[:, w // 2:]
def best_shift(y0, y1):
    e = {s: np.abs(L[y0:y1, 60:-60] - np.roll(R[y0:y1], s, axis=1)[:, 60:-60]).mean() for s in range(-30, 31)}
    k = min(e, key=e.get)
    return k, e[k], e[0]
ok_both = L.mean() > 2 and R.mean() > 2 and abs(L.mean() - R.mean()) / L.mean() < 0.15
# 鏡頭由前上方往下看:畫面下緣是離鏡頭近的旋臂,上緣是遠的;兩者的左右位移方向應該相反
near = best_shift(int(h * 0.72), int(h * 0.92))
far = best_shift(int(h * 0.28), int(h * 0.45))
ok_par = near[0] * far[0] < 0 and near[1] < near[2] and far[1] < far[2]
print(('PASS' if ok_both else 'FAIL') + f' SBS:左右兩眼都有畫面(平均亮度 {L.mean():.2f} / {R.mean():.2f})')
print(('PASS' if ok_par else 'FAIL') + f' SBS:近處與遠處的視差方向相反(近處位移 {near[0]}px,遠處 {far[0]}px)')
sys.exit(0 if ok_both and ok_par else 1)
