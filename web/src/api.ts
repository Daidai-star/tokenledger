import type { Dashboard, Range, ScanProgress } from "./types";

const BASE = "/api";

function qs(range: Range): string {
  const p = new URLSearchParams();
  if (range.from) p.set("from", range.from);
  if (range.to) p.set("to", range.to);
  if (range.tools?.length) p.set("tools", range.tools.join(","));
  const s = p.toString();
  return s ? `?${s}` : "";
}

export async function fetchDashboard(range: Range): Promise<Dashboard> {
  const res = await fetch(`${BASE}/dashboard${qs(range)}`);
  if (!res.ok) throw new Error(`dashboard ${res.status}`);
  return res.json();
}

export async function triggerScan(): Promise<{ started: boolean }> {
  const res = await fetch(`${BASE}/scan`, { method: "POST" });
  return res.json();
}

export async function triggerReset(): Promise<{ started: boolean }> {
  const res = await fetch(`${BASE}/reset`, { method: "POST" });
  return res.json();
}

/** 订阅扫描进度（SSE），用于驱动采集流程动画 */
export function subscribeScan(cb: (p: ScanProgress) => void): () => void {
  const es = new EventSource(`${BASE}/scan/stream`);
  es.addEventListener("progress", (e) => {
    try {
      cb(JSON.parse((e as MessageEvent).data));
    } catch {
      /* ignore */
    }
  });
  return () => es.close();
}