import { html, raw } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";
import type {
  CallRecord,
  LoadedWorkflow,
  LogRecord,
  RunRecord,
  StepRecord,
} from "../core/types.ts";

const CSS = `
:root{--bg:#0d1117;--panel:#161b22;--border:#30363d;--fg:#e6edf3;--muted:#8b949e;
--green:#3fb950;--red:#f85149;--yellow:#d29922;--blue:#58a6ff;--mono:ui-monospace,SFMono-Regular,Menlo,monospace}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}
a{color:var(--blue);text-decoration:none}a:hover{text-decoration:underline}
.wrap{max-width:1080px;margin:0 auto;padding:24px 20px 64px}
header{display:flex;align-items:baseline;gap:14px;flex-wrap:wrap;margin-bottom:24px}
h1{font-size:17px;margin:0;letter-spacing:-.01em}
h2{font-size:13px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin:28px 0 10px}
.crumb{color:var(--muted);font-size:13px}
.card{background:var(--panel);border:1px solid var(--border);border-radius:8px;overflow:hidden}
table{width:100%;border-collapse:collapse}
th{text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);
padding:9px 14px;border-bottom:1px solid var(--border);font-weight:600}
td{padding:10px 14px;border-bottom:1px solid var(--border);vertical-align:top}
tr:last-child td{border-bottom:none}
tr:hover td{background:#1c2129}
.mono{font-family:var(--mono);font-size:12px}
.muted{color:var(--muted)}
.pill{display:inline-block;padding:1px 8px;border-radius:20px;font-size:11px;font-weight:600;
border:1px solid currentColor;white-space:nowrap}
.success{color:var(--green)}.failed{color:var(--red)}.running{color:var(--blue)}.skipped{color:var(--muted)}
.disabled{opacity:.45}
.btn{display:inline-block;background:#21262d;border:1px solid var(--border);color:var(--fg);
padding:4px 11px;border-radius:6px;font-size:12px;cursor:pointer;font-family:inherit}
.btn:hover{background:#30363d}
.logs{font-family:var(--mono);font-size:12px;padding:0}
.logline{display:grid;grid-template-columns:76px 48px 1fr;gap:12px;padding:4px 14px;border-bottom:1px solid #21262d}
.logline:last-child{border-bottom:none}
.logline pre{margin:2px 0 0;white-space:pre-wrap;word-break:break-word;color:var(--muted)}
.err{background:#1c1416;border:1px solid #5c2b2b;border-radius:8px;padding:12px 14px;
font-family:var(--mono);font-size:12px;color:#ff9a94;white-space:pre-wrap;word-break:break-word}
.empty{padding:28px 14px;text-align:center;color:var(--muted)}
details{border-bottom:1px solid #21262d}details:last-child{border-bottom:none}
summary{padding:9px 14px;cursor:pointer;display:flex;gap:12px;align-items:baseline;list-style:none}
summary::-webkit-details-marker{display:none}
summary::before{content:"▸";color:var(--muted);font-size:10px;width:9px;flex:none}
details[open]>summary::before{content:"▾"}
summary:hover{background:#1c2129}
.payload{padding:0 14px 12px 35px;display:grid;gap:8px}
.payload h4{margin:0;font-size:10px;text-transform:uppercase;letter-spacing:.07em;color:var(--muted);font-weight:600}
.payload pre{margin:0;background:#0d1117;border:1px solid var(--border);border-radius:6px;
padding:9px 11px;overflow-x:auto;font-family:var(--mono);font-size:11.5px;max-height:320px}
.tag{font-size:10px;padding:1px 6px;border-radius:4px;background:#21262d;color:var(--muted)}
.bar{display:flex;gap:8px;align-items:center;margin:16px 0 0}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}
.stat{background:var(--panel);border:1px solid var(--border);border-radius:8px;padding:12px 14px}
.stat b{display:block;font-size:20px;font-weight:600;margin-bottom:1px}
.stat span{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}
`;

