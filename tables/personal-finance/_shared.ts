/**
 * Shared vocabulary for the personal-finance tables.
 *
 * The categories are a **closed set** on purpose. Left open, the column
 * collects "Groceries", "groceries", "Grocery" and "food/grocery" within a
 * month, and every question you would ask of the table — what did I spend on
 * this, how does the month compare — quietly answers about a quarter of the
 * rows. A closed set means the thing writing the row has to pick, and when
 * nothing fits, `other` is the honest answer rather than a new spelling.
 *
 * Adding one is a commit. That is the cost, and it is the right one: the set
 * is the report's row labels, so changing it is a decision about the report.
 */

/** Money out. */
export const EXPENSE_CATEGORIES = [
  "food",
  "groceries",
  "transport",
  "fuel",
  "utilities",
  "rent",
  "phone_internet",
  "health",
  /**
   * Looking after yourself rather than being ill: a haircut or a barber,
   * grooming, a salon, skincare and toiletries. Split out of `health` because
   * a barber is not a clinic, and out of `shopping` because a haircut is not a
   * purchase you can point at afterwards.
   */
  "personal_care",
  "shopping",
  "entertainment",
  "travel",
  "education",
  "family",
  "gifts",
  "fees",
  "subscriptions",
  "business",
  "other",
] as const;

/** Money in. */
export const INCOME_CATEGORIES = [
  "salary",
  "business",
  "freelance",
  "dividend",
  "interest",
  "rental",
  "refund",
  "gift",
  "other",
] as const;

/**
 * How a row arrived. Worth recording because the answer to "why is this wrong"
 * is usually here: `photo` and `pdf` rows were read by a model and can be
 * misread, `manual` rows were typed and cannot.
 */
export const SOURCES = ["photo", "pdf", "text", "manual", "import"] as const;

/**
 * How the money moved — a closed set for the same reason the categories are
 * one, and with the same failure mode if it is not ("Shopee Pay", "shopeepay",
 * "SPay").
 *
 * The cards are named individually rather than collapsed into `credit_card`,
 * because "which card is this on" is a question that gets asked and a generic
 * label cannot answer it.
 *
 * **This records how a purchase was paid for, not the settling of it.** Paying
 * the RHB bill, or an Atome instalment, is not an expense — see the note on
 * `PAID_FOR` below and the "what not to log" rule in README.
 */
export const ACCOUNTS = [
  "cash",
  /** A direct bank transfer or DuitNow, rather than a card. */
  "bank",
  "debit_cimb",
  "credit_rhb",
  "credit_pbb",
  /** Buy-now-pay-later. The row is the purchase in full, never an instalment. */
  "atome",
  "shopeepay",
  "tng",
  "grabpay",
  /** Usually foreign spend, so the `currency` column earns its keep here. */
  "wise",
  "other",
] as const;

/**
 * Who the money was actually for.
 *
 * The problem this solves: paying RM200 for a family dinner and being handed
 * RM150 back is not RM200 of your spending and RM150 of your income. Recorded
 * that way, both numbers are wrong — food spend is inflated and so is income.
 *
 * So money you fronted for somebody else stays **one expense row** with
 * `paid_for` set, and the payback is recorded on that same row as
 * `reimbursed_cents` rather than as a row in `income`. What you actually spent
 * is `amount_cents - reimbursed_cents`.
 *
 * If nobody ever pays you back, the row is simply your spending, which is the
 * correct answer and needs no correction.
 *
 * ## Who it was for is not the same question as who owes you
 *
 * `paid_for` answers the first one only. Buying your family dinner and buying
 * your family dinner *on the understanding they will settle up* are the same
 * row here, and reading "not me" as "they owe me" reports every treat you have
 * ever paid for as an outstanding debt.
 *
 * That is what `my_treat` on the expenses table is for: set it and the row is
 * simply your spending, still attributed to the person it was for. So "still
 * owed" is every row where `paid_for` is not `me`, `my_treat` is false, and
 * `amount_cents` and `reimbursed_cents` are not equal.
 */
export const PAID_FOR = [
  "me",
  "wife",
  "family",
  /** A work expense you will claim back. These stay outstanding for months. */
  "company",
  "other",
] as const;

/**
 * Help text reused by both tables, so the two do not drift into describing the
 * same column differently — the description is what an agent reads before it
 * writes a row, and two versions of it is two behaviours.
 */
export const HELP = {
  amount: "Whole cents/sen, always positive. RM 42.50 is 4250.",
  occurredOn:
    "The date on the receipt or statement, not the date it was entered (YYYY-MM-DD).",
  account:
    "Which card, wallet or account carried the purchase — not how that card was later " +
    "paid off. A purchase on Atome or a credit card is recorded here in full, once.",
  paidFor:
    "Who it was really for — not whether they owe you for it. `me` unless you " +
    "fronted it for someone; if you expect it back, the payback goes in " +
    "reimbursed_cents on this same row, never as income. If you do not, set my_treat.",
  // Kept to one sentence because the dashboard renders a bool's help as the
  // label beside its checkbox, where a paragraph does not fit. The longer
  // version of the rule is in the expenses table's own description, which is
  // what an agent reads before it writes a row.
  myTreat:
    "You paid for someone else and are not expecting it back, so the row is your " +
    "spending rather than a debt they owe you.",
  reimbursed:
    "How much has come back so far, in cents. 0 until it does. Net spend is " +
    "amount_cents minus this.",
  reimbursedOn: "When the most recent payback landed (YYYY-MM-DD). Null while still owed.",
  entryKey:
    "Optional idempotency key. Supply a stable one (a receipt hash, a bank " +
    "reference) and writing the same row twice is a no-op instead of a duplicate.",
  needsReview:
    "Set when the figures were read from an image and are worth a second look.",
} as const;
