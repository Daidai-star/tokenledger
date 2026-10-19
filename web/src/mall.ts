/**
 * 「你的 API 账单能买什么」——购买力换算的核心逻辑。
 *
 * 纯函数，无副作用，不碰网络：所有换算都在本地完成。
 * 商品价格是**参考零售价**（2026 年国内大致行情），汇率取固定值，
 * 两者都在界面上标注清楚——这是个趣味向的估算，不该伪装成精确报价。
 *
 * 价格跨度从 ¥88 到 ¥5800 万，横跨 6 个数量级，所以标尺必须用对数轴，
 * 否则便宜的商品会全部挤在 0 附近。
 */

/** 固定参考汇率（非实时，仅用于趣味换算） */
export const USD_CNY = 7.2;

export type Band = 0 | 1 | 2 | 3;

export interface MallItem {
  id: string;
  name: string;
  /** 图标 id，对应 mall-icons.ts 里的 MALL_ICONS key（手绘技术线稿，不是 emoji） */
  icon: string;
  /** 参考零售价，单位元 */
  price: number;
  band: Band;
  /** 一句话调侃，让卡片有人味而不是价目表 */
  hint: string;
}

export const BAND_NAMES = ["日常", "装备", "出行", "远方"] as const;

export const BAND_HINTS = [
  "消耗品，靠量取胜",
  "一次投入，用很久",
  "能带你去更远的地方",
  "这个先当个念想",
] as const;

/**
 * 商品阶梯。按价格升序排列——「你在这里」的位置标记依赖这个顺序。
 * 价格均为参考零售价，不是实时报价。
 */
export const MALL: MallItem[] = [
  { id: "beans", name: "手冲咖啡豆 250g", icon: "beans", price: 88, band: 0, hint: "写代码的燃料，也是燃料的燃料" },
  { id: "beer", name: "精酿啤酒 24 罐", icon: "beer", price: 228, band: 0, hint: "debug 到凌晨三点的人配得上它" },
  { id: "headphone", name: "头戴降噪耳机", icon: "headphone", price: 1299, band: 0, hint: "隔绝世界，只隔绝需求评审会" },
  { id: "keyboard", name: "客制化机械键盘", icon: "keyboard", price: 1880, band: 0, hint: "每个键都是一次投资" },

  { id: "monitor", name: "27 寸 4K 显示器", icon: "monitor", price: 2899, band: 1, hint: "能同时看见报错和修复" },
  { id: "fishing", name: "4.5m 竞技钓鱼竿", icon: "fishing", price: 4280, band: 1, hint: "把等待变成一种生产力" },
  { id: "ps5", name: "PS5 Pro + 双手柄", icon: "ps5", price: 6499, band: 1, hint: "打完主线就去改需求" },
  { id: "camera", name: "富士 X100VI 相机", icon: "camera", price: 13800, band: 1, hint: "记录你去的那些地方" },
  { id: "gpu", name: "RTX 5090 显卡", icon: "gpu", price: 17999, band: 1, hint: "本地跑模型，从此不求人" },
  { id: "ebike", name: "碳纤维电动公路车", icon: "ebike", price: 22800, band: 1, hint: "比骑车去上班快，也更贵" },

  { id: "laptop", name: "MacBook Pro 16 英寸", icon: "laptop", price: 29999, band: 2, hint: "顶盖上贴着 Never Issue Again" },
  { id: "moto", name: "川崎 ZX-6R 摩托车", icon: "moto", price: 86000, band: 2, hint: "排量不小，衣柜更小" },
  { id: "car", name: "一台家用轿车", icon: "car", price: 128000, band: 2, hint: "通勤半径从此不再受限于地铁" },
  { id: "rv", name: "一辆房车", icon: "rv", price: 1180000, band: 2, hint: "把家和网线一起拖走" },

  { id: "helicopter", name: "罗宾逊 R44 直升机", icon: "helicopter", price: 6800000, band: 3, hint: "从此不用等红灯" },
  { id: "jet", name: "二手 Citation 公务机", icon: "jet", price: 58000000, band: 3, hint: "落地直接进会议室" },
];

