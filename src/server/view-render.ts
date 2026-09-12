/**
 * Turning a view's panels into markup.
 *
 * Kept out of `views.ts` because that file is already the whole dashboard and
 * this is a self-contained renderer: panels in, HTML out, no knowledge of
 * routing, auth or the shell around it. The page wrappers that *do* know about
 * those live in `views.ts` and call in here for the body.
 *
 * ## The chart rules this file follows
 *
 * There is no charting library — everything is inline SVG and CSS, for the
 * same reason the dashboard has no CDN stylesheet: this thing has to render
 * correctly on a box with no outbound network.
 *
 * The colours are not the dashboard's text tokens. `--accent` and friends are
 * tuned for *links and labels on a surface*, which in dark mode makes them too
 * light to be a fill: the categorical checks put a mark's lightness in
 * OKLCH L 0.48–0.67 on a dark surface, and `--accent` sits at 0.73. So this
 * file declares its own three-slot series palette, one step deeper, validated
 * in both themes for lightness, chroma, colour-vision separation (worst pair
 * ΔE 11.3 protan / 18.0 normal in dark, 8.1 / 16.2 in light) and contrast
 * against the panel it sits on.
 *
 * Three slots and not eight, deliberately. A fourth hue that still separates
 * from these under deuteranopia does not exist in this lightness band, and the
 * honest answer to a fourth series is to fold the tail into "other" or split
 * the chart — so `series` refuses a fourth rather than inventing a colour
 * nobody can tell from the third.
 *
 * Four things that look like polish and are not:
 *
 *   - **Status colours stay reserved.** Green, red and amber mean good, bad
 *     and warning — a *state*, never "series 2". A `tone` on a stat or a bar
 *     is the only thing that reaches them.
 *   - **Every chart gets a table twin.** A value that can only be read by
 *     hovering cannot be read on a phone, by a screen reader, or on paper.
 *     The `<details>` under each chart is generated from the same numbers.
 *   - **One colour for every bar in a breakdown.** Shading each bar by its own
 *     length double-encodes what the bar already shows, and burns the only
 *     free channel to say nothing.
 *   - **The gap between two bars is the surface, not a stroke.** Outlining a
 *     mark to separate it from its neighbour thickens every mark on the page.
 */

import { html, raw } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";
import type { ControlDef, Panel, StatItem, Tone, ViewDef } from "../core/views.ts";
import { PERIOD_KEYS, PERIOD_LABELS } from "../core/views.ts";

/** The most series one chart may carry. See the header for why it is three. */
export const MAX_SERIES = 3;

/**
 * Everything the Views pages add to the dashboard's stylesheet.
 *
 * Concatenated into the one `<style>` the layout already emits rather than
 * shipped as a second block, so a view page is still a single document with a
 * single stylesheet and no second request.
 */
