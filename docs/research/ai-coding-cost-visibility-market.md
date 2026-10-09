# 本地 AI / Coding Agent 使用成本与用量可见性：市场研究

**查询日期：2026-10-09**（页面内容和 GitHub stars 为该日检索时可见值；动态价格与 stars 可能变化）  
**研究对象：** TokenLedger——纯本地、开源、桌面/CLI，读取 Codex、Claude Code、OpenCode、Gemini CLI、DSH 本地日志，统计 token 和估算成本，支持项目账单、缓存冷启动诊断、购买力换算；只读、零上传。

## 执行摘要

这个细分品类已被验证，但产品形态碎片化：厂商 dashboard 主要展示账号级额度、团队账单或当前窗口；ccusage 等开源工具分析本地日志，原始账单、跨工具项目归因和缓存诊断仍有解释成本。纯本地是有证据的信任差异，但单独不足以形成壁垒：Sniffly、ccusage 及众多低星工具都已宣称本地处理。TokenLedger 可把“多工具、项目级归因、可信成本解释、低安装摩擦”作为组合定位。

## 1. 竞品图谱

### (a) 厂商官方 usage dashboard

| 厂商/产品 | 官方能力 | 对 TokenLedger 的缺口 |
|---|---|---|
| Anthropic Claude / Claude Code | Pro 月付 $20、年付 $200；Max 5x $100/月、20x $200/月。额度按滚动 5 小时窗口和周额度共享，跨 Claude 网页、桌面、移动端与 Claude Code。到限额可开 usage credits，按标准 API 费率继续。Console 提供 API usage/cost，按模型、时间、API key 查询。([计划页](https://claude.com/pricing), [套餐说明](https://support.claude.com/en/articles/11049762-choose-a-claude-plan), [Console 用量报告](https://support.claude.com/en/articles/9534590-cost-and-usage-reporting-in-the-claude-console)) | 订阅用户看到的“API 等价成本”不是实付金额；官方额度主要回答还能用多少，不等于跨项目历史账单。Console 报告面向 API 帐户/角色，不能把多种 coding CLI 的本地使用归成个人项目账单。Claude Code 的 `/cost` 和 `/usage` 有用，但历史项目维度、缓存效率与跨工具合并仍需第三方。 |
| OpenAI Codex / ChatGPT | Codex 纳入 ChatGPT 各档计划，额度依套餐变化；`/status`、Settings/usage dashboard 显示额度/重置/credits，部分 Enterprise 有按 chat 的本地 high-usage 分析及预估美元值；个人可在符合条件时购买 credits。([Codex 计划与限制](https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan), [Codex 产品/套餐](https://openai.com/codex/), [个人 flexible usage credits](https://help.openai.com/en/articles/12642688-using-credits-for-flexible-usage-in-chatgpt-personal-plans)) | 共享额度/credits 会被 Work、Codex 等多个功能消耗；运行成本取决于模型、推理、上下文、工具和执行方式。官方页面也明确预估美元值不是 invoice。相较 API 逐 token 计费，用户难以从“额度/credits”得到项目真实经济成本。([官方用量说明](https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan)) |
| Cursor | Dashboard 可查看团队使用和账单；官方文档提供模型用量和 token breakdown，超出 included usage 后可按需购买，团队可配置支出限制。当前定价页列出 Pro $20/月、Teams $40/人/月，具体包含额度及模型价格随计划/模型而异。([Models & Pricing](https://docs.cursor.com/account/pricing), [团队 Dashboard](https://docs.cursor.com/en/account/teams/dashboard), [当前定价](https://cursor.com/pricing)) | 主要服务 Cursor 内使用；不读取 Claude Code、Codex 等本机日志来做个人跨工具、跨项目归因。官方 usage dashboard 本身仍依附账号/团队，不是离线个人账本。 |
| Gemini CLI | CLI `/stats` 可看 token usage 与缓存节省；缓存功能仅 API key/Vertex AI 认证可用，Google OAuth Code Assist 当前不支持缓存创建。([官方 token caching 文档](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/token-caching.md)) | 单 CLI 内命令为主，未见厂商提供面向个人的跨代理项目账单、成本诊断看板。认证模式不同也影响缓存/定价解释。 |

**官方方案的共同局限（归纳）：**仪表盘按厂商和帐户切分；额度、credits、API 账单、API 等价成本含义不同；项目归因往往不足；不能把本机各 agent 的 session 串成统一视图。此为对上述官方页面能力边界的归纳，不代表厂商没有未公开功能。

### (b) 第三方开源 / 本地工具

Stars 是 GitHub 检索页在 2026-10-09 可见值；没有页面数字的项目不臆测 star 数。

| 项目 | 已核实能力 | 主要不足/边界 |
|---|---|---|
| [ccusage](https://github.com/ccusage/ccusage) | **18.9k stars**。MIT；CLI 读本地数据，支持 Claude Code、Codex、OpenCode、Gemini CLI 等多来源，按日/周/月/session 汇总；多 CLI 生态覆盖最广。([README](https://github.com/ccusage/ccusage)) | CLI 报表优先，需用户理解命令及 API 等价成本；订阅用户的估价不能当真实账单；项目 GUI/诊断/低摩擦桌面体验不是核心。大量 adapters 意味着格式与定价维护面广。 |
| [Sniffly](https://github.com/chiphuyen/sniffly) | **1.3k stars**。Claude Code 日志分析、usage patterns、错误分析、消息历史；本地处理，分享 dashboard 为显式选项。([README](https://github.com/chiphuyen/sniffly)) | 聚焦 Claude Code；分享能力对敏感日志用户要明确提示；主要是使用模式/错误洞察，不是跨 CLI 统一账本。 |
| [ClaudeCodeUsage VS Code](https://github.com/ClaudeCodeUsage/ClaudeCodeUsage) | **66 stars**。本地 Claude Code + Codex VS Code 状态栏/看板，缓存、额度、趋势和 API 等价成本。([README](https://github.com/ClaudeCodeUsage/ClaudeCodeUsage)) | IDE 绑定；作者明确标注 Codex quota 为本机最近一次观察，成本为估算而非账单；覆盖面和分发规模有限。 |
| [TokenCost](https://github.com/mr-beaver/tokencost) | 本地 proxy/看板，支持 Claude Code、VS Code、Claude Desktop、OpenClaw 与 15+ API providers；声称可做模型路由、缓存优化。([README](https://github.com/mr-beaver/tokencost)) | 代理模式需接管请求路径，和“只读现有日志、零改配置”是不同采用门槛；优化/转发会触碰更高信任和兼容性要求。未从检索结果确认 stars。 |
| [Agent Trail](https://github.com/camtrik/agent-trail) | **16 stars**。Claude Code、Codex、OpenCode、OpenClaw、Qoder 本地 session 回放、项目/模型/成本、工具调用与 subagent 树；本地 SQLite。([README](https://github.com/camtrik/agent-trail)) | 更偏 session observability/replay；目前小众，Qoder 部分仅统计 token 不计成本。 |
| [Tokenmeter](https://github.com/serkankorkut/tokenmeter) | Claude Code、Codex、Copilot CLI；按 prompt/session/project 展示 token、缓存 miss、API 等价成本和订阅比较；单文件/零依赖/本地。([README](https://github.com/serkankorkut/tokenmeter)) | 直接竞品；说明“只读本地日志 + cache miss 诊断”已有人实现。README 未在搜索摘要展示 star 数。 |
| [Local Token Monitor](https://github.com/claudneysessa/local-token-monitor) | 单 Python 文件、零依赖、实时 Claude Code 本地 dashboard，按任务/日看成本；作者声明无网络调用；搜索摘要显示 **8 stars**。([README](https://github.com/claudneysessa/local-token-monitor)) | 仅 Claude Code；低星数表明“本地+零依赖”自身不能确保分发/留存。 |
| [Claude Code Monitor](https://github.com/alihassanml/claude-code-monitor) | 本地 JSONL → SQLite，实时 token/cost、project、session、工具失败、billing mode；不需账号、不传数据。([README](https://github.com/alihassanml/claude-code-monitor)) | Claude 单品，运行 dashboard 需要 Python/FastAPI 等依赖；本地 web server/CDN 依赖不等同于严格“零网络”。 |
| [Claude Code Usage Dashboard](https://github.com/ngonhattri/cc-usage-dashboard) | 本地 SQLite、缓存类别、成本/预算、日历、项目和 session 归因、CSV/JSON 导出。([README](https://github.com/ngonhattri/cc-usage-dashboard)) | Claude 单品，需 Node 22.5+、安装 web/server 依赖；功能面虽完整，跨工具与发行便利性仍可区分。 |
| [CC Token Meter](https://github.com/Sabeekhann/cc-token-meter) | Claude Code 本地缓存分析、预算、实时 session、建议；宣称无 API key、无 telemetry。([README](https://github.com/Sabeekhann/cc-token-meter)) | Claude 单品；项目还提供建议/优化，TokenLedger 可把账单核算与购买力解释做到跨 agent。 |

**名称核验：**`sniffly` 是真实项目（Chip Huyen）；`tokencost` 也有真实仓库（`mr-beaver/tokencost`）。搜索中的 `ccusage` 是多个同名仓库/分叉，本文以官方组织 [`ccusage/ccusage`](https://github.com/ccusage/ccusage) 为准；18.9k 是该仓库当前显示值。存在同名不等于同一产品/维护方。

### (c) 通用 LLM 成本追踪 SaaS / 可观测性

| 产品 | 客户/数据路径 | 是否读取 coding agent 本地历史日志 |
|---|---|---|
| [Helicone](https://github.com/Helicone/helicone) | LLM 应用开发/运维团队；以 SDK、gateway/请求代理记录 API 调用，包含成本、延迟、监控、路由等。云端路径要把请求经过 Helicone；也可自托管其 gateway。([Quickstart](https://docs.helicone.ai/getting-started/quick-start), [Gateway](https://helicone.mintlify.app/getting-started/integration-method/gateway), [本地 gateway 仓库](https://github.com/Helicone/ai-gateway)) | 默认模型是应用请求埋点/代理，不是事后扫描 Claude/Codex 本地 transcript。其 Claude Code 集成可通过 provider 配置跟踪实时请求，仍是主动接入路径。 |
| [Langfuse](https://langfuse.com/) | LLM 应用团队的 tracing、调试、评测和成本监控；支持 Cloud 或 self-host。([Claude Code integration](https://langfuse.com/integrations/developer-tools/claude-code)) | 有官方 Claude Code hook 集成：读 transcript 并发送 traces 到 Langfuse；要账户/API key/base URL，且可捕获 prompt、回复、工具输入输出。属于 opt-in 在线遥测，不能视为默认本地日志离线分析。官方 integration 列表也包含 Codex/Cursor/OpenCode，但需逐产品配置。([集成目录](https://langfuse.com/integrations)) |
| [Laminar](https://laminar.sh/) | 面向构建 AI 产品的开发者，围绕 tracing、评测与生产监控；通常通过 SDK/OTel instrumentation 采集应用运行事件。 | 搜索未找到其原生扫描 Claude Code/Codex 本地历史日志的官方依据；应视为运行时接入型方案，不应把通用 trace 能力误写成原生日志解析支持。 |
| [OpenLLMetry / Traceloop](https://traceloop.com/docs/openllmetry) | OpenTelemetry SDK，为 LLM 应用代码插桩，输出 traces 到 Traceloop 或现有 observability stack。默认 endpoint 是 Traceloop；默认 span 属性可记录 prompts/completions，隐私设置可关闭内容。([介绍](https://traceloop.com/docs/openllmetry), [配置/隐私](https://traceloop.com/docs/openllmetry/configuration)) | 不等同本地 CLI 文件分析；需在被测应用/SDK中插桩或显式上报。官方文档没找到原生消费 Claude Code/Codex 已生成历史日志的产品。 |

**定位差异：**SaaS 更强于团队实时监控、trace 搜索、告警、调试与治理；TokenLedger 应聚焦个人/小团队“事后读取本机真实 agent 记录、完全离线、多厂商账目解释”，不要与生产 LLM observability 正面比拼 tracing/evaluation。

## 2. 用户痛点证据（公开原话）

下列引用保留用户公开发言中的短句，均来自 X/HN/Reddit/GitHub/厂商社区；帖子可能是个案，不代表发生率。引用保留英文以避免误译。

1. **不知道 `/cost` 是否真的收费：**“surprising USD 321 of 'total cost'”; 用户以为月费已覆盖，看到 Claude Code `/usage` 数字后担心欠费。([Reddit, 2026-09-05](https://www.reddit.com/r/ClaudeAI/comments/1w8fy9u/suddenly_worried_about_costs_of_claude/))
2. **担心 API 账单失控：**“I prefer not to use the api so I don't inadvertently rack up a large bill.”([Reddit](https://www.reddit.com/r/ClaudeCode/comments/1qqlxsx/new_to_claudecode_should_i_pay_20month_or_go_with/))
3. **额度消耗速度超预期：**“hit first limit after 30 minutes”——HN 用户描述 Pro 计划在探索项目与 web search 后很快触顶。([Hacker News](https://news.ycombinator.com/item?id=47586176))
4. **用户不知道限制背后的 token 量：**HN 讨论称厂商“there is no transparent metrics on the token usage count”，套餐只显示相对限额。([Hacker News](https://news.ycombinator.com/item?id=47586176))
5. **成本与收费概念混淆：**用户看到 `$321` 后在评论中询问是否会被收费；回复解释这是 API 价格等价值，不是订阅用户实付账单。([Reddit](https://www.reddit.com/r/ClaudeAI/comments/1w8fy9u/suddenly_worried_about_costs_of_claude/))
6. **用量突增/额度缩水难以解释：**“Suddenly I was burning through a week's allowance in two days”——用户表示工作方式未变但周额度消耗显著变快。([Reddit, 2026-04-05](https://www.reddit.com/r/ClaudeCode/comments/1sd8t5u/anthropic_isnt_the_only_reason_youre_hitting/))
7. **实际账单分布被平均数遮蔽：**团队管理员称“4 engineers were 80% of the spend”，且一个人占 31%；只看每人平均值误导预算和治理。([Reddit, 2026-10-07](https://www.reddit.com/r/ClaudeCode/comments/1x04t9e/our_average_claude_code_cost_per_developer_is_4_a/))
8. **无法解释用量的时间/任务归属：**“I had no idea what each one was doing or how much they were costing me”——Codex 多 session 用户希望同时看到任务和成本。([HN](https://news.ycombinator.com/item?id=44438383))
9. **重放上下文成本难被直观理解：**HN 用户总结“hidden cost of context window re-evaluation in agent loops”。([HN, Show HN](https://news.ycombinator.com/item?id=48297491))
10. **本机日志有数据但不可用：**Sniffly 用户表示尝试后发现了“usage patterns”与错误分布；Reddit 讨论指出 session JSONL 可用于历史分析。([Reddit, Sniffly 介绍](https://www.reddit.com/r/ClaudeAI/comments/1m1jloe/), [HN 本地日志工具讨论](https://news.ycombinator.com/item?id=44438383))
11. **企业隐私担忧：**Claude Code issue 用户担心遥测“silently begins transmitting data”，并指出可能包含邮箱、用户/session/org ID，开启 prompt logging 后还会带 prompt。([GitHub issue #11057](https://github.com/anthropics/claude-code/issues/11057))
12. **团队的按需计费规则不清楚：**Cursor 用户公开询问 on-demand usage 如何量、按 token/request/model 哪种口径，以及“Why isn’t this explicitly clear on the pricing page?”([Cursor Community, 2026-05-20](https://forum.cursor.com/t/questions-about-on-demand-usage-based-pricing/161152))

**痛点聚类：**①数值口径混淆（额度 vs API equivalent vs 真正账单）；②用量波动和限额触顶缺乏原因解释；③跨项目/跨工具归因弱；④多 agent/subagent 让单次任务成本不直观；⑤企业担忧 prompt/代码和身份数据离开本机。

## 3. 定价与计费：为何用户容易意外

### Claude Code

- Claude Code 在付费 Pro/Max/Team 中使用共享套餐额度；个人 Pro 月付 $20，Max 5x $100、20x $200，均存在滚动 5 小时和周限额。超过额度可等重置、升级或启用 usage credits/切 Console API。额度受模型、上下文、任务长度和功能影响，没有稳定的固定消息数。([套餐页](https://claude.com/pricing), [用量与套餐说明](https://support.claude.com/en/articles/11049762-choose-a-claude-plan), [Pro/Max 使用说明](https://support.claude.com/en/articles/11145838-use-claude-code-with-your-pro-or-max-plan))
- **截至查询日 API token 单价（Anthropic 当前价格页）：**Opus 5.5 输入 $4/MTok、输出 $20/MTok、缓存读 $0.20/MTok、5 分钟缓存写 $5/MTok；Sonnet 5.5 输入 $2、输出 $10、缓存读 $0.10、缓存写 $2.50/MTok。缓存读约为输入价 0.05×，5m 写入 1.25×基准输入价；长缓存 TTL 可进一步加价。价格页会动态更新，部署应将价格表版本化。([官方定价](https://claude.com/pricing), [Anthropic prompt caching 说明](https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching))
- **容易意外的收费点：**把 `/cost` 的 API 等价估价误当作 Pro/Max 实际扣款；usage credits 在额度耗尽后以 API 价计费；缓存写入可能比普通输入贵，而缓存读取则大幅折扣；模型/上下文窗口以及额外功能使费用不按“消息数”线性变化。缓存冷启动/长时间间隔导致重复写入，是适合做诊断的本地指标。([Claude Code plan guidance](https://support.claude.com/en/articles/11145838-use-claude-code-with-your-pro-or-max-plan), [Anthropic pricing](https://docs.anthropic.com/en/docs/about-claude/pricing))
- Anthropic 当前价目页另显示 usage bundles $50/$250/$1000 面值档折扣 10%/20%/30%，跨 Claude、Claude Code、Cowork 和部分第三方产品共用；这类余额池让用户更需要区分“订阅费、credits 消耗、API 估值”。([Usage bundles](https://support.claude.com/en/articles/14246112-buy-usage-bundles))

### Codex / ChatGPT

- Codex 对个人通常以 ChatGPT 套餐额度计量，不是对本地 CLI 每次请求显示传统 API 账单；符合条件时触顶后可用 flexible credits，Codex 与部分 ChatGPT Work/Office 功能可共享额度/credit pool。企业也可能是 credits 或 USD token-based 两种计费形态，需按工作区确认。([Codex usage limits](https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan), [credits](https://help.openai.com/en/articles/12642688-using-credits-for-flexible-usage-in-chatgpt-personal-plans))
- 官方说明使用量取决于模型、任务复杂度、上下文、推理、速度和工具；有些客户端展示“估算美元值”且标明是 planning estimates，并非 invoice。因此 TokenLedger 应把 `observed tokens`、`estimated API equivalent`、`subscription/credits actual spend` 分栏，不能把估价包装成实付账单。([官方用量说明](https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan))

### Cursor

- 包含 usage 与超额按需计费；超量后按模型 API rates，额外用量可按需购买。模型 token breakdown 在 Dashboard。每日 agent 用户典型可能达到 $60–$100/月总用量、power users $200+，这是 Cursor 自己基于 usage 的估算，不等于个体承诺。([官方模型定价文档](https://docs.cursor.com/account/pricing))
- 令用户困惑的是 subscription 包含额度、bonus、request 计数、MAX token 计费及 on-demand API rates 共存；要检查清楚“是否会额外收费”需要分别看 dashboard 与购买/限额设置。([Cursor Pricing](https://cursor.com/pricing), [定价说明](https://docs.cursor.com/account/pricing))

## 4. 隐私敏感度与合规关联

- 明确的用户/开发者表态存在：Claude Code GitHub issue #11057 请求在 telemetry 启用时提示 destination 与数据类别，理由包括用户可能不知悉传输、数据包含身份信息、可选择记录 prompt，以及第三方监控服务的数据关系不透明。这是明确的隐私顾虑证据，但 issue 被关闭为 not planned，不能据此推断大多数用户拒用云。([GitHub issue](https://github.com/anthropics/claude-code/issues/11057))
- Langfuse 的官方 Claude Code 集成会从 transcript 取 prompt/response/tool 输入输出并发送到 Cloud 或自托管服务；其需配置 API keys/base URL。OpenLLMetry 默认也会把 prompt/completion 写入 span 属性，但可通过 `TRACELOOP_TRACE_CONTENT=false` 关闭。说明通用 SaaS 的可见性越强，数据最小化和用户告知越重要。([Langfuse integration](https://langfuse.com/integrations/developer-tools/claude-code), [OpenLLMetry privacy config](https://traceloop.com/docs/openllmetry/configuration))
- Cursor Privacy Mode 承诺代码不用于训练，并称与供应商有 ZDR 协议；但 coding 请求仍会把 prompt 和代码上下文发往模型供应商。说明“不开训练/零保留”不等于“数据从未离机”，因此纯本地对不允许任何外发的个人、受监管行业和企业设备仍有独特价值。([Cursor privacy](https://prod.cursor.com/help/security-and-privacy/privacy), [Data Use](https://cursor.com/data-use))
- GDPR/CCPA 的实用关联在数据最小化、目的限制、访问控制、留存和告知；**不能把本地运行直接宣称为合规保证**。工具可能处理日志中的个人信息/客户数据，用户或企业仍需遵守自己的保留和安全策略。法规层面可引用 GDPR 第 5 条原则及加州 CPPA 的数据最小化材料：([GDPR Article 5](https://eur-lex.europa.eu/eli/reg/2016/679/oj), [CPPA rulemaking materials](https://cppa.ca.gov/regulations/))。TokenLedger 的可验证承诺应是“默认零网络请求、只读、不收集/不上传”，而不是“GDPR compliant”。
- 反向证据：隐私不是所有人的首要购买条件。用户会使用云端 Langfuse/Helicone 来换取跨环境 tracing 和团队协作；Cursor 的企业客户可接受向模型供应商传请求，只要有 ZDR、训练限制和管理员管控。纯本地降低风险，却牺牲共享、云端告警、多设备同步和团队视图。

## 5. 定位结论与建议

### 市场空白

1. **跨工具统一项目账本仍是空位。**ccusage 已覆盖多来源 CLI，但桌面化的项目归因和诊断不是它的中心；大量竞品仍只支持 Claude Code，或者专注 quota widget、会话回放、遥测 tracing。TokenLedger 的 Claude Code/Codex/OpenCode/Gemini CLI/DSH 统一账本有真实差异，前提是适配器对格式变化保持可靠。
2. **成本解释比“又一个 token 图表”更值得做。**直接说明订阅额度、API equivalent、credits/实际账单的差别；拆缓存写、缓存读、普通输入、输出；识别冷启动、缓存失效、异常长上下文和高成本项目。用户误解 $321 API 估价就是欠费的案例，证明口径教育是产品核心而非脚注。
3. **将单次任务连接到工程决策。**项目/仓库账单、每个 agent/模型的 cost per task、购买力换算和“该订阅相当于多少 API 用量”可帮助个人选择套餐、团队做 chargeback/预算；同时明确估算置信度与缺失数据。
4. **安装、隐私可验证性。**竞争者已普遍宣称本地/无 telemetry，因此单说“零上传”不独占。用离线首启、网络权限/出站检测、源码可审计、只读文件权限、价格更新时间、数据源覆盖说明、导出/删除能力，把承诺做成可验证产品行为。不要引入 CDN 运行依赖，否则削弱“零网络”主张。

### “纯本地 + 零上传”是否有效？

**有效，但属于信任门槛/细分差异化，不是充分的产品定位。**真实证据包括本地日志工具的持续出现、Sniffly 的 1.3k stars、ccusage 的 18.9k stars，以及 Claude telemetry issue 对静默传输的关注。另一方面，Local Token Monitor 仅 8 stars、Agent Trail 16 stars等反例显示本地实现并不自动带来采用；stars 只能近似反映公开关注，不能替代活跃用户、留存、下载或收入。更成熟的表述是：“跨 coding agent 的本地成本账本：看清每个项目的真实 token 构成、估算成本和缓存浪费，数据始终留在设备上。”

### 推荐 ICP 与验证假设

- **首要用户：**每天并行使用 2 种以上 coding agents 的独立开发者/技术负责人；账单由本人承担，能够从本地日志直接受益。
- **次级用户：**不能把 prompt/代码上传到 observability SaaS 的企业工程师；需要本机分析或审计，但企业级预算控制/集中管理可能需要后续单独方案。
- **验证指标：**首次扫描后 60 秒内出现可解释的项目账单；源日志适配覆盖率；活跃用户每周查看次数；缓存冷启动洞察的采纳率；安装后第 2/4 周留存；估算值与 provider portal/实际 credits 的误差范围。
- **风险：**厂商改本地日志 schema/删除策略；API 价格快速变化；订阅成本无法由 token 日志精确反推；Cursor 等 GUI 产品未必写足够本地数据；多工具同名项目路径/工作区归属需谨慎归并。

## 来源索引与方法边界

- 优先引用官方定价、文档、仓库/README、官方支持页面和原始用户讨论；第三方博客/新闻不作为主要数字依据。
- 所有动态数字均为 **2026-10-09 检索值**，价格与 stars 会变动；标为“约”的 GitHub stars/社区规模不应当成精确用户量。
- 社区引文证明痛点存在，不用于估计问题发生率；Reddit/HN 匿名发言可能片面。官方的 API 等价成本也不是订阅用户的实际扣款。
