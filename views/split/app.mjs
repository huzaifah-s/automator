// The split-bills app — what a share link of views/split/split.ts opens.
//
// Plain browser JavaScript, no build step: the server inlines this file into
// the page (see `app` on ViewDef). It reads everything from `<base>/data`,
// which split.ts's `app.data()` builds with the same maths as the dashboard,
// and writes through `<base>/api/rows/<table>`, which only accepts the tables
// in the view's `entry` and validates like every other write.
//
// Screens are hash routes so the phone's back button works:
//   #/               overall: your balance, every group, recent activity
//   #/g/<id>         one group: balances, settle up, its expenses
//   #/add?g=<id>     add an expense      #/e/<id>    edit one
//   #/pay?g=…        record a payment    #/p/<id>    edit one
//   #/group[/<id>]   new / edit a group  #/people    people
//
// A link is a person (see split.ts): `D.who.me` is who this link opens as.
// A link that is nobody yet adds its holder on first open, or — when there
// are people no link opens as yet — shows "Who are you?" once instead of
// everything else.
//
// Everything typed by a person reaches the page through text nodes (`h()`),
// never innerHTML.

const V = window.VIEW;
const app = document.getElementById("app");
let D = null;

/* ------------------------------------------------------------- helpers */

function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "value") el.value = v;
    else if (k === "checked" || k === "disabled" || k === "selected") el[k] = true;
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  return el;
}

const enc = encodeURIComponent;
const money = (c) =>
  "RM " + (Math.abs(c) / 100).toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const toCents = (s) => {
  const t = String(s ?? "").replace(/[, ]/g, "").replace(/^rm/i, "");
  if (t === "") return NaN;
  const n = Number(t);
  return Number.isFinite(n) ? Math.round(n * 100) : NaN;
};
const toNum = (s) => {
  const t = String(s ?? "").replace(/[% ]/g, "");
  return t === "" ? NaN : Number(t);
};
const trimNum = (n) => String(Math.round(n * 100) / 100);
const pad = (n) => String(n).padStart(2, "0");
const todayIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const parseIso = (iso) => {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d);
};
const monthOf = (iso) => parseIso(iso).toLocaleString("en-GB", { month: "long", year: "numeric" });
const store = {
  get(k) {
    try { return localStorage.getItem(k); } catch { return null; }
  },
  set(k, v) {
    try { localStorage.setItem(k, v); } catch {}
  },
};

/** Divides cents by weights in whole cents that add up — the same rule as _split.ts. */
function allocate(amount, weights) {
  const out = {};
  const total = weights.reduce((n, [, w]) => n + w, 0);
  const size = Math.abs(amount);
  const sign = amount < 0 ? -1 : 1;
  if (!(total > 0)) {
    for (const [n] of weights) out[n] = 0;
    return out;
  }
  const ex = weights.map(([n, w], i) => ({ n, i, raw: (size * w) / total }));
  let left = size;
  for (const e of ex) {
    const whole = Math.floor(e.raw + 1e-9);
    out[e.n] = whole;
    left -= whole;
  }
  const frac = (e) => e.raw - Math.floor(e.raw + 1e-9);
  const by = [...ex].sort((a, b) => frac(b) - frac(a) || a.i - b.i);
  for (let k = 0; left > 0 && by.length; k = (k + 1) % by.length, left--) out[by[k].n]++;
  if (sign < 0) for (const k in out) out[k] = -out[k];
  return out;
}

const me = () => D.who.me;
const BAD_NAME = /[,;&+\d%]|\band\b/i;
const cleanName = (s) => String(s ?? "").trim().replace(/\s+/g, " ");
const You = (n) => (n === me() ? "You" : n);
const you = (n) => (n === me() ? "you" : n);
const groupById = (id) => D.groups.find((g) => g.id === id);
const groupByName = (n) => D.groups.find((g) => g.name === n);

/** Who an expense or payment can involve: the group first, then everyone else. */
function castOf(group, extra = []) {
  const out = [...(group?.members ?? [])];
  for (const n of [...D.people.map((p) => p.name), ...extra]) if (n && !out.includes(n)) out.push(n);
  return out;
}

function owesLine(t) {
  const m = me();
  if (t.from === m) return `You owe ${t.to} ${money(t.cents)}`;
  if (t.to === m) return `${t.from} owes you ${money(t.cents)}`;
  return `${t.from} owes ${t.to} ${money(t.cents)}`;
}

const COLORS = ["#5b8def", "#e0795a", "#3fb68b", "#b06fd6", "#d9a23c", "#4cb3c9", "#e0608f", "#7f8c4d"];
function avatar(name) {
  let x = 0;
  for (const ch of name) x = (x * 31 + ch.charCodeAt(0)) >>> 0;
  return h("span", { class: "av", style: `background:${COLORS[x % COLORS.length]}` }, name.slice(0, 1).toUpperCase());
}

/* ----------------------------------------------------------------- I/O */

async function load() {
  const r = await fetch(V.base + "/data", { cache: "no-store" });
  const j = await r.json().catch(() => ({ error: `Could not load (HTTP ${r.status})` }));
  if (!r.ok || j.error) throw new Error(j.error || `Could not load (HTTP ${r.status})`);
  D = j;
}

