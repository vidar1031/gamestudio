#!/usr/bin/env python3
# 确定性填充合成（2026-09-16）：以锁定主参考为底，叠加填充层（水位）与内容物（石子等抠图）。
# 背景：AI 生成对"同一容器+液位递进+内容物"不可靠（锚定压内容词/身份漂移），
# 且本地脚本黑盒合成违反出图可观测规则——合成收进服务端，经 /ai/tasks 进度与审核留痕。
# 用法：python3 fillComposite.py '<json args>'，args 见 main()；结果写 stdout JSON。
import sys, json
from PIL import Image, ImageDraw, ImageEnhance


def alpha_bbox(im, thresh=30):
    a = im.getchannel('A')
    px = a.load()
    w, h = im.size
    minx, miny, maxx, maxy = w, h, 0, 0
    for y in range(h):
        for x in range(w):
            if px[x, y] > thresh:
                if x < minx: minx = x
                if x > maxx: maxx = x
                if y < miny: miny = y
                if y > maxy: maxy = y
    if maxx <= minx or maxy <= miny:
        return (0, 0, w, h)
    return (minx, miny, maxx, maxy)


def water_layer(ref, top_y, in_l, in_r, in_b, color, waterline_color):
    W, H = ref.size
    layer = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    cx = (in_l + in_r) // 2
    d.rectangle([in_l, top_y, in_r, in_b], fill=color)
    d.polygon([(in_l, in_b - 40), (in_r, in_b - 40), (in_r - 40, in_b), (in_l + 40, in_b)], fill=color)
    d.rectangle([in_l, in_b - 60, in_r, in_b], fill=(color[0] // 2, color[1] // 2 + 20, color[2], min(255, color[3] // 3)))
    ew = (in_r - in_l) // 2
    d.ellipse([cx - ew, top_y - 10, cx + ew, top_y + 10], fill=waterline_color)
    d.arc([cx - ew, top_y - 10, cx + ew, top_y + 10], 0, 360, fill=(255, 255, 255, 200), width=2)
    mask = ref.getchannel('A').point(lambda a: 255 if a > 30 else 0)
    layer.putalpha(Image.composite(layer.getchannel('A'), Image.new('L', (W, H), 0), mask))
    return layer


def pebbles_layer(ref, pebble_img, spots, brightness, alpha, blue_shift):
    W, H = ref.size
    peb = pebble_img.convert('RGBA')
    peb = ImageEnhance.Brightness(peb).enhance(brightness)
    r, g, b, a = peb.split()
    if blue_shift > 0:
        b = b.point(lambda v: min(255, int(v * (1 + blue_shift))))
    a = a.point(lambda v: int(v * alpha))
    peb = Image.merge('RGBA', (r, g, b, a))
    layer = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    for cx, cy, wpx in spots:
        hh = int(peb.height * wpx / peb.width)
        layer.alpha_composite(peb.resize((int(wpx), hh), Image.LANCZOS), (int(cx - wpx / 2), int(cy - hh / 2)))
    mask = ref.getchannel('A').point(lambda v: 255 if v > 30 else 0)
    layer.putalpha(Image.composite(layer.getchannel('A'), Image.new('L', (W, H), 0), mask))
    return layer


def auto_pebble_spots(count, in_l, in_r, in_b):
    """瓶底自动堆叠：底排 3 + 中排 2 + 顶 1（按 count 截断），间距随内腔宽度"""
    cx = (in_l + in_r) // 2
    iw = in_r - in_l
    w0 = iw * 0.30
    rows = [
        [(cx - iw * 0.22, in_b - 38, w0), (cx + iw * 0.04, in_b - 30, w0 * 0.92), (cx + iw * 0.24, in_b - 38, w0 * 0.88)],
        [(cx - iw * 0.10, in_b - 100, w0 * 0.80), (cx + iw * 0.14, in_b - 94, w0 * 0.74)],
        [(cx + iw * 0.02, in_b - 152, w0 * 0.66)],
    ]
    spots = []
    for row in rows:
        for s in row:
            if len(spots) < count:
                spots.append(s)
    return spots


def main():
    args = json.loads(sys.argv[1])
    ref = Image.open(args['refPath']).convert('RGBA')
    W, H = ref.size
    bx0, by0, bx1, by1 = alpha_bbox(ref)
    bw, bh = bx1 - bx0, by1 - by0
    # 内腔启发式（细颈瓶类容器）：左右内缩 ~14%/11%，底部 ~12%，颈根 ~27%
    in_l = bx0 + bw * float(args.get('insetL', 0.14))
    in_r = bx1 - bw * float(args.get('insetR', 0.11))
    in_b = by1 - bh * float(args.get('insetB', 0.117))
    neck_y = by0 + bh * float(args.get('neckRatio', 0.27))

    out = ref.copy()
    overlays = args.get('overlays') or []
    for ov in overlays:
        pimg = Image.open(ov['imagePath'])
        count = int(ov.get('count', 3))
        spots = ov.get('spots') or auto_pebble_spots(count, in_l, in_r, in_b)
        out = Image.alpha_composite(out, pebbles_layer(
            out, pimg, spots,
            float(ov.get('brightness', 0.58)),
            float(ov.get('alpha', 0.92)),
            float(ov.get('blueShift', 0.08))
        ))

    level = float(args.get('waterLevel', 0))
    if level > 0:
        top_y = in_b - level * (in_b - neck_y)
        color = tuple(args.get('waterColor', [126, 200, 227, 110]))
        wl_color = tuple(args.get('waterlineColor', [230, 248, 255, 150]))
        out = Image.alpha_composite(out, water_layer(out, top_y, in_l, in_r, in_b, color, wl_color))

    out.save(args['outPath'], 'WEBP', lossless=True)
    print(json.dumps({'ok': True, 'outPath': args['outPath'], 'size': out.size}))


if __name__ == '__main__':
    main()
