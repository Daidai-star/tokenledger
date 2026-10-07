/**
 * 定价与事件模型的单元测试。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { PricingTable } from "./pricing.js";
import { UsageEvent } from "./model.js";

const P = new PricingTable();

function ev(init) {
  return new UsageEvent({
    id: "x",
    tool: "t",
    ts: Date.now(),
    model: "gpt-5",
    ...init,
  });
}

test("UsageEvent 数值字段归零处理", () => {
  const e = ev({ inputTokens: -5, outputTokens: NaN, cacheReadTokens: "100" });
  assert.equal(e.inputTokens, 0);
  assert.equal(e.outputTokens, 0);
  assert.equal(e.cacheReadTokens, 100);
});

test("UsageEvent 默认成功、缺失字段为 0", () => {
  const e = ev({});
  assert.equal(e.success, 1);
  assert.equal(e.status, 200);
  assert.equal(e.cacheWriteTokens, 0);
  assert.equal(e.costUsd, null);
});

test("UsageEvent success=false 映射到 0", () => {
  assert.equal(ev({ success: false }).success, 0);
});

test("定价：日志自带的 cost 优先", () => {
  const r = P.price(ev({ model: "unknown-xyz", costUsd: 1.234 }));
  assert.equal(r.usd, 1.234);
  assert.equal(r.source, "reported");
});

test("定价：内置表按 USD/1M 计算", () => {
  // gpt-5: input 1.25, output 10
  const r = P.price(ev({ model: "gpt-5", inputTokens: 1_000_000, outputTokens: 1_000_000 }));
  assert.equal(r.source, "builtin");
  assert.equal(Number(r.usd.toFixed(4)), 11.25);
});

test("定价：缓存读按折扣价计费（归一化后 input 为新鲜输入）", () => {
  // 1M 全部走缓存读 -> 只按 cacheRead 单价 0.125 计费
  const cached = P.price(ev({ model: "gpt-5", inputTokens: 0, cacheReadTokens: 1_000_000 })).usd;
  assert.equal(Number(cached.toFixed(4)), 0.125);
  // 同样的 1M，全部走新鲜输入 -> 1.25
  const plain = P.price(ev({ model: "gpt-5", inputTokens: 1_000_000 })).usd;
  assert.equal(Number(plain.toFixed(4)), 1.25);
  assert.ok(cached < plain);
});

test("定价：混合输入与缓存读分别计价", () => {
  // 200k 新鲜 + 800k 缓存读 = 0.2*1.25 + 0.8*0.125 = 0.25 + 0.1
  const r = P.price(
    ev({ model: "gpt-5", inputTokens: 200_000, cacheReadTokens: 800_000 }),
  );
  assert.equal(Number(r.usd.toFixed(4)), 0.35);
});

test("定价：未知模型返回 null 而不是 0", () => {
  const r = P.price(ev({ model: "totally-unknown-model" }));
  assert.equal(r.usd, null);
  assert.equal(r.source, "unknown");
});

test("定价：版本后缀不影响匹配", () => {
  const a = P.lookup("gpt-5-2025-11-01");
  const b = P.lookup("gpt-5");
  assert.ok(a && b);
  assert.equal(a.key, b.key);
  assert.equal(a.source, "builtin");
});

test("定价：内部代号模型落到家族估算档", () => {
  // 本机网关自定义命名，无公开价目，应按家族估而不是返回 null
  const gpt6 = P.lookup("gpt-6-luna");
  assert.equal(gpt6.key, "gpt-5");
  assert.equal(gpt6.source, "builtin~est", "家族匹配需标注为估算");

  assert.equal(P.lookup("gpt-6.1-sol").key, "gpt-5");
  assert.equal(P.lookup("gpt-5.6-terra").key, "gpt-5");

  // Claude 按档位区分
  assert.equal(P.lookup("claude-opus-5").key, "claude-opus-4");
  assert.equal(P.lookup("claude-sonnet-4-5").key, "claude-sonnet-4");
  assert.equal(P.lookup("claude-haiku-4-5").key, "claude-haiku-4");

  // DeepSeek / Gemini
  assert.equal(P.lookup("deepseek-v4.1-flash").key, "deepseek-chat");
  assert.equal(P.lookup("deepseek/deepseek-flash").key, "deepseek-chat");
  assert.equal(P.lookup("google-antigravity/gemini-3.8-flash").key, "gemini-2.5-flash");
});

test("定价：家族估算的单价与对应档位一致", () => {
  const real = P.price(ev({ model: "gpt-5", inputTokens: 1_000_000 })).usd;
  const est = P.price(ev({ model: "gpt-6-luna", inputTokens: 1_000_000 })).usd;
  assert.equal(real, est);
});

test("定价：完全无关的模型仍返回 null", () => {
  assert.equal(P.lookup("space-bunny-free"), null);
  assert.equal(P.lookup("muse-spark-1.3-contributor"), null);
  assert.equal(P.price(ev({ model: "space-bunny-free" })).usd, null);
});

test("定价：带供应商前缀的模型名能匹配", () => {
  assert.ok(P.lookup("openai/gpt-5"));
  assert.ok(P.lookup("anthropic/claude-sonnet-4-5-20250929"));
});

test("定价：Claude 缓存写入单独计价", () => {
  const r = P.price(
    ev({ model: "claude-sonnet-4", inputTokens: 1_000_000, cacheWriteTokens: 1_000_000 }),
  );
  // input 扣掉 cacheWrite(3.75) 后为 0.25M * 3 = 0.75，加 cacheWrite 3.75
  assert.ok(r.usd > 0);
  assert.ok(r.usd < 10);
});

test("PricingTable.load 不因缺失文件崩溃", () => {
  const t = PricingTable.load();
  assert.ok(t instanceof PricingTable);
});

test("PricingTable 从自定义 entries 查找", () => {
  const t = new PricingTable({ "my-model": { input: 2, output: 4, cacheRead: 0.2, cacheWrite: 0 } });
  const r = t.price(ev({ model: "my-model", inputTokens: 1_000_000, outputTokens: 500_000 }));
  assert.equal(r.source, "cc-switch");
  assert.equal(r.usd, 4);
});