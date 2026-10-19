---
version: alpha
name: TokenLedger-design-analysis
source: "heronaiapp.com (Heron AI) — Webflow, 复刻基准"
---

# TokenLedger 设计语言 — 制图板（Drafting Sheet）

复刻自 **heronaiapp.com**。原文是一份营销站，但它的视觉母题不是「SaaS 渐变卡片」，
而是**建筑制图 / 图纸标题栏**：暖象牙纸底、1px 发丝框把版面切成格子、
全大写重型 grotesque 标题、等宽小字标签、一个橘红强调色当印泥。

> 证据来源（本文件所有数值均为实测，非估计）：
> - 线上渲染页的计算样式（`heronaiapp.com` 与 `/heron-dashboard`，REA browser evaluate）
> - 站点自带样式表 `heronai.webflow.shared.9f21166e0.min.css` 的 `:root`
> - 站点自带底纹 `bg.svg`（解出 124×124 PNG，均值采样 `#f5f5ee`）

## 为什么定这套调

没有基准时，配色会散着一堆「差不多的暖灰」，字号会出现半步，
激活态只靠换个底色。定一份基准当标尺，这些问题不需要一个个凭感觉试。
Heron 的母题（制图板）恰好和本项目的定位（**本机 Token 账本**）同构：
账本 = 表格 + 横线 + 等宽数字，本来就是「图纸」的形状。

## Colors

| token | hex | 角色 | Heron 对应 |
| --- | --- | --- | --- |
| `--paper` | `#f5f5ed` | 页面底（暖象牙，带 124px 颗粒） | 由 `bg.svg` 采样 |
| `--surface` | `#f5f5ed` | 面板底 = 纸底 | Heron 面板靠线分隔，不靠底色差 |
| `--surface-sunk` | `#ecece2` | 内嵌块 / 进度槽 | — |
| `--line` | `#b3b3af` | **主发丝线**（比常见暖灰深一档） | `--content--border` |
| `--line-soft` | `#cfcfca` | 次级线 | — |
| `--line-strong` | `#282828` | 强调线 = 墨色 | — |
| `--ink` | `#282828` | 主文字 / 标题 | `--content--primary` |
| `--ink-2` | `#414140` | 正文 | `--content--secondary` |
| `--ink-3` | `#72726f` | 三级 / 标签 | `--content--surface` |
| `--ink-4` | `#b4b4b0` | 占位 / 弱化标题 | `--content--disable` |
| `--accent` | `#fa3600` | **唯一强调色**（橘红印泥） | `--content--brand` |
| `--accent-soft` | `#ffe7de` | 强调底 | — |
| `--accent-line` | `#ffb59e` | 强调描边 | — |

正文实际色是 `rgba(40,40,40,.72)`（Heron `--content--terriary`），
这里落到 `--ink-2` 的实色 `#414140`，避免透明度叠加导致的不可预测。

### 数据色板（8 色）

Heron 本身近乎**单色 + 一个橘红**。但本项目的图表必须区分
Codex / Claude / OpenCode / DSH / Gemini —— 砍成单色图就读不懂了。
所以**刻意偏离**：保留 8 个功能性色，但全部按 Heron 的调子**降饱和 + 偏墨**，
让橘红始终是图里最亮的一点。

| token | hex | 说明 |
| --- | --- | --- |
| `--c-clay` | `#fa3600` | 引导色（= accent），给量最大的系列 |
| `--c-ochre` | `#c0842f` | 琥珀 |
| `--c-sand` | `#8a7a5c` | 卡其 |
| `--c-sage` | `#6f8a5f` | 橄榄 |
| `--c-moss` | `#3f6f5e` | 深青绿 |
| `--c-slate` | `#4f6f8a` | 钢蓝 |
| `--c-slate2` | `#6b7787` | 灰蓝 |
| `--c-plum` | `#7d5a6b` | 灰梅 |

### 严重度（状态色，与品牌色分离）

