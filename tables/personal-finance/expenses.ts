import {
  bool,
  date,
  defineTable,
  enumOf,
  money,
  text,
} from "../../src/core/define.ts";
import { EXPENSE_CATEGORIES, HELP, SOURCES } from "./_shared.ts";

/**
 * Money out — one row per transaction, however it was captured.
 *
 * Written from three directions and deliberately identical from all of them:
 * by hand on the Tables tab, by an agent over the MCP endpoint after reading a
 * receipt, and by a workflow if one is ever pointed at a statement. Nothing in
 * here knows or cares which.
 */
export default defineTable({
  name: "expenses",
  description: "Money out — receipts, bills and anything else spent.",

  columns: {
    occurred_on: date({ label: "Date", help: HELP.occurredOn }),
    merchant: text({ label: "Merchant", help: "Who was paid, as printed." }),
    amount_cents: money({ label: "Amount", help: HELP.amount }),
    currency: text({ default: "MYR", help: "ISO code. MYR unless it was spent abroad." }),
    category: enumOf(EXPENSE_CATEGORIES, { label: "Category" }),
    account: text({ nullable: true, help: HELP.account }),
    note: text({ nullable: true, help: "Anything worth remembering about it." }),
    source: enumOf(SOURCES, { default: "manual", help: "How the row arrived." }),
    receipt_ref: text({
      nullable: true,
      label: "Receipt",
      help: "Where the original lives — a Drive link, or the photo's date and time.",
    }),
    needs_review: bool({ default: false, label: "Review?", help: HELP.needsReview }),
    entry_key: text({ nullable: true, label: "Key", help: HELP.entryKey }),
  },

  // Null opts out, so only rows that carry a key are deduped — which is what
  // makes a retried write safe without making two identical RM 5 coffees on
  // the same day collide.
  dedupe: "entry_key",

  // Newest spending first: the question this table is opened with is almost
  // always about the recent end of it.
  order: { column: "occurred_on", direction: "desc" },
});
