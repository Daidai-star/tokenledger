import { gsap, ScrollTrigger, SplitText, isCoarsePointer, prefersReduced } from "./gsap";

/**
 * 页面级动效的装配单。
 *
 * 全部装在 `gsap.context(...)` 里，切栏/换数据时 `ctx.revert()` 一次性拆干净——
 * GSAP 的 ScrollTrigger 和 pin 会往 DOM 里塞 wrapper、改 inline style，
 * 不 revert 的话第二次渲染就会叠一层，越切越歪。
 *
 * 三处安全约束（沿用项目既有原则）：
 * 1. prefers-reduced-motion 时一律不装配，内容直接可见。
 * 2. 纯装饰（线、角标）出错不能挡住数据——只动装饰层。
 * 3. 触屏不做 pin（手指滚动 + 固定区块的体验很差）。
 */

/** 逐行遮罩揭示：标题按行切开，每行从遮罩里升起。 */
export function mountHeadingReveals(scope: HTMLElement) {
  const els = gsap.utils.toArray<HTMLElement>(
    ".section-head h2, .profile-title, .brand strong, .reveal-heading",
    scope,
  );
  els.forEach((el) => {
    // SplitText 的 mask: "lines" 会在每个行外包一层 overflow:hidden 的遮罩
    const split = new SplitText(el, {
      type: "lines",
      linesClass: "split-line",
      mask: "lines",
    });
    gsap.from(split.lines, {
      yPercent: 115,
      duration: 0.85,
      ease: "expo.out",
      stagger: 0.07,
      scrollTrigger: { trigger: el, start: "top 88%", once: true },
    });
  });
}

/** SVG / 边框线描出土：图纸框、通栏线按 stroke-dashoffset / scale 画出来。 */
export function mountLineDraws(scope: HTMLElement) {
  // 图纸框四边在 .app 之外（fixed 层），所以这一步固定查 document
  const lines = gsap.utils.toArray<HTMLElement>(".sheet-line");
  if (lines.length) {
    gsap.set(".sheet-line.top, .sheet-line.bottom", { scaleX: 0, transformOrigin: "left center" });
    gsap.set(".sheet-line.left, .sheet-line.right", { scaleY: 0, transformOrigin: "center top" });
    gsap.to(".sheet-line.top, .sheet-line.bottom", {
      scaleX: 1,
      duration: 0.9,
      ease: "expo.inOut",
      stagger: 0.06,
    });
    gsap.to(".sheet-line.left, .sheet-line.right", {
      scaleY: 1,
      duration: 0.9,
      ease: "expo.inOut",
      stagger: 0.06,
      delay: 0.12,
    });
    gsap.from(".sheet-corner", {
      autoAlpha: 0,
      scale: 0.4,
      duration: 0.5,
      ease: "expo.out",
      stagger: 0.05,
      delay: 0.5,
    });
  }

  // 通栏分节线：滚到时从左侧展开（范围内元素）
  gsap.utils.toArray<HTMLElement>(".rule, .rule-dashed", scope).forEach((el) => {
    gsap.from(el, {
      scaleX: 0,
      transformOrigin: "left center",
      duration: 0.7,
      ease: "expo.out",
      scrollTrigger: { trigger: el, start: "top 92%", once: true },
    });
  });
}

/**
 * 滚动驱动（scrub）的固定区块：采集流程。
 *
 * 复刻 heronaiapp.com 的 700dvh home-map —— 把一块内容钉住，往下滚的过程
 * 逐帧推进时间轴。这里钉住「采集流程」面板，流水线节点随滚动依次点亮。
 */
export function mountPinnedPipeline(scope: HTMLElement) {
  if (isCoarsePointer()) return;
  if (!window.matchMedia("(min-width: 1024px)").matches) return;

  const stageEls = gsap.utils.toArray<HTMLElement>(".pipeline .stage", scope);
  if (!stageEls.length) return;

  gsap.from(stageEls, {
    autoAlpha: 0.25,
    scale: 0.94,
    ease: "none",
    stagger: 0.5,
    scrollTrigger: {
      trigger: ".pin-section",
      start: "top top",
      end: "+=140%",
      scrub: 0.6,
      pin: ".pin-inner",
      pinSpacing: true,
    },
  });
}

/** 顶栏随滚动收走，往上滚回来。 */
export function mountHeaderHide(topbar: HTMLElement) {
  let last = window.scrollY;
  const onScroll = () => {
    const y = window.scrollY;
    const down = y > last && y > 80;
    topbar.classList.toggle("tucked", down);
    last = y;
  };
  window.addEventListener("scroll", onScroll, { passive: true });

  const show = () => topbar.classList.remove("tucked");
  // hover 到顶栏时应当立刻收回「藏起来」的状态
  topbar.addEventListener("pointerenter", show);

  return () => {
    window.removeEventListener("scroll", onScroll);
    topbar.removeEventListener("pointerenter", show);
  };
}

/**
 * 把整页动效装进一个 gsap.context，返回 disposer。
 * 所有向后滚才出现的效果统一 once，不重播。
 */
export function mountSiteMotion(scope: HTMLElement, topbar: HTMLElement | null): () => void {
  if (prefersReduced()) return () => {};

  const ctx = gsap.context(() => {
    mountHeadingReveals(scope);
    mountLineDraws(scope);
    mountPinnedPipeline(scope);
  }, scope);

  const offHeader = topbar ? mountHeaderHide(topbar) : undefined;

  // 字体加载完再算一次行高——SplitText 在 webfont 到位前切行会切错
  let cancelled = false;
  if (document.fonts?.ready) {
    document.fonts.ready.then(() => {
      if (cancelled) return;
      ScrollTrigger.refresh();
    });
  }

  return () => {
    cancelled = true;
    offHeader?.();
    ctx.revert();
  };
}
