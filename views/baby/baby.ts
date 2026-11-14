import { bars, defineView, formatMoney, rows, series, stats } from "../../src/core/define.ts";

/**
 * The baby page — what was logged today, and the form to log the next thing.
 *
 * ## Who uses it, and how
 *
 * Both parents, from their phones, each through their own share link minted
 * on the dashboard ("Huzaifah", "Wife"). `entry` below is what turns those
 * links from read-only into the place feeds, nappies, sleep, vaccines, growth
 * and spending are logged: the link page puts a tab per table above these
 * panels, and every row it writes is stamped with the link's label. Revoking
 * a link on the dashboard stops it reading and writing at once; taking a
 * table out of `entry` stops every link writing to it.
 *
 * ## Time
 *
 * "Today" is from local midnight, in the server's `TZ` (Asia/Kuala_Lumpur in
 * production). The days are bucketed here in JavaScript rather than with
 * SQLite's `'localtime'`, so they follow the same clock the forms are filled
 * in with and do not depend on what the C library thinks the zone is.
 *
 * ## Labels
 *
 * The enum values (`breast_milk`, `zahidah`) are spelled out here as display
 * words rather than imported from `tables/baby/_shared.ts`: a view reaching
 * into a table's `_` file would make an edit there stop view reloading.
 */

const DAY = 86_400_000;

