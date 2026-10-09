# TokenLedger 项目进度

本机 Coding AI 工具的 Token 账本。仓库名 Alltokn，产品名 TokenLedger，版本 0.1.0。

## 项目目标

只读本机各 AI 编程工具的日志，统计 token 用量与预估成本，并回答三个问题：
花了多少、强度多高、钱花在哪个项目上。纯本地，不联网，不上传。

支持工具：Codex、Claude Code、OpenCode、DSH、Gemini CLI。
交付形态：命令行 + Tauri 桌面应用（Tauri 只做壳，后端是零依赖 Node）。

## 当前状态

v0.1.0 已发布并修好首次 Release 的构建问题。项目账单与缓存冷启动诊断已完成
后端查询 + 前端渲染，尚未发布新版本。

验证结果（2026-10-09）：

| 检查项 | 命令 | 结果 |
| --- | --- | --- |
| 测试 | `npm test` | 137 passed / 0 failed |
| 类型 | `npm run typecheck` | 通过 |
| 前端构建 | `npm run build` | 通过，199.58 kB（gzip 64.01 kB） |
| 接口 | `node server/index.js` + curl | `/api/projects`、`/api/cold-start` 均返回真实数据 |
| 浏览器渲染 | Playwright 1440px + 390px | 两个新区块渲染正常，窄屏溢出已清零 |

## 已完成工作

### 采集与存储

- 5 个 collector，各自解析本机日志格式，归一化成 `UsageEvent`
- 增量扫描：游标记录到文件字节偏移，崩溃时不提交，重跑能补齐
- Codex 的 `.jsonl.zst` 会话文件走 `node:zlib` 流式解压，跨块不截断行
- SQLite（`node:sqlite`，WAL 模式）落库，事件表幂等写入
- 数据库位置：CLI 用 `~/.tokenledger/tokenledger.db`（`TOKENLEDGER_DATA` 可改）；
  桌面应用用 Tauri app data 目录

### 聚合与接口

- `server/queries.js` 提供总览、时间序列、模型/工具排行、工具×模型矩阵、
  时段分布、速率统计、会话与事件流
- 成本估算 `server/pricing.js`，区分 `builtin` 精确价与 `builtin~est` 家族估算
- HTTP 服务零依赖，`node:http` + SSE 推送扫描进度

### 前端

- 全部图表自绘 SVG，无图表库；视觉走 Anthropic 的克制风格
- 用量趋势、工具占比、Token 构成、模型排行、活跃热力图、工具×模型矩阵、
  时段活跃、成本构成、最近会话/请求
- Token 速率区块：按分钟分桶，分母用活跃分钟，中位数与 P95 单列
- 购买力换算：15 件商品跨 6 个数量级，用对数标尺；购物车不纯贪心
- 分享卡片：本机 Canvas 2D 生成 PNG，用户自己决定发不发

### 项目账单与冷启动诊断（2026-10-09 完成）

- `Queries.projects()` — 按 cwd 聚合 token / 成本 / 会话数 / 模型数 / 缓存命中率
- `Queries.coldStart()` — 按会话内请求序号统计缓存命中率爬升曲线，
  并用首请求的实际混合单价反推「冷启动溢价」
- 接口 `GET /api/projects`、`GET /api/cold-start`，均已接进 `/api/dashboard`
- 前端 `web/src/components/Insights.tsx` 两个区块：
  `ProjectSection`（分布 + 明细表 + 极值指标）、`ColdStartSection`（五项指标 + 爬升曲线）

## 重要口径与决策

**冷启动的「首次」用 `ROW_NUMBER()` 而不是 `MIN(ts)`。**
并发请求会共享同一毫秒（实测平均 2.38 条，最多 225 条），用 `MIN(ts)` 做 JOIN
会把同一个会话重复计数 2.4 倍——417 个会话被算成 991。这条口径写死在
`server/projects.test.js` 的注释与用例里。

**`total_tokens` 是派生列。**
由「新鲜输入 + 输出 + 缓存读 + 缓存写」在 Store 落库时算出，`UsageEvent`
不接受传入。第一版测试传了 `total`，全部被忽略，断言失败才发现。

