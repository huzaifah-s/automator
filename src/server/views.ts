import { html, raw } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";
import type {
  CallRecord,
  LoadedWorkflow,
  LogRecord,
  RunRecord,
  RunStatus,
  StepRecord,
  WorkflowVersion,
} from "../core/types.ts";

/**
 * One entry in a workflow's health strip — the last handful of its runs, as
 * returned by `store.recentRunsPerWorkflow()`.
 */
export interface RunPulse {
  workflow: string;
  status: RunStatus;
  started_at: number;
  duration_ms: number | null;
  id: string;
}

/**
 * Everything the dashboard renders with. No CSS framework, no client
 * framework, no build step: this file is the whole front end, it is inlined
 * into every response, and it stays a few kilobytes. A CDN stylesheet would
 * also mean the dashboard stops looking like itself the moment the box it runs
 * on has no outbound network — which is exactly the box this tends to run on.
 */
const CSS = `
:root{
--bg:#0b0d12;--panel:#12151d;--panel-2:#181c26;--sunk:#0d1017;
--border:#232936;--border-soft:#1b202b;
--fg:#e7ebf3;--muted:#8d95a8;--faint:#5b6273;
--accent:#6ea8ff;--accent-soft:#182640;
--green:#43c162;--red:#ff6b62;--yellow:#e0a83a;
--mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;
--sans:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
@media (prefers-color-scheme:light){:root{
--bg:#f6f7f9;--panel:#fff;--panel-2:#f3f5f8;--sunk:#f7f9fb;
--border:#e2e6ee;--border-soft:#edf0f5;
--fg:#161a22;--muted:#5f6878;--faint:#8b93a2;
--accent:#1f6feb;--accent-soft:#e9f1ff;
--green:#1a7f37;--red:#cf222e;--yellow:#9a6700}}
*{box-sizing:border-box}
[hidden]{display:none!important}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.55 var(--sans);
-webkit-font-smoothing:antialiased}
a{color:var(--accent);text-decoration:none}
a:hover{text-decoration:underline}
.wrap{max-width:1120px;margin:0 auto;padding:0 20px 72px}

/* ---- shell ---- */
.top{position:sticky;top:0;z-index:9;background:var(--bg);
border-bottom:1px solid var(--border);margin:0 -20px 22px;padding:0 20px}
.topbar{display:flex;align-items:center;gap:16px;height:52px}
.brand{display:flex;align-items:center;gap:8px;color:var(--fg);font-weight:600;
letter-spacing:-.01em;font-size:15px}
.brand:hover{text-decoration:none}
.mark{width:20px;height:20px;border-radius:6px;display:grid;place-items:center;
background:var(--accent);color:#fff;font-size:11px;font-weight:700}
.tabs{display:flex;gap:2px;margin-left:6px}
.tab{display:flex;align-items:center;gap:7px;padding:6px 12px;border-radius:7px;
color:var(--muted);font-weight:500;font-size:13.5px}
.tab:hover{background:var(--panel-2);color:var(--fg);text-decoration:none}
.tab[aria-current]{background:var(--accent-soft);color:var(--accent)}
.tab .n{font-size:11px;font-variant-numeric:tabular-nums;padding:0 6px;border-radius:20px;
background:var(--panel-2);color:var(--muted);line-height:17px}
.tab[aria-current] .n{background:var(--accent);color:#fff}
.tab .n.bad{background:var(--red);color:#fff}
.grow{flex:1}
.crumb{display:flex;align-items:center;gap:7px;color:var(--muted);font-size:13px;
min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.crumb b{color:var(--fg);font-weight:600}

/* ---- stats ---- */
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin-bottom:20px}
.stat{background:var(--panel);border:1px solid var(--border);border-radius:10px;padding:12px 14px}
.stat b{display:block;font-size:21px;font-weight:600;letter-spacing:-.02em;
font-variant-numeric:tabular-nums;line-height:1.25}
.stat span{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}

/* ---- panels ---- */
.card{background:var(--panel);border:1px solid var(--border);border-radius:10px;overflow:hidden}
h2{font-size:11.5px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);
margin:26px 0 10px;font-weight:600}
.toolbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:12px}
input[type=search],select{background:var(--panel);border:1px solid var(--border);color:var(--fg);
border-radius:8px;padding:7px 11px;font:13px var(--sans);min-width:0}
input[type=search]{flex:1;max-width:320px}
input[type=search]:focus,select:focus{outline:none;border-color:var(--accent)}
.chip{padding:6px 11px;border-radius:8px;border:1px solid var(--border);background:var(--panel);
color:var(--muted);font-size:12.5px;white-space:nowrap}
.chip:hover{color:var(--fg);text-decoration:none;background:var(--panel-2)}
.chip[aria-current]{border-color:var(--accent);color:var(--accent);background:var(--accent-soft)}

/* ---- folders ---- */
.folder{background:var(--panel);border:1px solid var(--border);border-radius:10px;
overflow:hidden;margin-bottom:10px}
.folder>summary{display:flex;align-items:center;gap:9px;padding:10px 14px;cursor:pointer;
list-style:none;background:var(--panel-2)}
.folder>summary::-webkit-details-marker{display:none}
.folder>summary::after{content:"";width:6px;height:6px;border-right:1.6px solid var(--faint);
border-bottom:1.6px solid var(--faint);transform:rotate(-45deg);margin-left:2px;transition:transform .15s}
.folder[open]>summary::after{transform:rotate(45deg)}
.folder svg{color:var(--faint);flex:none}
.fname{font-family:var(--mono);font-size:12.5px;letter-spacing:-.01em}
.fname i{color:var(--faint);font-style:normal}

/* ---- rows ---- */
.row{display:grid;align-items:center;gap:14px;padding:11px 14px;border-top:1px solid var(--border-soft)}
.wf{grid-template-columns:minmax(0,1fr) 158px 92px 84px 84px 40px}
.ex{grid-template-columns:minmax(0,1fr) 92px 84px 104px 72px 90px}
.row.head{padding:7px 14px;border-top:none;font-size:10.5px;text-transform:uppercase;
letter-spacing:.07em;color:var(--faint);font-weight:600;background:var(--sunk)}
.folder .row.head{background:transparent;border-top:1px solid var(--border-soft)}
.card>.row:first-child{border-top:none}
.row:hover:not(.head){background:var(--panel-2)}
.name{display:flex;align-items:center;gap:8px;min-width:0}
.name b{font-weight:600;letter-spacing:-.01em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.desc{color:var(--muted);font-size:12.5px;margin-top:1px;overflow:hidden;
text-overflow:ellipsis;white-space:nowrap}
.off{opacity:.5}
.dot{width:7px;height:7px;border-radius:50%;flex:none;background:var(--faint)}
.dot.success{background:var(--green)}.dot.failed{background:var(--red)}
.dot.running{background:var(--accent);animation:pulse 1.4s ease-in-out infinite}
.dot.skipped{background:var(--yellow)}
@keyframes pulse{50%{opacity:.25}}
.mono{font-family:var(--mono);font-size:12px}
.muted{color:var(--muted)}
.trunc{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pill{display:inline-block;padding:1px 8px;border-radius:20px;font-size:11px;font-weight:600;
border:1px solid currentColor;white-space:nowrap;text-transform:lowercase}
.success{color:var(--green)}.failed{color:var(--red)}.running{color:var(--accent)}
.skipped{color:var(--yellow)}
.tag{font-size:10px;padding:1px 6px;border-radius:5px;background:var(--panel-2);
border:1px solid var(--border);color:var(--muted);white-space:nowrap}

/* ---- health strip ---- */
.spark{display:flex;gap:2px;align-items:flex-end;height:16px}
.spark i{width:4px;border-radius:1.5px;background:var(--faint);opacity:.85}
.spark i.success{background:var(--green)}.spark i.failed{background:var(--red)}
.spark i.running{background:var(--accent)}.spark i.skipped{background:var(--yellow)}

/* ---- controls ---- */
.btn{display:inline-flex;align-items:center;gap:6px;background:var(--panel-2);
border:1px solid var(--border);color:var(--fg);padding:5px 11px;border-radius:7px;
font:12px/1.4 var(--sans);cursor:pointer}
.btn:hover{border-color:var(--accent);color:var(--accent)}
.btn.icon{padding:5px 7px}
.bar{display:flex;gap:10px;align-items:center;margin-top:14px;flex-wrap:wrap}

/* ---- detail pages ---- */
table{width:100%;border-collapse:collapse}
th{text-align:left;font-size:10.5px;text-transform:uppercase;letter-spacing:.07em;
color:var(--faint);padding:8px 14px;border-bottom:1px solid var(--border);font-weight:600}
td{padding:9px 14px;border-bottom:1px solid var(--border-soft);vertical-align:top}
tr:last-child td{border-bottom:none}
.kv td:first-child{width:120px;color:var(--muted)}
.logs{font-family:var(--mono);font-size:12px;padding:0}
.logline{display:grid;grid-template-columns:78px 46px 1fr;gap:12px;padding:4px 14px;
border-bottom:1px solid var(--border-soft)}
.logline:last-child{border-bottom:none}
.logline pre{margin:2px 0 0;white-space:pre-wrap;word-break:break-word;color:var(--muted)}
.err{background:color-mix(in srgb,var(--red) 9%,var(--panel));border:1px solid
color-mix(in srgb,var(--red) 35%,var(--border));border-radius:10px;padding:12px 14px;
font-family:var(--mono);font-size:12px;color:var(--red);white-space:pre-wrap;word-break:break-word}
.empty{padding:34px 14px;text-align:center;color:var(--muted)}
.empty b{display:block;color:var(--fg);margin-bottom:3px}
details.item{border-top:1px solid var(--border-soft)}
.card>details.item:first-child{border-top:none}
details.item>summary{padding:9px 14px;cursor:pointer;display:flex;gap:11px;align-items:baseline;
list-style:none}
details.item>summary::-webkit-details-marker{display:none}
details.item>summary::before{content:"\\25B8";color:var(--faint);font-size:10px;width:9px;flex:none}
details.item[open]>summary::before{content:"\\25BE"}
details.item>summary:hover{background:var(--panel-2)}
.payload{padding:0 14px 12px 34px;display:grid;gap:8px}
.payload h4{margin:0;font-size:10px;text-transform:uppercase;letter-spacing:.07em;
color:var(--faint);font-weight:600}
.payload pre,.blob{margin:0;background:var(--sunk);border:1px solid var(--border);border-radius:8px;
padding:10px 12px;overflow-x:auto;font-family:var(--mono);font-size:11.5px;max-height:340px;
white-space:pre-wrap;word-break:break-word}

@media(max-width:880px){
.wf{grid-template-columns:minmax(0,1fr) 92px 40px}
.ex{grid-template-columns:minmax(0,1fr) 92px 90px}
.hide-sm{display:none}
.stats{grid-template-columns:repeat(2,1fr)}
.brand span:last-child{display:none}}
`;