export interface MallRow extends MallItem {
  /** 当前预算能买几件 */
  count: number;
  affordable: boolean;
  /** 买不起时还差多少元 */
  shortfall: number;
  /** 价格在标尺上的位置，0..1（对数） */
  pos: number;
}

export interface CartLine {
  item: MallItem;
  count: number;
  /** 这一行占掉的总金额 */
  total: number;
}

export interface MallContext {
  /** 累计活跃编码小时数（用于把账单换算成「每小时多少钱」） */
  activeHours?: number;
  /** 日均成本（元/天），用于把差额翻译成「还要写几天」 */
  dailyCost?: number;
}

export interface MallResult {
  rate: number;
  /** 换算后的预算，单位元 */
  budget: number;
  rows: MallRow[];
  /** 至少买得起一件的（便宜在前） */
  affordable: MallRow[];
  /** 下一个「够得着但还没买」的目标 */
  next: MallRow | null;
  nextShortfall: number;
  /** 贪心购物车：按价格从低到高尽量多买 */
  cart: CartLine[];
  cartTotal: number;
  /** 预算在标尺上的位置，0..1 */
  pos: number;
  /** 已经解锁的最高档位，-1 表示一件都买不起 */
  tier: number;
  /** 当前预算能拿到的最高单价商品 */
  best: MallRow | null;
  /** 「攒钱进度」：从当前最高档到下一档的完成度 0..1 */
  savingTo: { item: MallRow; progress: number; need: number } | null;
  /** 累计活跃编码小时（0 = 没传） */
  activeHours: number;
  /** 每个活跃编码小时烧掉多少元 */
  perHour: number;
  /** 日均成本（元/天），0 = 没传 */
  dailyCost: number;
  /** 按日均成本算，还要写多少天才能拿下下一件；没有日均数据时为 null */
  daysTo: number | null;
}

/** 单件商品的数量上限，避免预算极大时出现「12345 份咖啡豆」的噪音 */
const MAX_QTY = 999;

/**
 * 计算购买力。
 *
 * @param costUsd 累计预估成本（美元）；传 null / 0 会得到空购物车而不是报错
 * @param ctx     可选的上下文（活跃小时 / 日均成本），用来把金额翻译成时间
 */
