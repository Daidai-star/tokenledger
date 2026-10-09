/**
 * 扫描编排器。
 *
 * 职责：
 *  1. 给每个 collector 构造扫描上下文（游标读写、成本计算、进度回调、会话写入）
 *  2. 串行执行采集（避免同时打爆磁盘），事件分批入库
 *  3. 结束后重建日聚合表
 *  4. 通过事件总线把进度推给前端，驱动采集流程动画
 */

import { EventEmitter } from "node:events";
import fs from "node:fs";
import { PricingTable } from "./pricing.js";
import { ALL, detectInstalled } from "./collectors/index.js";

export class Scanner extends EventEmitter {
  constructor(store) {
    super();
    this.store = store;
    this.pricing = PricingTable.load();
    this.running = false;
    this.lastProgress = null;
  }

  /** 当前运行进度（前端轮询或 SSE 用） */
  progress() {
    return {
      running: this.running,
      pricingSource: this.pricing.source,
      ...(this.lastProgress || { stage: "idle", percent: 0 }),
    };
  }

  /**
   * 完整扫描。
   * @param {object} opts { tools?: string[], onProgress?: fn }
   */
  async run(opts = {}) {
    if (this.running) throw new Error("scan already running");
    this.running = true;
    // 开跑瞬间先推一帧，前端立刻进入采集中状态（否则首帧要到首个文件解析完才来）
    this.emit("progress", {
      running: true,
      stage: "scanning",
      percent: 0,
      tool: null,
      filesSeen: 0,
      filesParsed: 0,
      events: 0,
    });
    opts.onProgress?.({
      running: true,
      stage: "scanning",
      percent: 0,
      filesSeen: 0,
      filesParsed: 0,
      events: 0,
    });

    const tools = opts.tools?.length ? opts.tools : ALL.map((c) => c.id);
    const collectors = ALL.filter((c) => tools.includes(c.id));
    const runId = this.store.startScan();
    // running 字段必须带上：前端靠它切「采集中」状态与动画
    const emit = (payload) => {
      const full = { running: true, ...payload };
      this.lastProgress = full;
      this.emit("progress", full);
      opts.onProgress?.(full);
    };
    const finish = (payload) => {
      const full = { running: false, ...payload };
      this.lastProgress = full;
      this.emit("progress", full);
      opts.onProgress?.(full);
    };

    let eventsNew = 0;
    let filesSeen = 0;
    let filesParsed = 0;

    emit({ stage: "scanning", percent: 0, tool: null, filesSeen: 0, filesParsed: 0, events: 0 });

    try {
      for (let i = 0; i < collectors.length; i++) {
        const c = collectors[i];
        const base = (i / collectors.length) * 100;
        const span = 100 / collectors.length;

        emit({
          stage: "scanning",
          percent: base,
          tool: c.id,
          toolName: c.name,
          filesSeen,
          filesParsed,
          events: eventsNew,
        });

        const events = [];
        const sessions = [];
        const roots = Object.fromEntries(collectors.map((x) => [x.id, x.roots[0]]));

        // 游标先攒着，等事件真正落盘后再提交。
        // 否则进程在中途被杀时会出现「游标已推进、数据还在内存里」的窗口，
        // 重启后这些文件被当成未变更跳过，事件就永久丢了。
        let pendingCursors = [];

        const ctx = {
          roots,
          cursor: (source, file) => {
            const cur = this.store.getCursor(source, file);
            if (!cur) return { byteOffset: 0, lineNo: 0, size: 0, mtime: 0, reset: true };
            // 文件大小变化（追加）时不 reset；变小说明被截断
            const st = safeStat(file);
            const reset = st ? cur.file_size > st.size : false;
            return {
              byteOffset: cur.byte_offset,
              lineNo: cur.line_no,
              size: cur.file_size,
              mtime: cur.file_mtime,
              reset,
            };
          },
          advance: (source, file, res) => {
            pendingCursors.push({ source, file, res });
          },
          session: (s) => sessions.push(s),
          emitProgress: (tool, evCount, parsed, total) => {
            const pct = base + (total ? (parsed / total) * span : span);
            emit({
              stage: "scanning",
              percent: Math.min(99, pct),
              tool,
              filesSeen: filesSeen + total,
              filesParsed: filesParsed + parsed,
              events: eventsNew + evCount,
              toolProgress: total ? parsed / total : 1,
            });
          },
        };

        let result;
        try {
          result = await c.scan(ctx);
        } catch (err) {
          // 工具出错：丢弃游标，下次会从头重读（event_id 幂等，不会重复计数）
          pendingCursors = [];
          emit({ stage: "tool-error", percent: base, tool: c.id, error: String(err?.message || err) });
          continue;
        }

        filesSeen += result.stats?.filesSeen || 0;
        filesParsed += result.stats?.filesParsed || 0;

        if (result.events?.length) {
          // 成本计算：日志自带优先，否则查价目表
          for (const ev of result.events) {
            const p = this.pricing.price(ev);
            ev.costUsd = p.usd;
            ev.costSource = p.source;
          }
          emit({
            stage: "storing",
            percent: base + span * 0.9,
            tool: c.id,
            filesSeen,
            filesParsed,
            events: eventsNew + result.events.length,
          });
          eventsNew += this.store.insertEvents(result.events);
        }

        // 数据已落盘，现在才提交游标
        this.#commitCursors(pendingCursors);
        pendingCursors = [];

        for (const s of sessions) this.store.upsertSession(s);
      }

      emit({ stage: "aggregating", percent: 97, filesSeen, filesParsed, events: eventsNew });
      this.store.rebuildRollups();
      finish({ stage: "done", percent: 100, filesSeen, filesParsed, events: eventsNew });

      this.store.finishScan(runId, {
        filesSeen,
        filesParsed,
        eventsNew,
        status: "ok",
      });
      return { filesSeen, filesParsed, eventsNew };
    } catch (err) {
      this.store.finishScan(runId, {
        filesSeen,
        filesParsed,
        eventsNew,
        status: "error",
        error: String(err?.message || err),
      });
      finish({ stage: "error", percent: 100, error: String(err?.message || err) });
      throw err;
    } finally {
      this.running = false;
    }
  }

  /** 批量写入游标。事件落盘之后才调用。 */
  #commitCursors(list) {
    for (const { source, file, res } of list) {
      try {
        this.store.setCursor(source, file, {
          byteOffset: res.byteOffset,
          lineNo: res.lineNo,
          size: res.size,
          mtime: res.mtime,
        });
      } catch (err) {
        // 游标写失败只会导致下次重读该文件（幂等），不影响本次数据
        this.emit("progress", {
          running: true,
          stage: "storing",
          percent: 0,
          error: `游标写入失败 ${file}: ${String(err?.message || err)}`,
        });
      }
    }
  }

  /** 清空数据后全量重扫（游标一起清，否则会跳过文件导致采不到数据） */
  async reset(opts = {}) {
    if (this.running) throw new Error("scan already running");
    // 在 run() 推第一帧之前清理，保证前端看到的是完整的一次扫描
    this.store.db.exec("DELETE FROM usage_events");
    this.store.db.exec("DELETE FROM sessions");
    this.store.db.exec("DELETE FROM file_cursors");
    this.store.db.exec("DELETE FROM daily_rollups");
    return this.run(opts);
  }

  tools() {
    return detectInstalled();
  }
}

function safeStat(file) {
  try {
    return fs.statSync(file);
  } catch {
    return null;
  }
}