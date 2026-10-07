import { db } from "./db.ts";
import { table, type Row } from "./tables.ts";
import { realName } from "../integrations/evolution.ts";

/**
 * One person, one chat — for the personal assistant's WhatsApp chats.
 *
 * WhatsApp hides some numbers behind a privacy id (`…@lid`), and Evolution
 * files a conversation under whichever of the two a message came with, so
 * one person can turn into two chats: the phone number (`…@s.whatsapp.net`)
 * and the `@lid`. On 2026-10-07 that meant a lesson taught on one half never
 * applied to the other, two cards about the same call, and a holding reply he
 * had already corrected written again on the other half.
 *
 * The fix is a link, not a guess. The phone-number key is canonical — it is
 * what a reply is sent to, and a reply sent there lands in the conversation
 * he sees on his phone (one sent there on 2026-10-07 was answered from the
 * `@lid`). The `@lid` keeps its `people` row with `same_as` set to the
 * canonical key and nothing else of its own, so the sync still recognises it
 * and every tool can turn it into the canonical one. Everything else — the
 * chat log, lessons, questions, drafts — is moved to the canonical key, so
 * there is one conversation, one set of lessons and one open draft.
 *
 * **Never from names.** Two people can share a name, and a wrong link sends a
 * reply to the wrong person. A link comes from Evolution (a message filed
 * under the `@lid` that carries the number as `remoteJidAlt`) or from him,
 * through the assistant's `update_person same_as`, between two chats that are
 * both already in `people`.
 *
 * `task_work` and `tasks` hold no chat key (a task's source is a display
 * name), so there is nothing to move there.
 */

const PEOPLE = "people";

/** What a link did — counts only, because it is a run's checkpoint too. */
export interface LinkResult {
  /** The key everything now lives under. */
  canonical: string;
  /** False when the two were already linked, and nothing was done. */
  linked: boolean;
  messages: number;
  lessons: number;
  questions: number;
  drafts: number;
  /** Open drafts withdrawn because the other half already had one. */
  withdrawn: number;
}

const PRIORITY_RANK: Record<string, number> = { always: 3, normal: 2, ignore: 1 };

/** A WhatsApp key for a phone number, as opposed to a `@lid` or a group. */
export const isPhoneKey = (key: string) => /^whatsapp:\d+@s\.whatsapp\.net$/.test(key);
export const isLidKey = (key: string) => /^whatsapp:\d+@lid$/.test(key);

/** A people name that is only a stand-in: the hidden-number label or a number. */
const isPlaceholder = (name: unknown) =>
  String(name ?? "").startsWith("Hidden number") || !realName(String(name ?? ""));

/** alias key → canonical key, for every linked `people` row. */
export function aliases(): Map<string, string> {
  const out = new Map<string, string>();
  for (const r of table(PEOPLE).query({ limit: 1000 })) {
    if (r.same_as) out.set(String(r.chat_key), String(r.same_as));
  }
  return out;
}

/** The key a chat's things live under: itself, or the chat it is linked to. */
export function canonicalKey(key: string, links: Map<string, string> = aliases()): string {
  // A chain cannot form — linkChats points every alias at the end of one —
  // but a row edited by hand on the Tables tab could, so it is bounded.
  let k = key;
  for (let i = 0; i < 5 && links.has(k); i++) k = links.get(k)!;
  return k;
}

const moveMessages = db.prepare(
  `UPDATE OR IGNORE chat_messages SET chat = ? WHERE channel = 'whatsapp' AND chat = ?`,
);
// A message stored under both halves — the same id — is one message; the
// copy the update could not move is the duplicate.
const dropLeftovers = db.prepare(`DELETE FROM chat_messages WHERE channel = 'whatsapp' AND chat = ?`);

const jidOf = (key: string) => key.slice("whatsapp:".length);

/**
 * Makes two WhatsApp chats one person — the phone number kept, the `@lid`
 * its alias — and moves everything of the alias's onto the number.
 * Idempotent: a pair already linked is left as it is (`linked: false`).
 *
 * Either may already be linked to something else; each is followed to the
 * key it lives under first, so linking never forks a person in two. Two
 * numbers are refused. When neither is in `people` there is nothing to link
 * and it throws; a number with no row of its own takes the alias's.
 */