async function api(path, body) {
  const r = await fetch(`${V.base}/api/rows/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const j = await r.json().catch(() => ({ error: `Could not save (HTTP ${r.status})` }));
  if (!r.ok || j.error) throw new Error(friendly(j.error || `Could not save (HTTP ${r.status})`));
  return j;
}
const insert = (t, v) => api(t, v);

/**
 * Adds anyone in `names` who is not on People yet — a link holder ticked into
 * a group before they have opened their link. A name a link already
 * resolves to by spelling needs nothing more than the row.
 */
async function ensurePeople(names) {
  let added = false;
  for (const n of names) {
    if (D.people.some((p) => p.name.toLowerCase() === n.toLowerCase())) continue;
    try {
      await insert("split_people", { name: n });
    } catch (err) {
      // Somebody else added them a moment ago; anything else is real.
      if (!/already taken/.test(err.message)) throw err;
    }
    added = true;
  }
  if (added) await load();
}
const update = (t, id, v) => api(`${t}/${enc(id)}`, v);
const remove = (t, id) => api(`${t}/${enc(id)}/delete`);

/** The server speaks in column names; a person reads the sentence after them. */
function friendly(msg) {
  if (/already exists/.test(msg)) return "That name is already taken.";
  return msg.replace(/^split_\w+(\.\w+)?:\s*/, "").replace(/split_people\.name/g, "person");
}

/* -------------------------------------------------------------- router */

function route() {
  const raw = location.hash.replace(/^#\/?/, "");
  const [path, qs] = raw.split("?");
  return { parts: path.split("/").filter(Boolean).map(decodeURIComponent), q: new URLSearchParams(qs || "") };
}

const isForm = () => /^#\/(add|e|pay|p|group|people|settle)\b/.test(location.hash);

function render() {
  const { parts, q } = route();
  const [a, b] = parts;
  let view;
  try {
    if (!D.who.me) view = whoAreYou();
    else if (a === "g") view = groupView(b);
    else if (a === "add") view = expenseForm(null, q);
    else if (a === "e") view = expenseForm(b, q);
    else if (a === "pay") view = paymentForm(null, q);
    else if (a === "p") view = paymentForm(b, q);
    else if (a === "group") view = groupForm(b ?? null);
    else if (a === "people") view = peopleView();
    else if (a === "settle") view = settleForm(q);
    else view = homeView();
  } catch (err) {
    view = page(bar("Split bills", { back: "#/" }), h("div", { class: "err" }, String(err?.message ?? err)));
  }
  fill(app, view);
}

function go(hash) {
  if (location.hash === hash) render();
  else location.hash = hash;
}

/* --------------------------------------------------------------- frame */

const page = (...kids) => h("main", { class: "page" }, ...kids);
/** `replaceChildren` prints a null as the word "null"; this skips it, like `h()` does. */
const fill = (el, ...kids) => el.replaceChildren(...kids.flat(Infinity).filter((k) => k != null && k !== false));

function bar(title, { back, action } = {}) {
  return h(
    "header",
    { class: "bar" },
    back ? h("a", { class: "back", href: back }, "‹ Back") : h("span"),
    h("h1", {}, title),
    action ?? h("span"),
  );
}

const section = (title, action) => h("div", { class: "sec" }, h("h2", {}, title), action ?? null);

/* ---------------------------------------------------------------- home */

function homeView() {
  const m = me();
  const kids = [];

  const net = m ? D.overall.net[m] ?? 0 : 0;
  kids.push(
    h(
      "header",
      { class: "hero" },
      h("div", { class: "hello" }, m ? `Hi ${m} · overall` : "Split bills · overall"),
      !m
        ? h("div", { class: "big" }, pairTotals().length ? "Balances to settle" : "Everyone's settled up")
        : net > 0
          ? h("div", { class: "big good" }, `You're owed ${money(net)}`)
          : net < 0
            ? h("div", { class: "big warn" }, `You owe ${money(-net)}`)
            : h("div", { class: "big" }, "You're all settled up"),
    ),
  );

  const lines = pairTotals().sort(
    (a, b) => Number(b.from === m || b.to === m) - Number(a.from === m || a.to === m),
  );
  if (lines.length) {
    kids.push(
      h(
        "div",
        { class: "list" },
        lines.map((t) =>
          h(
            "div",
            { class: "item" },
            avatar(t.from === m ? t.to : t.from),
            h("div", { class: "grow" }, h("div", { class: "t" }, owesLine(t))),
            h("a", { class: "pill", href: `#/settle?a=${enc(t.from)}&b=${enc(t.to)}` }, "Settle up"),
          ),
        ),
        h("div", { class: "foot" }, "Added up across your groups. Settle up clears it in every group with one payment."),
      ),
    );
  }

  if (D.problems.length) kids.push(problemsCard());

  kids.push(section("Groups", h("a", { class: "pill", href: "#/group" }, "+ New group")));
  if (!D.groups.length) {
    kids.push(
      h(
        "div",
        { class: "empty" },
        h("b", {}, "Start with a group"),
        h("p", {}, "One for the two of you at home, and one for each trip or event with friends."),
        h("a", { class: "btn primary", href: "#/group" }, "Create a group"),
      ),
    );
  } else {
    kids.push(
      h(
        "div",
        { class: "list" },
        D.groups.map((g) => {
          const mine = m ? g.net[m] ?? 0 : 0;
          const involved = m && (g.members.includes(m) || m in g.net);
          const badge = involved
            ? mine > 0
              ? h("div", { class: "amt good" }, "you're owed", h("b", {}, money(mine)))
              : mine < 0
                ? h("div", { class: "amt warn" }, "you owe", h("b", {}, money(-mine)))
                : h("div", { class: "amt muted" }, "settled up")
            : h("div", { class: "amt muted" }, g.transfers.length ? `${g.transfers.length} to settle` : "settled up");
          return h(
            "a",
            { class: "item", href: `#/g/${enc(g.id)}` },
            h("span", { class: "gi" }, g.name.slice(0, 1).toUpperCase()),
            h(
              "div",
              { class: "grow" },
              h("div", { class: "t" }, g.name),
              h("div", { class: "s" }, `${g.members.length} ${g.members.length === 1 ? "person" : "people"} · ${money(g.spent)} spent`),
            ),
            badge,
          );
        }),
      ),
    );
  }

  const recent = activity(null).slice(0, 8);
  if (recent.length) {
    kids.push(section("Recent"));
    kids.push(h("div", { class: "list" }, recent.map((x) => activityRow(x, true))));
  }

  kids.push(
    h(
      "div",
      { class: "links" },
      h("a", { href: "#/people" }, "People"),
      h("span", {}, m && m.toLowerCase() !== V.label.trim().toLowerCase() ? `${m} · link “${V.label}”` : `${V.label}'s link`),
    ),
  );
  if (D.groups.length) kids.push(h("a", { class: "fab", href: "#/add" }, "+ Add expense"));
  return page(...kids);
}

function problemsCard() {
  const href = (p) =>
    p.table === "split_expenses" ? `#/e/${enc(p.id)}` : p.table === "split_payments" ? `#/p/${enc(p.id)}` : p.table === "split_groups" ? `#/group/${enc(p.id)}` : null;
  return h(
    "details",
    { class: "problems" },
    h("summary", {}, `⚠ ${D.problems.length} ${D.problems.length === 1 ? "thing needs" : "things need"} fixing`),
    h(
      "div",
      {},
      D.problems.map((p) => {
        const link = href(p);
        return h(link ? "a" : "div", { class: "item", href: link }, h("div", { class: "grow" }, h("div", { class: "t" }, p.what), h("div", { class: "s" }, p.problem)));
      }),
    ),
  );
}

/** Expenses and payments, newest first — all of them, or one group's. */
function activity(groupName) {
  const items = [
    ...D.expenses.filter((e) => !groupName || e.group_name === groupName).map((e) => ({ kind: "e", on: e.spent_on, at: e.created_at, e })),
    ...D.payments.filter((p) => !groupName || p.group_name === groupName).map((p) => ({ kind: "p", on: p.paid_on, at: p.created_at, p })),
  ];
  return items.sort((a, b) => (a.on < b.on ? 1 : a.on > b.on ? -1 : b.at - a.at));
}

function dateChip(iso) {
  const d = parseIso(iso);
  return h("div", { class: "date" }, d.toLocaleString("en-GB", { month: "short" }), h("b", {}, d.getDate()));
}

function activityRow(x, showGroup) {
  const m = me();
  if (x.kind === "p") {
    const p = x.p;
    return h(
      "a",
      { class: "item", href: `#/p/${enc(p.id)}` },
      dateChip(p.paid_on),
      h(
        "div",
        { class: "grow" },
        h("div", { class: "t" }, `${You(p.paid_by)} paid ${you(p.paid_to)}`),
        h("div", { class: "s" }, ["Paid back", showGroup ? p.group_name : null, p.note].filter(Boolean).join(" · ")),
      ),
      h("div", { class: "amt good" }, h("b", {}, money(p.amount_cents))),
    );
  }
  const e = x.e;
  let right;
  if (e.error) right = h("div", { class: "amt bad" }, "needs fixing");
  else if (m) {
    const diff = (e.paid_by === m ? e.amount_cents : 0) - (e.shares?.[m] ?? 0);
    right =
      diff > 0
        ? h("div", { class: "amt good" }, "you lent", h("b", {}, money(diff)))
        : diff < 0
          ? h("div", { class: "amt warn" }, "you borrowed", h("b", {}, money(-diff)))
          : h("div", { class: "amt muted" }, e.paid_by === m ? "just yours" : "not involved");
  } else right = h("div", { class: "amt" }, h("b", {}, money(e.amount_cents)));
  return h(
    "a",
    { class: "item", href: `#/e/${enc(e.id)}` },
    dateChip(e.spent_on),
    h(
      "div",
      { class: "grow" },
      h("div", { class: "t" }, e.item),
      h(
        "div",
        { class: e.error ? "s bad" : "s" },
        e.error ? `⚠ ${e.error}` : [`${You(e.paid_by)} paid ${money(e.amount_cents)}`, showGroup ? e.group_name : null].filter(Boolean).join(" · "),
      ),
    ),
    right,
  );
}

/* --------------------------------------------------------------- group */