**`#eventWhere()` 返回裸条件 + `where` 两种形态。**
`sql` 是不含 WHERE 的裸条件，供需要追加额外条件的查询拼装
（`WHERE ${w.sql ? `(${w.sql}) AND` : ""} cwd IS NOT NULL`）；
`where` 是完整形态，供原本直接插值的 `hourly` / `weekday` / `rate` 使用。
改这个函数时三处插值必须同步改，`projects.test.js` 末尾的用例专门兜这个。

**`total_tokens = 0` 的心跳行要排除。**
它们不带用量，混进冷启动统计会把「首次请求」错认成心跳。

**项目维度绝不外传。**
`cwd` 里就是项目名，可能含客户名或内部代号。接口只在本机提供，
界面上用 `shortPath` 只显示最后两段，且不进任何上传/分享路径。

**冷启动溢价按 1/5.75 折扣反推。**
Claude 缓存读相对 input 的折扣比例。这是估算，不是厂商账单，
界面上标注为「按缓存读 1/5.75 折扣反推」。

**Tauri 只当壳。**
后端是 8 GB 日志解析 + 多帧 zstd + SQLite 聚合的零依赖 Node 实现，重写不划算。
Rust 侧只做四件事：挑空闲端口、拉起打包的 Node、轮询 `/api/health`、开 WebView。
健康检查用 `std::net` 直发 HTTP，不引入 `reqwest`。实测 DMG 37.9 MB vs Electron ~85 MB。

**窄屏溢出是 grid 子项的 min-content 撑开，不是断点没写对**（10-09 实测）。
390px 下整页宽 540px，查出三处根因，媒体查询里改了三个地方才清零：

1. `@media (max-width: 900px)` 把 `.grid-2` 改成了单列，但子项仍按
   `min-content` 撑到 520px。补 `.grid-2 > * { min-width: 0 }`。
   注意只加一层不够——嵌套的 `.rank-list` 也要单独给 `min-width: 0`。
2. `.rank-row` 的固定列宽合计 476px（140+56+80+70+60 + 4×14 gap），
   窄屏放不下。媒体查询里压到 44+56+52 + 8px gap，并把 `minmax()`
   的下限从 `140px/80px` 改成 `0`（只写 `1fr` 的话下限还是 auto）。
3. `.table` 是 5 列 nowrap 的表格，min-content 438px。它没有滚动容器，
   整页被撑宽。给明细表包一层 `.table-scroll { overflow-x: auto }`，
   表格内部横向滚动，页面不动。宽屏下容器 530px 正好装下，不触发滚动。

复现方式：`page.setViewportSize({width:390,height:844})` 后比较
`document.documentElement.scrollWidth` 与 `innerWidth`。相等即无横向溢出。

**不做排行榜。**
coding agent 日志敏感度远高于普通使用统计，上传时间序列足以反推作息。
如果以后要加，保持纯本地，最多做成与历史快照的对比。

## 本机实测读数

数据区间 2026-02-12 → 2026-10-07，86,118 条事件。

- 47 个项目，最大一个 `workspace/image` 占 4.89B token（30,927 请求）
- 各项目缓存命中率在 92%~98% 之间，说明不同项目的上下文复用策略确实不同
- 冷启动曲线：第 1 次 52.0% → 第 2 次 79.6% → 第 3 次 81.8% → 第 6 次 86.7%
- 432 个会话的冷启动溢价合计 $8.44，每会话约 $0.0195
- Token 速率：活跃时段平均 636.3K tok/min，中位数 433.8K，P95 1.67M，
  峰值 579.37M tok/min（2026-07-17 00:52，单场长上下文会话）

## 环境与部署笔记

```bash
npm run dev            # server + vite 并行，前端在 5173
npm start              # 只起后端，8787
npm run scan           # 命令行触发一次扫描
npm run build          # 前端产物到 dist/
npm run desktop:build  # 完整桌面产物（需要 Rust 工具链）
npm test               # 全部测试
npm run typecheck
```

- 后端零运行时依赖：SQLite 用 `node:sqlite`，zstd 用 `node:zlib`，HTTP 用 `node:http`
- 需要 Node >= 22.5.0
- sidecar 由 `scripts/build-sidecar.mjs` 生成：esbuild 打后端单文件、拷 `dist/`、
  下载对应平台 Node 运行时，用 `--platform` / `--arch` 支持交叉架构
- CI 在 `.github/workflows`，构建矩阵覆盖 macOS arm64/x64 与 Windows x64