/** Local midnight of the day `ms` falls in. */
const midnight = (ms: number) => {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

const pad = (n: number) => String(n).padStart(2, "0");
const clock = (ms: number) => {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/** "Today 14:05" / "Yesterday 09:30" / "12 Nov 14:05". */
const when = (ms: number, now: number) => {
  const days = Math.round((midnight(now) - midnight(ms)) / DAY);
  if (days === 0) return `Today ${clock(ms)}`;
  if (days === 1) return `Yesterday ${clock(ms)}`;
  if (days === -1) return `Tomorrow ${clock(ms)}`;
  const d = new Date(ms);
  return `${d.getDate()} ${d.toLocaleString("en-GB", { month: "short" })} ${clock(ms)}`;
};

/** "12 Nov" for a `YYYY-MM-DD` column. */
const day = (iso: string) => {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y!, m! - 1, d!).toLocaleString("en-GB", { day: "numeric", month: "short" });
};

/** "2h 40m" / "35m". */
const span = (ms: number) => {
  const m = Math.max(0, Math.round(ms / 60_000));
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${pad(m % 60)}m`;
};

const MILK: Record<string, string> = { breast_milk: "breast milk", formula: "formula" };
const PAYER: Record<string, string> = { huzaifah: "Huzaifah", zahidah: "Zahidah" };

export default defineView({
  name: "baby",
  title: "Baby",
  description: "Milk, poop, sleep, vaccines, growth and spending — logged from your phone.",

  shareable: true,
  entry: [
    { table: "baby_feeds", label: "Milk" },
    { table: "baby_nappies", label: "Poop" },
    { table: "baby_sleep", label: "Sleep" },
    { table: "baby_vaccines", label: "Vaccine" },
    { table: "baby_growth", label: "Growth" },
    { table: "baby_expenses", label: "Expense" },
  ],

  // The dashboard's copy of the page; the share-link page carries a form and
  // is never refreshed under somebody's thumb.
  refresh: 120,

  load(ctx) {
    const now = ctx.now;
    const today = midnight(now);
    const feeds = ctx.from("baby_feeds");
    const nappies = ctx.from("baby_nappies");
    const sleep = ctx.from("baby_sleep");
    const vaccines = ctx.from("baby_vaccines");
    const growth = ctx.from("baby_growth");
    const spend = ctx.from("baby_expenses");

    /* ---------------------------------------------------------- today */

    const fortnight = today - 13 * DAY;
    const recentFeeds = ctx.sql<{ fed_at: number; milk: string; ml: number; vitamin_d: number }>(
      `SELECT fed_at, milk, ml, vitamin_d FROM ${feeds}
        WHERE deleted_at IS NULL AND fed_at >= ? AND fed_at <= ? ORDER BY fed_at DESC`,
      fortnight,
      now,
    );
    const feedsToday = recentFeeds.filter((f) => f.fed_at >= today);
    const mlToday = feedsToday.reduce((n, f) => n + f.ml, 0);
    const vitD = feedsToday.find((f) => f.vitamin_d);

    const [lastFeed] = ctx.sql<{ fed_at: number; milk: string; ml: number }>(
      `SELECT fed_at, milk, ml FROM ${feeds}
        WHERE deleted_at IS NULL AND fed_at <= ? ORDER BY fed_at DESC LIMIT 1`,
      now,
    );
    const [lastPoop] = ctx.sql<{ changed_at: number }>(
      `SELECT changed_at FROM ${nappies}
        WHERE deleted_at IS NULL AND kind IN ('poop', 'both') AND changed_at <= ?
        ORDER BY changed_at DESC LIMIT 1`,
      now,
    );
    const [nappyCount] = ctx.sql<{ poops: number; wees: number }>(
      `SELECT COALESCE(SUM(kind IN ('poop', 'both')), 0) AS poops,
              COALESCE(SUM(kind IN ('wee', 'both')), 0)  AS wees
         FROM ${nappies} WHERE deleted_at IS NULL AND changed_at >= ? AND changed_at <= ?`,
      today,
      now,
    );

    // A sleep with no end is still going, and counts up to now. Only the part
    // of each sleep that falls after midnight is today's.
    const sleeps = ctx.sql<{ started_at: number; ended_at: number | null }>(
      `SELECT started_at, ended_at FROM ${sleep}
        WHERE deleted_at IS NULL AND started_at <= ? AND COALESCE(ended_at, ?) > ?`,
      now,
      now,
      today,
    );
    const sleptToday = sleeps.reduce(
      (n, s) => n + Math.max(0, Math.min(s.ended_at ?? now, now) - Math.max(s.started_at, today)),
      0,
    );
    const asleep = sleeps.find((s) => s.ended_at === null && now - s.started_at < DAY);

    const todayPanel = stats([
      {
        label: "Last feed",
        value: lastFeed ? `${span(now - lastFeed.fed_at)} ago` : "—",
        sub: lastFeed
          ? `${when(lastFeed.fed_at, now)} · ${lastFeed.ml} ml ${MILK[lastFeed.milk] ?? lastFeed.milk}`
          : "nothing logged yet",
      },
      {
        label: "Milk today",
        value: `${mlToday} ml`,
        sub: `${feedsToday.length} feed${feedsToday.length === 1 ? "" : "s"}`,
      },
      {
        label: "Vitamin D today",
        value: vitD ? "Given" : "Not yet",
        sub: vitD ? `with the ${clock(vitD.fed_at)} feed` : "tick it on a feed",
        tone: vitD ? "good" : "warn",
      },
      {
        label: "Last poop",
        value: lastPoop ? `${span(now - lastPoop.changed_at)} ago` : "—",
        sub: `today: ${nappyCount?.poops ?? 0} poop · ${nappyCount?.wees ?? 0} wee`,
      },
      {
        label: "Sleep today",
        value: span(sleptToday),
        sub: asleep ? `asleep since ${clock(asleep.started_at)}` : `${sleeps.length} sleep${sleeps.length === 1 ? "" : "s"}`,
      },
    ]);

    /* ----------------------------------------------------- milk by day */

    const byDay = new Map<number, { breast: number; formula: number }>();
    for (let d = fortnight; d <= today; d = midnight(d + DAY + 3_600_000)) byDay.set(d, { breast: 0, formula: 0 });
    for (const f of recentFeeds) {
      const bucket = byDay.get(midnight(f.fed_at));
      if (!bucket) continue;
      if (f.milk === "formula") bucket.formula += f.ml;
      else bucket.breast += f.ml;
    }
    const milkPanel = series({
      title: "Milk per day",
      note: "The last 14 days, in ml.",
      legend: ["Breast milk", "Formula"],
      // No points at all when nothing was logged, so the panel says so
      // instead of drawing fourteen empty columns on a 0–1 axis.
      points: recentFeeds.length === 0 ? [] : [...byDay.entries()].map(([d, v]) => ({
        label: new Date(d).toLocaleString("en-GB", { day: "numeric", month: "short" }),
        values: [v.breast, v.formula],
        displays: [`${v.breast} ml`, `${v.formula} ml`],
      })),
      empty: "No feeds logged in the last 14 days.",
    });

    /* -------------------------------------------------------- vaccines */

    const pending = ctx.sql<{
      vaccine: string;
      dose: string | null;
      appointment_at: number | null;
      clinic: string | null;
      additional: number;
      remarks: string | null;
    }>(
      `SELECT vaccine, dose, appointment_at, clinic, additional, remarks FROM ${vaccines}
        WHERE deleted_at IS NULL AND given_on IS NULL
        ORDER BY appointment_at IS NULL, appointment_at ASC LIMIT 20`,
    );
    const given = ctx.sql<{ vaccine: string; dose: string | null; given_on: string; additional: number }>(
      `SELECT vaccine, dose, given_on, additional FROM ${vaccines}
        WHERE deleted_at IS NULL AND given_on IS NOT NULL
        ORDER BY given_on DESC LIMIT 8`,
    );
    const name = (v: { vaccine: string; dose: string | null; additional: number }) =>
      `${v.vaccine}${v.dose ? ` (${v.dose})` : ""}${v.additional ? " · additional" : ""}`;

    const comingUp = rows({
      title: "Vaccines coming up",
      columns: [
        { key: "vaccine", label: "Vaccine" },
        { key: "when", label: "Appointment", mono: true },
        { key: "clinic", label: "Clinic" },
        { key: "remarks", label: "Remarks" },
      ],
      data: pending.map((v) => ({
        vaccine: name(v),
        when: v.appointment_at ? when(v.appointment_at, now) : "not booked",
        clinic: v.clinic ?? "—",
        remarks: v.remarks ?? "",
      })),
      empty: "Nothing booked. Add the next appointment on the Vaccine tab.",
    });
    const done = rows({
      title: "Vaccines given",
      columns: [
        { key: "vaccine", label: "Vaccine" },
        { key: "on", label: "Given on", mono: true },
      ],
      data: given.map((v) => ({ vaccine: name(v), on: day(v.given_on) })),
      empty: "None recorded yet.",
    });

    /* ---------------------------------------------------------- growth */

    const readings = ctx.sql<{ measured_on: string; weight_kg: number | null; height_cm: number | null; place: string | null }>(
      `SELECT measured_on, weight_kg, height_cm, place FROM ${growth}
        WHERE deleted_at IS NULL ORDER BY measured_on DESC, created_at DESC LIMIT 8`,
    );
    const growthPanel = rows({
      title: "Growth",
      columns: [
        { key: "on", label: "Date", mono: true },
        { key: "weight", label: "Weight", align: "right", mono: true },
        { key: "height", label: "Height", align: "right", mono: true },
        { key: "place", label: "Where" },
      ],
      data: readings.map((r) => ({
        on: day(r.measured_on),
        weight: r.weight_kg == null ? "—" : `${r.weight_kg} kg`,
        height: r.height_cm == null ? "—" : `${r.height_cm} cm`,
        place: r.place ?? "",
      })),
      empty: "No readings yet. Add one on the Growth tab after a clinic visit.",
    });

    /* -------------------------------------------------------- spending */

    const monthStart = (() => {
      const d = new Date(now);
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-01`;
    })();
    const byPayer = ctx.sql<{ paid_by: string; total: number }>(
      `SELECT paid_by, SUM(amount_cents) AS total FROM ${spend}
        WHERE deleted_at IS NULL AND spent_on >= ? GROUP BY paid_by ORDER BY total DESC`,
      monthStart,
    );
    const byCategory = ctx.sql<{ category: string; total: number }>(
      `SELECT category, SUM(amount_cents) AS total FROM ${spend}
        WHERE deleted_at IS NULL AND spent_on >= ? GROUP BY category ORDER BY total DESC`,
      monthStart,
    );
    const monthTotal = byPayer.reduce((n, r) => n + r.total, 0);

    const payerPanel = bars({
      title: `Spent this month · ${formatMoney(monthTotal, "RM")}`,
      note: "Who paid, from the 1st of this month.",
      rows: byPayer.map((r) => ({
        label: PAYER[r.paid_by] ?? r.paid_by,
        value: r.total / 100,
        display: formatMoney(r.total, "RM"),
      })),
      empty: "Nothing spent this month yet.",
    });
    const categoryPanel = bars({
      title: "By category",
      rows: byCategory.map((r) => ({
        label: r.category.charAt(0).toUpperCase() + r.category.slice(1),
        value: r.total / 100,
        display: formatMoney(r.total, "RM"),
      })),
      empty: "Nothing spent this month yet.",
    });

    return [todayPanel, milkPanel, comingUp, done, growthPanel, payerPanel, categoryPanel];
  },
});