function groupView(id) {
  const g = groupById(id);
  if (!g) return page(bar("Group", { back: "#/" }), h("div", { class: "err" }, "That group is gone."));
  store.set("split:group", g.id);
  const m = me();
  const kids = [bar(g.name, { back: "#/", action: h("a", { class: "link", href: `#/group/${enc(g.id)}` }, "Edit") })];

  const mine = m ? g.net[m] ?? 0 : 0;
  kids.push(
    h(
      "header",
      { class: "hero small" },
      h("div", { class: "hello" }, `${g.members.join(", ")} · ${money(g.spent)} spent`),
      m && (g.members.includes(m) || m in g.net)
        ? mine > 0
          ? h("div", { class: "big good" }, `You're owed ${money(mine)}`)
          : mine < 0
            ? h("div", { class: "big warn" }, `You owe ${money(-mine)}`)
            : h("div", { class: "big" }, "You're settled up")
        : h("div", { class: "big" }, g.transfers.length ? "Balances to settle" : "Everyone's settled up"),
    ),
  );

  kids.push(
    h(
      "div",
      { class: "actions" },
      h("a", { class: "btn primary", href: `#/add?g=${enc(g.id)}` }, "+ Add expense"),
      h("a", { class: "btn", href: `#/pay?g=${enc(g.id)}` }, "Pay someone back"),
    ),
  );

  const items = activity(g.name);
  if (items.length) kids.push(section("Settle up"));
  if (items.length) kids.push(
    h(
      "div",
      { class: "list" },
      g.transfers.length
        ? g.transfers.map((t) =>
            h(
              "div",
              { class: "item" },
              avatar(t.from),
              h("div", { class: "grow" }, h("div", { class: "t" }, owesLine(t))),
              h(
                "a",
                { class: "pill", href: `#/pay?g=${enc(g.id)}&from=${enc(t.from)}&to=${enc(t.to)}&amt=${t.cents}` },
                "Paid",
              ),
            ),
          )
        : h("div", { class: "item muted" }, "Nobody owes anybody in this group."),
      g.transfers.length
        ? h("div", { class: "foot" }, "Tap Paid once the money has actually moved — it records the payment.")
        : null,
    ),
  );

  const balances = Object.entries(g.net);
  if (balances.length) {
    kids.push(section("Balances"));
    kids.push(
      h(
        "div",
        { class: "list" },
        g.members
          .concat(Object.keys(g.net).filter((n) => !g.members.includes(n)))
          .map((n) => {
            const c = g.net[n] ?? 0;
            return h(
              "div",
              { class: "item" },
              avatar(n),
              h("div", { class: "grow" }, h("div", { class: "t" }, n === m ? `${n} (you)` : n)),
              c > 0
                ? h("div", { class: "amt good" }, "gets back", h("b", {}, money(c)))
                : c < 0
                  ? h("div", { class: "amt warn" }, "owes", h("b", {}, money(-c)))
                  : h("div", { class: "amt muted" }, "settled up"),
            );
          }),
      ),
    );
  }

  if (!items.length) {
    kids.push(h("div", { class: "empty" }, h("b", {}, "No expenses yet"), h("p", {}, "Add the first one with the button above.")));
  }
  let month = null;
  let list = null;
  for (const x of items) {
    const mo = monthOf(x.on);
    if (mo !== month) {
      month = mo;
      kids.push(section(mo));
      list = h("div", { class: "list" });
      kids.push(list);
    }
    list.append(activityRow(x, false));
  }
  kids.push(h("a", { class: "fab", href: `#/add?g=${enc(g.id)}` }, "+ Add expense"));
  return page(...kids);
}

/* ------------------------------------------------------------- expense */

const MODES = { usual: "Usual", equal: "Equally", pct: "By %", rm: "By RM" };

function initialSplit(editing, group) {
  const base = { ticked: new Set(group.members), pct: {}, rm: {}, showOthers: false };
  const text = editing?.split?.trim() ?? "";
  if (!text) return { ...base, mode: group.usual ? "usual" : "equal" };
  if (/^(split\s+)?(equal|equally|even|evenly)$/i.test(text)) return { ...base, mode: "equal" };
  const cast = castOf(group, Object.keys(editing.shares ?? {}));
  const others = (names) => names.some((n) => !group.members.includes(n));

  if (text.includes("%")) {
    const pct = {};
    const ok = text
      .split(/\s*(?:,|;|\n|&|\+|\band\b)\s*/i)
      .filter(Boolean)
      .every((piece) => {
        const m = /^(.*?\S)[\s:=-]+(\d+(?:\.\d+)?)\s*%$/.exec(piece);
        const name = m && cast.find((n) => n.toLowerCase() === m[1].trim().toLowerCase());
        if (!name) return false;
        pct[name] = m[2];
        return true;
      });
    if (ok) return { ...base, mode: "pct", pct, showOthers: others(Object.keys(pct)) };
  }
  const shares = editing.shares;
  if (shares) {
    const names = cast.filter((n) => (shares[n] ?? 0) !== 0);
    const vals = names.map((n) => shares[n]);
    if (names.length && Math.max(...vals) - Math.min(...vals) <= 1) {
      return { ...base, mode: "equal", ticked: new Set(names), showOthers: others(names) };
    }
    const rm = {};
    for (const n of names) rm[n] = (shares[n] / 100).toFixed(2);
    return { ...base, mode: "rm", rm, showOthers: others(names) };
  }
  return { ...base, mode: "equal" };
}