export function linkChats(one: string, other: string, writtenBy: string): LinkResult {
  const people = table(PEOPLE);
  const links = aliases();
  let aliasKey = canonicalKey(one, links);
  let canonical = canonicalKey(other, links);
  if (aliasKey === canonical) {
    return { canonical, linked: false, messages: 0, lessons: 0, questions: 0, drafts: 0, withdrawn: 0 };
  }
  if (!aliasKey.startsWith("whatsapp:") || !canonical.startsWith("whatsapp:")) {
    throw new Error("Only WhatsApp chats are linked — a Telegram chat has one id");
  }
  // The number is what a reply goes to, so it is always the one kept.
  if (isPhoneKey(aliasKey) && isPhoneKey(canonical)) {
    throw new Error("Two phone numbers are two chats — only a hidden id (@lid) is linked to a number");
  }
  if (isPhoneKey(aliasKey)) [aliasKey, canonical] = [canonical, aliasKey];
  const byKey = (k: string) =>
    people.query({ where: [{ column: "chat_key", op: "=", value: k }], limit: 1 })[0] as Row | undefined;
  const alias = byKey(aliasKey);
  let canon = byKey(canonical);
  if (!alias && !canon) throw new Error(`Neither ${aliasKey} nor ${canonical} is in people`);
  if ([alias, canon].some((r) => r && r.kind !== "person")) throw new Error("Only a person's chats are linked, not a group's");

  if (!canon) {
    // Seen so far only under its hidden id: the number becomes the row, with
    // what was known about the alias.
    canon = people.insert(
      {
        name: alias!.name,
        channel: "whatsapp",
        kind: alias!.kind,
        priority: alias!.priority ?? null,
        notes: alias!.notes ?? null,
        chat_key: canonical,
      },
      { writtenBy },
    ).row;
  } else if (alias) {
    const patch: Record<string, unknown> = {};
    const a = alias.priority ? PRIORITY_RANK[String(alias.priority)] ?? 0 : 0;
    const c = canon.priority ? PRIORITY_RANK[String(canon.priority)] ?? 0 : 0;
    if (a > c) patch.priority = alias.priority;
    const notes = mergeNotes(canon.notes as string | null, alias.notes as string | null);
    if (notes !== (canon.notes ?? null)) patch.notes = notes;
    if (isPlaceholder(canon.name) && !isPlaceholder(alias.name)) patch.name = alias.name;
    if (Object.keys(patch).length) canon = people.update(String(canon.id), patch, { writtenBy });
  }

  if (alias) {
    // Its priority and notes now live on the canonical row; left here they
    // would be a second, stale copy.
    people.update(String(alias.id), { same_as: canonical, priority: null, notes: null }, { writtenBy });
  } else {
    // Linked before the hidden id ever got a row of its own: give it one, so
    // the sync knows the `@lid` the next time Evolution files a message there.
    people.insert(
      { name: canon.name, channel: "whatsapp", kind: canon.kind, priority: null, chat_key: aliasKey, same_as: canonical },
      { writtenBy },
    );
  }
  // Anything that pointed at the canonical row's old alias — a three-way
  // pair — follows to the end.
  for (const [from, to] of links) {
    if (to === aliasKey) {
      const row = byKey(from);
      if (row) people.update(String(row.id), { same_as: canonical }, { writtenBy });
    }
  }

  const messages = moveMessages.run(jidOf(canonical), jidOf(aliasKey)).changes;
  dropLeftovers.run(jidOf(aliasKey));

  const repoint = (name: string, extra?: (r: Row) => Record<string, unknown>) => {
    const t = table(name);
    const rows = t.query({ where: [{ column: "chat_key", op: "=", value: aliasKey }], limit: 1000 });
    for (const r of rows) t.update(String(r.id), { chat_key: canonical, ...(extra?.(r) ?? {}) }, { writtenBy });
    return rows.length;
  };
  const lessons = repoint("lessons");
  const questions = repoint("questions");

  // One open draft per chat. If both halves have one, the newer stands —
  // it was written with more of the conversation in view.
  const drafts = table("drafts");
  const open = (k: string) =>
    drafts
      .query({ where: [{ column: "chat_key", op: "=", value: k }], limit: 1000 })
      .filter((d) => d.status === "pending" || d.status === "revise");
  let withdrawn = 0;
  const both = [...open(aliasKey), ...open(canonical)].sort((x, y) => Number(y.created_at) - Number(x.created_at));
  for (const d of both.slice(1)) {
    drafts.update(
      String(d.id),
      {
        status: "withdrawn",
        reason: "Same person as another chat — merged; the newer draft stands",
        card_outdated: Boolean(d.card_id),
        learned: !d.feedback,
      },
      { writtenBy },
    );
    withdrawn++;
  }
  const url = chatUrl(canonical);
  const draftsMoved = repoint("drafts", (d) =>
    url && (d.status === "pending" || d.status === "revise") ? { chat_url: url } : {},
  );

  return {
    canonical,
    linked: true,
    messages,
    lessons,
    questions,
    drafts: draftsMoved,
    withdrawn,
  };
}

/** The "Open chat" link for a WhatsApp number — the same as the assistant's. */
function chatUrl(key: string): string | null {
  const n = key.match(/^whatsapp:(\d+)@s\.whatsapp\.net$/)?.[1];
  return n ? `https://wa.me/${n}` : null;
}

/** Both halves' notes, once each, within the 1000 characters notes allow. */
function mergeNotes(a: string | null, b: string | null): string | null {
  const x = a?.trim() || null;
  const y = b?.trim() || null;
  if (!x || !y) return x ?? y;
  if (x.includes(y)) return x;
  if (y.includes(x)) return y;
  const joined = `${x} ${y}`;
  return joined.length <= 1000 ? joined : `${joined.slice(0, 999)}…`;
}
