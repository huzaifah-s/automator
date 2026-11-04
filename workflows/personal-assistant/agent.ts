import { defineAgent } from "../../src/core/define.ts";
import { INSTRUCTIONS, TOOLS } from "./_tools.ts";

/**
 * Maria, the personal assistant, as an agent: her tools (_tools.ts) and the
 * instructions every client is handed with them.
 *
 * Served over MCP to a token minted for this agent on the MCP tab — at the
 * token's own /mcp/<id>, and at /mcp/assistant for the clients set up before
 * that — and called in-process by the chat pass. Three things drive her,
 * and none of them is in this file:
 *
 * - **Live Maria** (_live.ts): Claude Code spawned inside the bot's run,
 *   reaching these tools through `agentConnection` with the `live` profile.
 * - **The chat pass** (chat-pass.ts): code is the loop, one chat and one
 *   decision per model call, applied with `agentTools`.
 * - **The scheduled routine**: a hosted Claude session with a stored token,
 *   whose playbook is in huzaifah-s/maria-personal-assistant. Off since
 *   2026-10-25; kept working, not developed.
 *
 * The name is the grant's name and the alias path; every stored assistant
 * token is read as a grant on it (`tokenGrants`), so do not rename it.
 */
export default defineAgent({
  name: "assistant",
  label: "Personal assistant",
  description:
    "Maria: your Telegram and WhatsApp chats, drafts, people and Notion tasks. Reads private messages — " +
    "give it only to the assistant.",
  instructions: INSTRUCTIONS,
  tools: TOOLS,
  profiles: {
    /**
     * Live Maria answers a note or a draft comment in the bot's run. The
     * hourly run's own jobs — digests, the run log, outcomes and learning
     * from them, questions, briefs, the scorecard, follow-ups — are not hers.
     */
    live: { exclude: ["digest", "log_run", "outcomes", "ask", "brief", "scorecard", "awaiting", "offer_followup"] },
  },
});