export function computeMall(costUsd: number | null | undefined, ctx: MallContext = {}): MallResult {
  const usd = Number(costUsd);
  const safeUsd = Number.isFinite(usd) && usd > 0 ? usd : 0;
  const budget = safeUsd * USD_CNY;

  const sorted = [...MALL].sort((a, b) => a.price - b.price);
  const prices = sorted.map((m) => m.price);
  const lo = Math.log(prices[0]);
  const hi = Math.log(prices[prices.length - 1]);
  // 价格跨度小于一个数量级时退化为线性比例，避免除以 0
  const span = hi - lo || 1;
  const toPos = (p: number) => (Math.log(p) - lo) / span;

  const rows: MallRow[] = sorted.map((m) => {
    const count = Math.floor(budget / m.price);
    return {
      ...m,
      count,
      affordable: count > 0,
      shortfall: Math.max(0, m.price - budget),
      pos: toPos(m.price),
    };
  });

  const affordable = rows.filter((r) => r.affordable);
  // 「下一个目标」= 最便宜的买不起的那件
  const next = rows.find((r) => !r.affordable) || null;

  // 购物车：先给每件买得起的都来一件（由便宜到贵，尽量多凑齐品类），
  // 再用剩下的零钱回头补最便宜的。
  //
  // 为什么不是纯贪心「从便宜到贵买到钱花完」：那样会把整笔预算砸在最便宜的
  // 单品上（实测 ¥18842 全变成 214 包咖啡豆），购物车退化成一行，信息量归零。
  const cart = new Map<string, CartLine>();
  const add = (row: MallRow, n: number) => {
    if (n <= 0) return;
    const line = cart.get(row.id);
    // 上限作用在「最终数量」上，而不是单次增量——否则第一轮买过一件的
    // 商品会在第二轮突破上限（实测 beans 变成 1000）
    const count = Math.min(MAX_QTY, (line?.count || 0) + n);
    cart.set(row.id, { item: row, count, total: count * row.price });
  };

  let left = budget;
  for (const r of affordable) {
    if (r.price > left) break; // 已按价格升序，后面更买不起
    add(r, 1);
    left -= r.price;
  }
  for (const r of rows) {
    if (r.price > left) break;
    const n = Math.floor(left / r.price);
    add(r, n);
    left -= n * r.price;
  }
  const cartLines = [...cart.values()];
  // 直接对明细求和，而不是用「预算 - 剩余」推算：数量被上限截断时两者会不一致
  const cartTotal = cartLines.reduce((a, c) => a + c.total, 0);

  // 已解锁的最高档位
  const tier = affordable.length ? affordable[affordable.length - 1].band : -1;
  // 当前拿得出手的最贵的一件
  const best = affordable.length ? affordable[affordable.length - 1] : null;

  // 「攒钱进度」：从当前最高单价商品，走到下一件买不起的
  let savingTo: MallResult["savingTo"] = null;
  if (next) {
    const from = best ? best.price : 0;
    savingTo = {
      item: next,
      progress: from > 0 && next.price > from ? (budget - from) / (next.price - from) : 0,
      need: next.shortfall,
    };
    savingTo.progress = Math.max(0, Math.min(1, savingTo.progress));
  }

  // 时间维度：把「多少钱」翻译成「我写了多久」
  const activeHours = Number(ctx.activeHours) > 0 ? Number(ctx.activeHours) : 0;
  const dailyCost = Number(ctx.dailyCost) > 0 ? Number(ctx.dailyCost) : 0;

  return {
    rate: USD_CNY,
    budget,
    rows,
    affordable,
    next,
    nextShortfall: next ? next.shortfall : 0,
    cart: cartLines,
    cartTotal,
    pos: toPos(Math.max(budget, prices[0])),
    tier,
    best,
    savingTo,
    activeHours,
    perHour: activeHours > 0 ? budget / activeHours : 0,
    dailyCost,
    daysTo: dailyCost > 0 && next ? next.shortfall / dailyCost : null,
  };
}

/**
 * 日均成本：优先用最近 30 天里**有花费**的天的平均。
 *
 * 为什么不用全期平均：「再写几天」问的是**当下**的速度。一个用了半年的
 * 账单，早期几乎不烧钱，全期平均会把当下的速度稀释掉，算出来的天数虚高。
 * 样本不足 7 天时（比如刚装）才退回全期平均，避免一天的噪声被当成趋势。
 */
export function estimateDailyCost(
  days: { cost_usd: number }[],
  totalCost: number,
  activeDays: number,
): number {
  const recent = days.slice(-30).filter((d) => Number(d.cost_usd) > 0);
  if (recent.length >= 7) {
    return recent.reduce((a, d) => a + Number(d.cost_usd), 0) / recent.length;
  }
  return activeDays > 0 ? Number(totalCost) / activeDays : 0;
}

/** 购物车文案：挑出占比最高的几件，拼成一句话 */
export function cartSummary(cart: CartLine[], max = 4): string {
  if (!cart.length) return "";
  const top = [...cart]
    .sort((a, b) => b.total - a.total)
    .slice(0, max)
    .map((c) => `${c.count} × ${c.item.name}`);
  const rest = cart.length - top.length;
  return top.join(" + ") + (rest > 0 ? ` 等 ${cart.length} 件` : "");
}

/**
 * 「乱花一通」：随机把这笔钱花掉，生成一张小票。
 *
 * 刻意**不是**均匀随机——均匀随机会立刻退化成「一百多包咖啡豆」，
 * 因为最便宜的商品永远买得起。这里按**单价加权**挑商品（贵的东西更可能被看中），
 * 并且一次买 1..N 件（N 随剩余预算放大），结果才会既不可预测、又像真的在下单。
 *
 * 纯函数：随机源从参数注入，所以能写确定性测试。
 */
