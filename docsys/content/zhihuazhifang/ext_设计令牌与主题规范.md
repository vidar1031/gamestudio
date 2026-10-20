---
status: 编写中
owner: 规则统筹师（待任命）
version: v0.9-draft
updated: 2026-10-20
---
# 设计令牌与主题扩展规范

> 类型：规则规划声明 + 数值基线台账。本文是换肤（主题）与多语言（i18n）能力的工程地基：先把市场通行标准定为本项目参照，再把当前三端真实样式值收敛为令牌（design tokens）基线，最后声明扩展机制规则。实施走《交互优化升级方案》U0 波。
> 上游规则：《UI 设计规范》（观感/文案/自适应纪律）。本文只管"值与机制"，不管"该长什么样"。

## 1. 市场标准参考（选定参照系）

| 标准/体系 | 组织 | 本项目采用点 |
|---|---|---|
| [Design Tokens Format Module 2025.10](https://designzig.com/design-tokens-specification-reaches-first-stable-version-with-w3c-community-group/)（首个稳定版，2025-10-28） | W3C DTCG | 令牌的**交换格式**：JSON + `$value/$type/$description`，类型含 color/dimension/fontFamily/fontWeight/duration/cubicBezier；别名用 `{group.token}` 引用（[格式说明](https://www.handoffpro.dev/blog/design-tokens-json)） |
| [三层令牌架构](https://saglitz.com/design/design-tokens-theming)（primitive→semantic→component） | Material / Fluent 2 / Carbon 共同实践 | 令牌的**分层结构**：原始值层、语义别名层、组件层；组件只消费语义层 |
| [Ant Design v5 主题定制](https://ant.design/docs/react/customize-theme/)（seed/map/alias + ConfigProvider 动态切换） | 蚂蚁集团 | 国产工具型产品的主题化参照：种子令牌→派生映射→别名 |
| [CSS Custom Properties 主题运行时](https://www.mironsoft.de/en/blog/react-theming-system-with-css-variables) | 社区共识 | 换肤**运行时载体**：浏览器原生、切换零重渲染、React/Vue 双端通吃——本项目双栈（编辑器 React + 守护台 Vue）唯一合理选 |
| [Material Design 3 动态配色](https://www.theflutterk.it.com/blog/flutter-material3-design-tokens-guide) | Google | 种子色派生方案的参照（本项目保持单一强调色，仅借鉴其派生层级思想） |
| [WCAG 2.2 对比度](https://www.a11yflow.dev/blog/color-contrast-wcag-developer-guide) | W3C WAI | 令牌验收硬指标：正文 ≥4.5:1，大字（≥18pt 或 14pt 粗）≥3:1，UI 组件/焦点指示 ≥3:1（[AA 细则](https://accessibilityassistant.com/blog/accessibility-insights/how-to-apply-wcag-22-colour-contrast-accessibility/)） |
| [BCP 47 / RFC 5646 语言标签](https://publishing-project.rivendellweb.net/understanding-bcp-47/) + [RFC 4647 lookup 回退](https://www.i18n-l10n.com/core-i18n-architecture-locale-negotiation/locale-negotiation-strategies/) | IETF | 多语言包命名与回退链（如 `zh-Hans-CN → zh-Hans → zh → 默认`） |
| [ECMA-402（Intl）](https://www.i18n-l10n.com/core-i18n-architecture-locale-negotiation/date-number-formatting-standards/) + Unicode CLDR/TR35 | ECMA / Unicode | 日期/数字/相对时间的本地化格式化，禁止手拼 |
| [ICU MessageFormat](https://phrase.com/blog/posts/guide-to-the-icu-message-format/) | Unicode | 复数/变量文案的消息格式，禁止字符串拼接翻译（[i18n 常见陷阱](https://expertbeacon.com/how-to-get-started-with-internationalization-in-javascript/)） |

## 2. 技术选型裁决（声明）

1. **三层令牌**：primitive（原始值，按"是什么"命名）→ semantic（按"用途"命名，组件唯一消费层）→ component（组件级映射）。
2. **真相源文件**：`packages/schema` 同级新增 `packages/tokens/tokens.json`，DTCG 2025.10 格式；构建期由零依赖脚本生成双端 CSS 变量与 TS 类型。不引入 CSS-in-JS；Style Dictionary 等外部工具链暂不上（保持零依赖传统），预留格式兼容。
3. **运行时载体**：CSS 自定义属性，命名 `--ts-<层>-<名>`（ts=TalkScene）；主题即 `[data-theme]` 下的一组语义层覆写。守护台既有 `--c-*` 变量视为本规范的先行实验，收敛时改名归并。
4. **换肤**=新增一份语义层覆写包，禁止改任何组件代码；**多语言**=新增一份语言包，禁止改任何组件代码（§6、§7）。
5. 深色基底 + 单一强调色（#5eccff）为默认主题 `dark` 的品牌锚点，三端统一；浅色主题非首期目标，但令牌结构必须允许其存在。

## 3. 现状勘查（2026-10-20 实测真值）

| 端 | 文件 | 规模 | 变量化程度 |
|---|---|---|---|
| 编辑器 | apps/editor/src/style.css | 4,308 行 | **零 CSS 变量**，全魔法值 |
| 守护台 | apps/control-console/src/style.css | 514 行 | 已有 `--c-*` 变量约 20 枚（良好种子） |
| docsys | docsys/framework/assets/style.css | 60 行 | 已有 6 枚变量 |

漂移证据（三端三套底色，同一品牌色是唯一常量）：

| 语义 | 编辑器 | 守护台 | docsys |
|---|---|---|---|
| 基底 | `#0b1220` | `#0e1117 / #12161d` | `#0d1117` |
| 面板 | `#1f2937` | `#1a2030 / #222a36` | `#161b22` |
| 正文 | `#e5e7eb`（40 处） | `#e4eaf2` | `#dbe3ec` |
| 弱文 | `#9ca3af / #cbd5e1 / #9daab8` 并存 | `#9daab8 / #5e6e82` | `#8b98a8` |
| 强调 | `#5eccff` | `#5eccff` | `#5eccff` |
| 成功/警告/错误 | `#4ade80 / #f6c94e / #fca5a5` | `#4dd68c / #f6c94e / #ff6b6b` | `#4ade80 / #fbbf24 / —` |

失控项（编辑器实测）：字号 **15 个档位**（含 9/10/11.5/12.5 半像素碎档），用量 12px×68、11px×24、13px×12；圆角 **10 档**（2–18px + 999px）；间距 gap/padding 前 18 种组合无阶可循（10px×66、8px×57、6px×36…）。

## 4. 令牌基线 v0.9（收敛声明）

### 4.1 primitive 层（原始值）

| 令牌 | 值 | 归并来源 |
|---|---|---|
| `color.ink.bright` | `#f8fafc` | 编辑器高亮文 |
| `color.ink.base` | `#e4eaf2` | 守护台正文；编辑器 `#e5e7eb`、docsys `#dbe3ec` 归并 |
| `color.ink.sub` | `#9daab8` | 双端弱文；`#9ca3af/#cbd5e1/#8b98a8` 归并 |
| `color.ink.muted` | `#5e6e82` | 守护台 muted（仅用于图标/非正文，见 §5 对比度） |
| `color.bg.deep` | `#0e1117` | 守护台；docsys `#0d1117`、编辑器 `#0b1220` 归并 |
| `color.bg.base` | `#12161d` | 守护台 |
| `color.bg.panel` | `#1a2030` | 守护台；编辑器 `#1f2937`、docsys `#161b22` 归并 |
| `color.bg.card` | `#222a36` | 守护台 |
| `color.bg.input` | `#1c2535` | 守护台 |
| `color.accent` | `#5eccff` | 三端唯一常量，品牌锚点 |
| `color.ok` / `color.warn` / `color.err` | `#4dd68c` / `#f6c94e` / `#ff6b6b` | 守护台；编辑器 `#4ade80/#fca5a5`、docsys `#fbbf24` 归并 |
| `font.scale` | `{11, 12, 13, 14, 16, 18, 22, 28}` | 8 阶；禁半像素；15→14、24→22、9/10→11、48 仅启动屏特例 |
| `space.scale` | `{4, 8, 12, 16, 24, 32}` | 《UI 设计规范》§2 同源 |
| `radius.scale` | `{4, 6, 8, 10, pill=999}` | 5 档；2→4、12/14/16/18→10 |
| `breakpoint` | `{1024, 1440}` | 《UI 设计规范》§4 同源 |

### 4.2 semantic 层（组件唯一消费层，示例命名）

`--ts-bg-deep / --ts-bg-base / --ts-bg-panel / --ts-bg-card / --ts-bg-input`、`--ts-border`（rgba(255,255,255,.09)）/ `--ts-border-strong`（.14）、`--ts-text / --ts-text-sub / --ts-text-muted / --ts-text-inverse`、`--ts-accent / --ts-accent-dim`（18% alpha）、`--ts-ok / --ts-warn / --ts-err`（各配 12% alpha 底 + 30% alpha 边的徽标态）、`--ts-state-running/queued/blocked`（映射 accent/#8ba7c4/err）。

### 4.3 component 层（首批）

按钮高 `{28, 32, 36}`；卡片 `padding=16 / gap=16 / radius=10`；徽标 `font=11 / radius=pill / 三档色取 semantic 徽标态`；输入框 `bg=input / radius=8`；弹窗宽 `{420, 720, 1080}`（《UI 设计规范》§7 同源）；z 阶 `{sticky=10, drawer=20, modal=40, confirm=60, toast=80}`（终结 z-index 战争）。

## 5. 对比度验收（WCAG 2.2 AA）

- 正文（13/14px）一律用 `--ts-text` 或 `--ts-text-sub` 于 `--ts-bg-base/panel` 之上，实测须 ≥4.5:1。
- `--ts-text-muted` 对比度不足 4.5:1，**仅允许**用于图标、占位提示、≥16px 的非关键文字。
- 每枚新令牌入库前过对比度计算（构建脚本内置校验，失败即拒构建）。

## 6. 换肤（主题）扩展规则

1. 主题 = `packages/tokens/themes/<name>.json`，只覆写 semantic 层；primitive 层只增不改。
2. 运行时切换：`document.documentElement.dataset.theme = <name>`，零重渲染；默认 `dark`。
3. 新主题验收：WCAG 对比度全量复算通过 + 三端截图基线各一套。
4. 组件代码出现十六进制色值/魔法字号即评审打回（构建期 lint 兜底）。

## 7. 多语言（i18n）扩展规则

1. 语言包：`locales/<BCP47>.json`（首期 `zh-CN` 为默认与唯一完备包，`en` 作为机制验证样例）；回退链按 RFC 4647 lookup 截断（`zh-Hans-CN → zh-Hans → zh → zh-CN`）。
2. 文案一律 key 化外置（`t('hub.card.status.done')` 式），新代码写死文案即评审打回；复数/变量用 ICU MessageFormat，禁止拼接。
3. 日期/数字/相对时间一律走 `Intl`（ECMA-402）——与《UI 设计规范》§3 时间相对化同链落地。
4. 双端各封装薄 t() 助手（编辑器 React、守护台 Vue），不锁定框架库；后续量上来再评估 i18next/vue-i18n。
5. 新布局代码使用逻辑属性（`margin-inline-start` 等），为 RTL 语言预留；首期满载验收只做 zh-CN/en。

## 8. 与波次的衔接

- 本文是 U0 波的施工蓝图：U0 交付 = `packages/tokens` + 构建脚本 + 双端样式收敛到 `--ts-*` + 对比度校验 + 基线页。
- 台账维护：§3 现状表与 §4 基线表随收敛进度滚动更新；任何"新颜色/新字号"先进本文 primitive 层，再进代码。
