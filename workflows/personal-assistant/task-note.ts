import { z } from "zod";
import { defineCredential, defineWorkflow, manual } from "../../src/core/define.ts";
import { MARIA_ICON, MARIA_MARK, blocksText, headers, sameText, textBlocks, type Block } from "./_notion.ts";

/**
 * Personal assistant — writes a note on one of your To Do tasks.
 *
 * Started by the assistant's `task_note` tool, like `create-task`, so every
 * write to Notion is a run: on the run page and alerted on failure.
 *
 * **Append-only, one callout per note.** The note goes at the end of the page
 * as a grey callout headed "🤖 Maria · 7 Oct 14:05 · Draft", with the text
 * inside it. Nothing already on the page is changed, and no property — not
 * the status, not the due date — is touched: the assistant helps with a task,
 * it does not decide that one is finished.
 *
 * The callout's id and the text as rendered back are recorded in `task_work`,
 * which is how `sync-tasks` later notices you edited or deleted it — see that
 * table. The row is written in the same step as the append, and only once
 * Notion has returned a real block: a practice run's held PATCH returns none.
 *
 * Not retried, for the same reason as `create-task`: an append that timed out
 * may have happened, and a retry is the same note twice.
 */

const notion = defineCredential("notion", "huzaifah-notion");
const TZ = "Asia/Kuala_Lumpur";
/** Notion takes 100 children per request; the header line is not one of them. */
const MAX_LINES = 90;

const KINDS = { draft: "Draft", plan: "Plan", questions: "Questions", update: "Update", answer: "Your answer" };

const input = z.object({
  page_id: z.string().trim().min(32),
  title: z.string().trim().min(1),
  /** The task's status now, so a later change to Done or KIV reads as an outcome. */
  status: z.string().nullish(),
  kind: z.enum(["draft", "plan", "questions", "update", "answer"]),
  text: z.string().trim().min(1).max(8000),
});

const stamp = new Intl.DateTimeFormat("en-GB", {
  timeZone: TZ,
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

export default defineWorkflow({
  name: "personal-assistant-task-note",
  description: "Writes the assistant's note on a Notion To Do task",
  trigger: manual(),
  retries: 0,
  timeoutMs: 60_000,

  async run(ctx) {
    const parsed = input.safeParse(ctx.input);
    if (!parsed.success) {
      return { refused: parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ") };
    }
    const note = parsed.data;
    const children = textBlocks(note.text);
    if (children.length === 0) return { refused: "text has no lines" };
    if (children.length > MAX_LINES) {
      return { refused: `text is ${children.length} lines; a note is at most ${MAX_LINES} — split it or link out` };
    }

    // The same note twice is a retry or a run repeating itself, never
    // something you need to read again.
    const rendered = blocksText(children);
    const again = ctx
      .table("task_work")
      .query({ where: [{ column: "page_id", op: "=", value: note.page_id }], limit: 100 })
      .find((w) => sameText(String(w.text), rendered));
    if (again) return { refused: `this exact note is already on the task (${again.id})` };

    const heading = `${MARIA_MARK} ${stamp.format(new Date()).replace(",", "").replace(" at ", " ")} · ${KINDS[note.kind]}`;
    const callout = {
      object: "block",
      type: "callout",
      callout: {
        rich_text: [{ type: "text", text: { content: heading }, annotations: { bold: true } }],
        icon: { type: "emoji", emoji: MARIA_ICON },
        color: "gray_background",
        children,
      },
    };

    // `rendered` is what the sync will read back from this callout's
    // children, by the same function — so an untouched note compares equal.
    return ctx.step("append note", async () => {
      const res = await ctx.http.patch<{ results?: Block[] }>(
        `https://api.notion.com/v1/blocks/${note.page_id}/children`,
        { children: [callout] },
        { headers: headers(notion.token), retries: 0 },
      );
      const blockId = res?.results?.[0]?.id;
      if (typeof blockId !== "string") return { appended: false };
      const { row } = ctx.table("task_work").insert(
        {
          page_id: note.page_id,
          task_title: note.title,
          kind: note.kind,
          text: rendered,
          block_id: blockId,
          seen_text: rendered,
          seen_status: note.status ?? null,
        },
        { writtenBy: ctx.workflow },
      );
      return { appended: true, work: row.id, block: blockId };
    });
  },
});