/**
 * The one script the dashboard ships. It refreshes the page by swapping
 * `.wrap` from a fetch, not by re-navigating.
 *
 * A `<meta http-equiv="refresh">` re-runs the whole navigation, which under
 * basic auth means re-running the credential exchange every few seconds — and
 * a browser that declines to reuse the credentials answers with a prompt and
 * an error page instead of the dashboard. A fetch carries the credentials the
 * page already has, and a failed one leaves what you were reading on screen.
 *
 * The interval is read back off `.wrap` after every swap, so a page that stops
 * asking to be refreshed — a run that has finished — stops being polled.
 *
 * Because the swap throws away the DOM, everything the user did to it by hand
 * lives outside that DOM: the filter text in a closure, the collapsed folders
 * in localStorage. Both are re-applied to the replacement. Listeners are
 * delegated off `document` for the same reason.
 */
const SCRIPT = (seconds: number) => `
(() => {
  var query = "";
  var CLOSED = "automator:closed-folders";

  var closedSet = function () {
    try { return new Set(JSON.parse(localStorage.getItem(CLOSED) || "[]")); }
    catch (e) { return new Set(); }
  };

  var apply = function () {
    var box = document.getElementById("filter");
    if (box && box.value !== query) box.value = query;
    var needle = query.trim().toLowerCase();
    document.querySelectorAll("[data-search]").forEach(function (row) {
      row.hidden = needle !== "" && row.dataset.search.indexOf(needle) === -1;
    });
    var closed = closedSet();
    document.querySelectorAll("details[data-group]").forEach(function (group) {
      var rows = group.querySelectorAll("[data-search]");
      var shown = 0;
      rows.forEach(function (r) { if (!r.hidden) shown++; });
      group.hidden = rows.length > 0 && shown === 0;
      // A search opens the folders it matched in; otherwise the stored state wins.
      group.open = needle !== "" ? true : !closed.has(group.dataset.group);
      var badge = group.querySelector("[data-count]");
      if (badge) badge.textContent = shown === rows.length ? rows.length : shown + " / " + rows.length;
    });
    var none = document.getElementById("no-matches");
    if (none) none.hidden = needle === "" || document.querySelector("[data-search]:not([hidden])") !== null;
  };

  document.addEventListener("input", function (e) {
    if (!e.target || e.target.id !== "filter") return;
    query = e.target.value;
    apply();
  });

  document.addEventListener("change", function (e) {
    if (e.target && e.target.matches && e.target.matches("[data-autosubmit]")) e.target.form.submit();
  });

  // Persisted from the click and not from "toggle", because apply() opens and
  // closes folders itself — a search that opens every folder would otherwise
  // be indistinguishable from the user opening every folder, and would erase
  // what they had collapsed. A click on a summary is only ever the user, and
  // keyboard activation dispatches one too.
  document.addEventListener("click", function (e) {
    var summary = e.target.closest && e.target.closest("details[data-group] > summary");
    if (!summary) return;
    var d = summary.parentElement;
    var closed = closedSet();
    // The default action has not run yet, so "open" is still the old state.
    if (d.open) closed.add(d.dataset.group); else closed.delete(d.dataset.group);
    try { localStorage.setItem(CLOSED, JSON.stringify(Array.from(closed))); } catch (err) {}
  });

  apply();

  var tick = async function () {
    var el = document.querySelector(".wrap");
    var secs = el ? Number(el.dataset.poll || 0) : 0;
    if (!secs) return;
    var typing = document.activeElement && document.activeElement.id === "filter";
    if (!document.hidden && !typing) {
      try {
        var res = await fetch(location.href, { credentials: "same-origin" });
        if (res.ok) {
          var doc = new DOMParser().parseFromString(await res.text(), "text/html");
          var next = doc.querySelector(".wrap");
          if (next) { el.replaceWith(next); apply(); }
        }
      } catch (err) {}
    }
    setTimeout(tick, secs * 1000);
  };
  setTimeout(tick, ${seconds} * 1000);
})();`;

