# TokenLedger 增长策略

**起草日期：2026-10-09。** 基于本机实测数据、两份 agents 调研报告
（[独立开发者打法](research/indie-devtools-playbook.md)、
[市场与竞品](research/ai-coding-cost-visibility-market.md)）和竞品仓库实测。

## 一、先看事实：产品做完了，分发是零

`gh repo view Daidai-star/tokenledger`（2026-10-09）：

| 指标 | 值 |
| --- | --- |
| star / fork / watch | **0 / 0 / 0** |
| open issues / PR | 0 / 0 |
| license | **null** |
| homepage | 空 |
| 创建时间 | 2026-10-07 |
| release 下载（4 个包合计） | **4 次** |

代码质量不差：137 个测试、零运行时依赖、5 个 collector、桌面应用 37.9 MB。
问题不在产品，在**没有人知道它存在**。仓库存在 2 天，0 star。

对比同期同赛道：

| 项目 | star | 创建 | license | 官网 | 一句话 |
| --- | --- | --- | --- | --- | --- |
| [ccusage](https://github.com/ccusage/ccusage) | 18.9k | 2025-05 | 其他 | ccusage.com | `npx ccusage` |
| [codeburn](https://github.com/getagentseal/codeburn) | 11.4k | 2026-04 | MIT | codeburn.app | See where your AI spend goes |
| [tokscale](https://github.com/junhoyeo/tokscale) | 5.6k | 2025-12 | MIT | tokscale.ai | 全球 token 排行榜 |
| [TokenTracker](https://github.com/xiufengsun/TokenTracker) | 2.0k | 2026-04 | MIT | tokentracker.cc | Local-first, 31 tools |
| **TokenLedger** | **0** | 2026-10-07 | **无** | **无** | 本机 Coding AI Token 账本 |

star 数为 2026-10-09 经 `gh api` 实测。**代码质量不是问题，分发是问题。**

## 二、最紧急的三个硬伤

### 1. 没有 LICENSE —— 这是增长的最大障碍

`licenseInfo` 为 null，README 写「未附带许可证，默认保留所有权利」。

对一个面向开发者的开源工具，**这等于把「开源」这个信任信号关掉了**：
- 开发者不敢 star 一个连授权都不明确的仓库；
- 企业法务无法批准使用；
- 贡献者无法提交 PR；
- 竞品全部 MIT / 开放许可，我们成了异类。

竞品最低门槛就是 MIT。这是**必须立刻做**的一件事，成本一小时。

### 2. 产品叙事是「仪表盘」，不是「能帮你省钱/不踩坑的行动工具」

我们的 README 开头：「统计本机所有 coding 相关 AI 工具的模型用量，
给出可视化与流程动画」。这句话描述的是**我们的实现**，不是**用户的结果**。

竞品 codeburn 的第一句是「**See where your AI spend goes**」——
同样是本地日志分析，它说的是用户的钱去哪儿了。

更关键的是**功能差距**。codeburn 已经做到了：
- `codeburn optimize` — 扫出会烧钱不干活的东西（每轮重读的文件、
  几个月没用的 MCP server、过长的 CLAUDE.md），给出**评级 + 修复建议 + 预计省多少**；
- `codeburn quota` — 读订阅真实额度，告诉你套餐还剩多少、
  「这个月会不会超」，而不是只显示花了多少；
- `codeburn guard` — 挂 Claude Code hooks，超过 $5 警告、$15 中断；
- 菜单栏常驻、Capacity Dock 屏幕边缘额度环；
- 期间对比（两个日期范围并排看差异）。

我们的冷启动诊断已经触及「缓存浪费」这个方向（首请求溢价 $8.44、
每会话 $0.0195），但它是**描述性统计**，不是**可执行的建议**。

**差距的本质**：我们告诉用户「你的缓存命中率第 1 次是 52%」，
codeburn 告诉用户「这个文件你每轮都在重读，改成这样每月省 $12」。

### 3. 没有传播资产

- README **零 GIF、零徽章、零产品截图**（`rg -c 'badge|shields.io|.gif'` 结果为 0）。
  只在第 11 行放了一张 `overview.png`。
- 没有官网、没有 Product Hunt 页面。
- macOS 安装包**未签名未公证**，README 让用户去「系统设置 → 隐私与安全性」手动放行。
  这一步会劝退绝大多数非技术用户。codeburn 的 macOS 包是 **Developer ID 签名 + Apple 公证**的。
- 下载量 4 次，说明连第一步都没迈出去。

**我们其实已经有一个很强的传播钩子，但没人知道**：`web/src/share.ts`
实现了 279 行的 Canvas 2D 分享卡片生成（`renderShareCard`），
已在 `Mall.tsx` 接入，一键生成 PNG。

这是「我今年烧了 X 美元的 AI token」的天然社交货币。
调研显示独立开发者的传播钩子分三类：视觉反差、用户自己的结果、排行榜。
我们**同时有第一类和第二类**，却都没推出去。

## 三、定位：不要说「本地优先」，要说「别再被账单吓到」

调研给出的关键判断是：**「纯本地 + 零上传」不是壁垒，是信任门槛。**
反例很直接——Sniffly 1.3k star、Tokenmeter、各种 local-only 工具，
全都宣称本地处理；local-token-monitor 只有 8 star。

而我们的差异化在别处，且更硬：

**我们的独有资产**
1. **冷启动缓存诊断** — 用 `ROW_NUMBER()` 做会话内请求序号统计，
   反推「冷启动溢价」。竞品里我没找到第二个做这个的。
2. **项目级账单（47 个项目，本机实测）** — 竞品多为单工具/总量。
3. **跨 5 个工具统一口径** — 且认真处理了 Codex `.jsonl.zst` 的坑。
4. **购买力换算** — 15 件商品跨 6 个数量级，对数标尺。
5. **审美** — 界面是整个赛道里最讲究的。

**建议的定位句**

> 你的 Claude Code 和 Codex 账单只给你一个总数。
> TokenLedger 读你本机已有的日志，告诉你钱花在哪个项目、
> 哪次缓存冷启动上多烧了多少——文件不联网，数据不上传。

第一句对标 codeburn 的「账单只给你总数」，第二句给出我们独有的
「缓存冷启动」，第三句才是隐私（放最后，不是卖点，是信任确认）。

## 四、行动清单（按优先级）

### P0 — 本周，零成本，天级

| # | 行动 | 为什么 | 成本 |
| --- | --- | --- | --- |
| 1 | **加 MIT LICENSE** | 没有 license 就没有 star / PR / 企业使用 | 10 分钟 |
| 2 | README 首屏重写：结果先行 + 截图 + 三步安装 + 徽章 | 现在第一句讲的是实现不是结果 | 半天 |
| 3 | README 加 GIF：项目账单、冷启动曲线、分享卡片各一段 | 静态截图无法证明「结果」的冲击力 | 半天 |
| 4 | 写 `docs/overview` 的英文版 + 配一段 30 秒 demo 视频 | 调研：Show HN 受众最关心「能不能跑起来」 | 半天 |
| 5 | 分享卡片加「一键复制文案」并预置 X 分享意图 | 钩子已存在，只是没人知道 | 1 天 |

### P1 — 两周内，把产品从「看数」升级到「能省钱」

这是**最重要的一步**，也是唯一能让我们在拥挤赛道被记住的一步。

基于现有的冷启动数据，做 **「浪费诊断」**：

1. **冷启动溢价排行** — 哪个项目/会话的冷启动溢价最高，
   按我们的实测：`$8.44 / 432 会话`。用户看到「你的项目 A 每月多烧 $3，
   因为每次新会话都从零开始重建上下文」才会有反应。
2. **可执行建议** — 不是「命中率 52%」，而是：
   - 「你在 `image` 项目的 193 个会话里，
     平均第 6 次请求才达到稳定缓存。这部分是可优化的。」
   - 对应 codeburn 的 optimize：给出**改法 + 预计月省多少**。
3. **预算护栏** — `guard` 那一档：本地规则，
   「单会话超过 $X 提示」。只读日志能做到 session 级预警。
4. **订阅视角** — 用户真正关心的是「我的 $200 Max 够用吗」，
   不是「API 等价值 $321」。区分**订阅额度**与**API 估价**是刚需
   （调研里用户最困惑的正是这个）。

### P2 — 一个月内，分发基建

| # | 行动 | 依据 |
| --- | --- | --- |
| 6 | **macOS 签名 + 公证** | 未签名会劝退非技术用户；codeburn 已做 |
| 7 | **官网**（GitHub Pages 即可） | 8/8 头部竞品都有。star 转化需要落地页 |
| 8 | Linux `.deb` / `.AppImage` | codeburn、TokenTracker 都有，Windows 用户也不小 |
| 9 | **Show HN 首发** | 开发者工具的正解渠道。codeburn 拿了 PH featured |
| 10 | npm 包（`npx tokenledger`） | ccusage 的护城河——零安装试用 |
| 11 | Product Hunt 页面 + 徽章 | codeburn 的 README 顶部就有 PH featured 徽章 |

### P3 — 可选，中期

- 公开路线图 / good first issue（把围观者转成贡献者）
- 排行榜：**默认关闭**。项目决策里写了「不做排行榜」的隐私理由，
  这个判断是对的——cwd 含项目名。但可以做**匿名聚合的
  「模型效率榜」**（不含路径、不含时间序列），风险低很多。
- CLI 输出的 `--json` / `--markdown`，方便用户写博客

## 五、发布时的打法（照抄成功案例的结构）

codeburn 的 README 结构值得逐条对照：

1. 顶部双徽章（企业 logo + Product Hunt featured）
2. 一句话定位 + 「if it shows you something your bill never did, star it」
3. `npx xxx` 一行安装
4. 6 个平台徽章（macOS/Win/Linux，含签名状态说明）
5. **The problem** — 用用户的困惑开场（我们的对应：$321 API 估价 ≠ 欠费）
6. Sixty seconds — 一分钟看到价值
7. **Fix it** — 怎么省钱（我们缺这一段）
8. **Always in view** — 菜单栏/常驻（我们缺）
9. Inside your agent — 深度整合

其中 5、7 是我们最该立刻补的。

## 六、反模式（别做）

1. **别买 star。** WIRED 报道过这个市场，GitHub 官方也把 star 定义为
   「兴趣的近似信号」。短期数字会换来长期信任崩塌。
2. **别把 star 当成功指标。** 热门帖子能带来一次性流量，不保证留存。
   要看：README 到达 → 安装成功 → 首次完成核心任务 → 2/4 周回访。
3. **别做需要信任上传的排行榜。** 项目隐私决策是对的，保留。
4. **别用「零依赖」「零配置」当卖点。** codeburn 的 README 里
   技术栈在架构章节，不在标题。目标用户不 care。
5. **别只靠创作者本人。** 尤其 viral 期间要先整理 FAQ、
   good first issue 和支持边界，否则会被 issue 淹没。

## 七、star 与真实用户的换算（已实测）

这是验证「star 值不值得追」的关键对照。实测 codeburn 最新版本
`desktop-v0.9.25`（2026-10-09 经 `gh api` 读取）的各平台下载量：

| 平台 | 下载 |
| --- | --- |
| macOS arm64 `.dmg` | 1299 |
| Windows `.exe` | 635 |
| Linux `.deb` | 213 |
| Linux `.rpm` | 90 |
| Linux `.AppImage` | 53 |
| macOS Intel `.dmg` | 89 |
| **合计（去重前）** | **约 2380** |

对照 **11,361 star**——star 与真实安装量大约 **4.8 : 1**。

**这个换算有三个含义：**

1. **star 严重高估真实用户**，任何以 star 为目标的策略都会投错。
   codeburn 拿了 11k star，真实装机约 2.4k。
2. **但 star 依然是有效的上游漏斗**——它衡量的是「有多少人
   觉得这东西值得收藏」，而这个数比安装量更早可得、也更灵敏。
   正确用法是把 star 当**传播 reach 的代理指标**，
   把安装量当**转化指标**，两者分开看。
3. **对我们 0 star 的诊断依然成立**，而且更严重：
   按 4.8:1 折算，我们要达到 codeburn 的量级需要约
   **5.4 万 star**，或者把 star 降到几百但安装做到上百。
   后者现实得多——**这也说明小而美的路线是可行的**。

同理，我们自己 v0.1.0 四个包合计下载 **4 次**，star 0 个，
完全符合「刚发布、零分发」的基线。

## 八、这个判断可能错在哪

- **下载量也不等于活跃。** codeburn 的 2380 次下载里，
  有多少是 7 日 / 30 日回访用户，未知。它有 npm 包
  （`npx codeburn`），CLI 用户的下载量根本不计入 release——
  所以真实用户数可能**远高于** 2380。这个对照只能证明
  「star 不是安装量」，不能证明「star 不是用户」。
- **隐私可能不是首要购买条件。** 有人愿意用云端 Langfuse 换团队协作。
  纯本地牺牲了分享、告警、多设备同步，在团队场景是劣势。
- **「省钱」叙事未必对所有用户成立。** 如果用户用固定订阅
  （$200 Max 随便用），省 API 钱的叙事无效——这时要换成
  「你的额度够用吗 / 会不会触顶」。
- **赛道已经很挤。** ccusage 18.9k、codeburn 11.4k 都在前面。
  正面硬碰「又一个 token 统计」没有胜算，必须靠
  冷启动诊断这类**别人没做的洞察**取胜。

## 附：调研文件

- [独立开发者开源作品增长打法](research/indie-devtools-playbook.md) —
  8 个案例（Wealthfolio / Dayflow / screenpipe / term.everything /
  PocketPal / Postiz 等）的定位话术、冷启动渠道、传播钩子、定价与反模式
- [市场与竞品调研](research/ai-coding-cost-visibility-market.md) —
  厂商 dashboard / 开源工具 / SaaS 三层竞品，12 条用户痛点原话，
  官方定价与隐私证据
