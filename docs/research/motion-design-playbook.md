# 高质感 AI 产品界面动效与交互手册（2025–2026）

调研日期：2026-10-10。本文把“高质感”理解为动效帮助用户理解状态、空间关系与操作结果，同时不拖慢任务。本文中的数字分成两类：**平台/库明确值**（来源文档直接给出）与**落地起始值**（经验建议，需在具体界面校准）；不存在适用于所有界面的统一动效时长。

## 先看可直接采用的基线

| 场景 | 推荐起始值 | 调整原则 |
|---|---:|---|
| hover / pressed | 100–180ms | 即时反馈优先；不做长距离位移 |
| 小型状态变化、图标/标签 | 140–220ms | 传达状态即可，避免抢焦点 |
| 菜单、popover、toast | 160–240ms | 淡入配合 4–8px 位移；退出通常略快 |
| 对话框、侧栏 | 200–320ms | 遮罩透明度与面板位移分开调 |
| 首屏/分组 stagger | 30–60ms/项，单项 220–360ms | 只用于首屏少量内容；控制总瀑布时长 |
| 列表级 stagger | 20–40ms/项，单项 160–260ms | 批量数据避免逐项排队，可分组或不 stagger |
| easing | 入场 `cubic-bezier(.2,.8,.2,1)` | 快速响应、尾部收稳；退出用更快的 ease-in |