export const VIEW_CSS = `
/* ---- views: series palette ----
   Chart fills, not text tokens. Light mode first; the dark steps are chosen
   against the dark surface rather than flipped, and both sets are validated
   for lightness band, chroma, CVD separation and contrast. */
:root{--s1:#1f6feb;--s2:#9a6700;--s3:#0d7d5e;--grid:#e2e6ee;--track:#eef1f6}
@media (prefers-color-scheme:dark){:root{
--s1:#3f7fe0;--s2:#bd8324;--s3:#2e9d86;--grid:#232936;--track:#171b24}}

/* ---- views: list ---- */
.vlist{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:10px}
.vcard{display:flex;flex-direction:column;gap:6px;padding:14px;border-radius:10px;
background:var(--panel);border:1px solid var(--border);color:var(--fg)}
.vcard:hover{border-color:var(--accent);text-decoration:none}
.vcard b{font-weight:600;letter-spacing:-.01em}
.vcard span{color:var(--muted);font-size:12.5px;line-height:1.45}
.vcard .meta{display:flex;align-items:center;gap:8px;margin-top:2px}

/* ---- views: header + controls ----
   One filter row above everything it scopes: every panel on the page is drawn
   from the same slice, so per-panel filters would be a page that disagrees
   with itself. */
.vhead{margin-bottom:18px}
.vhead h1{font-size:20px;font-weight:600;letter-spacing:-.02em;margin:0 0 4px}
.vhead p{color:var(--muted);font-size:13px;margin:0;max-width:70ch}
.vctl{display:flex;gap:8px;align-items:end;flex-wrap:wrap;margin:14px 0 4px}
.vctl label{display:flex;flex-direction:column;gap:3px;min-width:0}
.vctl label>span{font-size:10.5px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}
.vctl select,.vctl input{background:var(--panel);border:1px solid var(--border);color:var(--fg);
border-radius:8px;padding:7px 11px;font:13px var(--sans);min-width:0}
.vctl select:focus,.vctl input:focus{outline:none;border-color:var(--accent)}

/* ---- views: panels ---- */
.vpanel{margin-bottom:18px}
.vpanel>h2{margin:0 0 10px}
.vbody{padding:14px}
.vnote{color:var(--muted);font-size:13px;line-height:1.6;margin:0}
.vempty{padding:26px 14px;text-align:center;color:var(--faint);font-size:13px}

/* ---- views: ranked bars ----
   One hue for every row. The number sits outside the bar, so a short row never
   has its own value clipped by it. */
.vbars{display:flex;flex-direction:column;gap:9px;padding:14px}
.vbar{display:grid;grid-template-columns:minmax(90px,148px) 1fr auto;gap:12px;align-items:center}
.vbar>.l{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px}
.vbar>.l i{display:block;font-style:normal;color:var(--faint);font-size:11.5px}
.vbar>.t{height:10px;border-radius:5px;background:var(--track);overflow:hidden}
.vbar>.t>i{display:block;height:100%;border-radius:0 4px 4px 0;background:var(--s1)}
.vbar>.t>i.good{background:var(--green)}.vbar>.t>i.bad{background:var(--red)}
.vbar>.t>i.warn{background:var(--yellow)}
.vbar>.v{font-family:var(--mono);font-size:12.5px;font-variant-numeric:tabular-nums;
white-space:nowrap}
.vbar>.v.good{color:var(--green)}.vbar>.v.bad{color:var(--red)}.vbar>.v.warn{color:var(--yellow)}

/* ---- views: column chart ----
   The box grows with the figure instead of fixing a height, so the x-axis band
   is never the thing that gets cropped into a nested scrollbar. */
.vchart{padding:14px 14px 6px}
.vchart svg{display:block;width:100%;height:auto;overflow:visible}
.vchart .gridline{stroke:var(--grid);stroke-width:1;shape-rendering:crispEdges}
.vchart .tick{fill:var(--faint);font-size:10px;font-family:var(--mono)}
.vchart .xlab{fill:var(--muted);font-size:11px}
.vlegend{display:flex;gap:14px;flex-wrap:wrap;padding:2px 14px 12px;font-size:12px;color:var(--muted)}
.vlegend span{display:inline-flex;align-items:center;gap:6px}
.vlegend i{width:9px;height:9px;border-radius:2px;display:inline-block}

/* ---- views: the table twin every chart carries ---- */
.vtwin{border-top:1px solid var(--border-soft)}
.vtwin>summary{cursor:pointer;list-style:none;padding:9px 14px;font-size:12px;color:var(--muted)}
.vtwin>summary::-webkit-details-marker{display:none}
.vtwin>summary:hover{color:var(--fg)}
.vtwin>summary::before{content:"▸ ";color:var(--faint)}
.vtwin[open]>summary::before{content:"▾ "}

/* ---- views: tables ---- */
.vtable{width:100%;border-collapse:collapse;font-size:13px}
.vtable th{text-align:left;font-size:10.5px;text-transform:uppercase;letter-spacing:.07em;
color:var(--faint);font-weight:600;background:var(--sunk);padding:7px 14px;white-space:nowrap}
.vtable td{padding:9px 14px;border-top:1px solid var(--border-soft);vertical-align:top}
.vtable tr:hover td{background:var(--panel-2)}
.vtable .r{text-align:right;font-variant-numeric:tabular-nums}
/* A date or an amount would rather make its table scroll than wrap in half. */
.vtable .m{font-family:var(--mono);font-size:12px;white-space:nowrap}
.vscroll{overflow-x:auto}

/* ---- views: share links ---- */
/* Collapsed by default, because minting a link is something you do once and
   then not again for months, while the panel it sat in was on every visit to
   every view — a form, a table of links and a Revoke button under the thing
   you actually came to read. Shut, it is one line that says whether any link
   exists; the count is the half of it worth seeing at a glance, since "this
   page is reachable without signing in" is not something to have to open a
   drawer to find out.
   Native <details>, so it costs no script and survives with JavaScript off —
   the same bargain the .menu and .folder disclosures on the dashboard make.
   Never rendered on the public page, which has no sharing box at all. */
details.vshared{margin-top:26px}
details.vshared>summary{display:flex;align-items:center;gap:9px;cursor:pointer;
list-style:none;padding:11px 14px;font-size:12.5px;color:var(--muted)}
details.vshared>summary::-webkit-details-marker{display:none}
details.vshared>summary:hover{color:var(--fg)}
details.vshared>summary b{color:var(--fg);font-weight:600;font-size:12.5px}
details.vshared>summary .n{margin-left:auto;font-size:11px;font-variant-numeric:tabular-nums;
padding:0 7px;border-radius:20px;background:var(--panel-2);color:var(--muted);line-height:17px}
/* The chevron is last so it stays pinned to the edge past the count. */
details.vshared>summary::after{content:"";width:5px;height:5px;flex:none;
border-right:1.6px solid var(--faint);border-bottom:1.6px solid var(--faint);
transform:rotate(-45deg);transition:transform .15s}
details.vshared[open]>summary::after{transform:rotate(45deg)}
details.vshared[open]>summary{border-bottom:1px solid var(--border-soft)}
.vshare{display:flex;flex-direction:column;gap:10px;padding:14px}
.vtoken{font-family:var(--mono);font-size:12px;word-break:break-all;background:var(--sunk);
border:1px solid var(--border);border-radius:8px;padding:10px 12px;color:var(--fg)}

/* ---- views: the public page ---- */
.pubwrap{max-width:1120px;margin:0 auto;padding:26px 20px 72px}
.pubfoot{margin-top:28px;color:var(--faint);font-size:11.5px;text-align:center}
`;

