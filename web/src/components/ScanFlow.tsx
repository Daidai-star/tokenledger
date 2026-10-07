import { useEffect, useState } from "react";
import type { ScanProgress, ToolMeta } from "../types";
import { fmtInt } from "../format";

/**
 * 采集流程面板。
 *
 * 展示扫描的每个阶段流转：
 *   检测工具 -> 逐个采集（进度条按文件数推进） -> 计算成本 -> 写入聚合 -> 完成
 * 阶段切换、进度条增长、节点点亮都带动画。
 */

const STAGES = [
  { key: "detect", label: "检测工具", icon: "◎" },
  { key: "scan", label: "解析日志", icon: "▤" },
  { key: "store", label: "写入存储", icon: "▣" },
  { key: "aggregate", label: "聚合", icon: "◈" },
  { key: "done", label: "完成", icon: "✓" },
];

/** 返回「已完成的阶段数」。done 表示全部 5 个阶段都走完了。 */
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

const STAGE_COUNT = STAGES.length;

function toolNameOf(tools: ToolMeta[], id: string): string {
  return tools.find((t) => t.id === id)?.name || id;
}

interface Props {
  progress: ScanProgress;
  tools: ToolMeta[];
  onScan: () => void;
  onReset: () => void;
}

export default function ScanFlow({ progress, tools, onScan, onReset }: Props) {
  const running = progress.running;
  const [confirmReset, setConfirmReset] = useState(false);
  const [pulse, setPulse] = useState(0);

  // 运行时用轻量脉冲强化「正在工作」的感知
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setPulse((p) => p + 1), 900);
    return () => clearInterval(t);
  }, [running]);

  useEffect(() => {
    if (!confirmReset) return;
    const t = setTimeout(() => setConfirmReset(false), 4000);
    return () => clearTimeout(t);
  }, [confirmReset]);

  const finished = progress.stage === "done";
  // 已完成时所有节点都是 done（含最后一个）；运行时最后未到的节点是 pending
  const doneCount = finished ? STAGE_COUNT : running ? stageIndex(progress.stage) : -1;
  const pct = running ? Math.max(0, Math.min(100, progress.percent)) : finished ? 100 : 0;

  return (
    <div className={`scan-flow${running ? " running" : ""}`}>
      <header className="scan-flow-head">
        <div className="scan-actions">
          <button className="btn primary" onClick={onScan} disabled={running}>
            {running ? "采集中" : "重新扫描"}
          </button>
          <button
            className={`btn ghost${confirmReset ? " danger" : ""}`}
            onClick={() => {
              if (!confirmReset) {
                setConfirmReset(true);
                return;
              }
              setConfirmReset(false);
              onReset();
            }}
            disabled={running}
          >
            {confirmReset ? "确认清库重扫？" : "清库重扫"}
          </button>
        </div>
      </header>

      {/* 阶段流水线 */}
      <div className="pipeline">
        {STAGES.map((s, i) => {
          const state =
            doneCount < 0 ? "idle" : i < doneCount ? "done" : running && i === doneCount ? "active" : "pending";
          return (
            <div key={s.key} className={`stage stage-${state}`}>
              <div className="stage-node">
                <span className="stage-icon">{s.icon}</span>
                {i < STAGES.length - 1 && <span className="stage-link" />}
              </div>
              <div className="stage-label">{s.label}</div>
            </div>
          );
        })}
      </div>

      {/* 主进度条 */}
      <div className="scan-bar-wrap">
        <div className="scan-bar">
          <div className="scan-bar-fill" style={{ width: `${pct}%` }} />
          {running && <div className="scan-bar-shine" />}
        </div>
        <div className="scan-bar-meta">
          <span className="scan-status">
            {running
              ? progress.stage === "storing"
                ? "正在写入 SQLite…"
                : progress.stage === "aggregating"
                  ? "重建日聚合表…"
                  : progress.tool
                    ? `正在解析 ${toolNameOf(tools, progress.tool)} 的日志`
                    : "正在检测已安装的工具…"
              : finished
                ? "上次扫描已完成"
                : "空闲"}
          </span>
          <span className="scan-counts">
            {running || finished
              ? `${fmtInt(progress.filesParsed || 0)} / ${fmtInt(progress.filesSeen || 0)} 文件 · ${fmtInt(progress.events || 0)} 条事件`
              : "点击「重新扫描」增量抓取各工具的新用量"}
          </span>
        </div>
      </div>

      {/* 工具节点流 */}
      <div className="tool-flow">
        {tools.map((t, i) => {
          const active = running && progress.tool === t.id;
          // 扫描跑完一轮后，工具节点全部标记完成
          const done = finished && !active;
          return (
            <div
              key={t.id}
              className={`tool-node${active ? " active" : ""}${done ? " done" : ""}${!t.installed ? " absent" : ""}`}
              style={{ animationDelay: `${i * 70}ms`, "--tool-color": t.color } as React.CSSProperties}
            >
              <span className="tool-node-dot" />
              <span className="tool-node-name">{t.name}</span>
              {!t.installed && <span className="tool-node-badge">未安装</span>}
            </div>
          );
        })}
      </div>

      {progress.error && <div className="scan-error">扫描出错：{progress.error}</div>}
    </div>
  );
}