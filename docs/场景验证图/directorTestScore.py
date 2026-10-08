#!/usr/bin/env python3
"""导演机件测试评分器：对构图输出做确定性几何检查，多轮统计通过率。
用法: python3 directorTestScore.py <composition_result.json> <round_no>
"""
import json
import sys

def items_of(scene, sid):
    return {i.get('subjectId'): i for i in (scene.get('items') or [])}

def check(scene):
    it = items_of(scene, scene.get('sceneId'))
    name = str(scene.get('sceneName') or '')
    g = lambda k, s, d=0: float((it.get(k) or {}).get(s) or d)
    res = {}
    if '三分法' in name:
        x = g('fox', 'x', 0.5)
        res['主体在三分线'] = abs(x - 0.33) < 0.14 or abs(x - 0.67) < 0.14
    elif '居中' in name:
        res['主体居中'] = abs(g('turtle', 'x', 0) - 0.5) < 0.12
    elif '三层景深' in name:
        ys = [g(k, 'y') for k in ('rabbit', 'fox', 'prop.house')]
        ss = [g(k, 'scale') for k in ('rabbit', 'fox', 'prop.house')]
        ok = ys[0] > 0.82 and 0.6 < ys[1] <= 0.85 and ys[2] < ys[1] and ss[0] > ss[1] > ss[2]
        res['前景>中景>背景（y与scale双递减）'] = bool(ok)
    elif '三角形' in name:
        pts = [(g(k, 'x'), g(k, 'y')) for k in ('fox', 'rabbit', 'turtle')]
        (x1, y1), (x2, y2), (x3, y3) = pts
        area = abs((x2 - x1) * (y3 - y1) - (x3 - x1) * (y2 - y1))
        spread = max(x1, x2, x3) - min(x1, x2, x3)
        res['三点不共线且横向展开'] = area > 0.02 and spread > 0.15
    elif '大小对比' in name:
        b, m = g('bear', 'scale'), g('mouse', 'scale')
        res['scale比≥1.8'] = m > 0 and b / m >= 1.8
    elif '视线引导' in name:
        fx, bx = g('fox', 'x'), g('prop.bird', 'x')
        fox = it.get('fox') or {}
        blk = str(fox.get('blocking') or '')
        flip = bool(fox.get('flipH'))
        ok = (bx > fx and not flip and ('右' in blk or '看' in blk or '盯' in blk)) or (bx < fx and flip and '左' in blk)
        res['狐狸朝向指向小鸟'] = bool(ok)
    elif '动势' in name:
        fx, bx = g('fox', 'x'), g('prop.butterfly', 'x')
        flip = bool((it.get('fox') or {}).get('flipH'))
        res['狐狸朝右(flipH=false)且蝴蝶在右前方'] = (not flip) and bx > fx
    elif '框架式' in name:
        rx, gx = g('rabbit', 'x'), g('loc.gate', 'x')
        rz, gz = g('rabbit', 'zIndex'), g('loc.gate', 'zIndex')
        res['兔在门框前(rz>gz)且水平对齐'] = rz > gz and abs(rx - gx) < 0.22
    elif '遮挡' in name:
        bz, rz = g('bear', 'zIndex'), g('rabbit', 'zIndex')
        bx, rx = g('bear', 'x'), g('rabbit', 'x')
        res['熊zIndex>兔且x接近(遮挡)'] = bz > rz and abs(bx - rx) < 0.2
    elif '留白' in name:
        s, x = g('mouse', 'scale'), g('mouse', 'x')
        res['主体小(≤0.55)且偏侧(|x-0.5|≥0.12)'] = s <= 0.55 and abs(x - 0.5) >= 0.12
    return res

def main():
    path, rnd = sys.argv[1], sys.argv[2]
    d = json.load(open(path))
    comp = (d.get('composition') or {}).get('scenes') or []
    print(f'--- 第 {rnd} 轮 ---')
    total_pass = total_check = 0
    for s in comp:
        r = check(s)
        for k, v in r.items():
            total_pass += 1 if v else 0
            total_check += 1
            print(f"{'PASS' if v else 'FAIL'} | {s.get('sceneName')} | {k}")
    print(f'round {rnd}: {total_pass}/{total_check}')

if __name__ == '__main__':
    main()
