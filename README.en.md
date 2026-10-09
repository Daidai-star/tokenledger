# TokenLedger

**Your Claude Code and Codex bill gives you one number. TokenLedger reads the log
files your tools already write and shows you which project the money went to, and
how much extra the cache cold start cost you. No network calls, no upload.**

Works with **Codex**, **Claude Code**, **OpenCode**, **DSH (DeepSeek Harness)** and
**Gemini CLI**. It reads whatever your tools already keep on disk — it is not tied
to one vendor.

[中文说明](README.md)

![overview](docs/overview.png)

## Where the money went

Projects aggregated by working directory. Paths stay local — the interface only
shows the last two segments, so company names and private repo names never end up
in a screenshot.

![Projects](docs/assets/projects.gif)

## Session churn is what makes cache bills expensive

The first request in a session has nothing cached to read, so it is billed at the
full input price. Grouping by request index within a session shows the curve as it
climbs, and the first request's blended price gives a defensible estimate of that
"cold start premium".

Measured on my own machine: 52.0% on request 1, 79.6% on request 2, 86.7% by
request 6. Across 432 sessions the cold start premium totals $8.44. Keeping one
context inside one session is a lot cheaper than re-feeding it every time.

![Cold start](docs/assets/coldstart.gif)

## What the money could buy

The accumulated API-equivalent bill, folded into real objects — 15 items across six
orders of magnitude. Computed entirely on your machine, works offline.

"Share this bill" renders a PNG locally; "Copy caption" gives you the text to
paste. Whether you post it is your call.

![Share card](docs/assets/share-card.jpg)

## Install

**Desktop app** (recommended, no Node needed): grab a build from
[Releases](https://github.com/Daidai-star/tokenledger/releases).

| Platform | Asset | Notes |
| --- | --- | --- |
| macOS (Apple Silicon) | `.dmg` | Unsigned — allow it once in System Settings → Privacy & Security |
| macOS (Intel) | `.dmg` | Same |
| Windows (x64) | `.msi` / `.exe` | NSIS installer, per-user, no admin needed |

**Run it yourself** (needs Node.js ≥ 24 for the built-in `node:sqlite` and the zstd
in `node:zlib`):

```bash
npm install
npm run build      # build the frontend
npm start          # start the server (first run scans automatically)
# open http://127.0.0.1:8787
```

## What it reads

Every tool writes session files locally, and those files contain every token and
every model call. TokenLedger reads them and nothing else — no network requests,
no telemetry, no upload. The database stays on your machine.

| Tool | Source | Metrics |
| --- | --- | --- |
| Codex | `~/.codex/sessions/**/rollout-*.jsonl` + `.jsonl.zst` | token deltas, model, cwd, originator |
| Claude Code | `~/.claude/projects/**/*.jsonl` | assistant message usage (input/output/cache) |
| OpenCode | `~/.local/share/opencode/opencode.db` | assistant message tokens/cost/model |
| DSH | `~/.dsh/sessions/**/session.v4.jsonl.zstd` | assistant/message usage, provider, model |
| Gemini CLI | `~/.gemini/tmp/**/*.json` | usageTokens |

Normalisation worth knowing about: `inputTokens` always means **fresh** input.
Codex reports `input_tokens` including `cached_input_tokens`, so the collector
subtracts to avoid double-billing downstream. And `total` counts cache reads —
otherwise a high-cache-hit tool like Codex would look far cheaper than it is.

## Cost estimates

When the log carries its own cost (OpenCode does), it is used as-is. Otherwise
tokens are priced per `USD / 1M tokens` from `~/.cc-switch/model-pricing.json`
first, then a built-in table with family fallback for gateway-specific names.
Every row records its `cost_source`, and the interface says which is which:

```
reported        from the log itself
cc-switch       local price table hit
builtin         exact hit in the built-in table
builtin~est     family estimate (uncertain)
unknown         no price found — counted as 0 and flagged in the UI
```

**These are estimates.** If you are on a subscription, the number shown is the
API-equivalent cost of your usage, not what you were actually charged.

## Under the hood

- Zero runtime dependencies. SQLite via `node:sqlite`, zstd via `node:zlib`,
  HTTP via `node:http`.
- Incremental scans: byte-offset cursors per file, committed only after the batch
  lands, so a crash mid-scan never loses data and a re-run fills the gap.
- Codex compresses older sessions to `.jsonl.zst` (single frame, streamed) and DSH
  writes multi-frame zstd — different paths, both handled. Only reading `.jsonl`
  misses most of the history (8.4B tokens on my machine).
- Tauri is only a shell: pick a free port, spawn the bundled Node, poll
  `/api/health`, open the WebView. 37.9 MB DMG vs ~85 MB for Electron.

## Privacy

Read-only on local logs. **No network requests, no data uploaded.** The desktop app
binds the backend to a random port on `127.0.0.1` and listens on nothing else.

There is deliberately no leaderboard. Coding agent logs are far more sensitive than
ordinary usage stats: `cwd` often contains company or project names, and an
uploaded time series is enough to infer working hours. Project breakdown is
therefore local-only, paths are truncated to two segments, and share cards never
include that dimension.

## License

[MIT](LICENSE) © 2026 Daidai-star

## Data storage

CLI mode: `~/.tokenledger/tokenledger.db` (SQLite, WAL). Delete the file to reset;
set `TOKENLEDGER_DATA` to move it. The desktop app uses Tauri's app data directory.
