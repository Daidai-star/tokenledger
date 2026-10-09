/**
 * 购买力换算的单元测试。
 *
 * 重点覆盖三类容易出错的地方：
 *  1. 贪心购物车的金额守恒（不能凭空多出或少掉钱）
 *  2. 中文数字读法（这是最容易写错的部分）
 *  3. 边界：零预算、超大预算、价格跨度退化
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  MALL,
  USD_CNY,
  computeMall,
  cartSummary,
  fmtCNY,
  fmtCNYVerbose,
} from "./mall.ts";

test("商品表按价格升序，且无重复 id / 无非正价格", () => {
  const ids = new Set(MALL.map((m) => m.id));
  assert.equal(ids.size, MALL.length, "id 必须唯一");
  for (let i = 1; i < MALL.length; i++) {
    assert.ok(MALL[i].price > MALL[i - 1].price, `第 ${i} 项价格必须更高`);
  }
  assert.ok(MALL.every((m) => m.price > 0 && m.name && m.emoji && m.hint));
});

test("computeMall 返回的商品行与目录一致且带正确价格", () => {
  const r = computeMall(1000);
  assert.equal(r.rows.length, MALL.length);
  assert.equal(r.rate, USD_CNY);
  // $1000 × 7.2 = ¥7200
  assert.equal(Math.round(r.budget), 7200);
  const ps5 = r.rows.find((x) => x.id === "ps5");
  assert.ok(ps5, "应包含 PS5");
  // ¥7200 / ¥6499 = 1
  assert.equal(ps5!.count, 1);
  assert.equal(ps5!.affordable, true);
});

test("买不起的商品标出还差多少，且差额正确", () => {
  const r = computeMall(1000); // ¥7200
  const laptop = r.rows.find((x) => x.id === "laptop")!; // ¥29999
  assert.equal(laptop.affordable, false);
  assert.equal(laptop.count, 0);
  assert.equal(Math.round(laptop.shortfall), 29999 - 7200);
  // 「下一个目标」应该是最便宜的买不起的那件
  assert.ok(r.next);
  assert.equal(r.next!.price, Math.min(...r.rows.filter((x) => !x.affordable).map((x) => x.price)));
});

test("标尺位置单调递增且落在 0..1", () => {
  const r = computeMall(5000);
  for (let i = 1; i < r.rows.length; i++) {
    assert.ok(r.rows[i].pos > r.rows[i - 1].pos, "价格更高则位置必须更靠右");
  }
  for (const row of r.rows) {
    assert.ok(row.pos >= 0 && row.pos <= 1, `位置越界: ${row.id} = ${row.pos}`);
  }
  assert.ok(r.pos >= 0 && r.pos <= 1);
});

test("贪心购物车金额守恒：买完的钱不超过预算", () => {
  for (const usd of [0.5, 12, 137, 1000, 2617, 50000, 1e6]) {
    const r = computeMall(usd);
    const sum = r.cart.reduce((a, c) => a + c.total, 0);
    assert.ok(sum <= r.budget + 1e-6, `$${usd}: 购物车 ${sum} 超过预算 ${r.budget}`);
    assert.equal(r.cartTotal, sum, `$${usd}: cartTotal 必须等于明细求和`);
  }
});

test("贪心购物车不会买超过单件上限", () => {
  // 极大预算时便宜商品的数量要被截断
  const r = computeMall(100000);
  for (const line of r.cart) {
    assert.ok(line.count <= 999, `${line.item.id} 数量 ${line.count} 超过上限`);
  }
});

test("购物车要「多品类」而不是把钱全砸在最便宜的单一商品上", () => {
  // 回归测试：曾经的纯贪心算法会把 ¥18842 全部变成 214 包咖啡豆，购物车退化成一行
  const r = computeMall(2617);
  assert.ok(r.cart.length >= 5, `品类数只有 ${r.cart.length}，说明又被贪心吃掉了`);
  // 至少要包含几件「有分量」的商品
  const pricey = r.cart.filter((c) => c.item.price >= 1000);
  assert.ok(pricey.length >= 3, `贵重商品只有 ${pricey.length} 件`);
  // 最贵的那件不能单独吃掉全部预算
  const top = Math.max(...r.cart.map((c) => c.total));
  assert.ok(top < r.budget * 0.6, `单品占了预算的 ${((top / r.budget) * 100).toFixed(0)}%`);
});

test("购物车里的每件都必须买得起，且买了就不超预算", () => {
  for (const usd of [1, 12, 300, 2617, 20000]) {
    const r = computeMall(usd);
    for (const c of r.cart) {
      assert.ok(c.count >= 1, `${c.item.id} 数量为 0`);
      assert.ok(c.item.price <= r.budget, `${c.item.id} 买不起却出现在购物车`);
    }
    const sum = r.cart.reduce((a, c) => a + c.total, 0);
    assert.ok(sum <= r.budget + 1e-6, `$${usd}: 明细 ${sum} 超预算 ${r.budget}`);
  }
});

test("购物车在预算不足最便宜商品时为空", () => {
  const r = computeMall(0.001); // ¥0.0072，买不起 ¥88
  assert.equal(r.cart.length, 0);
  assert.equal(r.affordable.length, 0);
  assert.equal(r.tier, -1);
  assert.equal(r.best, null);
});

test("零 / 负数 / 非法预算不抛错，按 0 处理", () => {
  for (const bad of [0, -100, null, undefined, NaN, Infinity]) {
    const r = computeMall(bad as number);
    assert.equal(r.budget, 0, `输入 ${bad} 应视为 0`);
    assert.equal(r.cart.length, 0);
    assert.ok(Number.isFinite(r.pos));
  }
});

test("档位随预算递增，且 best 是买得起的最贵一件", () => {
  const tiers = [10, 100, 1000, 10000].map((u) => computeMall(u).tier);
  for (let i = 1; i < tiers.length; i++) {
    assert.ok(tiers[i] >= tiers[i - 1], "预算增加时档位不该下降");
  }
  const r = computeMall(1000);
  if (r.best) {
    assert.ok(r.best.affordable);
    assert.ok(r.affordable.every((a) => a.price <= r.best!.price));
  }
});

test("攒钱进度落在 0..1，且 need 与 next 的差额一致", () => {
  for (const usd of [10, 300, 1000, 2617, 8000, 100000]) {
    const r = computeMall(usd);
    if (!r.savingTo) continue;
    assert.ok(r.savingTo.progress >= 0 && r.savingTo.progress <= 1, `$${usd}: progress=${r.savingTo.progress}`);
    assert.ok(Math.abs(r.savingTo.need - r.nextShortfall) < 1e-6);
  }
});

test("cartSummary 只列前 N 项并汇总剩余件数", () => {
  const r = computeMall(100000);
  const s = cartSummary(r.cart, 3);
  assert.ok(s.includes("+"));
  const top = r.cart.slice().sort((a, b) => b.total - a.total).slice(0, 3);
  for (const c of top) assert.ok(s.includes(c.item.name), `应包含 ${c.item.name}`);
  if (r.cart.length > 3) assert.ok(s.includes(`等 ${r.cart.length} 件`));
});

test("cartSummary 对空购物车返回空串", () => {
  assert.equal(cartSummary([]), "");
});

// ------------------------------------------------------------ 金额格式化

test("fmtCNY 按量级切换单位", () => {
  assert.equal(fmtCNY(0), "¥0");
  assert.equal(fmtCNY(88), "¥88");
  assert.equal(fmtCNY(7200), "¥7,200"); // 万以下用千分位
  assert.equal(fmtCNY(18800), "¥1.88 万");
  assert.equal(fmtCNY(10000), "¥1 万");
  assert.equal(fmtCNY(58000000), "¥5800 万");
  assert.equal(fmtCNY(1.2e8), "¥1.2 亿");
});

test("fmtCNYVerbose 中文读法覆盖 0 / 进位 / 补零 / 万亿", () => {
  assert.equal(fmtCNYVerbose(0), "零元");
  assert.equal(fmtCNYVerbose(5), "五元");
  assert.equal(fmtCNYVerbose(18), "十八元"); // 一十二 -> 十二
  assert.equal(fmtCNYVerbose(88), "八十八元");
  assert.equal(fmtCNYVerbose(105), "一百零五元"); // 中间补零
  assert.equal(fmtCNYVerbose(1005), "一千零五元"); // 连续两个零只留一个
  assert.equal(fmtCNYVerbose(6499), "六千四百九十九元");
  assert.equal(fmtCNYVerbose(10000), "一万元");
  assert.equal(fmtCNYVerbose(10001), "一万零一元"); // 组间补零
  assert.equal(fmtCNYVerbose(18800), "一万八千八百元"); // 万位不能丢千位
  assert.equal(fmtCNYVerbose(29999), "二万九千九百九十九元");
  assert.equal(fmtCNYVerbose(128000), "十二万八千元");
  assert.equal(fmtCNYVerbose(58000000), "五千八百万元"); // 5800 万，不是「五十八万」
  assert.equal(fmtCNYVerbose(1000000), "一百万元"); // 100 万，不是「一万」
  assert.equal(fmtCNYVerbose(1000001), "一百万零一元");
  assert.equal(fmtCNYVerbose(1e8), "一亿元");
});

test("fmtCNYVerbose 结果不含多余字符且长度合理", () => {
  for (const v of [0, 1, 10, 88, 105, 9999, 10000, 29999, 118000, 6800000, 58000000]) {
    const s = fmtCNYVerbose(v);
    assert.ok(s.endsWith("元"), `${v} -> ${s}`);
    assert.ok(!/[a-zA-Z0-9]/.test(s), `${v} -> ${s} 含非中文数字字符`);
    assert.ok(s.length < 30, `${v} -> ${s} 过长`);
  }
});

test("fmtCNYVerbose 与实际数值量级一致（防数量级错位）", () => {
  // 只校验末位「万」的位置，避免实现细节写死
  assert.ok(fmtCNYVerbose(128000).indexOf("万") === 2, "十二万八千 → 万在第 3 字");
  assert.ok(fmtCNYVerbose(10000).indexOf("万") === 1, "一万 → 万在第 2 字");
});
