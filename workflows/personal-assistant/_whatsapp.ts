import { realName, type ChatLogEntry, type EvolutionMessage } from "../../src/core/define.ts";

/**
 * What `sync-chats` and `find-chat` both need to turn Evolution's chats into
 * the chat log and `people` rows — one copy, so a chat looked up on demand
 * is named and recorded exactly as one the sync found.
 */

/**
 * WhatsApp message types that are bookkeeping, not something anybody said:
 * an edit, a deletion, a disappearing-messages setting.
 */
export const NOISE = new Set(["protocolMessage"]);

/**
 * What a person is called when WhatsApp gave no name at all — some people set
 * none, and Evolution has no address book. A phone number is shown as one;
 * a `@lid` is a privacy id, not a number, so it says the number is hidden
 * rather than showing digits that would be mistaken for one.
 */
export const HIDDEN = "Hidden number (WhatsApp)";
export function placeholder(jid: string): string {
  const [id, server] = jid.split("@");
  return server === "lid" ? HIDDEN : `+${id}`;
}
/** A people name that is only a stand-in, and may be replaced by a real one. */
export const isPlaceholder = (name: unknown) => name === HIDDEN || !realName(String(name ?? ""));

export function fromWhatsApp(m: EvolutionMessage, chatName: string | undefined): ChatLogEntry {
  return {
    channel: "whatsapp",
    chat: m.chat,
    chatName,
    isGroup: m.isGroup,
    id: m.id,
    sender: m.from,
    senderName: m.name,
    text: m.text,
    type: m.type,
    outgoing: m.outgoing,
    replyTo: m.replyTo,
    sentAt: m.timestamp ? m.timestamp * 1000 : Date.now(),
  };
}
