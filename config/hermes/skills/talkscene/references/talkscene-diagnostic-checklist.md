# TalkScene 快速诊断清单

用此清单在 60 秒内完成 TalkScene 全组件状态检查。按顺序执行，任一组件状态异常即记录为问题。

## 60 秒诊断流程

1. **TalkScene Server（端口 1999，权威健康检查）**
   ```
   curl -s -o /dev/null -w "HTTP:%{http_code}" http://127.0.0.1:1999/api/health
   # 期望: 200
   ```

2. **Editor（端口 8868，Vite SPA，无 /health）与 Control Server（端口 2099）**
   ```
   curl -s -o /dev/null -w "HTTP:%{http_code}" http://localhost:8868/
   curl -s -o /dev/null -w "HTTP:%{http_code}" http://127.0.0.1:2099/api/health
   # 期望: 均 200
   ```

3. **ComfyUI (端口 8188)**
   ```
   lsof -i :8188 2>/dev/null | head -2
   curl -s http://127.0.0.1:8188/ping 2>/dev/null; echo "EXIT:$?"
   # 期望: 端口监听中, exit 0
   # 注意: exit 7 = 连接被拒绝 = ComfyUI 未运行
   ```

4. **存储项目数**
   ```
   ls storage/projects/ | wc -l
   ```

5. **最新项目关键文件**
   ```
   ls storage/projects/<最新项目ID>/
   # 期望: meta.json, project.json, story.json, blueprint.json, scripts.json, assets/, story-assets/
   ```

6. **故事资产状态 (来自 project.json)**
   ```
   在 project.json 中查找: referenceStatus: "missing" 或 "ready"
   ```

7. **导出产物**
   ```
   ls storage/projects/<项目ID>/builds/latest/dist/index.html
   # 注意: 配置文件可能有此路径但实际文件不存在
   ```

## 状态判断

- 全部 7 项通过 → 完全运行
- Control Server 通过, ComfyUI 未运行 → 部分运行（AI 图像生成不可用）
- Control Server 未通过 → 不可用
- 存储项目数 = 0 → 无项目数据