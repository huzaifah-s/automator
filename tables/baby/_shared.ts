/**
 * Shared vocabulary for the baby tables.
 *
 * Every list here is a closed set for the same reason the finance categories
 * are: left open, "Formula", "formula" and "susu formula" are three answers to
 * one question, and every total on the baby view quietly counts a third of
 * them. Adding a value is a one-line change here and a restart.
 *
 * The values are what a parent sees on the phone page (underscores read as
 * spaces), so they are words rather than codes.
 */

/** What was in the bottle. Direct breastfeeding is not on the list: it has no ml. */
export const MILKS = ["breast_milk", "formula"] as const;

export const NAPPY_KINDS = ["poop", "wee", "both"] as const;

export const BABY_EXPENSE_CATEGORIES = [
  "milk",
  "diapers",
  "health",
  "clothes",
  "gear",
  "toiletries",
  "other",
] as const;

/**
 * Whose money it was, by name. Not "me": both parents log through their own
 * link, and "me" would mean a different person depending on who typed it.
 */
export const PAYERS = ["huzaifah", "zahidah"] as const;
