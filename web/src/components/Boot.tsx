import { useEffect, useMemo, useRef, useState } from "react";
import type { ScanProgress, ToolMeta } from "../types";
import { gsap, prefersReduced } from "../motion/gsap";
import { fmtInt } from "../format";

/**
 * 开机屏（规格表）—— 复刻 heronaiapp.com 的 loading 屏。
 *
 * 原站是一个**建筑图纸规格表**：尺子 + 坐标读数、项目规格（TYPE / FOUNDED /
 * FOCUS / LOCATION）、以及一串会逐条打勾的编号清单，最后整页通过
 * clip-path inset 揭开（un-mask）。
 *
 * 关键差异（也是我们比原站强的地方）：原站的清单是编出来的；
 * 我们的清单**接真实的扫描进度**（SSE 的 stage / percent / filesSeen / events）。
 * 没在扫描时就退化成一段快节奏的开机演示。
 */

const STAGES = [
  "DETECT LOCAL TOOLS",
  "PARSE SESSION LOGS",
  "WRITE TO SQLITE",
  "REBUILD AGGREGATES",
  "READY",
];

interface Props {
  progress: ScanProgress;
  /** 仪表盘数据是否已就绪 */
  ready: boolean;
  tools: ToolMeta[];
  events: number;
  onDone: () => void;
}

/** 把扫描阶段映射到清单下标（与 ScanFlow.tsx 的 stageIndex 同源）。 */
function stageIndex(stage: string): number {
  switch (stage) {
    case "scanning":
      return 1;
    case "storing":
      return 2;
    case "aggregating":
      return 3;
    case "done":
      return 4;
    default:
      return 0;
  }
}