const ICON_FOLDER = raw(
  `<svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor" aria-hidden="true"><path d="M1.75 1A1.75 1.75 0 0 0 0 2.75v10.5C0 14.216.784 15 1.75 15h12.5A1.75 1.75 0 0 0 16 13.25v-8.5A1.75 1.75 0 0 0 14.25 3H7.5a.25.25 0 0 1-.2-.1l-.9-1.2A1.75 1.75 0 0 0 5 1H1.75Z"/></svg>`,
);
const ICON_HOME = raw(
  `<svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor" aria-hidden="true"><path d="M8 .5 15 6v9.5H9.75V10.5h-3.5V15.5H1V6L8 .5Z"/></svg>`,
);
const ICON_PLAY = raw(
  `<svg viewBox="0 0 16 16" width="11" height="11" fill="currentColor" aria-hidden="true"><path d="M4.6 3.1v9.8c0 .4.45.65.79.43l7.7-4.9a.5.5 0 0 0 0-.86l-7.7-4.9a.5.5 0 0 0-.79.43Z"/></svg>`,
);

type Tab = "workflows" | "executions" | null;

interface Shell {
  /** Browser title and, on detail pages, the breadcrumb next to the tabs. */
  title: string;
  tab: Tab;
  /** Seconds between background refreshes, or null to leave the page alone. */
  refresh?: number | null;
  /** Rendered next to the tabs on pages that are not a tab themselves. */
  crumb?: HtmlEscapedString | Promise<HtmlEscapedString> | null;
  /** Tab badges — kept out of the pages so every page can show them. */
  badges?: { workflows?: number | null; failed?: number | null };
}

