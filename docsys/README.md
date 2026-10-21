# docsys —— 文档体系站点（GB/T 8567）

> 用途：以 Markdown 管理 GB/T 8567 软件文档体系，构建为纯静态站点。框架与数据分离，**可整体拷贝到任何项目复用**。

## 目录约定

```text
docsys/
  framework/          # 框架（渲染器/构建器/预览/样式/国标骨架模板）——不含任何项目内容
    markdown.mjs      # 零依赖 Markdown 渲染器（文档子集语法）
    render.mjs        # 构建器：content 册 → dist/ 纯静态 HTML
    serve.mjs         # 本地预览（默认 8891 端口）
    templates/gb8567/ # GB/T 8567 十四件国标文档骨架
    assets/           # 样式
  content/            # 数据（各产品册）——不含任何渲染逻辑
    <产品册>/
      manifest.json   # 册目录：分组/文档/状态/模板映射
      *.md            # 文档实例（front-matter：status/owner/version/updated）
  dist/               # 构建产物（不入库）
```

## 使用

```bash
npm run docsys:scaffold   # 首次：按 manifest 从国标骨架生成缺失的文档实例
npm run docsys:build      # 构建静态站点到 docsys/dist/
npm run docsys:serve      # 预览 http://127.0.0.1:8891/
```

## 复用到其它项目

**详细采纳指南见 `docsys/GUIDE.md`**（随目录拷走即送达对方；含文档地图、表达方法论、界面定义五件套、手册写法与验收口径）。
**模板仓**（2026-10-21 起）：`/Volumes/ovokit2t/aiwork/docsys-template/`（独立 git 仓，零依赖可独立运行，含示例册）——其它项目优先从模板仓克隆/拷贝，本仓 docsys 为织话智坊册的实例。

快速路径：
1. 拷贝整个 `docsys/` 目录到新仓；
2. 删掉 `content/` 下旧册，新建 `content/<产品册>/manifest.json`（照本仓示例声明分组与文档）；
3. 新仓 package.json 补三个 script（`docsys:scaffold`/`docsys:build`/`docsys:serve`，分别指向 framework 下对应 .mjs）；
4. `scaffold` → `build` → `serve`。

## 写作约定

- 文档状态四值：`未开始 / 编写中 / 评审中 / 完成`，写在文档 front-matter 的 `status` 字段（首页进度据此统计）。
- **层级纪律**：全局统筹层文档（产品说明书/可行性/需求/设计/测试计划）只写"系统必须满足什么"，不出现具体故事案例名与具体任务代号；案例与任务过程只进用户手册/操作手册/过程记录类文档（10/13/14）。
- Markdown 只用子集语法：标题/段落/表格/列表/代码围栏/行内代码/粗斜体/链接/图片/引用/分隔线。
- 内容文件可引用仓内既有文档（manifest 的 file 支持相对路径，如 `../../../docs/产品说明书.md`），保持单一真相源不复制。
- **代码结构一律用"真相文件树"**：代码围栏内缩进路径 + `#` 注释（参照《概要设计说明书》§3.1），真相以仓内文件为准；`chart org` 仅用于组织/页面结构，`chart flow` 用于逻辑流转，`chart layers` 用于分层——三者都不用于代码结构。
