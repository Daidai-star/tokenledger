# TokenLedger

统计本机所有 coding 相关 AI 工具的模型用量，给出可视化与流程动画。

支持的工具（可扩展）：**Codex**、**Claude Code**、**OpenCode**、**DSH (DeepSeek Harness)**、**Gemini CLI**。

![overview](docs/overview.png)

界面采用 Anthropic 风格的设计语言：暖调象牙白纸感、细发丝线分隔、
衬线体标题与数字、珊瑚色作为唯一强调色，克制而编辑感强。

## 快速开始

需要 Node.js ≥ 22.5（用到内置的 `node:sqlite`）。

```bash
npm install
npm run build      # 构建前端
npm start          # 启动服务（首次启动会自动全量扫描）
# 打开 http://127.0.0.1:8787
```

开发模式（前端热更新）：

```bash
npm run dev        # vite:5173 + api:8787，/api 已配好代理
```

不想起服务，只想要一份统计：

```bash
npm run scan                # 扫描并打印总览
npm run scan -- --tool codex   # 只扫某个工具
npm run reset               # 清库全量重扫
node server/cli.js stats    # 打印当前统计
node server/cli.js export out.json   # 导出 JSON
```

## 数据从哪来

每个工具都有本地日志，TokenLedger 只读这些文件，不做任何网络请求、不上传任何数据。

| 工具 | 数据源 | 拿到的指标 |
| --- | --- | --- |
| Codex | `~/.codex/sessions/**/rollout-*.jsonl` | token_count 增量、模型（turn_context）、cwd、originator |
| Claude Code | `~/.claude/projects/**/*.jsonl` | assistant 消息的 usage（input/output/cache） |
| OpenCode | `~/.local/share/opencode/opencode.db` | assistant 消息的 tokens/cost/model |
| DSH | `~/.dsh/sessions/**/session.v4.jsonl.zstd` | assistant/message 的 usage、provider、model |
| Gemini CLI | `~/.gemini/tmp/**/*.json` | usageTokens |

### 口径归一化

各工具的日志结构不同，collector 负责把差异消化掉，产出统一的 `UsageEvent`：

- **`inputTokens` 一律表示「新鲜输入」**。Codex 的 `input_tokens` 实际包含 `cached_input_tokens`，采集时做了减法，与 OpenCode / Claude 的口径对齐，避免下游重复计费。
- **total = input + output + cacheRead + cacheWrite**。缓存读算进总量，否则 Codex 这种高缓存命中的工具会被严重低估。
- **Codex 的 token_count 是累计值**，取 `last_token_usage` 作为单次增量；`total_token_usage` 只用来交叉校验。
- **`event_id` 保证幂等**：重复扫描同一文件不会重复计数。

### 增量扫描

`file_cursors` 表记录每个文件读到哪个字节。下次扫描：

- 文件未增长且 mtime 未变 → 跳过
- 文件被截断（size < offset）→ 从头重读（靠 `event_id` 幂等兜底）
- JSONL 用字节级读取，只在完整行边界停下，多字节 UTF-8 跨块不会损坏

大文件优化：Codex 单个 rollout 文件可达数 GB，且 99% 的行是消息正文。
采集器用字节级 `bytesFilter` 粗筛，只对含 `"token_count"` 等标记的行付出 `JSON.parse` 成本。
全量扫完 461 个 Codex 文件（约 8 GB）约 13 秒。

DSH 的 session 文件是**多帧拼接的 zstd**，Node 内置 API 只解第一帧，
所以优先走系统 `zstd -dc`，退化时按帧魔数切分逐帧解压。

## 成本估算

日志自带成本时直接采信（OpenCode 的 `cost` 字段）。否则按 `USD / 1M tokens` 计价：

1. `~/.cc-switch/model-pricing.json`（与 cc Switch 同源，优先）
2. 内置价目表 + 家族兜底

家族兜底处理网关自定义命名（`gpt-6-luna`、`claude-opus-5`、`deepseek-v4.1-flash`），
这些没有公开价目，按最接近的公开档位估算，`cost_source` 标为 `builtin~est` 以示区分。

```
cost_source: reported        日志自带
             cc-switch       本地价目表命中
             builtin         内置表精确命中
             builtin~est     家族估算（不确定）
             unknown         无价目，成本按 0 计入并在 UI 提示
```

## 可视化

- **用量趋势** — 堆叠面积图，可切 Token / 请求 / 成本，点模型可下钻
- **Token 速率** — 见下节
- **工具占比** — 环形图
- **Token 构成** — 缓存命中 / 新鲜输入 / 输出 / 推理 / 缓存写入
- **模型排行** — 按量排序，点击联动趋势图下钻
- **活跃热力图** — GitHub 风格年度热力图（Codex profile 的标志性视觉）
- **工具 × 模型矩阵** — 交叉热力，点击格子聚焦模型
- **时段活跃** — 24 小时分布
- **成本构成** + 工具明细表
- **最近会话 / 最近请求** — 实时事件流

## Token 速率（吞吐）

用量总量说明不了「强度」。速率统计回答的是：**你真正在写代码的时候，token 烧得多快。**

事件是「一次请求完成」的瞬时记录，所以速率按**分钟分桶**计算——
每分钟的 token 数 = 该分钟内所有请求的 token 之和。
分桶用 `strftime(..., 'localtime')`，保证小时/日期与本机时区一致。

指标分五层：

| 层级 | 内容 |
| --- | --- |
| `overall` | 活跃分钟数、活跃时长、平均 / 中位数 / P95 / 峰值速率，峰值时刻与当时的工具构成 |
| `byDay` | 每日速率曲线（活跃分钟内的 tok/min） |
| `byHour` | 24 小时速率画像，找出高产时段 |
| `byTool` | 各工具速率对比 |
| `recent` | 最近 60 分钟的逐分钟滚动速率 |

