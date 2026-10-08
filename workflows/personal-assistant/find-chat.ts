import { z } from "zod";
import {
  canonicalKey,
  chatLogKeeps,
  defineCredential,
  defineWorkflow,
  linkChats,
  manual,
  realName,
  type EvolutionChat,
  type Row,
} from "../../src/core/define.ts";
import { NOISE, fromWhatsApp, isPlaceholder, placeholder } from "./_whatsapp.ts";

/**
 * Personal assistant — finds a WhatsApp chat the sync has not brought in, by
 * a name or a number, and adds it to `people` with its recent messages.
 *
 * Started by the assistant's `find_chat` tool. The sync only reads chats with
 * a message since it last looked, so somebody he last spoke to a month ago is
 * nobody to the assistant — she could neither read the chat nor draft to it
 * (2026-10-08: "his WhatsApp chat isn't in my list"). Evolution keeps every
 * chat it has seen, so this pages through all of them.
 *
 * **Who can become a chat.** A chat Evolution already has — a conversation he
 * has had, the same thing the sync would add the moment it had a new message.
 * A number with no chat at all only when the endpoint passes `new_number`,
 * which it does only for a number written in his own note to her: the rule
 * that keeps a number in somebody's message from becoming a recipient.
 *
 * **A chat already here** is read again when the endpoint asks for its older
 * messages: the sync only takes what is new since it last looked, so history
 * WhatsApp hands Evolution later (a re-link with full history) reaches the
 * log only this way.
 *
 * **What is kept.** Messages go to the chat log, which takes only what falls
 * inside its retention window — his own for longer than theirs. The run's
 * result is chat keys, names and counts — never message text — like the
 * sync's.
 */

const whatsappAccount = defineCredential("evolution", "huzaifah-evolution-api");

/** Evolution pages; 10 is 1,000 chats, about three times what the account holds today. */
const PAGES = 10;
const PAGE = 100;
/** Chats added from one search: a name like "Ali" can match a dozen; past this, say so. */
const MAX_MATCHES = 5;
/**
 * Messages read from each chat found. Enough that his own older ones —
 * kept longer than theirs, for how he writes — come with it.
 */
const MESSAGES = 100;

const input = z
  .object({
    /** Part of a name — every word must appear in the chat's name. */
    name: z.string().trim().min(2).max(80).optional(),
    /** A number, digits only with its country code. */
    number: z.string().regex(/^\d{8,15}$/).optional(),
    /** The number is from his own words: add it even when there is no chat yet. */
    new_number: z.boolean().default(false),
  })
  .refine((v) => v.name || v.number, "Pass a name or a number");

export interface FoundChat {
  chat_key: string;
  name: string;
  kind: "person" | "group";
  /** Added to `people` by this run, rather than already there. */
  added: boolean;
  priority: string | null;
  /** Messages recorded now, inside the chat log's window. */
  messages: number;
  /** Messages Evolution has that are older than the window, so not recorded. */
  older: number;
  /** When the newest message was, ISO — null for a number never written to. */
  last: string | null;
}

/** Lower case, no accents, no punctuation — "Fáiz Hussin (PDKM)" finds "faiz hussin". */
const fold = (s: string) =>
  s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

const digitsOf = (jid: string | undefined) => (jid ? (jid.split("@")[0] ?? "") : "");