沿用项目既有原则：「严重」和「品牌」不该同色。品牌色回落到品牌用途。

| token | hex | 用途 |
| --- | --- | --- |
| `--sev-severe` | `#b8351c` | 超线 / 严重浪费 |
| `--sev-moderate` | `#a8752a` | 中等 |
| `--sev-mild` | `#6f7d52` | 轻微 |

## Typography

两种字族，各司其职：

| 角色 | 字族 | 说明 |
| --- | --- | --- |
| 显示 / 正文 | **Inter**（自托管 variable） | 替代 Heron 的授权字体 BT Grotesk |
| 微标签 / 数字 | **Geist Mono**（自托管 variable） | **与 Heron 同款**（Heron 用的就是 Geist Mono） |

> **字体替代说明**：BT Grotesk 是授权字体，不可分发。
> 从 Inter / Inter Tight / Archivo / Schibsted Grotesk 四选一做同文案同字号对照渲染，
> Inter 的字形（尖顶 A、带脚 G、直斜腿 R、水平切割 C）与字宽最接近 BT Grotesk。
> 备选：Archivo（字宽更接近，但 A 顶平、字碗偏方）。
> 两个文件都是 **SIL OFL 1.1**，落在 `web/public/fonts/`，**不联网**（本项目承诺零网络请求）。

### 字阶

Heron 的原生做法是 `rem` 随视口流式缩放（`html { font-size: .5787vw }`，
1728px 下 1rem = 10px）。本项目**刻意不采用**流体字阶：数据看板需要稳定的字阶，
窗口一拉字号就变会让表格跳动。保留固定 7 级阶梯。

| token | size | 用途 |
| --- | --- | --- |
| `--fs-display-xl` | 44px | 首屏最大数字 |
| `--fs-display-lg` | 34px | 区块主数字 |
| `--fs-display-md` | 26px | 面板数字 |
| `--fs-headline` | 20px | 区块标题 |
| `--fs-title` | 15px | 面板标题 |
| `--fs-body` | 13px | 正文 |
| `--fs-caption` | 12px | 次级说明 |
| `--fs-utility` | 10px | 极小的注 |
| `--fs-mono` | 11px | 等宽微标签 |

### 规则

1. **标题全大写、紧行高**：`text-transform: uppercase`、`line-height: 1.0`、
   `letter-spacing: -0.02em`、`font-weight: 700`（区块标题 600）。这是 Heron 最强的识别点。
2. **正文**：`font-weight: 500`、`letter-spacing: -0.01em`、`line-height: 1.45`。
3. **凡「标签」必等宽**：eyebrow、指标标签、坐标轴刻度、表头、按钮、
   导航单元、徽标 —— 一律 `--font-mono` + 大写 + `letter-spacing: .06em`。
   凡是「数字」也走等宽（`font-variant-numeric: tabular-nums`）。
4. **CJK 例外**：`text-transform` 对中文无效；等宽字族不含中文字形。
   所以中文一律走 `--font-sans` 的 CJK 回退栈（PingFang SC / 微软雅黑），
   大写的规则只作用于拉丁与数字。不要给中文标签套 mono，会掉字形。

## Layout

- **图纸边框**：固定 4 条 1px 发丝线框住视口，内缩 `--frame-inset`（8px），
  四角带 `+` 定位十字。这是「整个应用像一张图纸」的关键。
- **面板自带四边框**：每个面板/标题栏用四条发丝线围合，**不用阴影**（沿用项目既有禁令）。
- **区块之间用通栏实线分隔**，而不是靠留白或卡片。
- **圆角统一为 0**。药丸、圆点一律改方正：Heron 的激活标记是 **6px 实心方块**。
- **测量虚线**：`--dash-line`（1px × 16px 虚线）用于分节处的刻度线，配 `+` 角标。

### 间距

沿用项目既有的 **8px 基数**刻度（`--sp-3xs … --sp-section`），**刻意偏离** Heron 的 rem 流式间距：
看板需要稳定节奏。只换「表面」（颜色、字体、边框、方角），不动间距骨架。

