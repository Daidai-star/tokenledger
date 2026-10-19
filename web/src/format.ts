/** 格式化工具 */

/**
 * 去掉多余的尾随零。
 *
 * 轴刻度是 niceMax 算出来的整数（250M / 500M / 1B），走 toFixed(2) 会变成
 * 「250.00M / 1.00B」——数值上没错，但读者会以为精度真的到小数点后两位。
 * 坐标轴要的是「一眼看清刻度」，不是「显示全部有效数字」。
 */
const trim = (s: string): string => (s.includes(".") ? s.replace(/\.?0+$/, "") : s);

export function fmtTokens(n: number): { value: string; unit: string } {
  const v = Number(n) || 0;
  if (v >= 1e12) return { value: trim((v / 1e12).toFixed(2)), unit: "T" };
  if (v >= 1e9) return { value: trim((v / 1e9).toFixed(2)), unit: "B" };
  if (v >= 1e6) return { value: trim((v / 1e6).toFixed(2)), unit: "M" };
  if (v >= 1e3) return { value: trim((v / 1e3).toFixed(1)), unit: "K" };
  return { value: String(Math.round(v)), unit: "" };
}

export function tokens(n: number): string {
  const { value, unit } = fmtTokens(n);
  return unit ? `${value}${unit}` : value;
}

export function fmtInt(n: number): string {
  return new Intl.NumberFormat("en-US").format(Math.round(Number(n) || 0));
}

export function fmtCost(n: number | null): string {
  const v = Number(n) || 0;
  if (v === 0) return "$0";
  if (v < 0.01) return `$${v.toFixed(5)}`;
  if (v < 1) return `$${v.toFixed(3)}`;
  if (v < 1000) return `$${v.toFixed(2)}`;
  return `$${fmtInt(v)}`;
}

export function fmtMs(n: number): string {
  const v = Number(n) || 0;
  if (v === 0) return "—";
  if (v < 1000) return `${Math.round(v)}ms`;
  if (v < 60000) return `${(v / 1000).toFixed(1)}s`;
  return `${Math.floor(v / 60000)}m${Math.round((v % 60000) / 1000)}s`;
}

export function fmtDate(d: string): string {
  const [, m, dd] = d.split("-");
  return `${Number(m)}/${Number(dd)}`;
}

export function fmtDateFull(d: string): string {
  return d;
}

export function fmtTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

export function fmtAgo(ts: number | null): string {
  if (!ts) return "—";
  const diff = Date.now() - ts;
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return `${Math.floor(diff / 86_400_000)} 天前`;
}

export function fmtDuration(ms: number): string {
  if (!ms) return "—";
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  return `${Math.floor(s / 60)}m${Math.round(s % 60)}s`;
}

/**
 * 紧凑时长（入参是**秒**）。
 *
 * 和 fmtDuration 的区别：后者是给「单次操作耗时」用的（`13m13s` 有意义），
 * 而这个给「累计生成时长」用——累计可以到几百分钟甚至几天，
 * 写成 `543m16s` 既难读又会撑爆卡片布局。
 */
export function fmtSpan(sec: number): string {
  if (!sec || sec < 0) return "—";
  if (sec < 60) return `${Math.round(sec)}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  if (sec < 86400) return `${(sec / 3600).toFixed(1)}h`;
  return `${(sec / 86400).toFixed(1)}d`;
}

/** 短路径：~/workspace/foo -> ~/ws/foo 的简化版，只保留最后两段 */
export function shortPath(p: string | null): string {
  if (!p) return "—";
  const parts = p.split("/").filter(Boolean);
  if (parts.length <= 2) return p;
  return "…/" + parts.slice(-2).join("/");
}

/** 稳定字符串 -> 色相，用于模型配色 */
export function hueOf(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % 360;
}

/**
 * 数据色板：Heron 化的低饱和色 —— 引导色是强调橘红，
 * 其余降饱和偏墨，保证橘红始终是图里最亮的一点。
 * 与 styles.css 的 --c-* 同源（那边给 CSS 用，这边给 SVG 直接取 hex）。
 */
export const MODEL_COLORS = [
  "#fa3600", "#c0842f", "#3f6f5e", "#4f6f8a", "#8a7a5c",
  "#7d5a6b", "#6f8a5f", "#6b7787", "#a4552e", "#5a6b4a",
];

export function modelColor(model: string): string {
  return MODEL_COLORS[hueOf(model) % MODEL_COLORS.length];
}

/** 模型名去掉供应商前缀 */
export function bareModel(m: string): string {
  const i = m.indexOf("/");
  return i > 0 ? m.slice(i + 1) : m;
}