function layout(shell: Shell, body: HtmlEscapedString | Promise<HtmlEscapedString>) {
  const { title, tab, refresh = null, crumb = null, badges = {} } = shell;
  return html`<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark light">
<title>${title} · automator</title>
<style>${raw(CSS)}</style>
</head><body><div class="wrap"${refresh ? raw(` data-poll="${refresh}"`) : ""}>
  <div class="top"><div class="topbar">
    <a class="brand" href="/"><span class="mark">A</span><span>automator</span></a>
    <nav class="tabs">
      <a class="tab" href="/" ${tab === "workflows" ? raw('aria-current="page"') : ""}>Workflows${
        badges.workflows != null ? html`<span class="n">${badges.workflows}</span>` : ""
      }</a>
      <a class="tab" href="/runs" ${tab === "executions" ? raw('aria-current="page"') : ""}>Executions${
        badges.failed ? html`<span class="n bad">${badges.failed}</span>` : ""
      }</a>
    </nav>
    <span class="grow"></span>
    ${crumb ?? ""}
  </div></div>
  ${body}
</div>
<script>${raw(SCRIPT(refresh ?? 0))}</script>
</body></html>`;
}

/**
 * The 401 body. Hono's basicAuth answers with `application/octet-stream`,
 * which a browser cannot render for a top-level navigation — dismissing the
 * prompt reads as a failed request rather than a refused one.
 */
export function unauthorizedPage() {
  return layout(
    { title: "Unauthorized", tab: null },
    html`<div class="card"><div class="empty">
      <b>Sign in required</b>
      These pages need the credentials in <code class="mono">DASHBOARD_USER</code> and
      <code class="mono">DASHBOARD_PASS</code>. Reload to be asked again.
    </div></div>`,
  );
}

/* ---------------------------------------------------------------- format */

/*
 * Casing rule, so it does not drift again: text this file *writes* is sentence
 * case — page titles, row labels, badges, buttons, filter chips. Text the
 * system *stores* is rendered verbatim, which for this project means lowercase
 * — statuses, log levels, trigger kinds, cron expressions, file paths and
 * workflow names (the loader constrains names to lowercase-and-dashes). So a
 * "Status" row holds a `failed` pill, and that is deliberate: the pill is the
 * value you would grep for, the label is not.
 */

const fmt = (ts: number | null) =>
  ts ? new Date(ts).toISOString().replace("T", " ").slice(0, 19) : "—";

const dur = (ms: number | null) =>
  ms === null ? "—" : ms < 1000 ? `${ms}ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms / 60_000)}m`;

