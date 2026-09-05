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
input[type=search],input[type=date],select{background:var(--panel);
border:1px solid var(--border);color:var(--fg);
border-radius:8px;padding:7px 11px;font:13px var(--sans);min-width:0}
input[type=search]{flex:1;max-width:320px}
input[type=date]{font:12.5px var(--mono);color-scheme:dark light}
/* The pair travels as one unit, so a narrow screen never strands the arrow. */
.dates{display:flex;gap:8px;align-items:center}
input[type=search]:focus,input[type=date]:focus,select:focus{outline:none;border-color:var(--accent)}
.chip{padding:6px 11px;border-radius:8px;border:1px solid var(--border);background:var(--panel);
color:var(--muted);font-size:12.5px;white-space:nowrap}
.chip:hover{color:var(--fg);text-decoration:none;background:var(--panel-2)}
.chip[aria-current]{border-color:var(--accent);color:var(--accent);background:var(--accent-soft)}
/* A select is as wide as its widest option, and a workflow name is long:
   without these it decides the toolbar's width and hangs off a phone. */
.toolbar form{display:flex;gap:8px;align-items:center;min-width:0;max-width:100%}
.toolbar select{max-width:100%}

/* ---- menus ---- */
/* A filter whose options do not earn a permanent chip row: closed it is one
   chip that reads as its own value, open it is the list. Native <details>,
   so it costs no script to open — see SCRIPT for the two lines that keep an
   open one alive across a background refresh. */
