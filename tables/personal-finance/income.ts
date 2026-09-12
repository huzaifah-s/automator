import {
  bool,
  date,
  defineTable,
  enumOf,
  money,
  text,
} from "../../src/core/define.ts";
import { HELP, INCOME_CATEGORIES, SOURCES } from "./_shared.ts";

/**
 * Money in.
 *
 * A separate table rather than a `direction` column on `expenses`, because the
 * two are asked about separately far more often than together ("what did I
 * spend on food", "what did I earn in March") and a shared table makes every
 * one of those questions carry a filter that is easy to forget. The columns
 * that do line up are named identically, so a union when you genuinely want
 * both is a union and not a translation.
 */
export default defineTable({
  name: "income",
  description: "Money in — salary, invoices, refunds and anything else received.",

  columns: {
    occurred_on: date({ label: "Date", help: HELP.occurredOn }),
    payer: text({ label: "From", help: "Who paid it." }),
    amount_cents: money({ label: "Amount", help: HELP.amount }),
    currency: text({ default: "MYR", help: "ISO code. MYR unless it was paid abroad." }),
    category: enumOf(INCOME_CATEGORIES, { label: "Category" }),
    account: text({ nullable: true, help: HELP.account }),
    note: text({ nullable: true, help: "Anything worth remembering about it." }),
    source: enumOf(SOURCES, { default: "manual", help: "How the row arrived." }),
    reference: text({
      nullable: true,
      help: "Invoice number, bank reference — whatever identifies it elsewhere.",
    }),
    needs_review: bool({ default: false, label: "Review?", help: HELP.needsReview }),
    entry_key: text({ nullable: true, label: "Key", help: HELP.entryKey }),
  },

  dedupe: "entry_key",
  order: { column: "occurred_on", direction: "desc" },
});