上表是**实现起点，不是业界标准**。不要将 `ease-out-expo`、20–40ms 或 300–600ms 当成权威规范：官方资料未定义这些为通用规范。Motion 示例中有 30ms 字符、50ms 列表/元素、100ms stagger；其指南引用的入/退场建议通常不超过 300–400ms。Motion 的 100ms 文档示例是示例，不构成推荐上限。[Motion stagger](https://motion.dev/docs/stagger) · [Motion easing](https://motion.dev/docs/easing-functions) · [Motion transitions](https://motion.dev/docs/react-transitions)

## 1. 入场与 stagger

### 怎么选节奏

交错的目的在于显示阅读顺序或群组关系，而不是让每个元素都“表演”。同一组中元素越多，步长应越短；总耗时可估为 `duration + (n - 1) × stagger`。例如 6 项、240ms 单项、32ms 步长，总时长约 400ms。超过 8–10 个可见项时，建议只 stagger 首屏关键项、按行/组交错，或让列表整体淡入。用户重复打开的高频界面可缩短到约 120–200ms 或关闭装饰性入场。

### CSS：小批量元素

```css
:root {
  --ease-enter: cubic-bezier(.2, .8, .2, 1);
  --ease-exit: cubic-bezier(.4, 0, 1, 1);
}

@keyframes rise-in {
  from { opacity: 0; transform: translateY(6px); }
  to   { opacity: 1; transform: translateY(0); }
}

.entry > * {
  opacity: 0;
  animation: rise-in 260ms var(--ease-enter) both;
}
.entry > *:nth-child(1) { animation-delay: 0ms; }
.entry > *:nth-child(2) { animation-delay: 32ms; }
.entry > *:nth-child(3) { animation-delay: 64ms; }
.entry > *:nth-child(4) { animation-delay: 96ms; }
```

`both` 可避免延迟期间元素闪现；但在内容 SSR、导航恢复或 reduced-motion 场景，要确保无动画时内容仍显示。大型列表不宜枚举子项并长时间隐藏内容。

### Motion for React：从中心或首项交错

```jsx
import { motion, stagger } from "motion/react";

const list = {
  hidden: {},
  show: { transition: { delayChildren: stagger(0.04, { from: "first" }) } },
};
const item = {
  hidden: { opacity: 0, y: 6 },
  show: { opacity: 1, y: 0, transition: { duration: 0.24, ease: [0.2, 0.8, 0.2, 1] } },
};

<motion.ul variants={list} initial="hidden" animate="show">
  {rows.map(row => <motion.li key={row.id} variants={item}>{row.label}</motion.li>)}
</motion.ul>
```

Motion 的 `stagger()` 接受秒数、`from`（first/center/last/index）与 `ease`；建议步长按元素密度调节，字符动画可以更短（官方例子 30ms），列表/卡片常从 40–60ms 开始试。[Motion stagger 文档](https://motion.dev/docs/stagger) · [Motion 文本动画](https://motion.dev/docs/text-animation)

### 缓动怎么选

- 入场/回弹后落位：ease-out 或自定义 bezier，例如 `.2,.8,.2,1`。
- 退出：ease-in，常比入场短约 20–30%。
- 状态往返/持续进度：linear，或弹簧（spring）用于真实的空间移动。
- 不要在普通按钮上用夸张 overshoot、elastic 或长弹簧。弹簧适合拖拽释放、卡片归位等有质量感的动作。
- `ease-out-expo` 可作为某些强调性展示的风格选项，但不是 UI 通用默认；指数尾部容易显得骤停或刻意。

Motion 文档示例提供 `easeOut` 与 cubic-bezier，并引用 Emil Kowalski 的入/退场通常不超过 0.3–0.4 秒建议。[Motion easing functions](https://motion.dev/docs/easing-functions)

## 2. Hover、active 与按钮物理感

小幅改变尺度、阴影和颜色即可提供触感。优先选择 `transform`（通常可合成）与 `opacity`；`box-shadow` 变化属于绘制成本，适合面积小、频率低的微反馈，不宜对大面积模糊阴影做持续动画。颜色也需要 paint，但单次短促变化通常可以接受。hover 仅用于有 hover 能力的设备；键盘 focus 需有清楚的可见样式。

```css
.button {
  transition:
    transform 140ms cubic-bezier(.2,.8,.2,1),
    opacity 120ms ease-out,
    box-shadow 160ms ease-out,
    background-color 140ms ease-out;
}
.button:hover { transform: translateY(-1px); }
.button:active { transform: translateY(0) scale(.985); }
.button:focus-visible { outline: 2px solid currentColor; outline-offset: 3px; }
@media (hover: none) {
  .button:hover { transform: none; }
}
@media (prefers-reduced-motion: reduce) {
  .button { transition: none; }
}
```

实践要点：位移保持约 1–2px、缩放约 0.98–0.99；active 不要改变按钮布局尺寸；优先让按下立即响应，松开迅速复位。阴影可在 hover/active 两个静态档位间短过渡，但对大型列表中的每一项同时做模糊阴影动画可能掉帧。Stripe 的工程案例建议 hover 用 CSS transition、较复杂序列用 WAAPI，并建议多数动效控制在 500ms 以下；这是该团队工程文章的经验，不是硬性标准。[Stripe：Connect 前端体验](https://stripe.com/blog/connect-front-end-experience)

Radix 提供可与 CSS 动画搭配的 `data-state="open/closed"`，并支持退出动画完成后再卸载；若 JS 动画库负责卸载，可用 `forceMount` 把挂载生命周期交给动画状态管理。[Radix Animation Guide](https://www.radix-ui.com/primitives/docs/guides/animation)

## 3. 状态转场：数字、路径与共享元素

状态过渡应保持信息连续性：强调“哪一个值变了、来自哪里、去向何处”。先即时更新语义数据与辅助技术可读内容，再对视觉呈现做短暂过渡；不要把正确答案延迟到动画结束才暴露。

### 数字滚动

高频实时数字通常直接更新；汇总数字或用户触发的统计结果可做 250–500ms 的数值插值。避免快速连续的数字变化触发永无止境的滚动，可以合并更新、取消上一次动画并以最新值为终点。完整数字需对读屏器可访问，可用静态 `aria-label` 或 `aria-live="polite"` 的最终值，避免逐帧播报。

```js
function animateNumber(el, from, to, { duration = 360, format = n => Math.round(n).toLocaleString() } = {}) {
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  el.getAnimations().forEach(animation => animation.cancel());
  if (reduce || duration <= 0) { el.textContent = format(to); return; }
  const animation = el.animate([{ opacity: 1 }, { opacity: 1 }], {
    duration, easing: "ease-out", fill: "both"
  });
  const start = performance.now();
  const tick = now => {
    const p = Math.min(1, (now - start) / duration);
    const eased = 1 - Math.pow(1 - p, 3);
    el.textContent = format(from + (to - from) * eased);
    if (p < 1 && !reduce) requestAnimationFrame(tick);
    else { el.textContent = format(to); animation.cancel(); }
  };
  requestAnimationFrame(tick);
}
```

这个简例用于低频、短数字；货币/百分数应由 `format` 处理单位与小数，数字文本仍每帧更新会触发布局/绘制。若数字区域较大或频繁更新，视觉收益通常不值得成本。

### SVG 路径 morph

两条路径的命令结构/点对应关系需可插值（使用不同点数、命令结构时先正规化或用能重采样路径的库）；形状语义应对应，避免拓扑突变。确保填充规则、方向、闭合状态一致，设计中间态并检查极端尺寸。用 `<path d>` 插值可以由 Motion SVG/专用 morph 工具实现；不要假定任意 `d` 字符串都能原生平滑 morph。[Motion animate（SVG 属性与动画）](https://motion.dev/docs/animate) · [SVG path d 规范说明](https://developer.mozilla.org/en-US/docs/Web/SVG/Reference/Attribute/d)

### 共享元素过渡

View Transition API 适合列表缩略图到详情图、面板切换等“同一对象在新布局中的位置/尺寸变化”。同一文档中先命名共享元素，然后在 `startViewTransition()` 回调中同步更新 DOM：

```css
.card-image { view-transition-name: selected-image; }
::view-transition-old(selected-image),
::view-transition-new(selected-image) {
  animation-duration: 240ms;
  animation-timing-function: cubic-bezier(.2,.8,.2,1);
}
@media (prefers-reduced-motion: reduce) {
  ::view-transition-group(*),
  ::view-transition-old(*),
  ::view-transition-new(*) { animation-duration: 1ms; }
}
```

```js
function updateView(updateDOM) {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches || !document.startViewTransition) {
    updateDOM();
    return;
  }
  document.startViewTransition(() => updateDOM());
}
```

`view-transition-name` 必须在参与转换的旧/新状态里唯一；只给真正需要共享的元素命名。API 截图式地捕获旧/新视图，默认可能覆盖内容，长动画期间交互体验也需验证。MDN 标注 View Transition API 在不同平台支持有差异，使用前做 feature detection 并确保无 API 时状态更新照常发生。[MDN View Transition API](https://developer.mozilla.org/en-US/docs/Web/API/View_Transition_API) · [MDN transition types](https://developer.mozilla.org/en-US/docs/Web/API/View_Transition_API/Using_types)

## 4. 滚动驱动动画

`scroll()` 把动画映射到滚动容器的总体进度；`view()` 把动画映射到元素经过滚动视口的进度。它们是**滚动联动**而非简单的“进入视口就播一次”。滚动反向时动画也反向。适用于阅读进度、轻量视差、章节内容淡入；不要抢夺滚轮、强制滚动或让内容必须动画后才可读。

```css
.reading-progress {
  position: fixed;
  inset: 0 auto auto 0;
  height: 2px;
  width: 100%;
  transform: scaleX(0);
  transform-origin: left;
  background: #8b7cff;
  animation: progress linear both;
  animation-timeline: scroll(root block);
}
@keyframes progress { to { transform: scaleX(1); } }

.reveal {
  animation: reveal linear both;
  animation-timeline: view();
  animation-range: entry 0% entry 35%;
}
@keyframes reveal {
  from { opacity: 0; transform: translateY(10px); }
  to { opacity: 1; transform: translateY(0); }
}
@media (prefers-reduced-motion: reduce) {
  .reading-progress, .reveal { animation: none; transform: none; opacity: 1; }
}
```

注意 `animation-timeline` 要写在 `animation` shorthand **之后**，因为 shorthand 会重置它。渐进增强写法：默认内容全可见，只在支持时增加效果。

```css
.reveal { opacity: 1; transform: none; }
@supports (animation-timeline: view()) {
  @media (prefers-reduced-motion: no-preference) {
    .reveal {
      animation: reveal linear both;
      animation-timeline: view();
      animation-range: entry 0% entry 35%;
    }
  }
}
```

**截至 2026-10 的支持判断：**Chrome/Edge 从 115 起支持核心 scroll/view timelines；Safari/WebKit 在 Safari 26（2025）发布支持；Firefox 的稳定默认支持仍未确认，MDN 将 `animation-timeline` 标为 Limited availability / 非 Baseline。具体子特性和旧版设备有差异，以 MDN 兼容表和目标浏览器实测为准。生产应用不能把核心内容隐藏在该特性后；需要同等动画时可用 IntersectionObserver/WAAPI fallback，否则保持静态即可。[Chrome scroll-driven animations](https://developer.chrome.com/docs/css-ui/scroll-driven-animations) · [WebKit 指南](https://webkit.org/blog/17101/a-guide-to-scroll-driven-animations-with-just-css/) · [MDN animation-timeline 与兼容状态](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/animation-timeline)

## 5. 微交互克制：哪些动，哪些不动

**值得动：**动作结果（已保存、复制成功、筛选条件生效）、焦点/层级变化（popover、侧栏、对话框）、对象连续性（卡片移位、图片展开）、必要进度（上传、生成、同步）、用户主动拖拽/排序。动画应回答“发生了什么”，并与操作直接相连。

**通常不动：**静态文本、长列表每一行、持续闪烁的装饰、与操作无关的粒子/光效、焦点外的重复提示。避免用动画替代明确的状态文案和图标。Linear 的设计更新原文强调层级、对齐、密度和降低视觉噪声；这对 AI 工作台尤其适用：复杂任务面板把动效留给进度、结果出现与焦点切换，不要让每块卡片都争夺注意力。[Linear UI redesign](https://linear.app/now/how-we-redesigned-the-linear-ui) · [Linear 2026 UI refresh](https://linear.app/changelog/page/3)

- **加载态：**若短请求可能小于约 300ms，通常不必闪出 spinner；这是经验阈值，避免闪烁。更长操作要显示稳定的骨架或进度指示；可确定进度用百分比，不确定进度用低运动幅度的 spinner/静态状态文案。生成过程可逐段呈现可用内容，并标明仍在生成。
- **空态：**首次无数据时说明原因与下一步操作；若空状态插画做轻微一次性入场即可。空态不能用循环动画造成“正在加载”的错觉。
- **错误态：**立即呈现错误文本、原因和恢复动作；可用轻微颜色/边框强调，避免剧烈抖动或仅靠红色闪烁。表单校验后将焦点/错误关联到具体字段。
- **AI 状态：**用可读标签（思考/搜索/生成/完成/失败）和阶段变化辅助用户判断系统正在做什么。持续活动采用低对比、低频动效；用户切走后减少不必要的循环动画。不要把模拟打字当成真实生成进度。

Vercel 产品导览工程文章的原则很具体：导览里动画的职责是维持注意力，但不能让导览本身盖过产品；用 tooltip 在位置改变后再显现描述，并通过 transition 完成事件组织时序。[Vercel virtual product tour](https://vercel.com/blog/designing-the-vercel-virtual-product-tour)

## 6. 性能红线与 60fps

每帧预算在 60Hz 屏幕上约 **16.7ms**，但浏览器绘制、输入与脚本都会消耗预算，实际给动效的预算更少；高刷新率屏幕预算更低。目标不是“用了 GPU 就一定顺”，而是控制布局、绘制、层数量和同时动画的像素面积。

- **通常首选：**`transform`（translate/scale/rotate）和 `opacity`。一般可在合成阶段处理，但具体元素仍须用 DevTools 确认。
- **会布局/重排：**`width`、`height`、`top`、`left`、margin、padding 等改变几何关系的属性。改用 transform 做视觉位移/缩放，布局终态可在动画前后由布局本身完成。
- **会绘制：**`box-shadow`、`filter: blur()`、背景、边框颜色等。短时小区域可接受；避免整屏大模糊和大量元素同时持续更新。
- **`will-change`：**不是默认加速开关。只对即将动画且经性能分析确认有帮助的元素短期使用；过多会占用 GPU 内存并造成更多合成层。
- **SVG path morph、滤镜、canvas/WebGL：**复杂度高，需在低端移动设备实测；静态效果优先用 CSS/SVG，无需每帧 React state 重渲染。
- **检查：**Chrome Performance 录制目标交互，观察 Frames、Rendering/Paint、Long tasks；启用 Paint flashing/Layers；用 CPU throttling、低端真机和高刷新率设备验收。60fps 是目标而非保证。

Web.dev 将 `transform`/`opacity` 作为优先属性，并指出几何属性会触发布局与绘制；`box-shadow`、颜色等一般跳过 layout 但仍需 paint。谨慎使用 `will-change`。[web.dev Animations and performance](https://web.dev/articles/animations-and-performance) · [web.dev 高性能动画指南](https://web.dev/articles/animations-guide) · [web.dev Rendering performance](https://web.dev/articles/rendering-performance)

## 7. 可访问性与 WCAG

### `prefers-reduced-motion`

减少动态效果偏好应被视为第一类设置：取消非必要位移、缩放、视差、自动播放与循环；以即时切换、淡化（若合适）或不动作为替代。不能只把动画时长改成 0 后遗留不可见的初始态；需确保内容最终态始终存在。JavaScript 动画也应读取该偏好，并在运行中监听变化（用户可能在会话中切换）。

```css
/* 默认：静态内容已可见；只在明确允许 motion 时加装饰动画 */
.panel { opacity: 1; transform: none; }
@media (prefers-reduced-motion: no-preference) {
  .panel[data-entering="true"] {
    animation: rise-in 240ms cubic-bezier(.2,.8,.2,1) both;
  }
}
```

```js
const motionPreference = matchMedia("(prefers-reduced-motion: reduce)");
function runDecorativeMotion(element) {
  if (motionPreference.matches) return;
  // 启动 WAAPI 动画；每次启动前也可按需取消旧动画
}
motionPreference.addEventListener("change", event => {
  if (event.matches) document.getAnimations().forEach(a => a.cancel());
});
```

### WCAG 条款要点

- **WCAG 2.3.3 Animation from Interactions（AAA）：**由交互触发的非必要运动动画应可关闭，除非动画对功能或信息表达必要。W3C 将 `prefers-reduced-motion` 列为充分技术之一，但规范要求是结果，不限定必须用该媒体查询。[W3C SC 2.3.3](https://www.w3.org/WAI/WCAG21/Understanding/animation-from-interactions) · [W3C 技术 C39](https://www.w3.org/WAI/WCAG22/Techniques/css/C39.html)
- **WCAG 2.2.2 Pause, Stop, Hide（A）：**自动开始、持续超过 5 秒、并与其他内容并行呈现的移动/闪烁/滚动内容，通常要提供暂停、停止或隐藏机制（除非必要）。不要把 5 秒误解成“少于 5 秒可以随意闪”。[W3C WCAG 2.2.2 Understanding](https://www.w3.org/WAI/WCAG22/Understanding/pause-stop-hide.html)
- **WCAG 2.3.1 Three Flashes or Below Threshold（A）：**内容不得每秒闪烁超过三次，除非低于阈值。[W3C WCAG 2.2](https://www.w3.org/TR/WCAG22/)
- 状态不能只靠颜色或动画传递；提供文本/图标、正确语义、键盘可用性和清晰焦点。焦点移动和读屏播报应与界面状态更新一致。

## 8. 产品观察与证据边界

| 产品/来源 | 可验证的设计/工程信号 | 适合借鉴 |
|---|---|---|
| Linear | 官方 2024 redesign 与 2026 refresh 聚焦层级、对齐、密度、降低噪声；公开 changelog 有大量状态变化但未公开统一时长规范 | 动效先服务信息架构；产品内微动效参数属于未公开，不推测 |
| Vercel | 官方产品导览写明用 CSS transition 过渡 tooltip、dot pulse 引导用户，依赖 transitionEnd 协调内容出现；2025 Ship 案例使用 Motion `useTransform` 做滚动缩放与 sticky sections | 复杂序列靠明确事件编排；滚动效果与内容结构绑定 |
| Stripe | 工程博客给出 CSS transition → CSS animation → WAAPI → rAF 的复杂度阶梯、减少装饰动效并关注性能/无障碍；多数动画建议低于 500ms | 选择最简单可控的 API；高质感来自精确节奏与反馈，不等于堆效果 |
| Radix | 官方指南说明 open/closed 状态 CSS 动画和卸载时序、`forceMount` 配合 JS 动画生命周期 | 组件状态驱动动效，确保 exit 阶段 DOM 仍存在 |
| Anthropic Claude | Anthropic 官方材料主要介绍 Claude 产品/功能，未找到 Claude 应用完整公开的动效设计规范或参数 | 观察产品可做审美参考，但具体曲线/时长未验证，不把视觉推断说成官方实现 |
| “Opus 5.5 做的视频” | 没有具体视频链接或作品标识；搜索发现该称呼关联多种用户作品/演示，不能据此验证画面或制作方法 | 作为审美方向可拆成节奏、对比、连贯变形、镜头编排；具体作品及技术实现未验证 |

来源：[Linear 2024 redesign](https://linear.app/now/how-we-redesigned-the-linear-ui) · [Linear 2026 changelog](https://linear.app/changelog/page/3) · [Vercel 导览案例](https://vercel.com/blog/designing-the-vercel-virtual-product-tour) · [Vercel Ship 2025](https://vercel.com/blog/designing-and-building-the-vercel-ship-conference-platform) · [Stripe 工程文章](https://stripe.com/blog/connect-front-end-experience) · [Anthropic Claude Design 公告](https://www.anthropic.com/news/claude-design-anthropic-labs)

## 实施验收清单

- [ ] 动画对应一个可说清的用户收益：状态、层级、空间连续性或进度。
- [ ] 动效不挡操作；重复高频使用场景下不过度播放。
- [ ] 内容静态基线可见，JS/CSS 动画失败不影响信息与功能。
- [ ] `prefers-reduced-motion` 覆盖 CSS、Motion/WAAPI、视差和滚动动画。
- [ ] 使用 transform/opacity 为主；对 paint-heavy 动画有目标设备实测。
- [ ] 用键盘、读屏器、触屏、低端设备和慢速网络检查状态反馈。
- [ ] 验证动画中途状态切换、连续点击、取消/重启、组件卸载与路由返回。
- [ ] 滚动时间线做 `@supports` 检测；Firefox/旧浏览器拥有完整静态内容。

## 来源索引（优先一手资料）

- Motion 官方：[stagger](https://motion.dev/docs/stagger)、[transitions](https://motion.dev/docs/react-transitions)、[easing](https://motion.dev/docs/easing-functions)、[animate](https://motion.dev/docs/animate)、[view animations](https://motion.dev/docs/animate-view)
- Radix 官方：[Animation guide](https://www.radix-ui.com/primitives/docs/guides/animation)
- 浏览器/标准：[Chrome scroll-driven animations](https://developer.chrome.com/docs/css-ui/scroll-driven-animations)、[WebKit guide](https://webkit.org/blog/17101/a-guide-to-scroll-driven-animations-with-just-css/)、[MDN animation-timeline](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/animation-timeline)、[MDN View Transition API](https://developer.mozilla.org/en-US/docs/Web/API/View_Transition_API)
- 性能：[web.dev animations and performance](https://web.dev/articles/animations-and-performance)、[high-performance animations](https://web.dev/articles/animations-guide)、[rendering performance](https://web.dev/articles/rendering-performance)
- 无障碍：[W3C SC 2.3.3](https://www.w3.org/WAI/WCAG21/Understanding/animation-from-interactions)、[W3C C39](https://www.w3.org/WAI/WCAG22/Techniques/css/C39.html)、[WCAG 2.2](https://www.w3.org/TR/WCAG22/)
- 产品工程：[Linear redesign](https://linear.app/now/how-we-redesigned-the-linear-ui)、[Vercel virtual product tour](https://vercel.com/blog/designing-the-vercel-virtual-product-tour)、[Stripe Connect frontend](https://stripe.com/blog/connect-front-end-experience)
