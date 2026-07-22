# GameStudio 四阶段联调测试仪表盘

一个轻量级的 HTML+CSS+Node.js 测试外挂页面，用于可视化启动和监控 GameStudio 四阶段联调测试。

## 快速开始

```bash
# 启动仪表盘服务（端口 20990）
node scripts/test-dashboard/server.mjs

# 或指定端口
TEST_DASHBOARD_PORT=3000 node scripts/test-dashboard/server.mjs
```

打开浏览器访问: http://127.0.0.1:20990

## 功能

- **S0 系统启动硬检查**: 直接 API 调用，10 项服务健康检查（OMLX / Server / Control / Console / Hermes / ComfyUI / Editor / 记忆文件 / Settings）
- **L1 交互测试**: 调用 `control_production_test.mjs --stage=l1`，验证 Control ↔ Hermes 任务分类与执行
- **L4 故事生成 P0**: 调用 `control_production_test.mjs --stage=l4`，验证文本闭环完整性
- **P1 场景图锁定**: 当前为占位状态（测试脚本待实现），显示 docs/PRODUCTION_DEFECTS.md 中定义的 10 项测试框架

## 四阶段测试题目来源

所有 40 道测试题目定义于 `docs/PRODUCTION_DEFECTS.md`：
- S0-T01 ~ S0-T10: 第一阶段 系统启动硬检查
- L1-T01 ~ L1-T10: 第二阶段 交互测试
- L4-T01 ~ L4-T10: 第三阶段 故事生成 P0
- P1-T01 ~ P1-T10: 第四阶段 场景图锁定 P1

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `TEST_DASHBOARD_PORT` | `20990` | 仪表盘服务端口 |
| `CONTROL_BASE_URL` | `http://127.0.0.1:2099` | Control Server |
| `CONTROL_CONSOLE_URL` | `http://127.0.0.1:8870` | Control Console |
| `SERVER_BASE_URL` | `http://127.0.0.1:1999` | GameStudio Server |
| `EDITOR_BASE_URL` | `http://127.0.0.1:8868` | GameStudio Editor |
| `HERMES_BASE_URL` | `http://127.0.0.1:8742` | Hermes Gateway |
| `OMLX_BASE_URL` | `http://127.0.0.1:18888` | OMLX API |
| `COMFYUI_BASE_URL` | `http://127.0.0.1:8188` | ComfyUI |

## 技术栈

- **后端**: 纯 Node.js 内置模块 (`http`, `child_process`, `fs`)，零外部依赖
- **前端**: 纯 HTML+CSS+JS，无框架
- **通信**: Server-Sent Events (SSE) 实时流式输出
- **测试引擎**: 复用现有 `scripts/test/control_production_test.mjs`

## 文件结构

```
scripts/test-dashboard/
├── server.mjs    # HTTP 服务 + SSE + 测试执行
├── index.html    # 仪表盘 UI（四阶段卡片 + 日志控制台）
└── README.md     # 本文档
```

## 阻塞项说明

P1 阶段测试当前标记为 `NOT_IMPLEMENTED`，原因详见 `docs/PRODUCTION_DEFECTS.md` 4.6 节：
- P1-B01: Character asset pipeline 未实现
- P1-B02: `generateBackground` 仅支持 ComfyUI background
- P1-B03: 批量场景渲染未实现
- P1-B04: 锁定评审视觉模型可用性
- P1-B05: 场景资源回填校验闭环