## Components

- **按钮（块状）**：方正无圆角，1px 发丝边；左侧是等宽大写文字单元，
  右侧是一个被发丝线分开的方形箭头图标单元。hover 时**橘红底自下往上填充**，
  文字与箭头各自做一次上下换位（`cubic-bezier(.23,1,.32,1)`，0.5s）。
- **激活标记**：`6px` 实心方块，不是换个底色。
- **表格**：发丝横线分行，数字等宽右对齐，表头等宽大写。
- **徽标 / 状态**：方正、等宽、大写，靠描边而非填充。
- **颗粒**：用内联 `feTurbulence` SVG data-URI 复刻 Heron 的纸纹，**不能联网取图**。
  幅度压得很低（≤3% 不透明度），保证数据仍清晰。

## Elevation

**零投影**（沿用项目既有禁令）。层级只靠：发丝线、方角、等宽/大写对比、留白。
唯一的浮层（tooltip）用墨色实底 + 无圆角。

## Motion

保留项目既有动效分层（`--dur-*` / `--ease*`）与 `prefers-reduced-motion`。
从 Heron 吸收两条：
1. **填充式按钮**（橘红自下往上）。
2. **遮罩揭示**：标题按行从遮罩里升起（现有 `reveal.tsx` 已是这个方向，按 Heron 收紧）。

刻意不采纳：自定义光标、Lenis 滚动劫持、跑马灯 —— 营销站动效不适合数据应用。

## Do's and Don'ts

**Do**
- 用 `--accent` 只做：品牌标识、主 CTA、激活标记、焦点环、图表引导色。全站 ≤6 处。
- 标题全大写、紧行高、负字距；一句话一个标题。
- 能用发丝线就用发丝线：分节、分列、面板边框、表行。
- 数字一律等宽 + 右对齐；标签一律等宽 + 大写。
- 面板/方块一律方角。

**Don't**
- 不要投影、不要玻璃态、不要渐变卡片。
- 不要圆角、不要药丸（除非是纯装饰且已论证）。
- 不要把 `--accent` 当状态色（浪费严重度用 `--sev-*`）。
- 不要给中文套等宽大写（会掉字形）。
- 不要把 8 个数据色压成 Heron 式的单色（图会读不懂）。
- **不要用 emoji 当图标**。emoji 是字体：形状由系统决定（macOS / Windows /
  Android 各不相同），颜色固定、跟不上主题，小尺寸下细节还会糊成一团。
  需要图形就画 SVG 线稿——见下面「插图」。

### 插图（商品图标）

商品图案画成**图纸上的图**，而不是符号：

| 约定 | 值 |
| --- | --- |
| 网格 | 32 × 32 |
| 描边 | 1.4，圆头圆角 |
| 光学边距 | 图案收在 3..29 之间 |
| 颜色 | 一律 `currentColor`（买不起压 `opacity` 即可，不用另画一套） |
| 细节填充 | 同色 `fill-opacity: 0.16`，用来暗示玻璃 / 材质 / 屏幕 |
| 视角 | 实物轮廓（侧面或正面），不是抽象符号 |

线稿是**纯数据**（`web/src/mall-icons.ts`），同时喂给 React（DOM）和
`iconDataUrl()`（分享卡片的 canvas）。canvas 不认 JSX，而 data URL
不产生网络请求——和「不联网、不上传」的定位一致。

## 刻意偏离汇总

1. **间距用固定 8px 基数**，不用 Heron 的 rem 流式间距 —— 看板要稳定。
2. **保留 8 个功能数据色**，不做单色 —— 图表可读性优先。
3. **字阶固定**，不用 `vw` 流体 —— 同上。
4. **不引入**自定义光标 / 滚动劫持 / 跑马灯 —— 营销站动效。
5. **颗粒压到极淡** —— 数据可读性优先。
6. **字体用 Inter 替代 BT Grotesk** —— 授权不可分发。