function expenseForm(id, q) {
  const editing = id ? D.expenses.find((e) => e.id === id) : null;
  if (id && !editing) return page(bar("Expense", { back: "#/" }), h("div", { class: "err" }, "That expense is gone."));
  if (!D.groups.length) return needGroup();
  const m = me();

  let group =
    (editing && groupByName(editing.group_name)) || groupById(q.get("g")) || groupById(store.get("split:group")) || D.groups[0];
  const back = `#/g/${enc(group.id)}`;
  const f = {
    item: editing?.item ?? "",
    amount: editing ? (editing.amount_cents / 100).toFixed(2) : "",
    date: editing?.spent_on ?? todayIso(),
    paid_by: editing?.paid_by ?? null,
    category: editing?.category ?? "other",
    note: editing?.note ?? "",
  };
  let sp = initialSplit(editing, group);
  let error = editing?.error ? `This one needs fixing: ${editing.error}` : null;
  let saving = false;

  const shell = page();
  const refs = {};

  const cast = () => castOf(group, [...Object.keys(editing?.shares ?? {}), editing?.paid_by]);
  const defaultPayer = () => (m && cast().includes(m) ? m : group.members[0] ?? cast()[0]);

  /** Who is in, under the current mode. */
  const involved = () => {
    const c = cast();
    if (sp.mode === "equal") return c.filter((n) => sp.ticked.has(n));
    if (sp.mode === "pct") return c.filter((n) => toNum(sp.pct[n]) > 0);
    if (sp.mode === "rm") return c.filter((n) => toCents(sp.rm[n]) > 0);
    return Object.keys(group.usual ?? {});
  };

  function setMode(mode) {
    const amt = toCents(f.amount);
    const who = involved().length ? involved() : [...group.members];
    if (mode === "equal") sp.ticked = new Set(who);
    if (mode === "pct") {
      if (sp.mode === "usual" && group.usual) {
        sp.pct = Object.fromEntries(Object.entries(group.usual).map(([n, v]) => [n, trimNum(v)]));
      } else {
        const each = allocate(10000, who.map((n) => [n, 1]));
        sp.pct = Object.fromEntries(who.map((n) => [n, trimNum(each[n] / 100)]));
      }
    }
    if (mode === "rm") {
      const shares = evaluate().shares;
      sp.rm = {};
      if (amt > 0) {
        const each = shares ?? allocate(amt, who.map((n) => [n, 1]));
        for (const n of Object.keys(each)) if (each[n]) sp.rm[n] = (each[n] / 100).toFixed(2);
      }
    }
    sp.mode = mode;
    draw();
  }

  function evaluate() {
    const amt = toCents(f.amount);
    if (!(amt > 0)) return { ok: false, why: "Enter the amount first", shares: null };
    const c = cast();
    if (sp.mode === "usual") {
      return { ok: true, shares: allocate(amt, Object.entries(group.usual)) };
    }
    if (sp.mode === "equal") {
      const names = c.filter((n) => sp.ticked.has(n));
      if (!names.length) return { ok: false, why: "Tick at least one person", shares: null };
      return { ok: true, shares: allocate(amt, names.map((n) => [n, 1])) };
    }
    if (sp.mode === "pct") {
      const entries = c.filter((n) => String(sp.pct[n] ?? "").trim() !== "").map((n) => [n, toNum(sp.pct[n])]);
      if (entries.some(([, v]) => !(v >= 0))) return { ok: false, why: "A percentage isn't a number", shares: null };
      const sum = entries.reduce((n, [, v]) => n + v, 0);
      const shares = allocate(amt, entries.filter(([, v]) => v > 0));
      if (Math.abs(sum - 100) > 0.0001) {
        return {
          ok: false,
          shares,
          why: sum < 100 ? `${trimNum(100 - sum)}% left to assign` : `${trimNum(sum - 100)}% too much`,
        };
      }
      return { ok: true, shares, info: "100% assigned" };
    }
    const entries = c.filter((n) => String(sp.rm[n] ?? "").trim() !== "").map((n) => [n, toCents(sp.rm[n])]);
    if (entries.some(([, v]) => !(v >= 0))) return { ok: false, why: "An amount isn't a number", shares: null };
    const shares = Object.fromEntries(entries);
    const diff = amt - entries.reduce((n, [, v]) => n + v, 0);
    if (diff !== 0) {
      return { ok: false, shares, why: diff > 0 ? `${money(diff)} left to assign` : `${money(-diff)} too much` };
    }
    return { ok: true, shares, info: `All ${money(amt)} assigned` };
  }

  function splitText() {
    const c = cast();
    if (sp.mode === "usual") return null;
    if (sp.mode === "equal") {
      const names = c.filter((n) => sp.ticked.has(n));
      const wholeGroup = names.length === group.members.length && group.members.every((n) => sp.ticked.has(n));
      if (wholeGroup) return group.split ? "equal" : null;
      return names.join(", ");
    }
    if (sp.mode === "pct") {
      return c.filter((n) => toNum(sp.pct[n]) > 0).map((n) => `${n} ${trimNum(toNum(sp.pct[n]))}%`).join(", ");
    }
    return c.filter((n) => toCents(sp.rm[n]) > 0).map((n) => `${n} ${(toCents(sp.rm[n]) / 100).toFixed(2)}`).join(", ");
  }

  function refresh() {
    const r = evaluate();
    for (const [n, el] of Object.entries(refs.share ?? {})) {
      const c = r.shares?.[n] ?? 0;
      el.textContent = c ? money(c) : "";
    }
    if (refs.foot) {
      refs.foot.textContent = r.ok ? r.info ?? "" : r.why;
      refs.foot.className = "foot " + (r.ok ? "good" : "warn");
      refs.foot.hidden = r.ok && !r.info;
    }
    const why = !f.item.trim() ? "Say what it was for" : !(toCents(f.amount) > 0) ? "Enter the amount" : r.ok ? null : r.why;
    refs.save.disabled = saving || !!why;
    refs.hint.textContent = why ?? "";
  }

  function personRow(n) {
    const isMember = group.members.includes(n);
    const label = h("div", { class: "grow" }, h("div", { class: "t" }, n), !isMember ? h("div", { class: "s" }, "not in this group") : null);
    const share = h("span", { class: "share" });
    refs.share[n] = share;
    if (sp.mode === "equal") {
      return h(
        "label",
        { class: "who" },
        h("input", {
          type: "checkbox",
          checked: sp.ticked.has(n),
          onchange: (ev) => {
            ev.target.checked ? sp.ticked.add(n) : sp.ticked.delete(n);
            refresh();
          },
        }),
        avatar(n),
        label,
        share,
      );
    }
    if (sp.mode === "usual") {
      return h("div", { class: "who" }, avatar(n), label, h("span", { class: "s" }, `${trimNum(group.usual[n] ?? 0)}%`), share);
    }
    const key = sp.mode === "pct" ? "pct" : "rm";
    return h(
      "div",
      { class: "who" },
      avatar(n),
      label,
      sp.mode === "pct" ? share : null,
      h(
        "span",
        { class: "in" },
        sp.mode === "rm" ? h("i", {}, "RM") : null,
        h("input", {
          type: "text",
          inputmode: "decimal",
          placeholder: "0",
          value: sp[key][n] ?? "",
          oninput: (ev) => {
            sp[key][n] = ev.target.value;
            refresh();
          },
        }),
        sp.mode === "pct" ? h("i", {}, "%") : null,
      ),
    );
  }

  function draw() {
    refs.share = {};
    const c = cast();
    const members = c.filter((n) => group.members.includes(n));
    const others = c.filter((n) => !group.members.includes(n));
    const rows = sp.mode === "usual" ? Object.keys(group.usual ?? {}) : members;
    const otherRows = sp.mode === "usual" ? [] : others;
    if (!f.paid_by || !c.includes(f.paid_by)) f.paid_by = defaultPayer();

    const modes = Object.keys(MODES).filter((k) => k !== "usual" || group.usual);

    refs.save = h("button", { class: "btn primary wide", type: "submit" }, saving ? "Saving…" : editing ? "Save changes" : "Add expense");
    refs.hint = h("div", { class: "hint" });
    refs.foot = h("div", { class: "foot" });

    const form = h(
      "form",
      {
        class: "f",
        onsubmit: async (ev) => {
          ev.preventDefault();
          if (refs.save.disabled) return;
          saving = true;
          refresh();
          const values = {
            spent_on: f.date,
            item: f.item.trim(),
            amount_cents: toCents(f.amount),
            group_name: group.name,
            paid_by: f.paid_by,
            split: splitText() || null,
            category: f.category,
            note: f.note.trim() || null,
          };
          try {
            if (editing) await update("split_expenses", editing.id, values);
            else await insert("split_expenses", values);
            store.set("split:group", group.id);
            await load();
            go(`#/g/${enc(group.id)}`);
          } catch (err) {
            saving = false;
            error = err.message;
            draw();
          }
        },
      },
      error ? h("div", { class: "err" }, error) : null,
      h(
        "div",
        { class: "field" },
        h("label", { for: "x-item" }, "What was it?"),
        h("input", {
          id: "x-item",
          type: "text",
          placeholder: "Dinner, Grab, groceries…",
          value: f.item,
          autocomplete: "off",
          oninput: (ev) => {
            f.item = ev.target.value;
            refresh();
          },
        }),
      ),
      h(
        "div",
        { class: "field money" },
        h("label", { for: "x-amt" }, "How much?"),
        h(
          "span",
          { class: "in big" },
          h("i", {}, "RM"),
          h("input", {
            id: "x-amt",
            type: "text",
            inputmode: "decimal",
            placeholder: "0.00",
            value: f.amount,
            oninput: (ev) => {
              f.amount = ev.target.value;
              refresh();
            },
          }),
        ),
      ),
      h(
        "div",
        { class: "row2" },
        h(
          "div",
          { class: "field" },
          h("label", {}, "Paid by"),
          h(
            "select",
            { onchange: (ev) => { f.paid_by = ev.target.value; } },
            c.map((n) => h("option", { value: n, selected: n === f.paid_by }, n === m ? `${n} (you)` : n)),
          ),
        ),
        h(
          "div",
          { class: "field" },
          h("label", {}, "Group"),
          h(
            "select",
            {
              onchange: (ev) => {
                group = groupById(ev.target.value);
                sp = initialSplit(null, group);
                draw();
              },
            },
            D.groups.map((g) => h("option", { value: g.id, selected: g.id === group.id }, g.name)),
          ),
        ),
      ),

      h("div", { class: "sec" }, h("h2", {}, "Split")),
      h(
        "div",
        { class: "seg" },
        modes.map((k) =>
          h(
            "button",
            { type: "button", class: sp.mode === k ? "on" : "", onclick: () => sp.mode !== k && setMode(k) },
            MODES[k],
          ),
        ),
      ),
      h(
        "div",
        { class: "list split" },
        rows.map(personRow),
        otherRows.length
          ? sp.showOthers
            ? otherRows.map(personRow)
            : h(
                "button",
                {
                  type: "button",
                  class: "item more",
                  onclick: () => {
                    sp.showOthers = true;
                    draw();
                  },
                },
                `+ Someone not in ${group.name}`,
              )
          : null,
        refs.foot,
      ),

      h(
        "div",
        { class: "row2" },
        h(
          "div",
          { class: "field" },
          h("label", {}, "Date"),
          h("input", { type: "date", value: f.date, onchange: (ev) => (f.date = ev.target.value || todayIso()) }),
        ),
        h(
          "div",
          { class: "field" },
          h("label", {}, "Category"),
          h(
            "select",
            { onchange: (ev) => (f.category = ev.target.value) },
            D.categories.map((c) => h("option", { value: c.value, selected: c.value === f.category }, c.label)),
          ),
        ),
      ),
      h(
        "div",
        { class: "field" },
        h("label", {}, "Note (optional)"),
        h("input", { type: "text", value: f.note, oninput: (ev) => (f.note = ev.target.value) }),
      ),
      refs.hint,
      refs.save,
      editing
        ? h(
            "button",
            {
              type: "button",
              class: "btn danger wide",
              onclick: async () => {
                if (!confirm(`Delete "${editing.item}"?`)) return;
                try {
                  await remove("split_expenses", editing.id);
                  await load();
                  go(`#/g/${enc(group.id)}`);
                } catch (err) {
                  error = err.message;
                  draw();
                }
              },
            },
            "Delete expense",
          )
        : null,
    );

    fill(shell, bar(editing ? "Edit expense" : "Add expense", { back }), form);
    refresh();
  }

  draw();
  if (!editing) setTimeout(() => shell.querySelector("#x-item")?.focus(), 50);
  return shell;
}

