# Y 波：三视图参考图白底压平（确定性后处理，不重抽）
# 边缘 BFS 泛洪（父节点色差版）：从四边种子出发，与来路父节点色差 <tol 即填白并继续蔓延——
# 渐变底/浅灰底/淡阴影随局部渐变逐格爬满；主体与背景交界处色差大，蔓延停止（白毛安全：主体不连通边缘种子）。
# 用法：python3 flatten_to_white.py <in> <out> [tol]；stdout 打压平后边缘带近白占比
import sys
from collections import deque
from PIL import Image

def flatten(inp, outp, tol=44):
    im = Image.open(inp).convert('RGB')
    w, h = im.size
    px = im.load()
    visited = bytearray(w * h)
    q = deque()
    # 种子：四边全部像素（携自身色入队）
    for x in range(w):
        q.append((x, 0, *px[x, 0])); q.append((x, h - 1, *px[x, h - 1]))
    for y in range(h):
        q.append((0, y, *px[0, y])); q.append((w - 1, y, *px[w - 1, y]))
    while q:
        x, y, pr, pg, pb = q.popleft()
        if x < 0 or y < 0 or x >= w or y >= h:
            continue
        idx = y * w + x
        if visited[idx]:
            continue
        r, g, b = px[x, y]
        # 仅与来路父节点色差判定（局部渐变可爬）；不设近白直连——上一轮 nearWhite 直连把主体白毛经背景白区吃光
        if abs(r - pr) + abs(g - pg) + abs(b - pb) < tol:
            visited[idx] = 1
            px[x, y] = (255, 255, 255)
            q.extend([(x + 1, y, r, g, b), (x - 1, y, r, g, b), (x, y + 1, r, g, b), (x, y - 1, r, g, b)])
    im.save(outp, lossless=True)
    d = list(im.getdata())
    b16 = 16
    edge = [d[y * w + x] for y in range(h) for x in range(w) if x < b16 or x >= w - b16 or y < b16 or y >= h - b16]
    white = sum(1 for p in edge if p[0] >= 240 and p[1] >= 240 and p[2] >= 240)
    print(round(white / len(edge), 3))

if __name__ == '__main__':
    flatten(sys.argv[1], sys.argv[2], int(sys.argv[3]) if len(sys.argv) > 3 else 44)
