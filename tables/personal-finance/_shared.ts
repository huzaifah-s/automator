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
 * Help text reused by both tables, so the two do not drift into describing the
 * same column differently — the description is what an agent reads before it
 * writes a row, and two versions of it is two behaviours.
 */
export const HELP = {
  amount: "Whole cents/sen, always positive. RM 42.50 is 4250.",
  occurredOn:
    "The date on the receipt or statement, not the date it was entered (YYYY-MM-DD).",
  account: "Which account or wallet it moved through — cash, maybank, tng, card.",
  entryKey:
    "Optional idempotency key. Supply a stable one (a receipt hash, a bank " +
    "reference) and writing the same row twice is a no-op instead of a duplicate.",
  needsReview:
    "Set when the figures were read from an image and are worth a second look.",
} as const;