/* ---------------------------------------------------------- settle all */

/**
 * Who owes whom across every group, person to person: each group's own
 * settle-up list, added up per pair. Not one simplification over all groups
 * at once — that can route a debt through someone in another group, and then
 * the number on Home is not what clearing the groups one by one costs. This
 * one always is, so a line here and its Settle up screen agree.
 */
function pairTotals() {
  const nets = new Map();
  for (const g of D.groups) {
    for (const t of g.transfers) {
      const [x, y] = t.from < t.to ? [t.from, t.to] : [t.to, t.from];
      const key = JSON.stringify([x, y]);
      nets.set(key, (nets.get(key) ?? 0) + (t.from === x ? t.cents : -t.cents));
    }
  }
  return [...nets]
    .filter(([, c]) => c !== 0)
    .map(([key, c]) => {
      const [x, y] = JSON.parse(key);
      return c > 0 ? { from: x, to: y, cents: c } : { from: y, to: x, cents: -c };
    })
    .sort((p, q) => q.cents - p.cents);
}

/**
 * What `a` owes `b` in each group, from that group's own settle-up list —
 * positive when a pays b, negative when b pays a. A balance that the group's
 * simplification routes through a third person is not between these two, and
 * is left for that group's own Settle up.
 */
function pairwise(a, b) {
  const out = [];
  for (const g of D.groups) {
    let net = 0;
    for (const t of g.transfers) {
      if (t.from === a && t.to === b) net += t.cents;
      if (t.from === b && t.to === a) net -= t.cents;
    }
    if (net !== 0) out.push({ group: g, net });
  }
  return out;
}

/**
 * Splitwise's "settle all balances": one sum of money between two people,
 * recorded as a payment in every group they have a balance in, so each group
 * zeroes out on its own. A group where the debt runs the other way gets a
 * payment the other way — together they add up to what actually changed hands.
 */
function settleForm(q) {
  let a = q.get("a");
  let b = q.get("b");
  let parts = a && b ? pairwise(a, b) : [];
  let total = parts.reduce((n, p) => n + p.net, 0);
  if (total < 0) {
    [a, b] = [b, a];
    parts = parts.map((p) => ({ ...p, net: -p.net }));
    total = -total;
  }
  const m = me();
  const f = { date: todayIso(), note: "" };
  let error = null;
  let saving = false;
  const shell = page();

  function draw() {
    if (!a || !b || !parts.length || total === 0) {
      fill(shell, 
        bar("Settle up", { back: "#/" }),
        h(
          "div",
          { class: "empty" },
          h("b", {}, "Nothing to settle directly"),
          h("p", {}, "Between these two, the balances run through other people. Settle them inside each group instead."),
          h("a", { class: "btn primary", href: "#/" }, "Back"),
        ),
      );
      return;
    }
    const save = h("button", { class: "btn primary wide", type: "submit", disabled: saving }, saving ? "Saving…" : `Done — ${money(total)} paid back`);
    fill(shell, 
      bar("Settle up", { back: "#/" }),
      h(
        "form",
        {
          class: "f",
          onsubmit: async (ev) => {
            ev.preventDefault();
            if (saving) return;
            saving = true;
            draw();
            const note = f.note.trim() || "Settled all balances";
            try {
              for (const p of parts) {
                await insert("split_payments", {
                  paid_on: f.date,
                  group_name: p.group.name,
                  paid_by: p.net > 0 ? a : b,
                  paid_to: p.net > 0 ? b : a,
                  amount_cents: Math.abs(p.net),
                  note,
                });
              }
              await load();
              go("#/");
            } catch (err) {
              // Some payments may have gone in before the failure; the fresh
              // data shows what is left, so the form is rebuilt from it.
              saving = false;
              error = err.message;
              await load().catch(() => {});
              parts = pairwise(a, b);
              total = parts.reduce((n, p) => n + p.net, 0);
              draw();
            }
          },
        },
        h(
          "header",
          { class: "hero small" },
          h("div", { class: "hello" }, "One payment, every group"),
          h("div", { class: "big" }, `${You(a)} ${a === m ? "pay" : "pays"} ${you(b)} ${money(total)}`),
        ),
        error ? h("div", { class: "err" }, error) : null,
        h("div", { class: "sec" }, h("h2", {}, "This clears")),
        h(
          "div",
          { class: "list" },
          parts.map((p) =>
            h(
              "div",
              { class: "item" },
              h("span", { class: "gi" }, p.group.name.slice(0, 1).toUpperCase()),
              h(
                "div",
                { class: "grow" },
                h("div", { class: "t" }, p.group.name),
                h("div", { class: "s" }, p.net > 0 ? `${You(a)} owed ${you(b)}` : `${You(b)} owed ${you(a)} — netted off`),
              ),
              h("div", { class: `amt ${p.net > 0 ? "" : "good"}` }, h("b", {}, `${p.net > 0 ? "" : "−"}${money(Math.abs(p.net))}`)),
            ),
          ),
          h("div", { class: "foot" }, `Records a payment in each group above, so each one is settled on its own.`),
        ),
        h(
          "div",
          { class: "row2" },
          h(
            "div",
            { class: "field" },
            h("label", {}, "Date"),
            h("input", { type: "date", value: f.date, onchange: (ev) => (f.date = ev.target.value || todayIso()) }),
          ),
          h(
            "div",
            { class: "field" },
            h("label", {}, "Note (optional)"),
            h("input", { type: "text", placeholder: "DuitNow, cash…", value: f.note, oninput: (ev) => (f.note = ev.target.value) }),
          ),
        ),
        h("p", { class: "lead" }, "Only tap this once the money has actually moved."),
        save,
      ),
    );
  }

  draw();
  return shell;
}

function needGroup() {
  return page(
    bar("Add expense", { back: "#/" }),
    h("div", { class: "empty" }, h("b", {}, "Make a group first"), h("p", {}, "Every expense belongs to a group — Home, a trip, an event."), h("a", { class: "btn primary", href: "#/group" }, "Create a group")),
  );
}

/* ------------------------------------------------------------- payment */