/* ------------------------------------------------------------------ bits */

const toneClass = (tone: Tone | undefined) =>
  tone && tone !== "plain" ? tone : "";

/** Compact axis ticks: 1.2k, 340, 2.5m. Never the full number on an axis. */
function compact(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${trim(value / 1_000_000)}m`;
  if (abs >= 1_000) return `${trim(value / 1_000)}k`;
  return trim(value);
}

function trim(n: number): string {
  const rounded = Math.round(n * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

/**
 * A round number at or above the largest value, so the top gridline is a
 * number somebody would say out loud rather than 41,387.
 */
function niceMax(max: number): number {
  if (max <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(max));
  for (const step of [1, 1.5, 2, 2.5, 3, 4, 5, 7.5, 10]) {
    if (max <= step * magnitude) return step * magnitude;
  }
  return 10 * magnitude;
}

/* ---------------------------------------------------------------- panels */

function statsPanel(items: StatItem[]) {
  return html`<div class="stats">
    ${items.map(
      (s) => html`<div class="stat">
        <b class="${toneClass(s.tone)}">${s.value}</b>
        <span>${s.label}</span>
        ${s.sub ? html`<div class="desc">${s.sub}</div>` : ""}
      </div>`,
    )}
  </div>`;
}

function barsPanel(panel: Extract<Panel, { kind: "bars" }>) {
  // Widths are relative to the largest *magnitude*, so a breakdown that
  // contains a negative row still draws every other row at a sane size
  // instead of collapsing them against an outlier's sign.
  const max = Math.max(1, ...panel.rows.map((r) => Math.abs(r.value)));
  return card(
    panel.title,
    panel.note,
    panel.rows.length === 0
      ? html`<div class="vempty">${panel.empty ?? "Nothing in this period."}</div>`
      : html`<div class="vbars">
          ${panel.rows.map(
            (r) => html`<div class="vbar">
              <div class="l">${r.label}${r.sub ? html`<i>${r.sub}</i>` : ""}</div>
              <div class="t">
                <i
                  class="${toneClass(r.tone)}"
                  style="${raw(`width:${((Math.max(0, r.value) / max) * 100).toFixed(2)}%`)}"
                ></i>
              </div>
              <div class="v ${toneClass(r.tone)}">${r.display ?? String(r.value)}</div>
            </div>`,
          )}
        </div>`,
  );
}

/**
 * A grouped column chart.
 *
 * Geometry in a fixed coordinate system scaled by the viewBox, so the figure
 * is responsive without a resize listener, and the box includes the x-axis
 * band rather than clipping it.
 */
function seriesPanel(panel: Extract<Panel, { kind: "series" }>) {
  const { legend, points } = panel;
  if (legend.length > MAX_SERIES) {
    throw new Error(
      `a series panel carries at most ${MAX_SERIES} series (got ${legend.length}) — ` +
        `fold the tail into one "other" series or split the chart`,
    );
  }
  for (const p of points) {
    if (p.values.length !== legend.length) {
      throw new Error(
        `series point "${p.label}" has ${p.values.length} value(s) but the legend names ${legend.length}`,
      );
    }
  }

  if (points.length === 0) {
    return card(
      panel.title,
      panel.note,
      html`<div class="vempty">${panel.empty ?? "Nothing in this period."}</div>`,
    );
  }

  const W = 760;
  const padL = 48;
  const padR = 6;
  const padT = 10;
  const plotH = 180;
  const axisH = 24;
  const H = padT + plotH + axisH;

  const max = niceMax(Math.max(0, ...points.flatMap((p) => p.values)));
  const plotW = W - padL - padR;
  const groupW = plotW / points.length;
  // A 2px gap of bare surface between neighbouring bars, rather than a stroke
  // around each one — an outline thickens every mark on the page.
  const gap = 2;
  const inset = Math.min(groupW * 0.16, 14);
  const barW = Math.max(2, (groupW - inset * 2 - gap * (legend.length - 1)) / legend.length);
  const y = (v: number) => padT + plotH - (Math.max(0, v) / max) * plotH;
  // Every label if they fit, otherwise every other one — a collided axis is
  // less readable than a sparse one, and the table twin has them all.
  const labelEvery = points.length > 14 ? Math.ceil(points.length / 12) : 1;

  const ticks = [0, 0.25, 0.5, 0.75, 1];
  const colour = (i: number) => `var(--s${i + 1})`;

  return card(
    panel.title,
    panel.note,
    html`<div class="vchart">
        <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${panel.title ?? "Chart"}">
          ${ticks.map((t) => {
            const yy = padT + plotH - t * plotH;
            return html`<g>
              <line class="gridline" x1="${padL}" y1="${yy}" x2="${W - padR}" y2="${yy}" />
              <text class="tick" x="${padL - 8}" y="${yy + 3}" text-anchor="end">
                ${(panel.unit ? `${panel.unit} ` : "") + compact(max * t)}
              </text>
            </g>`;
          })}
          ${points.map((p, gi) => {
            const gx = padL + gi * groupW + inset;
            return html`<g>
              ${p.values.map((v, si) => {
                const top = y(v);
                const height = padT + plotH - top;
                return html`<rect
                  x="${gx + si * (barW + gap)}"
                  y="${top}"
                  width="${barW}"
                  height="${Math.max(0, height)}"
                  rx="${Math.min(4, barW / 2)}"
                  fill="${colour(si)}"
                ><title>${`${p.label} · ${legend[si]}: ${p.displays?.[si] ?? String(v)}`}</title></rect>`;
              })}
              ${gi % labelEvery === 0
                ? html`<text
                    class="xlab"
                    x="${padL + gi * groupW + groupW / 2}"
                    y="${padT + plotH + 16}"
                    text-anchor="middle"
                  >
                    ${p.label}
                  </text>`
                : ""}
            </g>`;
          })}
        </svg>
      </div>
      ${legend.length > 1
        ? html`<div class="vlegend">
            ${legend.map(
              (name, i) =>
                html`<span
                  ><i style="${raw(`background:${colour(i)}`)}"></i>${name}</span
                >`,
            )}
          </div>`
        : ""}
      <details class="vtwin">
        <summary>Show the numbers</summary>
        <div class="vscroll">
          <table class="vtable">
            <thead>
              <tr>
                <th></th>
                ${legend.map((name) => html`<th class="r">${name}</th>`)}
              </tr>
            </thead>
            <tbody>
              ${points.map(
                (p) => html`<tr>
                  <td class="m">${p.label}</td>
                  ${p.values.map(
                    (v, i) => html`<td class="r m">${p.displays?.[i] ?? String(v)}</td>`,
                  )}
                </tr>`,
              )}
            </tbody>
          </table>
        </div>
      </details>`,
  );
}

function rowsPanel(panel: Extract<Panel, { kind: "rows" }>) {
  return card(
    panel.title,
    panel.note,
    panel.data.length === 0
      ? html`<div class="vempty">${panel.empty ?? "Nothing in this period."}</div>`
      : html`<div class="vscroll">
          <table class="vtable">
            <thead>
              <tr>
                ${panel.columns.map(
                  (c) => html`<th class="${c.align === "right" ? "r" : ""}">${c.label}</th>`,
                )}
              </tr>
            </thead>
            <tbody>
              ${panel.data.map(
                (row) => html`<tr>
                  ${panel.columns.map((c) => {
                    const cls = [c.align === "right" ? "r" : "", c.mono ? "m" : ""]
                      .filter(Boolean)
                      .join(" ");
                    const cell = row[c.key];
                    return html`<td class="${cls}">${cell === null || cell === undefined ? "—" : String(cell)}</td>`;
                  })}
                </tr>`,
              )}
            </tbody>
          </table>
        </div>`,
  );
}

/** A titled card. The title is a heading outside the box, as everywhere else. */
function card(
  title: string | undefined,
  note: string | undefined,
  body: HtmlEscapedString | Promise<HtmlEscapedString>,
) {
  return html`<section class="vpanel">
    ${title ? html`<h2>${title}</h2>` : ""}
    <div class="card">
      ${note ? html`<div class="vbody"><p class="vnote">${note}</p></div>` : ""} ${body}
    </div>
  </section>`;
}

/**
 * Renders a whole page of panels.
 *
 * A panel that throws is rendered as the error rather than taking the page
 * down with it: a view is a read, and one broken chart is worth strictly less
 * than the five working ones beside it.
 */
export function renderPanels(panels: Panel[]) {
  return html`${panels.map((panel) => {
    try {
      switch (panel.kind) {
        case "stats":
          return statsPanel(panel.items);
        case "bars":
          return barsPanel(panel);
        case "series":
          return seriesPanel(panel);
        case "rows":
          return rowsPanel(panel);
        case "note":
          return card(panel.title, undefined, html`<div class="vbody"><p class="vnote">${panel.body}</p></div>`);
      }
    } catch (err) {
      return card(
        undefined,
        undefined,
        html`<div class="vempty">
          This panel could not be drawn — ${err instanceof Error ? err.message : String(err)}
        </div>`,
      );
    }
  })}`;
}

/* -------------------------------------------------------------- controls */

/**
 * The filter row — one row, above everything it scopes.
 *
 * A GET form, so the current filter is in the URL: that is what makes a view
 * bookmarkable, and what makes a share link able to carry the slice its sender
 * was looking at.
 */
export function renderControls(def: ViewDef, values: Record<string, string>, action: string) {
  const entries = Object.entries(def.controls ?? {});
  if (entries.length === 0) return html``;

  return html`<form class="vctl" method="get" action="${action}">
    ${entries.map(([key, control]) => renderControl(key, control, values[key] ?? ""))}
    <button class="btn" type="submit">Apply</button>
  </form>`;
}

function renderControl(key: string, control: ControlDef, value: string) {
  if (control.kind === "period") {
    const options = control.options ?? PERIOD_KEYS;
    return html`<label>
      <span>${control.label ?? "Period"}</span>
      <select name="${key}">
        ${options.map(
          (o) =>
            html`<option value="${o}" ${o === value ? raw("selected") : ""}>
              ${PERIOD_LABELS[o] ?? o}
            </option>`,
        )}
      </select>
    </label>`;
  }
  if (control.kind === "select") {
    const options = control.options.map((o) =>
      typeof o === "string" ? { value: o, label: o } : o,
    );
    return html`<label>
      <span>${control.label ?? key}</span>
      <select name="${key}">
        ${control.all !== undefined
          ? html`<option value="" ${value === "" ? raw("selected") : ""}>${control.all}</option>`
          : ""}
        ${options.map(
          (o) =>
            html`<option value="${o.value}" ${o.value === value ? raw("selected") : ""}>
              ${o.label}
            </option>`,
        )}
      </select>
    </label>`;
  }
  return html`<label>
    <span>${control.label ?? key}</span>
    <input type="search" name="${key}" value="${value}" placeholder="${control.placeholder ?? ""}" />
  </label>`;
}