/** "just now" / "4m ago" / "in 2h" — absolute time stays in the title attribute. */
function relative(ts: number | null): string {
  if (!ts) return "—";
  const delta = ts - Date.now();
  const ahead = delta > 0;
  const s = Math.round(Math.abs(delta) / 1000);
  const say = (n: number, unit: string) => (ahead ? `in ${n}${unit}` : `${n}${unit} ago`);
  if (s < 45) return ahead ? "any moment" : "just now";
  if (s < 3600) return say(Math.round(s / 60), "m");
  if (s < 86_400) return say(Math.round(s / 3600), "h");
  return say(Math.round(s / 86_400), "d");
}

const statusPill = (s: string) => html`<span class="pill ${s}">${s}</span>`;

const triggerLabel = (wf: LoadedWorkflow) =>
  wf.trigger.kind === "cron"
    ? `cron · ${wf.trigger.expression}`
    : wf.trigger.kind === "poll"
      ? `poll · ${wf.trigger.expression}`
      : wf.trigger.kind === "webhook"
        ? `${wf.trigger.method ?? "POST"} /hooks/${wf.trigger.path}`
        : "manual";

function pretty(json: string): string {
  try {
    return JSON.stringify(JSON.parse(json), null, 2);
  } catch {
    return json;
  }
}

/* ------------------------------------------------------------- workflows */

/** Top-level workflows first — `""` sorts before any folder name. */
function groupByFolder(workflows: LoadedWorkflow[]): [string, LoadedWorkflow[]][] {
  const groups = new Map<string, LoadedWorkflow[]>();
  for (const w of workflows) {
    const key = w.folder ?? "";
    const list = groups.get(key);
    if (list) list.push(w);
    else groups.set(key, [w]);
  }
  return [...groups].sort(([a], [b]) => a.localeCompare(b));
}

/**
 * Bars run oldest-to-newest left-to-right, which is the opposite of the order
 * the query returns them in.
 */
function healthStrip(pulses: RunPulse[]) {
  if (pulses.length === 0) return html`<span class="mono muted" style="font-size:11px">—</span>`;
  const bars = [...pulses].reverse();
  const longest = Math.max(...bars.map((p) => p.duration_ms ?? 0), 1);
  return html`<span class="spark" title="${bars.length} most recent run(s), oldest first">
    ${bars.map((p) => {
      // Height carries duration, so a run that suddenly takes far longer than
      // its neighbours is visible without opening anything.
      const h = 6 + Math.round(10 * Math.min(1, (p.duration_ms ?? 0) / longest));
      return html`<i class="${p.status}" style="height:${h}px"></i>`;
    })}
  </span>`;
}

/**
 * "Updated" is when the file's contents last changed, not when it last ran —
 * absent for a workflow whose first boot has not happened yet, which only
 * shows up in the window between adding a file and restarting.
 */
function updatedCell(version: WorkflowVersion | undefined) {
  if (!version) return html`<span class="mono muted">—</span>`;
  const added = version.updated_at === version.first_seen;
  return html`<span class="mono muted trunc"
    title="${added ? "Added" : "Changed"} ${fmt(version.updated_at)}"
    >${relative(version.updated_at)}</span>`;
}

function workflowRow(
  w: LoadedWorkflow,
  nextRun: (name: string) => Date | null,
  pulses: RunPulse[],
  version: WorkflowVersion | undefined,
) {
  const next = nextRun(w.name);
  const last = pulses[0];
  const search = `${w.name} ${w.description ?? ""} ${w.file} ${w.trigger.kind}`.toLowerCase();
  return html`
    <div class="row wf ${w.enabled === false ? "off" : ""}" data-search="${search}">
      <div style="min-width:0">
        <div class="name">
          <span class="dot ${last?.status ?? ""}"
                title="${last ? `last run ${last.status} · ${relative(last.started_at)}` : "never run"}"></span>
          <b><a href="/workflows/${w.name}">${w.name}</a></b>
          ${w.enabled === false ? html`<span class="tag">Disabled</span>` : ""}
        </div>
        ${w.description ? html`<div class="desc">${w.description}</div>` : ""}
      </div>
      <div class="mono muted trunc hide-sm" title="${triggerLabel(w)}">${triggerLabel(w)}</div>
      <div class="hide-sm">${healthStrip(pulses)}</div>
      <div class="hide-sm">${updatedCell(version)}</div>
      <div class="mono muted trunc" title="${next ? fmt(next.getTime()) : "no schedule"}">
        ${next ? relative(next.getTime()) : "—"}
      </div>
      <form method="post" action="/workflows/${w.name}/run">
        <button class="btn icon" type="submit" title="Run now">${ICON_PLAY}</button>
      </form>
    </div>
  `;
}