## 已知风险与限制

- **成本是估算**。`builtin~est` 走家族兜底，`unknown` 无价目按 0 计入并提示。
  界面上标注了定价源。
- **冷启动溢价是反推值**，基于固定 1/5.75 折扣假设，不是厂商实际账单。
- **并发同刻请求有丢弃**。`ROW_NUMBER()` 取第一条，同毫秒的第 2、3 条在
  首请求统计里不计入。这是口径选择的代价，换来的是不重复计数。
- **项目数会随扫描范围增长**。界面上限前 10 + 前 12 明细，超出部分只给计数。
- **发布流水线在 10-09 刚修完六个问题**（Node 归档路径、Windows sidecar 兼容、
  产物路径、CRLF 正则、Windows 包静默漏发）。首次发布踩坑多，后续改动需谨慎验证。
- **窄屏横向溢出已修**（10-09 浏览器实测）。390px 下原为 540px 溢出，
  根因有三处，见下方决策记录。

## 接下来的优先级

1. **补 macOS 签名与公证** —— v0.1.0 的 dmg 未签名，
   README 让用户手动去「系统设置」放行，劝退非技术用户。
   codeburn 的 macOS 包是 Developer ID 签名 + Apple 公证的。
2. **官网**（GitHub Pages 即可）—— 8/8 头部竞品都有，是 star 转化的落地页
3. Linux `.deb` / `.AppImage` —— codeburn、TokenTracker 都提供
4. npm 包（`npx tokenledger`）—— ccusage 的护城河是零安装试用
5. Show HN 首发 —— 开发者工具的正解渠道，README.en.md 已备好
6. **补「浪费诊断」**（策略文档 P1，最重要）——
   把已有的冷启动数据从描述性统计升级成可执行建议 + 预计省多少。
   详见 [增长策略](GROWTH_STRATEGY.md)
7. 发布策略由用户决定

### 分发基建（2026-10-09 已完成）

- **MIT LICENSE** 已加（`LICENSE`），README License 章节同步。
  这一项从「没人敢 star」变成可 star / 可 PR / 企业法务可过。
- **README 首屏重写**：从「统计…给出可视化」改成结果先行——
  「账单只给你一个总数 → 钱花在哪个项目 → 缓存冷启动多烧了多少 → 能买什么」。
  结构照 codeburn 逐条对照：结果先于架构，隐私放最后当信任确认。
- **三张传播素材**已生成（`docs/assets/`）：
  `projects.gif`（139 KB，条形逐条生长）、
  `coldstart.gif`（250 KB，命中率曲线逐点生长 + 轴标签渐进加深）、
  `share-card.jpg`（241 KB，本机真实数据生成的分享卡片；
  原 PNG 976 KB，转 JPEG 后视觉无差异）。
  GIF 不是滚动截图，而是用真实接口数据驱动 SVG 逐帧生长——
  「结果先于架构」的视觉演示，比静态截图有说服力。
- **README.en.md** 英文版就绪，Show HN 用。明确写了
  「这些是估算，订阅用户看到的是 API 等价成本不是实付」。
- **分享卡片加了「复制配文」**（`Mall.tsx`）——文案只说本机可验证的事实，
  不含项目路径，避免用户贴出去被追问「哪家公司哪个项目」。
  实测剪贴板内容正确，按态切换「已复制」。

### 分发基线（2026-10-09 实测）

`gh repo view` / `gh api releases`：star 0、fork 0、license null、
homepage 空、v0.1.0 四个安装包累计下载 4 次。
对照 codeburn：11,361 star，最新版各平台合计下载约 2380 次（约 4.8:1）。
**结论：star 是传播 reach 的代理指标，安装量才是转化指标，两者分开看。**
产品本身完成度不差（137 测试、零运行时依赖、桌面 37.9 MB），
瓶颈在分发而非产品。

## 更新规则

- 每次功能落地、bug 修复、部署成功或失败后更新本文件
- 大改动前先写 `docs/checklists/active/<date>-<slug>.md`，
  完成后移到 `completed/`，暂缓的移到 `deferred/`
- 口径类决策必须连同「踩过什么坑」一起记，避免以后重犯
- 验证结果要带命令与通过/失败结论，没验证就直说没验证
- 不记录密钥值与长命令日志
