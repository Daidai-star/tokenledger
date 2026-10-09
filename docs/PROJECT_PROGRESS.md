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
- **浏览器端未做可视化验证**。本次改动只做了构建产物检查（确认新文案与
  `.proj-path` 样式进了 bundle），实际渲染效果待人工确认。

## 接下来的优先级

1. 人工在浏览器里确认两个新区块的渲染与窄屏表现
2. 用户还有后续需求，待明确后再排
3. 发布策略由用户决定，本轮明确不做 release

## 更新规则

- 每次功能落地、bug 修复、部署成功或失败后更新本文件
- 大改动前先写 `docs/checklists/active/<date>-<slug>.md`，
  完成后移到 `completed/`，暂缓的移到 `deferred/`
- 口径类决策必须连同「踩过什么坑」一起记，避免以后重犯
- 验证结果要带命令与通过/失败结论，没验证就直说没验证
- 不记录密钥值与长命令日志