export function workflowsPage(
  workflows: LoadedWorkflow[],
  nextRun: (name: string) => Date | null,
  pulses: RunPulse[],
  counts: Record<string, number>,
  versions: Map<string, WorkflowVersion>,
) {
  const byWorkflow = new Map<string, RunPulse[]>();
  for (const p of pulses) {
    const list = byWorkflow.get(p.workflow);
    if (list) list.push(p);
    else byWorkflow.set(p.workflow, [p]);
  }

  const groups = groupByFolder(workflows);
  const active = workflows.filter((w) => w.enabled !== false).length;
  const runs24h = Object.values(counts).reduce((a, b) => a + b, 0);
  const failed24h = counts.failed ?? 0;

  const header = html`<div class="row wf head">
    <div>Workflow</div>
    <div class="hide-sm">Trigger</div>
    <div class="hide-sm">Health</div>
    <div class="hide-sm">Updated</div>
    <div>Next</div>
    <div></div>
  </div>`;

  return layout(
    {
      title: "Workflows",
      tab: "workflows",
      refresh: 15,
      badges: { workflows: workflows.length, failed: failed24h },
    },
    html`
      <div class="stats">
        <div class="stat"><b>${active}</b><span>active workflows</span></div>
        <div class="stat"><b>${groups.length}</b><span>folder${groups.length === 1 ? "" : "s"}</span></div>
        <div class="stat"><b>${runs24h}</b><span>runs · 24h</span></div>
        <div class="stat"><b class="${failed24h ? "failed" : ""}">${failed24h}</b><span>failed · 24h</span></div>
      </div>

      <div class="toolbar">
        <input type="search" id="filter" placeholder="Filter workflows…" autocomplete="off" spellcheck="false">
        <span class="muted mono" style="font-size:12px">${workflows.length} in ${groups.length} folder${groups.length === 1 ? "" : "s"}</span>
      </div>

      ${workflows.length === 0
        ? html`<div class="card"><div class="empty">
            <b>No workflows yet</b>
            Drop a file that default-exports <code class="mono">defineWorkflow()</code> into
            <code class="mono">./workflows</code> — subdirectories become the folders here.
          </div></div>`
        : groups.map(
            ([folder, group]) => html`
              <details class="folder" data-group="${folder || "/"}" open>
                <summary>
                  ${folder ? ICON_FOLDER : ICON_HOME}
                  <span class="fname">${folder ? html`workflows/<b>${folder}</b>/` : html`workflows/<i>(top level)</i>`}</span>
                  <span class="grow"></span>
                  <span class="tag" data-count>${group.length}</span>
                </summary>
                ${header}
                ${group.map((w) =>
                  workflowRow(w, nextRun, byWorkflow.get(w.name) ?? [], versions.get(w.name)),
                )}
              </details>
            `,
          )}

      <div class="card" id="no-matches" hidden><div class="empty">
        <b>Nothing matches that filter</b>
        Clear the box above to see every workflow again.
      </div></div>
    `,
  );
}

/* ------------------------------------------------------------ executions */

// Labelled, because the chip is a control and not an echo of the column: the
// value that goes into ?status= stays the stored lowercase one, which is what
// the pills next to them render.
const STATUS_FILTERS = [
  { value: "", label: "All" },
  { value: "success", label: "Succeeded" },
  { value: "failed", label: "Failed" },
  { value: "running", label: "Running" },
  { value: "skipped", label: "Skipped" },
] as const;

export function executionsPage(
  runs: RunRecord[],
  filter: { status: string; workflow: string },
  counts: Record<string, number>,
  workflowNames: string[],
  /** In-flight right now — not the same as "started in the last 24h". */
  running: number,
) {
  const qs = (status: string) => {
    const params = new URLSearchParams();
    if (status) params.set("status", status);
    if (filter.workflow) params.set("workflow", filter.workflow);
    const s = params.toString();
    return s ? `/runs?${s}` : "/runs";
  };

  return layout(
    {
      title: "Executions",
      tab: "executions",
      refresh: 10,
      badges: { workflows: null, failed: counts.failed ?? 0 },
    },
    html`
      <div class="stats">
        <div class="stat"><b>${Object.values(counts).reduce((a, b) => a + b, 0)}</b><span>runs · 24h</span></div>
        <div class="stat"><b class="success">${counts.success ?? 0}</b><span>succeeded · 24h</span></div>
        <div class="stat"><b class="${counts.failed ? "failed" : ""}">${counts.failed ?? 0}</b><span>failed · 24h</span></div>
        <div class="stat"><b class="${running ? "running" : ""}">${running}</b><span>running now</span></div>
      </div>

      <form class="toolbar" method="get" action="/runs">
        ${STATUS_FILTERS.map(
          (f) => html`<a class="chip" href="${qs(f.value)}"
            ${filter.status === f.value ? raw('aria-current="true"') : ""}>${f.label}</a>`,
        )}
        <span class="grow"></span>
        ${filter.status ? html`<input type="hidden" name="status" value="${filter.status}">` : ""}
        <select name="workflow" data-autosubmit>
          <option value="">Every workflow</option>
          ${workflowNames.map(
            (n) => html`<option value="${n}" ${filter.workflow === n ? raw("selected") : ""}>${n}</option>`,
          )}
        </select>
        <noscript><button class="btn" type="submit">Apply</button></noscript>
      </form>

      ${runsTable(runs)}
    `,
  );
}

