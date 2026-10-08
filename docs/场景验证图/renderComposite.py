#!/usr/bin/env python3
"""构图验证渲染器：把 story.json 的 背景+摆位 合成成品图（与播放器同语义）。
anchor(0.5,1) 底中锚点 / x,y 归一化 / scale / flipX / zIndex 升序叠放。
用法: python3 renderComposite.py <project_dir> <sceneId> <out_path>
"""
import json
import sys
from PIL import Image

def main():
    root, scene_id, out_path = sys.argv[1], sys.argv[2], sys.argv[3]
    story = json.load(open(f'{root}/story.json'))
    proj = json.load(open(f'{root}/project.json'))
    assets = {a.get('id'): a.get('uri') for a in proj.get('assets', [])}
    node = next((n for n in story.get('nodes', []) if n.get('id') == scene_id), None)
    if not node:
        raise SystemExit('scene not found')
    visuals = node.get('visuals') or {}
    bg_id = visuals.get('backgroundAssetId')
    bg_uri = assets.get(bg_id)
    bg = Image.open(f'{root}/{bg_uri}').convert('RGBA') if bg_uri else Image.new('RGBA', (768, 1024), (30, 40, 60, 255))
    W, H = bg.size
    canvas = bg.copy()
    placements = sorted(visuals.get('placements') or [], key=lambda p: (p.get('zIndex') or 0))
    for p in placements:
        img_id = p.get('imageAssetId')
        uri = assets.get(img_id)
        if not uri:
            continue
        try:
            im = Image.open(f'{root}/{uri}').convert('RGBA')
        except Exception:
            continue
        t = p.get('transform') or {}
        scale = float(t.get('scale', 1))
        im = im.resize((max(1, int(im.width * scale)), max(1, int(im.height * scale))), Image.LANCZOS)
        if t.get('flipX'):
            im = im.transpose(Image.FLIP_LEFT_RIGHT)
        x = float(t.get('x', 0.5)) * W
        y = float(t.get('y', 1)) * H
        px = int(x - im.width / 2)
        py = int(y - im.height)
        canvas.alpha_composite(im, (px, py))
    canvas.convert('RGB').save(out_path, 'WEBP', quality=92)
    print(json.dumps({'ok': True, 'out': out_path, 'placements': len(placements)}))

if __name__ == '__main__':
    main()