export default function Boot({ progress, ready, tools, events, onDone }: Props) {
  const root = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const appRef = useRef<HTMLElement | null>(null);
  const [pct, setPct] = useState(0);
  const [checked, setChecked] = useState(0);
  const [coord, setCoord] = useState({ x: 1131, y: 1131 });
  // 最短停留：数据很快时别让开机屏一闪而过，那样比不放还廉价
  const [minElapsed, setMinElapsed] = useState(false);
  const doneRef = useRef(false);

  const reduce = useMemo(() => prefersReduced(), []);

  // 坐标读数跟随指针（原站写死 1131PX，这里让它活着）
  useEffect(() => {
    const onMove = (e: PointerEvent) =>
      setCoord({ x: Math.round(e.clientX), y: Math.round(e.clientY) });
    window.addEventListener("pointermove", onMove, { passive: true });
    return () => window.removeEventListener("pointermove", onMove);
  }, []);

  useEffect(() => {
    const t = window.setTimeout(() => setMinElapsed(true), 2100);
    return () => window.clearTimeout(t);
  }, []);

  // 真实扫描在跑 → 清单/百分比跟着真实进度；否则走演示节奏
  useEffect(() => {
    if (progress.running) {
      setPct(Math.max(2, Math.min(100, progress.percent)));
      setChecked(Math.max(1, Math.min(4, stageIndex(progress.stage) + 1)));
      return;
    }
    if (progress.stage === "done") {
      setPct(100);
      setChecked(5);
      return;
    }
    const id = window.setInterval(() => {
      setPct((p) => (p >= 96 ? 96 : p + Math.max(1, (96 - p) * 0.12)));
      setChecked((c) => (c >= 4 ? 4 : c + 1));
    }, 220);
    return () => window.clearInterval(id);
  }, [progress.running, progress.percent, progress.stage]);

  // 进场
  useEffect(() => {
    if (!root.current || !inner.current || reduce) return;
    const tl = gsap.timeline();
    // 容器负责淡入；行只做位移——绝不在行上动 opacity，
    // 否则 StrictMode 的 mount→unmount→mount 会把某几行永久留在透明态。
    tl.fromTo(inner.current, { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.45, ease: "power2.out" })
      .fromTo(
        ".boot-line",
        { y: 14 },
        { y: 0, duration: 0.5, stagger: 0.05, ease: "expo.out" },
        "-=0.25",
      );
    return () => {
      tl.kill();
    };
  }, [reduce]);

  // 收尾：就绪 + 最短停留 → 打满 → 揭开整页
  useEffect(() => {
    if (!ready || !minElapsed || doneRef.current) return;
    appRef.current = document.querySelector(".app");
    doneRef.current = true;
    setPct(100);
    setChecked(5);

    const finish = () => {
      document.documentElement.classList.remove("booting");
      onDone();
    };

    if (reduce) {
      const t = window.setTimeout(finish, 120);
      return () => window.clearTimeout(t);
    }

    const tl = gsap.timeline({ onComplete: finish });
    tl.to({}, { duration: 0.35 }) // 让 100% 与打满的勾停留一瞬
      .to(inner.current, { autoAlpha: 0, y: -14, duration: 0.45, ease: "power2.in" })
      .to(root.current, { clipPath: "inset(0% 0% 100% 0%)", duration: 0.85, ease: "expo.inOut" }, "-=0.1");
    if (appRef.current) {
      tl.fromTo(
        appRef.current,
        { clipPath: "inset(0% 0% 100% 0%)" },
        { clipPath: "inset(0% 0% 0% 0%)", duration: 0.85, ease: "expo.inOut", clearProps: "clipPath" },
        "<",
      );
    }
    return () => {
      tl.kill();
    };
  }, [ready, minElapsed, reduce, onDone]);

  useEffect(() => {
    document.documentElement.classList.add("booting");
    return () => document.documentElement.classList.remove("booting");
  }, []);

  const toolNames = tools.length ? tools.map((t) => t.name).join(" / ") : "CODEX / CLAUDE CODE / OPENCODE / DSH / GEMINI CLI";

  return (
    <div className="boot" ref={root}>
      {/* 尺子 + 坐标读数 */}
      <div className="boot-ruler" aria-hidden>
        <span className="boot-ruler-line" />
        <span className="boot-ruler-plus" />
      </div>

      <div className="boot-inner" ref={inner}>
        <div className="boot-coord">
          <span>X:<b>{coord.x}</b>PX</span>
          <span>Y:<b>{coord.y}</b>PX</span>
        </div>

        <div className="boot-title boot-line">
          TokenLedger — 本机 Coding AI 用量账本
        </div>

        <div className="boot-spec">
          <div className="boot-spec-row boot-line">
            <span className="boot-k">TOOLS</span>
            <span className="boot-sep">:</span>
            <span className="boot-v">{toolNames}</span>
          </div>
          <div className="boot-spec-row boot-line">
            <span className="boot-k">SOURCE</span>
            <span className="boot-sep">:</span>
            <span className="boot-v">~/.codex · ~/.claude · opencode.db · ~/.dsh · ~/.gemini</span>
          </div>
          <div className="boot-spec-row boot-line">
            <span className="boot-k">MODE</span>
            <span className="boot-sep">:</span>
            <span className="boot-v">LOCAL ONLY — 不联网 · 不上传</span>
          </div>
          <div className="boot-spec-row boot-line">
            <span className="boot-k">RECORDS</span>
            <span className="boot-sep">:</span>
            <span className="boot-v">{fmtInt(events)} EVENTS</span>
          </div>
        </div>

        <div className="boot-check">
          {STAGES.map((s, i) => (
            <div key={s} className={`boot-step${i < checked ? " on" : ""}`}>
              <span className="boot-num">{String(i + 1).padStart(3, "0")}</span>
              <span className="boot-step-label">{s}</span>
              <span className="boot-dash" />
              <span className="boot-tick">{i < checked ? "✓" : ""}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="boot-progress" aria-hidden>
        <div className="boot-progress-bar">
          <span style={{ width: `${pct}%` }} />
        </div>
        <div className="boot-progress-num">
          <b>{Math.round(pct)}</b>%
        </div>
      </div>
    </div>
  );
}
