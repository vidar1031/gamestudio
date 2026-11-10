# Z 波：sheet 横图按内容切割（替代等宽）——白底上非白连通域列投影找谷分段（栏数自适应 3-4，
# charturn 实测会出四栏布局），按谷切栏（含 padding）；切不出（谷不够/栏数不对）如实报不硬切
# 用法：python3 sheet_split.py <sheet> <outPrefix>；stdout JSON：{"ok":true,"cells":N,"cuts":[...],"outs":[...]}
import sys
import json
from PIL import Image

def near_white(p):
    return p[0] >= 230 and p[1] >= 230 and p[2] >= 230  # Z 波实测：charturn 白底实为浅灰蓝(216-224)，阈值 238 会误判为非白满屏粘连

def split(inp, out_prefix):
    im = Image.open(inp).convert('RGB')
    w, h = im.size
    px = im.load()
    # Z 波调参第 2 轮：列投影计数对"栏间零星手臂/尾巴"太敏感（一只狼的手臂伸进栏间=该列满高前景）。
    # 改用列前景 y 向跨度（ymax-ymin）：栏内列=整只狼头到脚（跨度大），栏间列=零星延伸物（跨度小）
    spans = []
    for x in range(w):
        ys = [y for y in range(h) if not near_white(px[x, y])]
        spans.append((ys[-1] - ys[0] + 1) if ys else 0)
    peak = max(spans) if spans else 0
    if peak <= 0:
        return {'ok': False, 'reason': 'blank_sheet'}
    # Z 波调参：列投影滑动窗平滑（12px 窗）——栏间零星尾巴/手臂像素被均掉，谷带才显形
    sm = []
    for x in range(w):
        lo, hi = max(0, x - 6), min(w, x + 6)
        sm.append(sum(spans[lo:hi]) / (hi - lo))
    floor = max(h * 0.3, max(sm) * 0.5)  # 谷=跨度低于半高
    # 谷带：平滑投影 ≤ floor 的连续列；栏=谷带间的高原段。中段谷才有效（两端边缘留白不算谷）
    segments = []  # 高原段 [l, r]
    in_seg = False
    seg_start = 0
    for x in range(w):
        if sm[x] > floor and not in_seg:
            in_seg = True
            seg_start = x
        elif sm[x] <= floor and in_seg:
            in_seg = False
            segments.append([seg_start, x - 1])
    if in_seg:
        segments.append([seg_start, w - 1])
    # 过滤太窄段（< w*0.1 视为噪点/边缘碎片）
    segments = [s for s in segments if s[1] - s[0] + 1 >= w * 0.1]
    n = len(segments)
    if n < 3 or n > 4:
        return {'ok': False, 'reason': f'cells_count_{n}', 'segments': segments}
    pad = int(w * 0.005)
    outs = []
    for i, (l, r) in enumerate(segments):
        cl = max(0, l - pad)
        cr = min(w, r + pad + 1)
        out = f'{out_prefix}_cell{i}.png'
        im.crop((cl, 0, cr, h)).save(out)
        outs.append(out)
    return {'ok': True, 'cells': n, 'segments': segments, 'outs': outs}

if __name__ == '__main__':
    print(json.dumps(split(sys.argv[1], sys.argv[2])))