function layout(title: string, refresh: number | null, body: HtmlEscapedString | Promise<HtmlEscapedString>) {
  return html`<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} · automator</title>
${refresh ? raw(`<meta http-equiv="refresh" content="${refresh}">`) : ""}
<style>${raw(CSS)}</style>
</head><body><div class="wrap">
<header><h1><a href="/">automator</a></h1><span class="crumb">${title}</span></header>
${body}
</div></body></html>`;
}

const fmt = (ts: number | null) =>
  ts ? new Date(ts).toISOString().replace("T", " ").slice(0, 19) : "—";

const dur = (ms: number | null) =>
  ms === null ? "—" : ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;

const statusPill = (s: string) => html`<span class="pill ${s}">${s}</span>`;

const triggerLabel = (wf: LoadedWorkflow) =>
  wf.trigger.kind === "cron"
    ? `cron · ${wf.trigger.expression}`
    : wf.trigger.kind === "poll"
      ? `poll · ${wf.trigger.expression}`
      : wf.trigger.kind === "webhook"
        ? `${wf.trigger.method ?? "POST"} /hooks/${wf.trigger.path}`
        : "manual";

/* ------------------------------------------------------------------ index */

export function indexPage(
  workflows: LoadedWorkflow[],
  nextRun: (name: string) => Date | null,
  runs: RunRecord[],
) {
  const failed24h = runs.filter(
    (r) => r.status === "failed" && r.started_at > Date.now() - 86_400_000,
  ).length;

  return layout(
    "overview",
    15,
    html`
      <div class="grid">
        <div class="stat"><b>${workflows.filter((w) => w.enabled !== false).length}</b><span>active workflows</span></div>
        <div class="stat"><b>${runs.length}</b><span>recent runs</span></div>
        <div class="stat"><b class="${failed24h ? "failed" : ""}">${failed24h}</b><span>failed · 24h</span></div>
      </div>

      <h2>Workflows</h2>
      <div class="card">
        <table>
          <thead><tr><th>Name</th><th>Trigger</th><th>Next</th><th>File</th><th></th></tr></thead>
          <tbody>
            ${workflows.length === 0
              ? html`<tr><td colspan="5" class="empty">No workflows found in ./workflows</td></tr>`
              : workflows.map(
                  (w) => html`
                    <tr class="${w.enabled === false ? "disabled" : ""}">
                      <td><a href="/workflows/${w.name}"><b>${w.name}</b></a>
                        ${w.description ? html`<div class="muted">${w.description}</div>` : ""}</td>
                      <td class="mono">${triggerLabel(w)}</td>
                      <td class="mono muted">${nextRun(w.name)?.toISOString().replace("T", " ").slice(0, 19) ?? "—"}</td>
                      <td class="mono muted">${w.file}</td>
                      <td>
                        <form method="post" action="/workflows/${w.name}/run">
                          <button class="btn" type="submit">Run</button>
                        </form>
                      </td>
                    </tr>
                  `,
                )}
          </tbody>
        </table>
      </div>

      <h2>Recent runs</h2>
      ${runsTable(runs)}
    `,
  );
}

/* --------------------------------------------------------------- workflow */