export default defineWorkflow({
  name: "personal-assistant-find-chat",
  description: "Finds a WhatsApp chat the assistant has not seen yet, by name or number, and brings it in",
  trigger: manual(),
  // A read-and-record: running it twice finds the same chat and records
  // nothing new, so a retry is safe.
  retries: 1,
  timeoutMs: 60_000,

  async run(ctx) {
    const parsed = input.safeParse(ctx.input);
    if (!parsed.success) return { refused: parsed.error.issues.map((i) => i.message).join("; "), found: [] };
    const { name, number, new_number } = parsed.data;

    const hits = await ctx.step("search", async () => {
      const words = name ? fold(name).split(" ").filter(Boolean) : [];
      const matches: EvolutionChat[] = [];
      let scanned = 0;
      for (let page = 0; page < PAGES; page++) {
        const chats = await ctx.evolution.chats({
          limit: PAGE,
          skip: page * PAGE,
          private: true,
          credential: whatsappAccount,
        });
        scanned += chats.length;
        for (const c of chats) {
          if (c.chat.endsWith("@newsletter") || c.chat.endsWith("@broadcast")) continue;
          const alt = c.lastMessage?.chatAlt;
          const byNumber =
            number !== undefined && (digitsOf(c.chat) === number || digitsOf(alt) === number);
          const label = fold(c.name ?? "");
          const byName = words.length > 0 && label !== "" && words.every((w) => label.includes(w));
          if (byNumber || byName) matches.push(c);
        }
        if (chats.length < PAGE) break;
      }
      // Newest first is how Evolution lists them; a number match first of all.
      matches.sort((a, b) => Number(digitsOf(b.chat) === number) - Number(digitsOf(a.chat) === number));
      // A step's result is stored: only the chats that will be brought in.
      return {
        scanned,
        matched: matches.length,
        chats: matches.slice(0, MAX_MATCHES).map((c) => ({
          chat: c.chat,
          name: c.name,
          alt: c.lastMessage?.chatAlt,
          isGroup: c.isGroup,
          updatedAt: c.updatedAt,
        })),
      };
    });

    const people = () =>
      new Map<string, Row>(ctx.table("people").query({ limit: 1000 }).map((r) => [String(r.chat_key), r]));

    const found = await ctx.step("bring in", async () => {
      const out: FoundChat[] = [];
      let list = hits.chats;
      // No chat with that number, and he gave it himself: one he has never
      // written to — WhatsApp says whether it exists.
      if (list.length === 0 && number && new_number) {
        const [checked] = await ctx.evolution.exists([number], { credential: whatsappAccount });
        if (checked?.exists && checked.jid) {
          list = [{ chat: checked.jid, name: undefined, alt: undefined, isGroup: false, updatedAt: undefined }];
        }
      }

      for (const c of list) {
        // A hidden id whose number came with it is kept under the number,
        // as the sync does, so drafts go to a number and lessons carry over.
        const lidWithNumber = c.chat.endsWith("@lid") && c.alt;
        const target = canonicalKey(`whatsapp:${lidWithNumber ? c.alt : c.chat}`);
        let row = people().get(target);

        const messages = (
          await ctx.evolution.messages(c.chat, { limit: MESSAGES, private: true, credential: whatsappAccount })
        ).filter((m) => !NOISE.has(m.type));
        const theirName =
          realName(c.name) ??
          (c.isGroup ? undefined : realName([...messages].reverse().find((m) => !m.outgoing)?.name)) ??
          (c.isGroup ? undefined : await ctx.evolution.contactName(c.chat, { private: true, credential: whatsappAccount }));

        let added = false;
        if (!row) {
          const inserted = ctx.table("people").insert(
            {
              name: theirName ?? placeholder(target.slice("whatsapp:".length)),
              channel: "whatsapp",
              kind: c.isGroup ? "group" : "person",
              priority: null,
              chat_key: target,
            },
            { writtenBy: ctx.workflow },
          );
          row = inserted.row;
          added = inserted.created;
        } else if (theirName && isPlaceholder(row.name)) {
          row = ctx.table("people").update(String(row.id), { name: theirName }, { writtenBy: ctx.workflow });
        }
        if (lidWithNumber && canonicalKey(`whatsapp:${c.chat}`) !== target) {
          try {
            linkChats(`whatsapp:${c.chat}`, target, ctx.workflow);
          } catch (err) {
            // As in the sync: a pair that cannot be linked must not lose the
            // chat that was found. No keys in the line — they are numbers.
            ctx.log.warn(`A hidden WhatsApp id was not linked to its number: ${(err as Error).message.replace(/\d{6,}/g, "…")}`);
          }
        }

        const inWindow = messages
          .map((m) => ({ ...fromWhatsApp(m, c.name), chat: target.slice("whatsapp:".length) }))
          .filter((e) => chatLogKeeps(e));
        const recorded = ctx.chatLog.record(inWindow);
        const newest = messages.at(-1)?.timestamp;
        out.push({
          chat_key: target,
          name: String(row.name),
          kind: c.isGroup ? "group" : "person",
          added,
          priority: (row.priority as string | null) ?? null,
          messages: recorded,
          older: messages.length - inWindow.length,
          last: newest ? new Date(newest * 1000).toISOString() : (c.updatedAt ?? null),
        });
      }
      return out;
    });

    return { scanned: hits.scanned, matched: hits.matched, found };
  },
});
