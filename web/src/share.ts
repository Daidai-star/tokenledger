/**
 * 分享卡片：用 Canvas 2D 在本地画一张 PNG。
 *
 * 为什么不用 html2canvas / SVG foreignObject：
 *  - foreignObject 序列化 DOM 在 WebView（尤其 Windows 的 WebView2）里
 *    经常因为字体和 CSS 继承而失真；
 *  - 引入截图库会破坏「零依赖、纯本地」的定位。
 * 直接用 Canvas 逐个绘制完全可控，代价是要手写排版——但卡片布局是固定的。
 *
 * 卡片同样不上传：生成后交给系统的「分享」面板 / 保存到本地，由用户自己决定发不发。
 */

/** 与 styles.css 一致的设计 token */
const C = {
  paper: "#faf9f5",
  surface: "#fffefb",
  sunk: "#f4f2ec",
  line: "#e8e5dc",
  lineStrong: "#d8d4c8",
  ink: "#1a1917",
  ink2: "#5d5b55",
  ink3: "#918e85",
  ink4: "#b5b2a8",
  accent: "#c15f3c",
  accentSoft: "#f5e9e2",
};

export interface CardInput {
  costUsd: number | null;
  totalTokens: number;
  requests: number;
  models: number;
  activeDays: number;
  /** 阶梯上最能代表购买力的一件 */
  bestLabel: string;
  /** 换算后的预算（元） */
  budgetCNY: number;
  /** 预算的中文读法 */
  budgetVerbose: string;
  /** 范围描述，例如「2026-02-12 → 2026-10-07」 */
  span: string;
  tools: { name: string; tokens: number; color: string }[];
}

const W = 1200;
const H = 630; // 1.91:1，适合 OG 图 / 社交平台