分母用**活跃分钟**而不是全部时间——否则「一周没写代码」会把平均值稀释得毫无意义。
中位数单列出来，因为速率是长尾分布，均值会被个别峰值拉偏。

本机当前读数：活跃时段平均 635.0K tok/min，中位数 433.4K，P95 1.66M，
峰值 579.37M tok/min（2026-07-17 00:52，单场长上下文会话），
累计活跃 349 小时 / 20,911 个有请求的分钟。

按工具看，DSH / OpenCode / Claude Code 的单位时间吞吐都在 910K~992K tok/min，
Codex 因为会话跨度长、总活跃分钟多（20,248 min），平均到 612.3K tok/min——
但它的绝对量占了全机 93%。

## 流程动画

`采集流程` 面板把扫描过程做成可视流水线：

`检测工具 → 解析日志 → 写入存储 → 聚合 → 完成`

- 阶段节点依次点亮，连接线填充
- 进度条按文件数推进，带流光
- 正在处理的工具高亮，节点呼吸 + 圆点脉冲
- 进度通过 SSE（`/api/scan/stream`）实时推送，扫描完成后自动刷新数据

其余动效：入场淡入上移、数字滚动、条形图生长、环形图弧线扫出、
hover tooltip、状态切换过渡；并遵循 `prefers-reduced-motion`。

## 架构

```
server/
├── model.js              UsageEvent / Collector 契约（扩展点）
├── pricing.js            成本估算
├── store.js              SQLite：事件表、游标、扫描记录、日聚合
├── scanner.js            扫描编排 + 进度事件
├── queries.js            聚合查询
├── index.js              HTTP 服务 + SSE
├── cli.js                命令行
└── collectors/
    ├── util.js           遍历 / 增量 JSONL 读取 / 字节过滤
    ├── codex.js  claude-code.js  opencode.js  dsh.js  gemini.js
    └── index.js          注册表
web/src/
├── App.tsx               页面编排、筛选、指标卡
├── components/
│   ├── Charts.tsx        自绘 SVG 图表集（趋势/排行/环形/柱状/热力/矩阵）
│   └── ScanFlow.tsx      采集流程动画
├── api.ts  format.ts  types.ts  styles.css
```

后端零运行时依赖：SQLite 用 Node 内置 `node:sqlite`，zstd 用 `node:zlib`，HTTP 用 `node:http`。
前端图表全部自绘 SVG，没有引入图表库。

## 扩展一个新工具

实现 `Collector` 契约，加进 `collectors/index.js` 即可，存储/聚合/API/前端都不用改：

```js
// server/collectors/mytool.js
import { UsageEvent, Collector } from "../model.js";
import { walkFiles, readJsonlIncremental, toTs, hashId } from "./util.js";

export const mytool = new Collector({
  id: "mytool",
  name: "My Tool",
  color: "#ff6b6b",
  roots: ["/path/to/logs"],
  detect: () => true,
  async scan(ctx) {
    const events = [];
    for (const file of walkFiles(ctx.roots.mytool, { exts: [".jsonl"] })) {
      const cur = ctx.cursor("mytool", file);
      const res = readJsonlIncremental(file, cur.reset ? null : cur, (obj) => {
        events.push(new UsageEvent({
          id: hashId("mytool", obj.requestId),  // 幂等键
          tool: "mytool",
          ts: toTs(obj.timestamp),
          model: obj.model,
          inputTokens: obj.usage?.input || 0,
          outputTokens: obj.usage?.output || 0,
        }));
      });
      ctx.advance("mytool", file, res);       // 保存游标
      ctx.emitProgress("mytool", events.length, 1, 1);
    }
    return { events, stats: { filesSeen: 1, filesParsed: 1 } };
  },
});
```

`ctx` 提供：`cursor()` / `advance()` / `session()` / `emitProgress()`。

## API

| 端点 | 说明 |
| --- | --- |
| `GET /api/dashboard` | 首屏全量数据 |
| `GET /api/overview` | 总览指标 |
| `GET /api/timeseries` | 时间序列（`?byTool=true` 按工具拆） |
| `GET /api/by-model` | 模型排行 |
| `GET /api/by-tool` | 工具对比 |
| `GET /api/matrix` | 工具 × 模型 |
| `GET /api/hourly` `?weekday` | 时段分布 |
| `GET /api/rate` | Token 速率统计 |
| `GET /api/sessions` `?events` | 会话 / 事件流 |
| `GET /api/profile` | 档案（streak、强度） |
| `GET /api/profiles/:tool` | 单工具账号信息 |
| `POST /api/scan` | 触发扫描 |
| `POST /api/reset` | 清库重扫 |
| `GET /api/scan/stream` | SSE 扫描进度 |

通用参数：`from` / `to`（YYYY-MM-DD）、`tools`（逗号分隔）、`limit`。

## 测试

```bash
npm test        # 73 个用例
npm run typecheck
```

覆盖：增量读取（截断/跨块 UTF-8/坏行/去重）、字节过滤、定价（缓存不重复计费、家族兜底）、
幂等写入、聚合与主键冲突、查询筛选、streak 计算、扫描编排（并发保护/错误隔离/增量跳过/reset）。

## 数据存储

`~/.tokenledger/tokenledger.db`（SQLite，WAL）。删除该文件即可完全重置；
`TOKENLEDGER_DATA` 环境变量可改位置。

## 隐私

只读本机日志，不发起任何网络请求，不上传任何数据。数据库留在本地。

截图与文档里的项目路径均为 `…/` 开头的相对展示，不含用户名或绝对路径。

## License

未附带许可证。默认保留所有权利，其他人无权复制、修改或分发本项目的代码。
仅供阅读参考。