.menu{position:relative}
.menu>summary{display:flex;align-items:center;gap:7px;list-style:none;cursor:pointer;
padding:6px 11px;border-radius:8px;border:1px solid var(--border);background:var(--panel);
color:var(--muted);font-size:12.5px;white-space:nowrap}
.menu>summary::-webkit-details-marker{display:none}
.menu>summary::after{content:"";width:5px;height:5px;margin:-3px 0 0 1px;
border-right:1.6px solid var(--faint);border-bottom:1.6px solid var(--faint);transform:rotate(45deg)}
.menu>summary:hover{background:var(--panel-2);color:var(--fg)}
.menu>summary b{color:var(--fg);font-weight:600;font-size:13px}
.menu[open]>summary{border-color:var(--accent)}
.menu svg{color:var(--faint);flex:none}
.pop{position:absolute;z-index:8;top:calc(100% + 6px);left:0;min-width:190px;
max-width:calc(100vw - 40px);display:flex;flex-direction:column;gap:2px;padding:6px;
background:var(--panel);border:1px solid var(--border);border-radius:10px;
box-shadow:0 14px 30px rgba(0,0,0,.35)}
.pop a{padding:6px 9px;border-radius:7px;color:var(--fg);font-size:13px;white-space:nowrap}
.pop a:hover{background:var(--panel-2);text-decoration:none}
.pop a[aria-current]{color:var(--accent);background:var(--accent-soft)}
.pop form{flex-wrap:wrap;margin-top:4px;padding-top:7px;border-top:1px solid var(--border-soft)}

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
.cr{grid-template-columns:minmax(0,1fr) 120px 96px 210px}
.sc{grid-template-columns:minmax(0,1fr) 96px 150px}
.row.head{padding:7px 14px;border-top:none;font-size:10.5px;text-transform:uppercase;
letter-spacing:.07em;color:var(--faint);font-weight:600;background:var(--sunk)}
.folder .row.head{background:transparent;border-top:1px solid var(--border-soft)}
.card>.row:first-child{border-top:none}
.row:hover:not(.head){background:var(--panel-2)}
.name{display:flex;align-items:center;gap:8px;min-width:0}
.name b{font-weight:600;letter-spacing:-.01em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* The folder a run's workflow lives in. It keeps its full width and the name
   truncates beside it, because the project is the half you are scanning for;
   and the clip keeps a long one inside its column instead of over the status. */
.name .path{flex:none;color:var(--faint);font-family:var(--mono);font-size:12px}
.ex .name{overflow:hidden}
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
.btn.primary{background:var(--accent);border-color:var(--accent);color:#fff}
.btn.primary:hover{color:#fff;filter:brightness(1.08)}
.btn.danger:hover{border-color:var(--red);color:var(--red)}
.bar{display:flex;gap:10px;align-items:center;margin-top:14px;flex-wrap:wrap}
.actions{display:flex;gap:6px;justify-content:flex-end}
.actions form{display:contents}

/* ---- forms ---- */
input[type=text],input[type=password],textarea{background:var(--panel);width:100%;
border:1px solid var(--border);color:var(--fg);border-radius:8px;padding:8px 11px;
font:13px var(--sans)}
input[type=text]:focus,input[type=password]:focus,textarea:focus{outline:none;border-color:var(--accent)}
input.mono{font-family:var(--mono);font-size:12.5px}
.form{display:grid;gap:15px;padding:16px}
.field label{display:block;font-size:12px;font-weight:600;margin-bottom:5px}
.field .help{font-size:11.5px;color:var(--muted);margin-top:5px}
.field .req{color:var(--faint);font-weight:400;text-transform:none;letter-spacing:0}
.check{display:flex;gap:8px;align-items:flex-start;font-size:12.5px;color:var(--muted)}
.check input{margin:3px 0 0}
.check b{color:var(--fg);font-weight:600;display:block;font-size:13px}
.note{background:var(--sunk);border:1px solid var(--border);border-radius:9px;
padding:11px 13px;font-size:12.5px;color:var(--muted);margin-bottom:14px}
.note b{color:var(--fg)}
.flash{border-radius:9px;padding:10px 13px;font-size:12.5px;margin-bottom:14px;
border:1px solid color-mix(in srgb,var(--red) 35%,var(--border));
background:color-mix(in srgb,var(--red) 9%,var(--panel));color:var(--red)}
.pick{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:10px}
.pick a{display:block;background:var(--panel);border:1px solid var(--border);border-radius:10px;
padding:13px 15px;color:var(--fg)}
.pick a:hover{border-color:var(--accent);text-decoration:none}
.pick b{display:block;font-weight:600;margin-bottom:3px}
.pick span{color:var(--muted);font-size:12.5px}
.detail{font-size:12px;color:var(--muted);margin-top:2px;overflow:hidden;
text-overflow:ellipsis;white-space:nowrap}

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
/* Too narrow for both: the name drops to a line of its own under the folder,
   rather than the two of them sharing one and each showing three letters. */
.ex .name:has(.path){flex-wrap:wrap}
.ex .name .path{flex:1 1 0;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ex .name .path+b{flex-basis:100%}
.cr{grid-template-columns:minmax(0,1fr) 210px}
.sc{grid-template-columns:minmax(0,1fr) 150px}
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

  // A <details> menu closes on its own summary and on nothing else, which is
  // the one thing everybody expects of a menu.
  document.addEventListener("click", function (e) {
    document.querySelectorAll("details.menu[open]").forEach(function (d) {
      if (!d.contains(e.target)) d.open = false;
    });
  });

  document.addEventListener("change", function (e) {
    if (e.target && e.target.matches && e.target.matches("[data-autosubmit]")) e.target.form.submit();
  });

  // Delete is the one control here that cannot be undone by pressing it again.
  document.addEventListener("submit", function (e) {
    var ask = e.target && e.target.dataset && e.target.dataset.confirm;
    if (ask && !confirm(ask)) e.preventDefault();
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
    // Any focused control, not just the search box: the refresh replaces the
    // whole page, and a half-typed date would vanish under the user's cursor.
    var el2 = document.activeElement;
    var busy = !!(el2 && el2.matches && el2.matches("input,select,textarea"));
    // An open menu is being used too, and the swap would shut it mid-choice.
    if (document.querySelector("details.menu[open]")) busy = true;
    if (!document.hidden && !busy) {
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

type Tab = "workflows" | "executions" | "credentials" | null;

interface Shell {
  /** Browser title and, on detail pages, the breadcrumb next to the tabs. */
  title: string;
  tab: Tab;
  /** Seconds between background refreshes, or null to leave the page alone. */
  refresh?: number | null;
  /** Rendered next to the tabs on pages that are not a tab themselves. */
  crumb?: HtmlEscapedString | Promise<HtmlEscapedString> | null;
  /** Tab badges — kept out of the pages so every page can show them. */
  badges?: { workflows?: number | null; failed?: number | null; unconnected?: number | null };
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
      <a class="tab" href="/credentials" ${tab === "credentials" ? raw('aria-current="page"') : ""}>Credentials${
        badges.unconnected ? html`<span class="n bad">${badges.unconnected}</span>` : ""
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
function groupByFolder<T extends { folder: string | null }>(workflows: T[]): [string, T[]][] {
  const groups = new Map<string, T[]>();
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
  /** Credentials this workflow declared that are not connected yet. */
  blocked: string[],
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
          ${blocked.length > 0
            ? html`<a class="tag failed" href="/credentials"
                      title="Runs are refused until ${blocked.join(", ")} is connected">Blocked</a>`
            : ""}
        </div>
        ${blocked.length > 0
          ? html`<div class="desc failed">Not connected: ${blocked.join(", ")}</div>`
          : w.description
            ? html`<div class="desc">${w.description}</div>`
            : ""}
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
  /** Workflow name → the credentials it declared that are not connected. */
  blocked: Map<string, string[]>,
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
      badges: { workflows: workflows.length, failed: failed24h, unconnected: blocked.size },
    },
    html`
      <div class="stats">
        <div class="stat"><b>${active}</b><span>active workflows</span></div>
        <div class="stat"><b>${groups.length}</b><span>folder${groups.length === 1 ? "" : "s"}</span></div>
        <div class="stat"><b>${runs24h}</b><span>runs · 24h</span></div>
        ${blocked.size > 0
          ? html`<div class="stat"><b class="failed">${blocked.size}</b><span>blocked</span></div>`
          : ""}
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
                  workflowRow(
                    w,
                    nextRun,
                    byWorkflow.get(w.name) ?? [],
                    versions.get(w.name),
                    blocked.get(w.name) ?? [],
                  ),
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

// The time windows, in the order they read on screen. The keys are what
// `?range=` carries and what `resolveRange()` in the server resolves; "custom"
// is not a chip, it is the state the two date fields put the page into.
const RANGE_FILTERS = [
  { value: "", label: "All time" },
  { value: "24h", label: "24 hours" },
  { value: "7d", label: "7 days" },
  { value: "14d", label: "14 days" },
  { value: "30d", label: "30 days" },
] as const;

/**
 * A resolved time window: the chip that is lit (`key`), the two date fields as
 * the browser wants them back (`from`/`to`, `YYYY-MM-DD` or empty), and the
 * epoch-millisecond bounds the query actually ran with.
 */
export interface RunRange {
  key: string;
  from: string;
  to: string;
  since?: number;
  until?: number;
}

/** What the window covers, for the captions under the counts. */
function rangeLabel(range: RunRange) {
  if (range.key === "custom") return "selected dates";
  return (
    RANGE_FILTERS.find((r) => r.value === range.key)?.label ?? "all time"
  ).toLowerCase();
}

/**
 * A workflow as the executions tab needs it. The runs table stores only a
 * name, so the folder a run came from has to be looked up from the registry.
 */
export interface WorkflowChoice {
  name: string;
  folder: string | null;
}

export function executionsPage(
  runs: RunRecord[],
  filter: { status: string; workflow: string; folder: string; range: RunRange },
  /** Per status, over the same window and workflow as `runs`. */
  counts: Record<string, number>,
  /** Every loaded workflow — the filter's options, and the folder each run shows. */
  workflows: WorkflowChoice[],
  /** In-flight right now — not the same as "started in the last 24h". */
  running: number,
  window: {
    /** The row cap `runs` was fetched under. */
    limit: number;
    /** Everything the filter matches, so a capped list can say so. */
    matching: number;
    /** Failures in the last 24h regardless of the window — the tab badge
     *  means the same thing on every page, so it does not follow the chips. */
    failed24h: number;
  },
) {
  const current = {
    status: filter.status,
    workflow: filter.workflow,
    // `/` is the top level — the one group with no folder name to carry.
    folder: filter.folder,
    range: filter.range.key,
    from: filter.range.from,
    to: filter.range.to,
  };

  // One link builder for both chip rows: every filter rides along except the
  // ones this chip is here to change, so picking a range keeps the workflow
  // and picking a status keeps the dates.
  const link = (over: Partial<typeof current>) => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...current, ...over })) {
      if (v) params.set(k, v);
    }
    const s = params.toString();
    return s ? `/runs?${s}` : "/runs";
  };

  // The same filters as hidden fields, for the controls that submit a form.
  // Without these, changing the workflow would quietly drop the window.
  const carry = (except: string[]) =>
    Object.entries(current)
      .filter(([k, v]) => v && !except.includes(k))
      .map(([k, v]) => html`<input type="hidden" name="${k}" value="${v}">`);

  const label = rangeLabel(filter.range);

  // A run only records a workflow name, so the folder comes from the loaded
  // workflow. A run whose file has since been deleted has no entry here and
  // renders without a folder, the same as a top-level one.
  const folders = new Map(workflows.map((w) => [w.name, w.folder] as const));
  const option = (n: string) =>
    html`<option value="${n}" ${filter.workflow === n ? raw("selected") : ""}>${n}</option>`;

  // The chips come from every workflow, so the one you are filtered to is
  // still on screen; the select is narrowed to it, because an option that can
  // only ever return nothing is not a choice.
  const groups = groupByFolder(workflows);
  const inFolder = filter.folder
    ? workflows.filter((w) => (w.folder ?? "/") === filter.folder)
    : workflows;

  // What each closed menu says it is set to. Both filters are five to ten
  // one-word options; laid out flat they were three rows of chips above the
  // numbers they change, which is more room than a setting you touch once
  // deserves. The dates live inside the window menu for the same reason, and
  // still decide on their own what a custom window is — nothing here holds a
  // "custom" state that the fields could disagree with.
  const windowSummary =
    filter.range.key === "custom"
      ? `${filter.range.from || "…"} → ${filter.range.to || "…"}`
      : (RANGE_FILTERS.find((r) => r.value === filter.range.key)?.label ?? "All time");
  const folderSummary =
    filter.folder === "" ? "All folders" : filter.folder === "/" ? "Top level" : filter.folder;

  return layout(
    {
      title: "Executions",
      tab: "executions",
      refresh: 10,
      badges: { workflows: null, failed: window.failed24h },
    },
    html`
      <div class="toolbar">
        <details class="menu">
          <summary><span class="muted">Window</span> <b>${windowSummary}</b></summary>
          <div class="pop">
            ${RANGE_FILTERS.map(
              (r) => html`<a href="${link({ range: r.value, from: "", to: "" })}"
                ${filter.range.key === r.value ? raw('aria-current="true"') : ""}>${r.label}</a>`,
            )}
            <form method="get" action="/runs">
              ${carry(["from", "to"])}
              <span class="dates">
                <input type="date" name="from" value="${filter.range.from}"
                  aria-label="From date (UTC)" title="From — UTC, inclusive" data-autosubmit>
                <span class="muted">→</span>
                <input type="date" name="to" value="${filter.range.to}"
                  aria-label="To date (UTC)" title="To — UTC, inclusive" data-autosubmit>
              </span>
              <noscript><button class="btn" type="submit">Apply</button></noscript>
            </form>
          </div>
        </details>

        ${groups.length > 1
          ? html`<details class="menu">
              <summary>${ICON_FOLDER} <b>${folderSummary}</b></summary>
              <div class="pop">
                <a href="${link({ folder: "", workflow: "" })}"
                  ${filter.folder ? "" : raw('aria-current="true"')}>All folders</a>
                ${groups.map(([folder]) => {
                  // Picking a folder drops the workflow, the same way picking a
                  // range drops the dates: the two would otherwise contradict
                  // each other and the list would come back empty.
                  const value = folder || "/";
                  return html`<a href="${link({ folder: value, workflow: "" })}"
                    ${filter.folder === value ? raw('aria-current="true"') : ""}
                    >${folder || "Top level"}</a>`;
                })}
              </div>
            </details>`
          : ""}

        <span class="grow"></span>

        <form method="get" action="/runs">
          ${carry(["workflow"])}
          <select name="workflow" data-autosubmit>
            <option value="">${filter.folder ? "Every workflow in the folder" : "Every workflow"}</option>
            ${filter.folder
              ? inFolder.map((w) => option(w.name))
              : groups.map(([folder, group]) =>
                  folder
                    ? html`<optgroup label="workflows/${folder}/">
                        ${group.map((w) => option(w.name))}
                      </optgroup>`
                    : html`${group.map((w) => option(w.name))}`,
                )}
          </select>
          <noscript><button class="btn" type="submit">Apply</button></noscript>
        </form>
      </div>

      <div class="stats">
        <div class="stat"><b>${Object.values(counts).reduce((a, b) => a + b, 0)}</b><span>runs · ${label}</span></div>
        <div class="stat"><b class="success">${counts.success ?? 0}</b><span>succeeded · ${label}</span></div>
        <div class="stat"><b class="${counts.failed ? "failed" : ""}">${counts.failed ?? 0}</b><span>failed · ${label}</span></div>
        <div class="stat"><b class="${running ? "running" : ""}">${running}</b><span>running now</span></div>
      </div>

      <div class="toolbar">
        ${STATUS_FILTERS.map(
          (f) => html`<a class="chip" href="${link({ status: f.value })}"
            ${filter.status === f.value ? raw('aria-current="true"') : ""}>${f.label}</a>`,
        )}
      </div>

      ${runsTable(
        runs,
        true,
        // "Nothing has run yet" is a lie once a window is on — the runs may
        // well exist a chip to the left.
        filter.status || filter.workflow || filter.folder || filter.range.key
          ? html`<div class="empty">
              <b>No runs in this window</b>
              Nothing matches ${label}${
                filter.workflow
                  ? html` for <code class="mono">${filter.workflow}</code>`
                  : filter.folder === "/"
                    ? html` at the top level`
                    : filter.folder
                      ? html` in <code class="mono">workflows/${filter.folder}/</code>`
                      : ""
              }.
              Widen the range or clear the filters.
            </div>`
          : undefined,
        folders,
      )}
      ${runs.length >= window.limit && window.matching > runs.length
        ? html`<div class="note" style="margin:12px 0 0">
            Showing the newest <b>${runs.length}</b> of <b>${window.matching}</b> runs in this
            window. Narrow the dates or pick a workflow to see the rest.
          </div>`
        : ""}
    `,
  );
}

function runsTable(
  runs: RunRecord[],
  showWorkflow = true,
  /** Shown instead of the default when a filter, not an idle box, emptied it. */
  empty?: HtmlEscapedString | Promise<HtmlEscapedString>,
  /** Workflow name → its folder, for the project label beside the name. */
  folders?: Map<string, string | null>,
) {
  const cols = showWorkflow ? html`<div>Workflow</div>` : html`<div>Run</div>`;
  return html`
    <div class="card">
      <div class="row ex head">
        ${cols}<div>Status</div><div class="hide-sm">Trigger</div>
        <div class="hide-sm">Started</div><div class="hide-sm">Duration</div><div>Detail</div>
      </div>
      ${runs.length === 0
        ? (empty ??
          html`<div class="empty">
            <b>Nothing has run yet</b>
            Runs appear here as soon as a trigger fires — or press the run button on a workflow.
          </div>`)
        : runs.map(
            (r) => html`
              <div class="row ex">
                <div style="min-width:0">
                  <div class="name">
                    <span class="dot ${r.status}"></span>
                    ${showWorkflow && folders?.get(r.workflow)
                      ? html`<span class="path" title="workflows/${folders.get(r.workflow)}/"
                          >${folders.get(r.workflow)}/</span>`
                      : ""}
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
  blocked: string[],
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

      ${blocked.length > 0
        ? html`<div class="flash">
            <b>Not connected.</b> This workflow declares ${blocked.join(", ")}, which
            ${blocked.length === 1 ? "has" : "have"} no stored value yet — runs are refused
            until then. <a href="/credentials">Connect ${blocked.length === 1 ? "it" : "them"} →</a>
          </div>`
        : ""}

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
        ${wf.credentials.length > 0
          ? html`<tr><td>Credentials</td><td class="mono">
              ${wf.credentials.map(
                (ref) => html`<a href="/credentials">${ref}</a> `,
              )}
            </td></tr>`
          : ""}
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

/* ----------------------------------------------------------- credentials */

/*
 * The one tab that writes. Everything here is gated on `writable`, which the
 * server sets from DASHBOARD_WRITE — with it off the page still renders, still
 * groups by folder, and still shows what is connected and what is not; it just
 * has no buttons. That is the read-only dashboard this project started with,
 * kept as a deployment choice rather than deleted.
 *
 * The rule about values is narrower than "nothing comes back". A field the
 * provider declared `secret: false` — a hostname, a port, a from-address — is
 * configuration and is rendered into the edit form, because an edit form you
 * cannot see is not an edit form. A field that is a credential is never sent
 * to the browser at all, in any view, at any time. See providers.ts.
 */

export interface CredentialFieldView {
  name: string;
  label: string;
  secret: boolean;
  optional: boolean;
  /** Whether a value is stored — the only thing said about a secret field. */
  set: boolean;
  /** Populated for non-secret fields only. */
  value?: string;
  placeholder?: string;
  help?: string;
}

export interface CredentialView {
  provider: string;
  id: string;
  folder: string | null;
  /** The provider's label, or null when the platform is gone from this build. */
  platform: string | null;
  primary: boolean;
  /** Environment variables this credential supplies, when it is primary. */
  envNames: string[];
  fields: CredentialFieldView[];
  missing: string[];
  testedAt: number | null;
  testOk: boolean | null;
  testDetail: string | null;
  /** Workflow files that declared it with defineCredential(). */
  requiredBy: string[];
}

/** Declared by a workflow, with nothing stored for it yet. */
export interface WantedCredentialView {
  provider: string;
  id: string;
  /** Whether the platform is one this build knows how to connect. */
  known: boolean;
  requiredBy: string[];
}

export interface SecretView {
  key: string;
  folder: string | null;
  updatedAt: number;
}

export interface ProviderView {
  id: string;
  label: string;
  blurb: string;
  docs?: string;
  fields: CredentialFieldView[];
  /**
   * The environment variables a primary credential of this platform supplies.
   * Empty when the platform has no built-in client, which is what hides the
   * "use this for the built-in client" checkbox rather than offering one that
   * would do nothing.
   */
  envNamesForPrimary: string[];
}

const ICON_KEY = raw(
  `<svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor" aria-hidden="true"><path d="M10.5 1a4.5 4.5 0 1 0-4.28 5.86L2 11.09V15h3.9l.6-.6v-1.5h1.5l.9-.9v-1.5h1.5l1.1-1.1A4.5 4.5 0 0 0 10.5 1Zm1.25 3.25a1.25 1.25 0 1 1 0-2.5 1.25 1.25 0 0 1 0 2.5Z"/></svg>`,
);

/** "connected" / "not connected" / "never tested" as one pill. */
function connectionPill(c: CredentialView) {
  if (c.platform === null) return html`<span class="pill skipped">unknown platform</span>`;
  if (c.missing.length > 0) return html`<span class="pill failed">incomplete</span>`;
  if (c.testOk === null) return html`<span class="pill skipped">untested</span>`;
  return c.testOk
    ? html`<span class="pill success">connected</span>`
    : html`<span class="pill failed">failing</span>`;
}

function credentialDot(c: CredentialView): string {
  if (c.platform === null || c.missing.length > 0) return "failed";
  if (c.testOk === null) return "";
  return c.testOk ? "success" : "failed";
}

function credentialRow(c: CredentialView, writable: boolean) {
  const ref = `${c.provider}/${c.id}`;
  const search = `${c.provider} ${c.id} ${c.platform ?? ""} ${c.folder ?? ""}`.toLowerCase();
  return html`
    <div class="row cr" data-search="${search}">
      <div style="min-width:0">
        <div class="name">
          <span class="dot ${credentialDot(c)}"></span>
          <b>${c.id}</b>
          <span class="tag">${c.platform ?? c.provider}</span>
          ${c.primary
            ? html`<span class="tag" title="Supplies ${c.envNames.join(", ") || "no env vars"} for the built-in client">Primary</span>`
            : ""}
        </div>
        ${c.missing.length > 0
          ? html`<div class="detail failed">Not set: ${c.missing.join(", ")}</div>`
          : c.testDetail
            ? html`<div class="detail ${c.testOk ? "" : "failed"}" title="${c.testDetail}">${c.testDetail}</div>`
            : html`<div class="detail">Never tested</div>`}
        ${c.requiredBy.length > 0
          ? html`<div class="detail">Used by ${c.requiredBy.join(", ")}</div>`
          : ""}
      </div>
      <div class="hide-sm">${connectionPill(c)}</div>
      <div class="mono muted trunc hide-sm" title="${c.testedAt ? fmt(c.testedAt) : "never tested"}">
        ${c.testedAt ? relative(c.testedAt) : "—"}
      </div>
      <div class="actions">
        ${writable
          ? html`
              <form method="post" action="/credentials/${ref}/test">
                <button class="btn" type="submit">Test</button>
              </form>
              <a class="btn" href="/credentials/${ref}">Edit</a>
              <form method="post" action="/credentials/${ref}/delete"
                    data-confirm="Delete ${c.id} and every value it holds? This cannot be undone.">
                <button class="btn danger" type="submit">Delete</button>
              </form>
            `
          : html`<span class="muted mono" style="font-size:11.5px">read-only</span>`}
      </div>
    </div>
  `;
}

function secretRow(secret: SecretView, writable: boolean) {
  return html`
    <div class="row sc" data-search="${secret.key.toLowerCase()}">
      <div class="name" style="min-width:0">
        ${ICON_KEY}<b class="mono trunc">${secret.key}</b>
      </div>
      <div class="mono muted trunc hide-sm" title="${fmt(secret.updatedAt)}">
        ${relative(secret.updatedAt)}
      </div>
      <div class="actions">
        ${writable
          ? html`
              <a class="btn" href="/secrets/${secret.key}">Edit</a>
              <form method="post" action="/secrets/${secret.key}/delete"
                    data-confirm="Delete ${secret.key}? If the environment also sets it, that value becomes live again.">
                <button class="btn danger" type="submit">Delete</button>
              </form>
            `
          : html`<span class="muted mono" style="font-size:11.5px">read-only</span>`}
      </div>
    </div>
  `;
}

export function credentialsPage(args: {
  credentials: CredentialView[];
  secrets: SecretView[];
  wanted: WantedCredentialView[];
  writable: boolean;
  encryptionReady: boolean;
  failed24h: number;
  workflowCount: number;
  error?: string | null;
}) {
  const { credentials, secrets, wanted, writable, encryptionReady } = args;

  // Credentials and loose secrets share one folder tree: they are the same
  // kind of thing to whoever is looking for one.
  const folders = new Map<string, { creds: CredentialView[]; secrets: SecretView[] }>();
  const bucket = (name: string | null) => {
    const key = name ?? "";
    let group = folders.get(key);
    if (!group) folders.set(key, (group = { creds: [], secrets: [] }));
    return group;
  };
  for (const c of credentials) bucket(c.folder).creds.push(c);
  for (const s of secrets) bucket(s.folder).secrets.push(s);
  const groups = [...folders].sort(([a], [b]) => a.localeCompare(b));

  const connected = credentials.filter((c) => c.testOk === true).length;
  const broken = credentials.filter(
    (c) => c.platform === null || c.missing.length > 0 || c.testOk === false,
  ).length;

  return layout(
    {
      title: "Credentials",
      tab: "credentials",
      // Deliberately not refreshed: this page has forms in it, and the
      // background swap that keeps the other tabs current would throw away
      // whatever was half-typed into one.
      refresh: null,
      badges: {
        workflows: args.workflowCount,
        failed: args.failed24h,
        unconnected: wanted.length + broken,
      },
    },
    html`
      ${args.error ? html`<div class="flash">${args.error}</div>` : ""}

      ${!encryptionReady
        ? html`<div class="flash">
            <b>Nothing can be stored yet.</b> Set
            <code class="mono">SECRETS_ENCRYPTION_KEY</code> to a 32-byte key —
            <code class="mono">openssl rand -base64 32</code> — and restart. Until then every
            credential comes from the environment.
          </div>`
        : ""}

      ${!writable
        ? html`<div class="note">
            <b>Read-only.</b> Set <code class="mono">DASHBOARD_WRITE=1</code> to add and edit
            credentials here. Without it the write surface is
            <code class="mono">bun run secret</code> and the API, which is how this dashboard
            behaved before the tab existed.
          </div>`
        : ""}

      <div class="stats">
        <div class="stat"><b>${credentials.length}</b><span>credentials</span></div>
        <div class="stat"><b class="${connected ? "success" : ""}">${connected}</b><span>connected</span></div>
        <div class="stat"><b class="${broken ? "failed" : ""}">${broken}</b><span>need attention</span></div>
        <div class="stat"><b>${secrets.length}</b><span>loose secrets</span></div>
      </div>

      ${wanted.length > 0
        ? html`
            <h2>Declared by a workflow, not connected</h2>
            <div class="card">
              ${wanted.map(
                (w) => html`
                  <div class="row cr">
                    <div style="min-width:0">
                      <div class="name">
                        <span class="dot failed"></span>
                        <b>${w.id}</b><span class="tag">${w.provider}</span>
                      </div>
                      <div class="detail">Needed by ${w.requiredBy.join(", ")}</div>
                    </div>
                    <div class="hide-sm">
                      ${w.known
                        ? html`<span class="pill failed">missing</span>`
                        : html`<span class="pill skipped">unknown platform</span>`}
                    </div>
                    <div class="hide-sm"></div>
                    <div class="actions">
                      ${writable && w.known
                        ? html`<a class="btn primary" href="/credentials/new/${w.provider}?id=${w.id}">Connect</a>`
                        : ""}
                    </div>
                  </div>
                `,
              )}
            </div>
            <div class="note" style="margin-top:10px">
              These workflows are loaded but will not run until their credentials are filled in.
              A missing credential does not stop the server, on purpose — this page is where you
              fix it, and a server that refused to boot could not serve it.
            </div>
          `
        : ""}

      <div class="toolbar" style="margin-top:22px">
        <input type="search" id="filter" placeholder="Filter credentials and secrets…"
               autocomplete="off" spellcheck="false">
        ${writable
          ? html`<a class="btn primary" href="/credentials/new">Add credential</a>
                 <a class="btn" href="/secrets/new">Add secret</a>`
          : ""}
      </div>

      ${credentials.length === 0 && secrets.length === 0
        ? html`<div class="card"><div class="empty">
            <b>Nothing stored yet</b>
            ${writable
              ? raw("A credential is one platform's fields kept together and testable. A secret is a single value.")
              : raw("Add one with <code class='mono'>bun run secret -- set KEY</code>.")}
          </div></div>`
        : groups.map(
            ([folder, group]) => html`
              <details class="folder" data-group="cred:${folder || "/"}" open>
                <summary>
                  ${folder ? ICON_FOLDER : ICON_HOME}
                  <span class="fname">${folder ? html`<b>${folder}</b>` : html`<i>(no folder)</i>`}</span>
                  <span class="grow"></span>
                  <span class="tag" data-count>${group.creds.length + group.secrets.length}</span>
                </summary>
                ${group.creds.length > 0
                  ? html`<div class="row cr head">
                      <div>Credential</div>
                      <div class="hide-sm">Status</div>
                      <div class="hide-sm">Tested</div>
                      <div></div>
                    </div>
                    ${group.creds.map((c) => credentialRow(c, writable))}`
                  : ""}
                ${group.secrets.length > 0
                  ? html`<div class="row sc head">
                      <div>Secret</div>
                      <div class="hide-sm">Updated</div>
                      <div></div>
                    </div>
                    ${group.secrets.map((secret) => secretRow(secret, writable))}`
                  : ""}
              </details>
            `,
          )}

      <div class="card" id="no-matches" hidden><div class="empty">
        <b>Nothing matches that filter</b>
        Clear the box above to see everything again.
      </div></div>
    `,
  );
}

/** Step one of adding a credential: which platform. */
export function providerPickerPage(providers: ProviderView[]) {
  return layout(
    {
      title: "Add credential",
      tab: "credentials",
      crumb: html`<span class="crumb"><a href="/credentials">Credentials</a> / <b>Add</b></span>`,
    },
    html`
      <h2>Pick a platform</h2>
      <div class="pick">
        ${providers.map(
          (p) => html`
            <a href="/credentials/new/${p.id}">
              <b>${p.label}</b><span>${p.blurb}</span>
            </a>
          `,
        )}
      </div>
      <div class="note" style="margin-top:16px">
        Not here? A platform is a few lines in <code class="mono">src/core/providers.ts</code> —
        its fields and one cheap call that proves the values work. It is code rather than a form
        on this page on purpose: a test request the server runs, configured from a browser and
        stored in the database, is the shape this project left n8n to avoid.
      </div>
    `,
  );
}

/** Create or edit one credential. */
export function credentialFormPage(args: {
  provider: ProviderView;
  /** Absent when creating. */
  existing?: CredentialView;
  suggestedId?: string;
  folders: string[];
  error?: string | null;
  /**
   * Non-secret values from a submission that failed validation, so one bad
   * field does not make you retype the other four. Secret fields are never
   * echoed back — a rejected password is retyped, which is the correct cost.
   */
  submitted?: Record<string, string>;
}) {
  const { provider, existing, error } = args;
  const editing = existing !== undefined;
  const title = editing ? `${existing.id}` : `New ${provider.label} credential`;

  return layout(
    {
      title,
      tab: "credentials",
      crumb: html`<span class="crumb"><a href="/credentials">Credentials</a> / <b>${title}</b></span>`,
    },
    html`
      ${error ? html`<div class="flash">${error}</div>` : ""}

      <h2>${provider.label}</h2>
      <div class="note">
        ${provider.blurb}
        ${provider.docs
          ? html` <a href="${provider.docs}" rel="noreferrer noopener" target="_blank">Where to get one →</a>`
          : ""}
      </div>

      <form class="card" method="post" action="/credentials">
        <input type="hidden" name="provider" value="${provider.id}">
        <div class="form">
          <div class="field">
            <label for="id">Name <span class="req">— lowercase letters, digits and dashes</span></label>
            ${editing
              ? html`<input class="mono" type="text" id="id" name="id" value="${existing.id}" readonly>
                     <div class="help">A credential cannot be renamed — workflows refer to it by this name.</div>`
              : html`<input class="mono" type="text" id="id" name="id" required
                            value="${args.submitted?.["@id"] ?? args.suggestedId ?? ""}" placeholder="main"
                            pattern="[a-z0-9][a-z0-9-]*">
                     <div class="help">
                       A workflow reaches it with
                       <code class="mono">defineCredential("${provider.id}", "&lt;name&gt;")</code>.
                     </div>`}
          </div>

          <div class="field">
            <label for="folder">Folder <span class="req">— optional, for grouping only</span></label>
            <input type="text" id="folder" name="folder" list="folders"
                   value="${args.submitted?.["@folder"] ?? existing?.folder ?? ""}" placeholder="the-mantra">
            <datalist id="folders">
              ${args.folders.map((f) => html`<option value="${f}"></option>`)}
            </datalist>
          </div>

          ${provider.fields.map((f) => {
            const stored = existing?.fields.find((x) => x.name === f.name);
            const filled = stored?.set ?? false;
            return html`
              <div class="field">
                <label for="f_${f.name}">
                  ${f.label}
                  ${f.optional ? html`<span class="req">— optional</span>` : ""}
                </label>
                ${f.secret
                  ? html`<input type="password" id="f_${f.name}" name="f_${f.name}"
                                autocomplete="new-password" spellcheck="false"
                                placeholder="${filled ? "•••••••• stored — leave blank to keep" : (f.placeholder ?? "")}"
                                ${!f.optional && !filled ? raw("required") : ""}>`
                  : html`<input type="text" id="f_${f.name}" name="f_${f.name}"
                                spellcheck="false" value="${args.submitted?.[f.name] ?? stored?.value ?? ""}"
                                placeholder="${f.placeholder ?? ""}"
                                ${!f.optional ? raw("required") : ""}>`}
                ${f.help ? html`<div class="help">${f.help}</div>` : ""}
              </div>
            `;
          })}

          ${provider.envNamesForPrimary.length > 0
            ? html`
                <label class="check">
                  <input type="checkbox" name="primary" value="1"
                         ${existing?.primary ? raw("checked") : ""}>
                  <span>
                    <b>Use this for the built-in client</b>
                    Fills ${provider.envNamesForPrimary.join(", ")}, so
                    <code class="mono">ctx</code> uses it without the workflow naming a
                    credential. Only one ${provider.label} credential can do this at a time.
                  </span>
                </label>
              `
            : ""}

          <div class="bar">
            <button class="btn primary" type="submit">
              ${editing ? "Save and test" : "Connect and test"}
            </button>
            <a class="btn" href="/credentials">Cancel</a>
            <span class="muted" style="font-size:12px">
              Saving runs the connection test straight away.
            </span>
          </div>
        </div>
      </form>
    `,
  );
}

/** Create or edit one loose secret — a single value with no platform. */
export function secretFormPage(args: {
  /** Absent when creating. */
  existingKey?: string;
  folder?: string | null;
  folders: string[];
  error?: string | null;
}) {
  const editing = args.existingKey !== undefined;
  return layout(
    {
      title: editing ? args.existingKey! : "New secret",
      tab: "credentials",
      crumb: html`<span class="crumb"><a href="/credentials">Credentials</a> /
        <b>${editing ? args.existingKey! : "New secret"}</b></span>`,
    },
    html`
      ${args.error ? html`<div class="flash">${args.error}</div>` : ""}
      <div class="note">
        A single value under one name, the same thing
        <code class="mono">bun run secret -- set</code> writes. Workflows read it with
        <code class="mono">defineSecrets</code>, and integrations that read the environment
        for themselves see it too. Use a credential instead when a platform wants several
        values that only make sense together.
      </div>

      <form class="card" method="post" action="/secrets">
        <div class="form">
          <div class="field">
            <label for="key">Name <span class="req">— uppercase letters, digits and underscores</span></label>
            <input class="mono" type="text" id="key" name="key" required
                   value="${args.existingKey ?? ""}" placeholder="SOME_API_KEY"
                   pattern="[A-Z][A-Z0-9_]*" ${editing ? raw("readonly") : ""}>
          </div>
          <div class="field">
            <label for="value">Value</label>
            <input type="password" id="value" name="value"
                   autocomplete="new-password" spellcheck="false"
                   ${editing ? "" : raw("required")}
                   placeholder="${editing ? "•••••••• stored — leave blank to keep" : ""}">
            <div class="help">
              ${editing
                ? "Leave it blank to move the folder without retyping the value."
                : "Never displayed again once saved, here or over the API."}
            </div>
          </div>
          <div class="field">
            <label for="sfolder">Folder <span class="req">— optional</span></label>
            <input type="text" id="sfolder" name="folder" list="folders" value="${args.folder ?? ""}">
            <datalist id="folders">
              ${args.folders.map((f) => html`<option value="${f}"></option>`)}
            </datalist>
          </div>
          <div class="bar">
            <button class="btn primary" type="submit">Save</button>
            <a class="btn" href="/credentials">Cancel</a>
          </div>
        </div>
      </form>
    `,
  );
}