function paymentForm(id, q) {
  const editing = id ? D.payments.find((p) => p.id === id) : null;
  if (id && !editing) return page(bar("Payment", { back: "#/" }), h("div", { class: "err" }, "That payment is gone."));
  if (!D.groups.length) return needGroup();
  const m = me();
  let group =
    (editing && groupByName(editing.group_name)) || groupById(q.get("g")) || groupById(store.get("split:group")) || D.groups[0];
  const back = `#/g/${enc(group.id)}`;
  const amt = q.get("amt");
  const f = {
    from: editing?.paid_by ?? q.get("from") ?? null,
    to: editing?.paid_to ?? q.get("to") ?? null,
    amount: editing ? (editing.amount_cents / 100).toFixed(2) : amt ? (Number(amt) / 100).toFixed(2) : "",
    date: editing?.paid_on ?? todayIso(),
    note: editing?.note ?? "",
  };
  let error = null;
  let saving = false;
  const shell = page();
  const refs = {};

  function refresh() {
    const why =
      !f.from || !f.to ? "Pick who paid who" : f.from === f.to ? "From and to are the same person" : !(toCents(f.amount) > 0) ? "Enter the amount" : null;
    refs.save.disabled = saving || !!why;
    refs.hint.textContent = why ?? "";
  }

  function draw() {
    const c = castOf(group, [editing?.paid_by, editing?.paid_to]);
    if (!f.from || !c.includes(f.from)) f.from = m && c.includes(m) ? m : c[0];
    if (!f.to || !c.includes(f.to)) f.to = c.find((n) => n !== f.from) ?? c[0];
    const pick = (key) =>
      h(
        "select",
        {
          onchange: (ev) => {
            f[key] = ev.target.value;
            refresh();
          },
        },
        c.map((n) => h("option", { value: n, selected: n === f[key] }, n === m ? `${n} (you)` : n)),
      );
    refs.save = h("button", { class: "btn primary wide", type: "submit" }, saving ? "Saving…" : editing ? "Save changes" : "Save — they're paid back");
    refs.hint = h("div", { class: "hint" });

    fill(shell, 
      bar(editing ? "Edit pay-back" : "Pay someone back", { back }),
      h(
        "form",
        {
          class: "f",
          onsubmit: async (ev) => {
            ev.preventDefault();
            if (refs.save.disabled) return;
            saving = true;
            refresh();
            const values = {
              paid_on: f.date,
              group_name: group.name,
              paid_by: f.from,
              paid_to: f.to,
              amount_cents: toCents(f.amount),
              note: f.note.trim() || null,
            };
            try {
              if (editing) await update("split_payments", editing.id, values);
              else await insert("split_payments", values);
              await load();
              go(`#/g/${enc(group.id)}`);
            } catch (err) {
              saving = false;
              error = err.message;
              draw();
            }
          },
        },
        h("p", { class: "lead" }, "Not a new bill — this is money handed over to clear a debt (DuitNow, cash). It lowers what's owed and isn't counted as spending."),
        error ? h("div", { class: "err" }, error) : null,
        h(
          "div",
          { class: "pay" },
          h("div", { class: "field" }, h("label", {}, "Who paid"), pick("from")),
          h("div", { class: "arrow" }, "→"),
          h("div", { class: "field" }, h("label", {}, "To"), pick("to")),
        ),
        h(
          "div",
          { class: "field money" },
          h("label", {}, "How much?"),
          h(
            "span",
            { class: "in big" },
            h("i", {}, "RM"),
            h("input", {
              type: "text",
              inputmode: "decimal",
              placeholder: "0.00",
              value: f.amount,
              oninput: (ev) => {
                f.amount = ev.target.value;
                refresh();
              },
            }),
          ),
        ),
        h(
          "div",
          { class: "row2" },
          h(
            "div",
            { class: "field" },
            h("label", {}, "Group"),
            h(
              "select",
              {
                onchange: (ev) => {
                  group = groupById(ev.target.value);
                  draw();
                },
              },
              D.groups.map((g) => h("option", { value: g.id, selected: g.id === group.id }, g.name)),
            ),
          ),
          h(
            "div",
            { class: "field" },
            h("label", {}, "Date"),
            h("input", { type: "date", value: f.date, onchange: (ev) => (f.date = ev.target.value || todayIso()) }),
          ),
        ),
        h(
          "div",
          { class: "field" },
          h("label", {}, "Note (optional)"),
          h("input", { type: "text", placeholder: "DuitNow, cash…", value: f.note, oninput: (ev) => (f.note = ev.target.value) }),
        ),
        refs.hint,
        refs.save,
        editing
          ? h(
              "button",
              {
                type: "button",
                class: "btn danger wide",
                onclick: async () => {
                  if (!confirm("Delete this payment?")) return;
                  try {
                    await remove("split_payments", editing.id);
                    await load();
                    go(`#/g/${enc(group.id)}`);
                  } catch (err) {
                    error = err.message;
                    draw();
                  }
                },
              },
              "Delete payment",
            )
          : null,
      ),
    );
    refresh();
  }

  draw();
  return shell;
}

/* --------------------------------------------------------------- group */

function groupForm(id) {
  const editing = id ? groupById(id) : null;
  if (id && !editing) return page(bar("Group", { back: "#/" }), h("div", { class: "err" }, "That group is gone."));
  const m = me();
  const f = {
    name: editing?.name ?? "",
    ticked: new Set(editing ? editing.members : m ? [m] : []),
    note: editing?.note ?? "",
    mode: editing?.split ? "pct" : "equal",
    pct: editing?.usual ? Object.fromEntries(Object.entries(editing.usual).map(([n, v]) => [n, trimNum(v)])) : {},
    newPerson: "",
  };
  let error = editing?.split && !editing.usual ? `The usual split "${editing.split}" can't be read — set it again below.` : null;
  let saving = false;
  const shell = page();
  const refs = {};
  const back = editing ? `#/g/${enc(editing.id)}` : "#/";

  /** People, then anyone a group already names, then links nobody has opened yet. */
  const everyone = () => {
    const out = D.people.map((p) => p.name);
    for (const n of editing?.members ?? []) if (!out.includes(n)) out.push(n);
    for (const l of D.linkOnly) if (l.pickable && !out.some((n) => n.toLowerCase() === l.label.toLowerCase())) out.push(l.label);
    return out;
  };
  const pending = (n) => !D.people.some((p) => p.name === n) && D.linkOnly.some((l) => l.label === n);
  const chosen = () => everyone().filter((n) => f.ticked.has(n));

  function refresh() {
    let why = !f.name.trim()
      ? "Give the group a name"
      : !chosen().length
        ? "Tick who's in it"
        : m && !f.ticked.has(m)
          ? "Keep yourself ticked — your link only shows the groups you're in"
          : null;
    if (!why && f.mode === "pct") {
      const vals = chosen().map((n) => toNum(f.pct[n]));
      const sum = vals.reduce((a, v) => a + (v > 0 ? v : 0), 0);
      if (Math.abs(sum - 100) > 0.0001) why = sum < 100 ? `${trimNum(100 - sum)}% left to assign` : `${trimNum(sum - 100)}% too much`;
    }
    if (refs.foot) {
      refs.foot.hidden = f.mode !== "pct";
      refs.foot.textContent = why && f.mode === "pct" && f.name.trim() && chosen().length ? why : "100% assigned";
      refs.foot.className = "foot " + (why ? "warn" : "good");
    }
    refs.save.disabled = saving || !!why;
    refs.hint.textContent = why ?? "";
  }

  async function addPerson() {
    const name = f.newPerson.trim().replace(/\s+/g, " ");
    if (!name) return;
    if (BAD_NAME.test(name)) {
      error = "Keep a name to letters and spaces — commas, numbers and \"and\" are how splits are written.";
      draw();
      return;
    }
    const existing = D.people.find((p) => p.name.toLowerCase() === name.toLowerCase());
    try {
      if (!existing) await insert("split_people", { name });
      await load();
      f.ticked.add(existing?.name ?? name);
      f.newPerson = "";
      error = null;
    } catch (err) {
      error = err.message;
    }
    draw();
  }

  function draw() {
    refs.save = h("button", { class: "btn primary wide", type: "submit" }, saving ? "Saving…" : editing ? "Save group" : "Create group");
    refs.hint = h("div", { class: "hint" });
    refs.foot = h("div", { class: "foot" });
    const usedBy = editing
      ? D.expenses.filter((e) => e.group_name === editing.name).length + D.payments.filter((p) => p.group_name === editing.name).length
      : 0;

    fill(shell, 
      bar(editing ? "Edit group" : "New group", { back }),
      h(
        "form",
        {
          class: "f",
          onsubmit: async (ev) => {
            ev.preventDefault();
            if (refs.save.disabled) return;
            saving = true;
            refresh();
            const names = chosen();
            try {
              await ensurePeople(names);
            } catch (err) {
              saving = false;
              error = err.message;
              return draw();
            }
            const values = {
              name: f.name.trim(),
              members: names.join(", "),
              split: f.mode === "pct" ? names.filter((n) => toNum(f.pct[n]) > 0).map((n) => `${n} ${trimNum(toNum(f.pct[n]))}%`).join(", ") : null,
              note: f.note.trim() || null,
            };
            try {
              let gid = editing?.id;
              if (editing) {
                await update("split_groups", editing.id, values);
                // Expenses name their group, so a rename carries them along.
                if (values.name !== editing.name) {
                  for (const e of D.expenses.filter((x) => x.group_name === editing.name)) {
                    await update("split_expenses", e.id, { group_name: values.name });
                  }
                  for (const p of D.payments.filter((x) => x.group_name === editing.name)) {
                    await update("split_payments", p.id, { group_name: values.name });
                  }
                }
              } else {
                gid = (await insert("split_groups", values)).row.id;
              }
              await load();
              go(`#/g/${enc(gid)}`);
            } catch (err) {
              saving = false;
              error = err.message;
              draw();
            }
          },
        },
        error ? h("div", { class: "err" }, error) : null,
        h(
          "div",
          { class: "field" },
          h("label", {}, "Name"),
          h("input", {
            type: "text",
            placeholder: "Home, Langkawi trip, Mum's birthday…",
            value: f.name,
            oninput: (ev) => {
              f.name = ev.target.value;
              refresh();
            },
          }),
        ),
        h("div", { class: "sec" }, h("h2", {}, "Who's in it")),
        h(
          "div",
          { class: "list" },
          everyone().map((n) =>
            h(
              "label",
              { class: "who" },
              h("input", {
                type: "checkbox",
                checked: f.ticked.has(n),
                onchange: (ev) => {
                  ev.target.checked ? f.ticked.add(n) : f.ticked.delete(n);
                  draw();
                },
              }),
              avatar(n),
              h(
                "div",
                { class: "grow" },
                h("div", { class: "t" }, n === m ? `${n} (you)` : n),
                pending(n) ? h("div", { class: "s" }, "has a link, hasn't opened it yet") : null,
              ),
            ),
          ),
          h(
            "div",
            { class: "who" },
            h("input", {
              type: "text",
              class: "grow",
              placeholder: "Add a person — e.g. Ali",
              value: f.newPerson,
              oninput: (ev) => (f.newPerson = ev.target.value),
              onkeydown: (ev) => {
                if (ev.key === "Enter") {
                  ev.preventDefault();
                  addPerson();
                }
              },
            }),
            h("button", { type: "button", class: "pill", onclick: addPerson }, "Add"),
          ),
        ),
        h("div", { class: "sec" }, h("h2", {}, "Usual split")),
        h(
          "div",
          { class: "seg" },
          [
            ["equal", "Equally"],
            ["pct", "Different %"],
          ].map(([k, label]) =>
            h(
              "button",
              {
                type: "button",
                class: f.mode === k ? "on" : "",
                onclick: () => {
                  if (k === "pct" && !chosen().some((n) => f.pct[n])) {
                    const each = allocate(10000, chosen().map((n) => [n, 1]));
                    for (const n of chosen()) f.pct[n] = trimNum(each[n] / 100);
                  }
                  f.mode = k;
                  draw();
                },
              },
              label,
            ),
          ),
        ),
        f.mode === "pct"
          ? h(
              "div",
              { class: "list split" },
              chosen().map((n) =>
                h(
                  "div",
                  { class: "who" },
                  avatar(n),
                  h("div", { class: "grow" }, h("div", { class: "t" }, n)),
                  h(
                    "span",
                    { class: "in" },
                    h("input", {
                      type: "text",
                      inputmode: "decimal",
                      placeholder: "0",
                      value: f.pct[n] ?? "",
                      oninput: (ev) => {
                        f.pct[n] = ev.target.value;
                        refresh();
                      },
                    }),
                    h("i", {}, "%"),
                  ),
                ),
              ),
              refs.foot,
            )
          : h("p", { class: "lead" }, "Every bill is split evenly unless you change it on the expense."),
        h(
          "div",
          { class: "field" },
          h("label", {}, "Note (optional)"),
          h("input", { type: "text", value: f.note, oninput: (ev) => (f.note = ev.target.value) }),
        ),
        refs.hint,
        refs.save,
        editing && usedBy === 0
          ? h(
              "button",
              {
                type: "button",
                class: "btn danger wide",
                onclick: async () => {
                  if (!confirm(`Delete the group "${editing.name}"?`)) return;
                  try {
                    await remove("split_groups", editing.id);
                    await load();
                    go("#/");
                  } catch (err) {
                    error = err.message;
                    draw();
                  }
                },
              },
              "Delete group",
            )
          : null,
      ),
    );
    refresh();
  }

  draw();
  return shell;
}

