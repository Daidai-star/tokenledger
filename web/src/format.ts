/** 格式化工具 */

export function fmtTokens(n: number): { value: string; unit: string } {
  const v = Number(n) || 0;
  if (v >= 1e12) return { value: (v / 1e12).toFixed(2), unit: "T" };
  if (v >= 1e9) return { value: (v / 1e9).toFixed(2), unit: "B" };
  if (v >= 1e6) return { value: (v / 1e6).toFixed(2), unit: "M" };
  if (v >= 1e3) return { value: (v / 1e3).toFixed(1), unit: "K" };
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
 * 数据色板：低饱和、有质感。
 * 呼应 Anthropic 的暖调——不能用高饱和霓虹色，会破坏整体的克制感。
 */
export const MODEL_COLORS = [
  "#c15f3c", "#6b8e6b", "#5b7a99", "#c09553", "#8b6f8e",
  "#4f7d6e", "#b08968", "#7a8794", "#9a6b53", "#6b7f5e",
];

export function modelColor(model: string): string {
  return MODEL_COLORS[hueOf(model) % MODEL_COLORS.length];
}

/** 模型名去掉供应商前缀 */
export function bareModel(m: string): string {
  const i = m.indexOf("/");
  return i > 0 ? m.slice(i + 1) : m;
}