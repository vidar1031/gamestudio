#!/usr/bin/env python3
"""确定性变换合成：以锁定主参考为底，产出剧情状态变体（微主体/简单状态专用）。

背景：IPAdapter 三档实测对微主体（蚂蚁）身份与姿势双失控；纯文本亦如此。
该类变化不重新生成像素，只对锁定立绘做确定性变换（倾斜/翻转/压扁/跃起/速度线），
身份零漂移（同一文件像素级变换），全程 PIL 本地合成，服务端可观测。

入参 JSON：
  refPath     锁定主参考（透明底 webp/png）
  outPath     输出（无损 webp）
  rotateDeg   身体倾斜角度（正=前倾，负=后仰），默认 0
  flipH       水平翻转，默认 false
  squashY     纵向压扁比例（0.7=被压/蹲下），默认 1
  jumpRatio   跃起上移占身高比例（0.12=跳起），默认 0
  motionLines 速度线数量（奔跑/飞扑用），默认 0
  sweat       汗滴数量（焦急/用力用），默认 0
"""
import json
import sys
from PIL import Image, ImageDraw


def alpha_bbox(im, thresh=30):
    a = im.getchannel('A')
    mask = a.point(lambda v: 255 if v > thresh else 0)
    box = mask.getbbox()
    if not box:
        return (0, 0, im.size[0], im.size[1])
    return box


def motion_lines_layer(size, anchor_y, direction, count):
    """速度线：角色身后横向短线，方向与角色朝向相反。"""
    w, h = size
    layer = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    import random
    rnd = random.Random(42)
    x_edge = w * 0.06 if direction > 0 else w * 0.70
    x_span = w * 0.24
    for _ in range(count):
        y = anchor_y + rnd.uniform(-0.18, 0.10) * h
        ln = rnd.uniform(0.35, 1.0) * x_span
        x0 = x_edge + rnd.uniform(0, 0.4) * x_span
        if direction < 0:
            x0 = w - x0 - ln
        d.line([(x0, y), (x0 + ln, y)], fill=(255, 255, 255, 200), width=max(3, int(h * 0.006)))
    return layer


def sweat_layer(size, head_xy, count):
    """汗滴：头顶两侧的蓝色小水滴。"""
    w, h = size
    layer = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    hx, hy = head_xy
    r = max(4, int(h * 0.012))
    offs = [(1.0, -0.6), (-1.0, -0.9), (1.4, 0.1), (-1.3, -0.2)]
    for i in range(min(count, len(offs))):
        ox, oy = offs[i]
        cx = hx + ox * w * 0.09
        cy = hy + oy * h * 0.05
        d.polygon([(cx, cy - r * 1.6), (cx - r, cy + r * 0.4), (cx + r, cy + r * 0.4)], fill=(120, 200, 255, 230))
        d.ellipse([cx - r, cy - r * 0.2, cx + r, cy + r * 1.2], fill=(120, 200, 255, 230))
    return layer


def main():
    args = json.loads(sys.argv[1])
    ref = Image.open(args['refPath']).convert('RGBA')
    W, H = ref.size
    bx0, by0, bx1, by1 = alpha_bbox(ref)

    rotate = float(args.get('rotateDeg', 0))
    flip = bool(args.get('flipH', False))
    squash = max(0.4, min(1.0, float(args.get('squashY', 1))))
    jump = max(0.0, float(args.get('jumpRatio', 0)))
    n_lines = int(args.get('motionLines', 0))
    n_sweat = int(args.get('sweat', 0))

    out = ref.copy()
    if flip:
        out = out.transpose(Image.FLIP_LEFT_RIGHT)
    if squash < 1.0:
        # 压扁：以脚底为锚点纵向压缩（被压/蹲下/用力）
        new_h = int(H * squash)
        out = out.resize((W, new_h), Image.LANCZOS)
        canvas = Image.new('RGBA', (W, H), (0, 0, 0, 0))
        canvas.alpha_composite(out, (0, H - new_h))
        out = canvas
    if abs(rotate) > 0.01:
        # 倾斜：绕脚底中心旋转，expand=False 保持画幅
        out = out.rotate(-rotate, resample=Image.BICUBIC, center=(W / 2, by1), expand=False)
    if jump > 0:
        dy = int(H * jump)
        canvas = Image.new('RGBA', (W, H), (0, 0, 0, 0))
        canvas.alpha_composite(out, (0, -dy))
        out = canvas

    if n_lines > 0:
        anchor_y = (by0 + by1) / 2
        out = Image.alpha_composite(out, motion_lines_layer((W, H), anchor_y, -1 if flip else 1, n_lines))
    if n_sweat > 0:
        head_xy = ((bx0 + bx1) / 2, by0 + (by1 - by0) * 0.08)
        out = Image.alpha_composite(out, sweat_layer((W, H), head_xy, n_sweat))

    out.save(args['outPath'], 'WEBP', lossless=True)
    print(json.dumps({'ok': True, 'outPath': args['outPath'], 'size': out.size}))


if __name__ == '__main__':
    main()