function roundRect(
  c: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

/** 文本超出宽度就截断并加省略号 */
function fitText(c: CanvasRenderingContext2D, text: string, maxW: number): string {
  if (c.measureText(text).width <= maxW) return text;
  let s = text;
  while (s.length > 1 && c.measureText(s + "…").width > maxW) s = s.slice(0, -1);
  return s + "…";
}

function fmtTokensShort(n: number): string {
  const v = Number(n) || 0;
  if (v >= 1e12) return (v / 1e12).toFixed(2) + "T";
  if (v >= 1e9) return (v / 1e9).toFixed(2) + "B";
  if (v >= 1e6) return (v / 1e6).toFixed(1) + "M";
  if (v >= 1e3) return (v / 1e3).toFixed(1) + "K";
  return String(Math.round(v));
}

function fmtCNYShort(n: number): string {
  const v = Number(n) || 0;
  const t = (x: number) => String(Number(x.toFixed(2)));
  if (v >= 1e8) return `¥${t(v / 1e8)}亿`;
  if (v >= 1e4) return `¥${t(v / 1e4)}万`;
  return `¥${Math.round(v).toLocaleString("en-US")}`;
}

/** 在给定宽度内按比例分配，归一化到 1 */
function shares(values: number[]): number[] {
  const total = values.reduce((a, b) => a + Math.max(0, b), 0);
  if (total <= 0) return values.map(() => 0);
  return values.map((v) => Math.max(0, v) / total);
}

/**
 * 画一张卡片并返回 PNG blob。纯本地，调用方自行决定存盘还是分享。
 */
export async function renderShareCard(input: CardInput): Promise<Blob> {
  const scale = 2; // 2x 缩放，导出 2400x1260， retina 下不发虚
  const canvas = document.createElement("canvas");
  canvas.width = W * scale;
  canvas.height = H * scale;
  const c = canvas.getContext("2d");
  if (!c) throw new Error("无法获取 canvas 2d 上下文");
  c.scale(scale, scale);
  c.textBaseline = "alphabetic";

  // 背景
  c.fillStyle = C.paper;
  c.fillRect(0, 0, W, H);

  // 纸纹：极淡的斜向线条，和界面保持一致
  c.save();
  c.globalAlpha = 0.5;
  c.strokeStyle = "rgba(0,0,0,0.012)";
  c.lineWidth = 1;
  for (let i = -H; i < W; i += 3) {
    c.beginPath();
    c.moveTo(i, 0);
    c.lineTo(i + H, H);
    c.stroke();
  }
  c.restore();

  // 顶部珊瑚色晕染
  const grad = c.createRadialGradient(90, -40, 10, 90, -40, 620);
  grad.addColorStop(0, "rgba(193,95,60,0.07)");
  grad.addColorStop(1, "rgba(193,95,60,0)");
  c.fillStyle = grad;
  c.fillRect(0, 0, W, 340);

  const PAD = 64;

  // ---- 品牌行
  c.fillStyle = C.accent;
  c.font = "600 30px ui-serif, Georgia, serif";
  c.fillText("TL", PAD, PAD + 6);

  c.fillStyle = C.ink;
  c.font = "500 25px ui-serif, Georgia, serif";
  c.fillText("TokenLedger", PAD + 46, PAD + 6);

  c.fillStyle = C.ink3;
  c.font = "13px -apple-system, 'PingFang SC', sans-serif";
  c.fillText("本机 Coding AI 用量账本", PAD, PAD + 32);

  // 右上：范围
  c.textAlign = "right";
  c.fillStyle = C.ink3;
  c.font = "13px -apple-system, 'PingFang SC', sans-serif";
  c.fillText(input.span, W - PAD, PAD + 6);
  c.textAlign = "left";

  // ---- 分隔线
  c.strokeStyle = C.line;
  c.lineWidth = 1;
  c.beginPath();
  c.moveTo(PAD, PAD + 52.5);
  c.lineTo(W - PAD, PAD + 52.5);
  c.stroke();

  // ---- 主数字
  let y = PAD + 118;
  c.fillStyle = C.ink3;
  c.font = "13px -apple-system, 'PingFang SC', sans-serif";
  c.fillText("累计账单折合", PAD, y);

  y += 66;
  c.fillStyle = C.ink;
  c.font = "400 76px ui-serif, Georgia, serif";
  c.fillText(fmtCNYShort(input.budgetCNY), PAD, y);

  y += 30;
  c.fillStyle = C.ink2;
  c.font = "400 19px ui-serif, Georgia, serif";
  c.fillText(input.budgetVerbose, PAD, y);

  // ---- 购买力高亮块
  const boxY = y + 26;
  const boxH = 76;
  roundRect(c, PAD, boxY, W - PAD * 2, boxH, 10);
  c.fillStyle = C.accentSoft;
  c.fill();
  c.strokeStyle = "#e4c7b8";
  c.lineWidth = 1;
  c.stroke();

  c.fillStyle = C.accent;
  c.font = "13px -apple-system, 'PingFang SC', sans-serif";
  c.fillText("这笔钱能拿下", PAD + 22, boxY + 30);
  c.fillStyle = C.ink;
  c.font = "500 26px -apple-system, 'PingFang SC', sans-serif";
  c.fillText(fitText(c, input.bestLabel, W - PAD * 2 - 44), PAD + 22, boxY + 60);

  // ---- 四个指标
  const stats: [string, string][] = [
    ["总 Token", fmtTokensShort(input.totalTokens)],
    ["请求", input.requests.toLocaleString("en-US")],
    ["模型", String(input.models)],
    ["活跃天", String(input.activeDays)],
  ];
  const sy = boxY + boxH + 52;
  const colW = (W - PAD * 2) / stats.length;
  stats.forEach(([k, v], i) => {
    const x = PAD + i * colW;
    c.fillStyle = C.ink3;
    c.font = "12px -apple-system, 'PingFang SC', sans-serif";
    c.fillText(k, x, sy);
    c.fillStyle = C.ink;
    c.font = "400 27px ui-serif, Georgia, serif";
    c.fillText(v, x, sy + 34);
    if (i > 0) {
      c.strokeStyle = C.line;
      c.beginPath();
      c.moveTo(x - 18.5, sy - 12);
      c.lineTo(x - 18.5, sy + 30);
      c.stroke();
    }
  });

  // ---- 工具占比条
  const barY = sy + 76;
  const barH = 10;
  const parts = shares(input.tools.map((t) => t.tokens));
  let bx = PAD;
  parts.forEach((p, i) => {
    const w = (W - PAD * 2) * p;
    if (w <= 0) return;
    c.fillStyle = input.tools[i].color;
    roundRect(c, bx, barY, Math.max(2, w - 2), barH, 5);
    c.fill();
    bx += w;
  });

  // 图例
  let lx = PAD;
  const ly = barY + 30;
  c.font = "12px -apple-system, 'PingFang SC', sans-serif";
  for (let i = 0; i < input.tools.length; i++) {
    const label = `${input.tools[i].name} ${(parts[i] * 100).toFixed(0)}%`;
    const tw = c.measureText(label).width;
    if (lx + tw + 24 > W - PAD) break;
    c.fillStyle = input.tools[i].color;
    c.beginPath();
    c.arc(lx + 4, ly - 4, 4, 0, Math.PI * 2);
    c.fill();
    c.fillStyle = C.ink2;
    c.fillText(label, lx + 14, ly);
    lx += tw + 34;
  }

  // ---- 底部免责说明：这是个估算，不该被当成报价
  c.fillStyle = C.ink4;
  c.font = "11px -apple-system, 'PingFang SC', sans-serif";
  c.fillText(
    "价格与汇率为参考值，非实时报价 · 数据全部来自本机，不上传",
    PAD,
    H - 28,
  );

  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("canvas 导出失败"))), "image/png");
  });
}

/** 触发浏览器/系统下载。降级路径：在新标签页打开，交给用户长按保存 */
export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // 立刻 revoke 会让部分 WebView 的下载中断，留一拍
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