export function workflowPage(
  wf: LoadedWorkflow,
  next: Date | null,
  stats: { total: number; succeeded: number; failed: number },
  runs: RunRecord[],
) {
  return layout(
    wf.name,
    15,
    html`
      <div class="grid">
        <div class="stat"><b>${stats.total ?? 0}</b><span>total runs</span></div>
        <div class="stat"><b class="success">${stats.succeeded ?? 0}</b><span>succeeded</span></div>
        <div class="stat"><b class="${stats.failed ? "failed" : ""}">${stats.failed ?? 0}</b><span>failed</span></div>
      </div>

      <h2>Definition</h2>
      <div class="card"><table><tbody>
        <tr><td class="muted">trigger</td><td class="mono">${triggerLabel(wf)}</td></tr>
        <tr><td class="muted">next run</td><td class="mono">${next?.toISOString().replace("T", " ").slice(0, 19) ?? "—"}</td></tr>
        <tr><td class="muted">retries</td><td class="mono">${wf.retries ?? 2}</td></tr>
        <tr><td class="muted">timeout</td><td class="mono">${dur(wf.timeoutMs ?? 300_000)}</td></tr>
        <tr><td class="muted">on overlap</td><td class="mono">${wf.onOverlap ?? "skip"}</td></tr>
        <tr><td class="muted">file</td><td class="mono">workflows/${wf.file}</td></tr>
      </tbody></table></div>

      <h2>Runs</h2>
      ${runsTable(runs, false)}
    `,
  );
}

/* -------------------------------------------------------------------- run */

export function runPage(
  run: RunRecord,
  logs: LogRecord[],
  steps: StepRecord[],
  calls: CallRecord[],
) {
  return layout(
    `run ${run.id.slice(0, 8)}`,
    run.status === "running" ? 5 : null,
    html`
      <div class="card"><table><tbody>
        <tr><td class="muted">workflow</td><td><a href="/workflows/${run.workflow}">${run.workflow}</a></td></tr>
        <tr><td class="muted">status</td><td>${statusPill(run.status)}</td></tr>
        <tr><td class="muted">trigger</td><td class="mono">${run.trigger}</td></tr>
        <tr><td class="muted">attempts</td><td class="mono">${run.attempts}</td></tr>
        <tr><td class="muted">started</td><td class="mono">${fmt(run.started_at)}</td></tr>
        <tr><td class="muted">duration</td><td class="mono">${dur(run.duration_ms)}</td></tr>
        <tr><td class="muted">id</td><td class="mono muted">${run.id}</td></tr>
      </tbody></table></div>

      ${run.resumed_from
        ? html`<p class="muted" style="margin:10px 0 0">
            Resumed from <a href="/runs/${run.resumed_from}">${run.resumed_from.slice(0, 8)}</a> —
            steps that already succeeded were reused.</p>`
        : ""}

      ${run.replayed_from
        ? html`<p class="muted" style="margin:10px 0 0">
            Replay of <a href="/runs/${run.replayed_from}">${run.replayed_from.slice(0, 8)}</a> —
            same input, every step re-run from scratch.</p>`
        : ""}

      ${run.status === "failed"
        ? html`<div class="bar">
            <form method="post" action="/runs/${run.id}/resume">
              <button class="btn" type="submit">Resume from last good step</button>
            </form>
            <span class="muted">Re-runs the workflow, skipping every step that already succeeded.</span>
          </div>`
        : ""}

      ${run.input
        ? html`<div class="bar">
            <form method="post" action="/runs/${run.id}/replay">
              <button class="btn" type="submit">Replay with this input</button>
            </form>
            <span class="muted">Starts a fresh run with the same input — no steps reused.</span>
          </div>`
        : ""}

      ${run.input
        ? html`<h2>Input</h2><div class="card"><div class="logs" style="padding:12px 14px"><pre style="margin:0;white-space:pre-wrap">${pretty(run.input)}</pre></div></div>`
        : ""}

      ${run.error ? html`<h2>Error</h2><div class="err">${run.error}</div>` : ""}
      ${run.result && run.result !== "null"
        ? html`<h2>Result</h2><div class="card"><div class="logs" style="padding:12px 14px"><pre style="margin:0;white-space:pre-wrap">${pretty(run.result)}</pre></div></div>`
        : ""}

      ${steps.length
        ? html`<h2>Steps</h2>
            <div class="card">
              ${steps.map(
                (st) => html`
                  <details>
                    <summary>
                      <span class="${st.status === "ok" ? "success" : "failed"}">${st.status === "ok" ? "✓" : "✗"}</span>
                      <b style="flex:1">${st.name}</b>
                      ${st.run_id !== run.id ? html`<span class="tag">reused</span>` : ""}
                      ${st.truncated ? html`<span class="tag">truncated</span>` : ""}
                      <span class="mono muted">${dur(st.duration_ms)}</span>
                    </summary>
                    <div class="payload">
                      ${st.input
                        ? html`<div><h4>Input</h4><pre>${pretty(st.input)}</pre></div>`
                        : ""}
                      ${st.output
                        ? html`<div><h4>Output</h4><pre>${pretty(st.output)}</pre></div>`
                        : ""}
                      ${st.error ? html`<div><h4>Error</h4><pre>${st.error}</pre></div>` : ""}
                      ${!st.input && !st.output && !st.error
                        ? html`<span class="muted">Nothing captured</span>`
                        : ""}
                    </div>
                  </details>
                `,
              )}
            </div>`
        : ""}

      ${calls.length
        ? html`<h2>HTTP calls</h2>
            <div class="card">
              ${calls.map(
                (call) => html`
                  <details>
                    <summary>
                      <span class="mono ${call.status && call.status < 400 ? "success" : "failed"}"
                        >${call.status ?? "ERR"}</span>
                      <span class="mono" style="flex:1;word-break:break-all"
                        >${call.method} ${call.url}</span>
                      <span class="mono muted">${dur(call.duration_ms)}</span>
                    </summary>
                    <div class="payload">
                      ${call.request
                        ? html`<div><h4>Request</h4><pre>${pretty(call.request)}</pre></div>`
                        : ""}
                      ${call.response
                        ? html`<div><h4>Response</h4><pre>${pretty(call.response)}</pre></div>`
                        : ""}
                    </div>
                  </details>
                `,
              )}
            </div>`
        : ""}

      <h2>Logs</h2>
      <div class="card logs">
        ${logs.length === 0
          ? html`<div class="empty">No log lines</div>`
          : logs.map(
              (l) => html`
                <div class="logline">
                  <span class="muted">${new Date(l.ts).toISOString().slice(11, 23)}</span>
                  <span class="${l.level === "error" ? "failed" : l.level === "warn" ? "" : "muted"}"
                        style="${l.level === "warn" ? "color:var(--yellow)" : ""}">${l.level}</span>
                  <span>${l.msg}${l.data ? html`<pre>${pretty(l.data)}</pre>` : ""}</span>
                </div>
              `,
            )}
      </div>
    `,
  );
}