/* ------------------------------------------------------- who are you */

/**
 * A link nobody is yet, when there are people no link opens as — links made
 * before a link was a person, labelled "Sayang" for Zahidah. Asked once:
 * picking a name writes this link's label onto that person, and from then on
 * it opens as them. The server only lets a link claim somebody no other link
 * already opens as.
 */
function whoAreYou() {
  const label = V.label.trim();
  let name = D.who.usable ? label : "";
  let error = null;
  let busy = false;
  const shell = page();

  async function claim(person) {
    if (busy) return;
    busy = true;
    try {
      await update("split_people", person.id, { link: label });
      await load();
      go("#/");
    } catch (err) {
      busy = false;
      error = err.message;
      draw();
    }
  }

  async function addMe() {
    const n = cleanName(name);
    if (!n || busy) return;
    if (BAD_NAME.test(n)) {
      error = "Keep a name to letters and spaces — commas, numbers and \"and\" are how splits are written.";
      return draw();
    }
    busy = true;
    try {
      await insert("split_people", { name: n, link: label });
      await load();
      go("#/");
    } catch (err) {
      busy = false;
      error = err.message;
      draw();
    }
  }

  function draw() {
    const choices = D.people.filter((p) => D.who.claimable.includes(p.name));
    fill(
      shell,
      h(
        "header",
        { class: "hero" },
        h("div", { class: "hello" }, `Split bills · link “${label}”`),
        h("div", { class: "big" }, "Who are you?"),
      ),
      h("p", { class: "lead" }, "Pick yourself once and this link opens as you from now on — bills you add are paid by you, and you'll see the groups you're in."),
      error ? h("div", { class: "err" }, error) : null,
      choices.length
        ? h(
            "div",
            { class: "list" },
            choices.map((p) =>
              h(
                "button",
                { type: "button", class: "item pick", onclick: () => claim(p) },
                avatar(p.name),
                h("div", { class: "grow" }, h("div", { class: "t" }, p.name)),
                h("span", { class: "pill" }, "That's me"),
              ),
            ),
          )
        : null,
      h("div", { class: "sec" }, h("h2", {}, choices.length ? "None of these" : "Your name")),
      h(
        "div",
        { class: "list" },
        h(
          "div",
          { class: "who" },
          h("input", {
            type: "text",
            class: "grow",
            placeholder: "Your name",
            value: name,
            oninput: (ev) => (name = ev.target.value),
            onkeydown: (ev) => {
              if (ev.key === "Enter") {
                ev.preventDefault();
                addMe();
              }
            },
          }),
          h("button", { type: "button", class: "pill", onclick: addMe }, "Add me"),
        ),
      ),
    );
  }
  draw();
  return shell;
}

/* -------------------------------------------------------------- people */

function peopleView() {
  const m = me();
  let error = null;
  let name = "";
  const shell = page();

  async function add() {
    const n = name.trim().replace(/\s+/g, " ");
    if (!n) return;
    if (BAD_NAME.test(n)) {
      error = "Keep a name to letters and spaces — commas, numbers and \"and\" are how splits are written.";
      return draw();
    }
    try {
      await insert("split_people", { name: n });
      await load();
      name = "";
      error = null;
    } catch (err) {
      error = err.message;
    }
    draw();
  }

  function draw() {
    fill(shell, 
      bar("People", { back: "#/" }),
      error ? h("div", { class: "err" }, error) : null,
      h(
        "div",
        { class: "list" },
        D.people.map((p) => {
          const groups = D.groups.filter((g) => g.members.includes(p.name)).length;
          const link = p.name === m ? null : !p.hasLink ? "no link" : p.opened ? "has a link" : "has a link, not opened yet";
          return h(
            "div",
            { class: "item" },
            avatar(p.name),
            h(
              "div",
              { class: "grow" },
              h("div", { class: "t" }, p.name === m ? `${p.name} (you)` : p.name),
              h("div", { class: "s" }, [groups ? `in ${groups} of your groups` : null, link].filter(Boolean).join(" · ") || "not in your groups"),
            ),
            p.name === m
              ? null
              : h(
                  "button",
                  {
                    type: "button",
                    class: "pill quiet",
                    onclick: async () => {
                      if (!confirm(`Remove ${p.name}? Bills they're already in stay as they are; they just won't be offered for new ones.`)) return;
                      try {
                        await remove("split_people", p.id);
                        await load();
                      } catch (err) {
                        error = err.message;
                      }
                      draw();
                    },
                  },
                  "Remove",
                ),
          );
        }),
        D.linkOnly.map((l) =>
          h(
            "div",
            { class: "item" },
            avatar(l.label),
            h(
              "div",
              { class: "grow" },
              h("div", { class: "t" }, `“${l.label}”`),
              h("div", { class: "s" }, l.pickable ? "has a link, not opened yet" : "a link that hasn't said who it is yet — it asks when opened"),
            ),
          ),
        ),
        h(
          "div",
          { class: "who" },
          h("input", {
            type: "text",
            class: "grow",
            placeholder: "Add a person — e.g. Ali",
            value: name,
            oninput: (ev) => (name = ev.target.value),
            onkeydown: (ev) => {
              if (ev.key === "Enter") {
                ev.preventDefault();
                add();
              }
            },
          }),
          h("button", { type: "button", class: "pill", onclick: add }, "Add"),
        ),
      ),
      h(
        "p",
        { class: "lead" },
        "Everyone with a share link is here already, and can be put in a group before they've opened it. " +
          "Add someone by hand only if they won't log bills themselves — a friend on one trip. " +
          "To let someone log bills, make them a share link on the dashboard, labelled with their name.",
      ),
    );
  }
  draw();
  return shell;
}

