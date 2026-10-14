# 对齐 CC Switch 口径 + 天级用量/成本视图

日期：2026-10-14
起因：用户看完速率区块后仍觉得不对，要求参考 CC Switch（`~/.cc-switch/cc-switch.db`）。

## 一、调研结论（决定了做法，必须先记住）

### 我们的总量和 CC Switch 本来就相等

```
我们的 total     = input_fresh + cache_read + cache_write + output
CC Switch 的 total = (input 含缓存) + output
```

`input_fresh + cache_read = 原始 input`，两者等价，**唯一差额是 `cache_write`**。
实测 codex 的 `cache_write` 恒为 0，全库 `sum(total_tokens) = 12,420,082,796`
与换算值**完全一致**。

**所以对齐口径是纯展示层改动：不用重扫、不用迁移、不动采集层。**

### CC Switch 的 input 确实含缓存

`proxy_request_logs` 24,562 行**100% 满足 `input > cache_read`**，且
`input - cache_read` 集中在 0~10K（8566 行 0~1K / 14528 行 1K~10K），
符合「原始 input = 新鲜输入 + cached」的语义。

### CC Switch 的 `usage_daily_rollups` 表有 bug，不能当基准

同一天（2026-02-12）对比：

| 字段 | 原始行实际 | rollups 记录 | 偏差 |
| --- | --- | --- | --- |
| 行数 | 7 | — | — |
| input | 1,026,466 | 2,012,999 | 1.96× |
| cache_read | 974,464 | 33,213,824 | 34× |

rollups 与自己的原始行对不上。**对齐时只参考 `proxy_request_logs`，不要参考 rollups。**

## 二、要改什么

### A. 口径对齐（展示层）

界面上的 `input` 从「新鲜输入」改为**含缓存**（= `input + cache_read`），
与 CC Switch / Codex 原始日志一致。数据库与采集层不动。

需要同步的位置（避免同一页出现两种 input 口径）：
- 首屏总览的 Token 构成
- 模型排行、成本构成里的 input 列
- 项目账单的明细

### B. 速率区块改造为天级用量/成本

- 主指标：日 token 总量 + 日成本（双图）
- 配套：本月/上月累计对比
- 生成速度（tok/s）**降级为注脚保留**，不再做主指标
- 缓存命中率公式：现在 overview 已经是
  `cache_read / (input + cache_read)`，这个口径本身不用改，但要在界面上说清楚

## 三、验收

- [ ] `npm test` 全绿
- [ ] `npm run typecheck` 通过
- [ ] `npm run build` 通过
- [ ] 首屏与明细表的 input 口径一致，且标注「含缓存读」
- [ ] 天级视图能与 CC Switch 的原始行对上（用同一天、同一口径抽查）
- [ ] 390px / 1280px 无横向溢出、无 console error
- [ ] 口径变化写进 `PROJECT_PROGRESS.md` 的决策记录

## 四、风险

- **最大风险**：改口径会影响所有既有数字的观感。必须在界面上明确标注
  「input 含缓存读」，否则用户会以为数字凭空变大。
- 采集层不动，所以随时可回滚（只需改展示层）。