function runsTable(runs: RunRecord[], showWorkflow = true) {
  const cols = showWorkflow ? html`<div>Workflow</div>` : html`<div>Run</div>`;
  return html`
    <div class="card">
      <div class="row ex head">
        ${cols}<div>Status</div><div class="hide-sm">Trigger</div>
        <div class="hide-sm">Started</div><div class="hide-sm">Duration</div><div>Detail</div>
      </div>
      ${runs.length === 0
        ? html`<div class="empty">
            <b>Nothing has run yet</b>
            Runs appear here as soon as a trigger fires — or press the run button on a workflow.
          </div>`
        : runs.map(
            (r) => html`
              <div class="row ex">
                <div style="min-width:0">
                  <div class="name">
                    <span class="dot ${r.status}"></span>
                    <b>${showWorkflow
                      ? html`<a href="/workflows/${r.workflow}">${r.workflow}</a>`
                      : html`<a href="/runs/${r.id}" class="mono">${r.id.slice(0, 8)}</a>`}</b>
                  </div>
                  ${r.error
                    ? html`<div class="desc failed" title="${r.error}">${r.error.slice(0, 120)}</div>`
                    : ""}
                </div>
                <div>${statusPill(r.status)}</div>
                <div class="mono muted hide-sm">${r.trigger}</div>
                <div class="mono muted hide-sm" title="${fmt(r.started_at)}">${relative(r.started_at)}</div>
                <div class="mono muted hide-sm">${dur(r.duration_ms)}</div>
                <div class="mono"><a href="/runs/${r.id}"
                  >${showWorkflow ? r.id.slice(0, 8) : "Open →"}</a></div>
              </div>
            `,
          )}
    </div>
  `;
}

/* --------------------------------------------------------------- workflow */