/* --------------------------------------------------------------- style */

document.head.append(
  h(
    "style",
    {},
    `
body{background:var(--bg)}
.page{max-width:560px;margin:0 auto;padding:0 16px calc(110px + env(safe-area-inset-bottom))}
.bar{position:sticky;top:0;z-index:5;background:var(--bg);display:grid;grid-template-columns:76px 1fr 76px;
align-items:center;height:54px;margin:0 -16px;padding:0 16px;border-bottom:1px solid var(--border-soft)}
.bar h1{margin:0;font-size:16px;font-weight:600;text-align:center;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bar .back,.bar .link{font-size:15px}
.bar>:last-child{justify-self:end}
.bar+.list,.bar+.err,.bar+.empty{margin-top:16px}
.hero{padding:26px 0 14px}
.hero.small{padding:18px 0 12px}
.hello{color:var(--muted);font-size:13.5px}
.big{font-size:27px;font-weight:650;letter-spacing:-.02em;margin-top:3px;line-height:1.2}
.good{color:var(--green)}.warn{color:var(--yellow)}.bad{color:var(--red)}.muted{color:var(--muted)}
.sec{display:flex;align-items:center;justify-content:space-between;margin:24px 0 8px}
.sec h2{margin:0;font-size:11.5px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);font-weight:600}
button,input,select{font-family:var(--sans)}
.list{background:var(--panel);border:1px solid var(--border);border-radius:14px;overflow:hidden}
.item,.who{display:flex;gap:12px;align-items:center;padding:12px 14px;border-top:1px solid var(--border-soft);
color:var(--fg);text-decoration:none;min-height:56px}
.item:first-child,.who:first-child{border-top:0}
a.item:hover{text-decoration:none;background:var(--panel-2)}
a.item:active{background:var(--panel-2)}
.grow{flex:1;min-width:0}
.t{font-weight:550;font-size:15px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.s{color:var(--muted);font-size:12.5px;margin-top:1px}
.s.bad{color:var(--red);white-space:normal}
.amt{text-align:right;font-size:11.5px;white-space:nowrap;flex:none}
.amt b{display:block;font-size:14.5px;font-weight:600}
.date{width:34px;text-align:center;flex:none;color:var(--muted);font-size:10.5px;line-height:1.1;text-transform:uppercase}
.date b{display:block;font-size:18px;color:var(--fg);font-weight:600}
.av,.gi{width:32px;height:32px;border-radius:50%;display:grid;place-items:center;font-weight:700;color:#fff;
flex:none;font-size:13.5px}
.gi{border-radius:10px;background:var(--accent-soft);color:var(--accent);width:38px;height:38px;font-size:16px}
.foot{padding:10px 14px;font-size:12.5px;color:var(--muted);background:var(--panel-2);border-top:1px solid var(--border-soft)}
.foot.good{color:var(--green)}.foot.warn{color:var(--yellow);font-weight:600}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;padding:12px 16px;border-radius:12px;
border:1px solid var(--border);background:var(--panel);color:var(--fg);font:600 15px var(--sans);cursor:pointer;text-decoration:none}
.btn:hover{text-decoration:none}
.btn.primary{background:var(--accent);border-color:var(--accent);color:#fff}
.btn.danger{color:var(--red);background:transparent}
.btn:disabled{opacity:.45;cursor:default}
.btn.wide{width:100%;margin-top:10px}
.actions{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.pill{padding:7px 12px;border-radius:999px;background:var(--accent-soft);color:var(--accent);font:600 13px var(--sans);
border:0;cursor:pointer;white-space:nowrap;text-decoration:none}
.pill:hover{text-decoration:none}
.pill.quiet{background:var(--panel-2);color:var(--muted)}
.fab{position:fixed;left:50%;transform:translateX(-50%);bottom:calc(18px + env(safe-area-inset-bottom));z-index:6;
background:var(--accent);color:#fff;padding:15px 24px;border-radius:999px;font-weight:650;font-size:15px;
box-shadow:0 8px 24px rgba(0,0,0,.3)}
.fab:hover{text-decoration:none}
.empty{margin-top:18px;background:var(--panel);border:1px dashed var(--border);border-radius:14px;padding:22px 18px;text-align:center}
.empty b{font-size:16px}.empty p{color:var(--muted);margin:6px 0 14px}
.links{display:flex;justify-content:space-between;color:var(--faint);font-size:12.5px;margin:22px 2px 0}
.problems{background:var(--panel);border:1px solid var(--yellow);border-radius:14px;margin-top:16px;overflow:hidden}
.problems summary{padding:12px 14px;color:var(--yellow);font-weight:600;cursor:pointer}
.problems .item{border-top:1px solid var(--border-soft)}
.err{background:var(--panel);border:1px solid var(--red);color:var(--red);padding:10px 12px;border-radius:12px;margin:14px 0 0;font-size:14px}
.lead{color:var(--muted);font-size:13px;margin:12px 2px}
.hint{color:var(--muted);font-size:12.5px;text-align:center;margin-top:16px;min-height:1em}
.f .field{margin:14px 0 0;min-width:0}
.f .field>label{font-size:12.5px;color:var(--muted);margin-bottom:6px;font-weight:500}
.page input[type=text],.page input[type=date],.page select{width:100%;font:16px var(--sans);padding:0 12px;height:46px;
border-radius:12px;border:1px solid var(--border);background:var(--panel);color:var(--fg);max-width:none;box-sizing:border-box}
.page input:focus,.page select:focus{outline:none;border-color:var(--accent)}
.f .row2{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.in{display:flex;align-items:center;gap:6px;flex:none}
.in i{font-style:normal;color:var(--muted);font-size:13px}
.who input.grow{height:42px}
.who .in input{width:84px;text-align:right;height:38px}
.who input[type=checkbox]{width:22px;height:22px;flex:none;accent-color:var(--accent);margin:0}
.who .share{color:var(--muted);font-size:13px;font-variant-numeric:tabular-nums;white-space:nowrap}
label.who{cursor:pointer}
.in.big{display:flex;background:var(--panel);border:1px solid var(--border);border-radius:12px;padding:0 14px}
.in.big:focus-within{border-color:var(--accent)}
.in.big i{font-size:18px}
.f .in.big input{border:0;background:transparent;font-size:28px;font-weight:650;height:60px;padding:0 4px}
.seg{display:flex;gap:4px;background:var(--panel-2);padding:4px;border-radius:12px;margin-bottom:10px;border:1px solid var(--border-soft)}
.seg button{flex:1;border:0;background:transparent;color:var(--muted);padding:10px 4px;border-radius:9px;
font:500 13.5px var(--sans);cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.seg button.on{background:var(--panel);color:var(--fg);font-weight:650;box-shadow:0 1px 3px rgba(0,0,0,.18)}
.item.more{width:100%;background:transparent;border-left:0;border-right:0;border-bottom:0;color:var(--accent);
font:500 14px var(--sans);cursor:pointer;justify-content:center}
button.item.pick{width:100%;background:transparent;border-left:0;border-right:0;border-bottom:0;font:inherit;text-align:left;cursor:pointer}
button.item.pick:first-child{border-top:0}
.pay{display:grid;grid-template-columns:1fr auto 1fr;gap:8px;align-items:end}
.pay .arrow{padding-bottom:12px;color:var(--muted);font-size:18px}
`,
  ),
);

/* ---------------------------------------------------------------- boot */

async function boot() {
  try {
    await load();
    // A link nobody is yet, with nobody it could be: it is a new person,
    // named after its label. With people to choose from, whoAreYou asks.
    if (!D.who.me && !D.who.claimable.length && D.who.usable) {
      try {
        await insert("split_people", { name: V.label.trim().replace(/\s+/g, " "), link: V.label.trim() });
      } catch {}
      await load();
    }
  } catch (err) {
    fill(app, page(h("div", { class: "err" }, err.message)));
    return;
  }
  render();
  window.addEventListener("hashchange", () => {
    render();
    window.scrollTo(0, 0);
  });
  // Someone else may have logged a bill while this tab sat in a pocket. A
  // form keeps what is being typed; every other screen redraws fresh.
  document.addEventListener("visibilitychange", async () => {
    if (document.visibilityState !== "visible" || isForm()) return;
    try {
      await load();
      render();
    } catch {}
  });
}

boot();