export function randomCart(
  rows: MallRow[],
  budget: number,
  rng: () => number = Math.random,
  maxSteps = 400,
): { cart: CartLine[]; total: number; left: number } {
  const lines = new Map<string, CartLine>();
  let left = budget;
  let step = 0;

  while (left > 0 && step++ < maxSteps) {
    const usable = rows.filter((r) => r.price <= left);
    if (!usable.length) break;

    const totalW = usable.reduce((a, r) => a + r.price, 0);
    let pick = rng() * totalW;
    let chosen = usable[usable.length - 1];
    for (const r of usable) {
      pick -= r.price;
      if (pick <= 0) {
        chosen = r;
        break;
      }
    }

    const affordable = Math.floor(left / chosen.price);
    // 一次买几件：预算越大越可能多拿，否则会退化成一件一件加
    const span = Math.max(1, Math.min(affordable, Math.round(left / 2000) + 1, 8));
    const n = 1 + Math.floor(rng() * span);

    const line = lines.get(chosen.id);
    const count = Math.min(MAX_QTY, (line?.count || 0) + n);
    const delta = count - (line?.count || 0);
    if (delta <= 0) break; // 撞到单件上限，再转下去也花不掉钱
    lines.set(chosen.id, { item: chosen, count, total: count * chosen.price });
    left -= delta * chosen.price;
  }

  const cart = [...lines.values()].sort((a, b) => b.total - a.total);
  return { cart, total: cart.reduce((a, c) => a + c.total, 0), left: Math.max(0, left) };
}

/** 金额格式化：元。万以下用千分位，这样 ¥7,200 比 ¥7.2 千 好懂得多 */
export function fmtCNY(n: number): string {
  const v = Number(n) || 0;
  const trim = (x: number) => String(Number(x.toFixed(2)));
  if (v >= 1e8) return `¥${trim(v / 1e8)} 亿`;
  if (v >= 1e4) return `¥${trim(v / 1e4)} 万`;
  return `¥${Math.round(v).toLocaleString("en-US")}`;
}

const DIGITS = "零一二三四五六七八九";
const UNITS = ["", "十", "百", "千"];
const BIG = ["", "万", "亿", "万亿"];

/** 把 1..9999 转成中文读法（「一千零五」） */
function under10000(n: number): string {
  if (n <= 0) return "";
  let hi = 3;
  while (hi > 0 && Math.floor(n / 10 ** hi) % 10 === 0) hi--;

  const parts: string[] = [];
  let zero = false; // 出现过空位，需要在下一个数字前补「零」
  for (let i = hi; i >= 0; i--) {
    const d = Math.floor(n / 10 ** i) % 10;
    if (d === 0) {
      zero = true;
      continue;
    }
    // 「一十二」口语里是「十二」：最高位是 1 且单位为「十」时省掉「一」，
    // 但「十」本身要保留（否则 18 会读成「一八」）
    if (i === 1 && d === 1 && hi === 1) {
      parts.push((zero ? "零" : "") + "十");
      zero = false;
      continue;
    }
    parts.push((zero ? "零" : "") + DIGITS[d] + UNITS[i]);
    zero = false;
  }
  return parts.join("");
}

/**
 * 大额金额用中文数字读出来，更有仪式感。
 *
 * 按四位一组切分：亿 / 万 / 个。「万」以上最容易写错——曾经把 18800
 * 读成「一万八十八」，把 100 万读成「一万」，所以这段单独测。
 */
export function fmtCNYVerbose(n: number): string {
  const v = Math.max(0, Math.round(Number(n) || 0));
  if (v === 0) return "零元";

  const groups: number[] = [];
  let rest = v;
  while (rest > 0) {
    groups.push(rest % 10000);
    rest = Math.floor(rest / 10000);
  }

  const chunks: string[] = [];
  for (let i = groups.length - 1; i >= 0; i--) {
    const g = groups[i];
    if (!g) continue;
    // 相邻组之间有空位时补「零」（如 一百万零一）
    const needZero = chunks.length > 0 && g < 1000;
    chunks.push((needZero ? "零" : "") + under10000(g) + BIG[i]);
  }
  return chunks.join("") + "元";
}