/* ---------------------------------------------------------------- helpers */

function runsTable(runs: RunRecord[], showWorkflow = true) {
  return html`
    <div class="card">
      <table>
        <thead><tr>
          ${showWorkflow ? html`<th>Workflow</th>` : ""}
          <th>Status</th><th>Trigger</th><th>Started</th><th>Duration</th><th>Detail</th>
        </tr></thead>
        <tbody>
          ${runs.length === 0
            ? html`<tr><td colspan="6" class="empty">Nothing has run yet</td></tr>`
            : runs.map(
                (r) => html`
                  <tr>
                    ${showWorkflow
                      ? html`<td><a href="/workflows/${r.workflow}">${r.workflow}</a></td>`
                      : ""}
                    <td>${statusPill(r.status)}</td>
                    <td class="mono muted">${r.trigger}</td>
                    <td class="mono muted">${fmt(r.started_at)}</td>
                    <td class="mono">${dur(r.duration_ms)}</td>
                    <td class="mono">
                      <a href="/runs/${r.id}">${r.id.slice(0, 8)}</a>
                      ${r.error ? html`<span class="failed"> · ${r.error.slice(0, 60)}</span>` : ""}
                    </td>
                  </tr>
                `,
              )}
        </tbody>
      </table>
    </div>
  `;
}

function pretty(json: string): string {
  try {
    return JSON.stringify(JSON.parse(json), null, 2);
  } catch {
    return json;
  }
}