export function workflowPage(
  wf: LoadedWorkflow,
  next: Date | null,
  stats: { total: number; succeeded: number; failed: number },
  runs: RunRecord[],
  version: WorkflowVersion | undefined,
) {
  const crumb = html`<span class="crumb">
    ${wf.folder ? html`${ICON_FOLDER} <a href="/">${wf.folder}</a> /` : ""}
    <b>${wf.name}</b>
  </span>`;

  return layout(
    { title: wf.name, tab: "workflows", refresh: 15, crumb },
    html`
      <div class="stats">
        <div class="stat"><b>${stats.total ?? 0}</b><span>total runs</span></div>
        <div class="stat"><b class="success">${stats.succeeded ?? 0}</b><span>succeeded</span></div>
        <div class="stat"><b class="${stats.failed ? "failed" : ""}">${stats.failed ?? 0}</b><span>failed</span></div>
        <div class="stat"><b>${next ? relative(next.getTime()) : "—"}</b><span>next run</span></div>
      </div>

      ${wf.description ? html`<p class="muted" style="margin:0 0 4px">${wf.description}</p>` : ""}

      <h2>Definition</h2>
      <div class="card"><table class="kv"><tbody>
        <tr><td>Trigger</td><td class="mono">${triggerLabel(wf)}</td></tr>
        <tr><td>Next run</td><td class="mono">${next ? fmt(next.getTime()) : "—"}</td></tr>
        <tr><td>Retries</td><td class="mono">${wf.retries ?? 2}</td></tr>
        <tr><td>Timeout</td><td class="mono">${dur(wf.timeoutMs ?? 300_000)}</td></tr>
        <tr><td>On overlap</td><td class="mono">${wf.onOverlap ?? "skip"}</td></tr>
        <tr><td>Folder</td><td class="mono">${wf.folder ? `workflows/${wf.folder}/` : "workflows/ (top level)"}</td></tr>
        <tr><td>File</td><td class="mono">workflows/${wf.file}</td></tr>
        <tr><td>Updated</td><td class="mono">${
          version
            ? html`${fmt(version.updated_at)} <span class="muted">(${relative(version.updated_at)}${
                version.updated_at === version.first_seen ? ", first seen" : ""
              })</span>`
            : "—"
        }</td></tr>
        <tr><td>Version</td><td class="mono" title="${wf.hash}">${wf.hash.slice(0, 12)}</td></tr>
      </tbody></table></div>

      <div class="bar">
        <form method="post" action="/workflows/${wf.name}/run">
          <button class="btn" type="submit">${ICON_PLAY} Run now</button>
        </form>
        <a class="chip" href="/runs?workflow=${wf.name}">All executions →</a>
      </div>

      <h2>Recent runs</h2>
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
  children: RunRecord[] = [],
) {
  const crumb = html`<span class="crumb">
    <a href="/workflows/${run.workflow}">${run.workflow}</a> /
    <b class="mono">${run.id.slice(0, 8)}</b>
  </span>`;

  return layout(
    {
      title: `Run ${run.id.slice(0, 8)}`,
      tab: "executions",
      refresh: run.status === "running" ? 5 : null,
      crumb,
    },
    html`
      <div class="card"><table class="kv"><tbody>
        <tr><td>Workflow</td><td><a href="/workflows/${run.workflow}">${run.workflow}</a></td></tr>
        <tr><td>Status</td><td>${statusPill(run.status)}</td></tr>
        <tr><td>Trigger</td><td class="mono">${run.trigger}</td></tr>
        <tr><td>Attempts</td><td class="mono">${run.attempts}</td></tr>
        <tr><td>Started</td><td class="mono">${fmt(run.started_at)} <span class="muted">· ${relative(run.started_at)}</span></td></tr>
        <tr><td>Duration</td><td class="mono">${dur(run.duration_ms)}</td></tr>
        <tr><td>Run ID</td><td class="mono muted">${run.id}</td></tr>
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

      ${run.parent_run
        ? html`<p class="muted" style="margin:10px 0 0">
            Started by <a href="/runs/${run.parent_run}">${run.parent_run.slice(0, 8)}</a>
            through <span class="mono">ctx.run()</span>.</p>`
        : ""}

      ${children.length
        ? html`<h2>Workflows it ran</h2>
            <div class="card"><table><tbody>
              ${children.map(
                (c) => html`<tr>
                  <td>${statusPill(c.status)}</td>
                  <td><a href="/runs/${c.id}">${c.workflow}</a></td>
                  <td class="mono muted">${dur(c.duration_ms)}</td>
                  <td class="mono muted">${c.id.slice(0, 8)}</td>
                </tr>`,
              )}
            </tbody></table></div>`
        : ""}

      ${run.status === "failed" || run.input
        ? html`<div class="bar">
            ${run.status === "failed"
              ? html`<form method="post" action="/runs/${run.id}/resume">
                  <button class="btn" type="submit">Resume from last good step</button>
                </form>`
              : ""}
            ${run.input
              ? html`<form method="post" action="/runs/${run.id}/replay">
                  <button class="btn" type="submit">Replay with this input</button>
                </form>`
              : ""}
            <span class="muted" style="font-size:12.5px">
              ${run.status === "failed"
                ? "Resume skips every step that already succeeded; replay redoes all of them."
                : "Replay starts a fresh run with the same input — no steps reused."}
            </span>
          </div>`
        : ""}

      ${run.input
        ? html`<h2>Input</h2><div class="card"><pre class="blob" style="border:none">${pretty(run.input)}</pre></div>`
        : ""}

      ${run.error ? html`<h2>Error</h2><div class="err">${run.error}</div>` : ""}
      ${run.result && run.result !== "null"
        ? html`<h2>Result</h2><div class="card"><pre class="blob" style="border:none">${pretty(run.result)}</pre></div>`
        : ""}

      ${steps.length
        ? html`<h2>Steps</h2>
            <div class="card">
              ${steps.map(
                (st) => html`
                  <details class="item">
                    <summary>
                      <span class="${st.status === "ok" ? "success" : "failed"}">${st.status === "ok" ? "✓" : "✗"}</span>
                      <b style="flex:1">${st.name}</b>
                      ${st.run_id !== run.id ? html`<span class="tag">Reused</span>` : ""}
                      ${st.truncated ? html`<span class="tag">Truncated</span>` : ""}
                      <span class="mono muted">${dur(st.duration_ms)}</span>
                    </summary>
                    <div class="payload">
                      ${st.input ? html`<div><h4>Input</h4><pre>${pretty(st.input)}</pre></div>` : ""}
                      ${st.output ? html`<div><h4>Output</h4><pre>${pretty(st.output)}</pre></div>` : ""}
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
                  <details class="item">
                    <summary>
                      <span class="mono ${call.status && call.status < 400 ? "success" : "failed"}"
                        >${call.status ?? "ERR"}</span>
                      <span class="mono" style="flex:1;word-break:break-all"
                        >${call.method} ${call.url}</span>
                      <span class="mono muted">${dur(call.duration_ms)}</span>
                    </summary>
                    <div class="payload">
                      ${call.request ? html`<div><h4>Request</h4><pre>${pretty(call.request)}</pre></div>` : ""}
                      ${call.response ? html`<div><h4>Response</h4><pre>${pretty(call.response)}</pre></div>` : ""}
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
                  <span class="${l.level === "error" ? "failed" : l.level === "warn" ? "skipped" : "muted"}">${l.level}</span>
                  <span>${l.msg}${l.data ? html`<pre>${pretty(l.data)}</pre>` : ""}</span>
                </div>
              `,
            )}
      </div>
    `,
  );
}
