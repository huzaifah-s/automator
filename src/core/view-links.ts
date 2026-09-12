/**
 * Share links — the one way a view becomes readable without the dashboard's
 * credentials.
 *
 * A link is a random token. Knowing it *is* the access, the same way knowing
 * an MCP token is, and this file follows that one deliberately: **only the
 * digest is stored**, the plaintext is shown once at the moment it is minted,
 * and nothing anywhere returns it afterwards. A copy of the database is
 * therefore not a set of working links.
 *
 * Two properties are worth stating plainly, because a page that renders a
 * personal ledger deserves both:
 *
 * **The file decides whether a link may exist at all.** `resolve()` hands back
 * a record; the route then checks the view is still loaded and still has
 * `shareable: true`. Setting that flag back to false in the repository stops
 * every link that was ever minted, on the next request, without anybody having
 * to remember which ones were handed out. The database may only ever subtract
 * from what the repository allows — the same asymmetry as pausing a workflow.
 *
 * **A link is scoped to one view.** There is no "share everything" token, and
 * a link minted for the finance view cannot be pointed at an ops view by
 * editing the URL: the view name comes out of the row, never out of the path.
 */

import { createHash, randomBytes } from "node:crypto";
import { store } from "./db.ts";
import { log } from "./logger.ts";
import type { ViewLinkRecord } from "./types.ts";

/** Recognisable in a log line or a chat message as this and nothing else. */
const PREFIX = "aview_";

/** How much of the plaintext is kept so a row can be told from its siblings. */
const HINT_LENGTH = PREFIX.length + 6;

function digest(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Mints a link and returns the plaintext token **once**.
 *
 * 24 random bytes, so the token is 48 hex characters. Guessing one is not a
 * thing that happens, which is why there is no rate limit in front of the
 * public route: the lookup is by digest and there is no prefix to walk.
 */
export function createViewLink(
  view: string,
  label: string,
  opts: { expiresInDays?: number | null } = {},
): { token: string; id: string } {
  const token = PREFIX + randomBytes(24).toString("hex");
  const id = randomBytes(4).toString("hex");
  const days = opts.expiresInDays ?? null;
  store.insertViewLink({
    id,
    view,
    label,
    hash: digest(token),
    prefix: token.slice(0, HINT_LENGTH),
    expires_at: days && days > 0 ? Date.now() + days * 86_400_000 : null,
  });
  log.info(
    `Share link "${label}" created for view ${view} (${id}` +
      `${days ? `, expires in ${days} day(s)` : ""})`,
  );
  return { token, id };
}

export function deleteViewLink(id: string): boolean {
  const gone = store.deleteViewLink(id);
  if (gone) log.info(`Share link ${id} revoked — the URL now answers 404`);
  return gone;
}

export function viewLinks(view?: string): ViewLinkRecord[] {
  return store.viewLinks(view);
}

/**
 * Resolves a presented token to its row, or null.
 *
 * An expired link is treated exactly like an unknown one — the caller answers
 * 404 either way, because "this link has expired" tells somebody who should
 * not have the link that it was once real.
 */
export function resolveViewLink(presented: string): ViewLinkRecord | null {
  if (!presented || !presented.startsWith(PREFIX)) return null;
  const row = store.viewLinkByHash(digest(presented));
  if (!row) return null;
  if (row.expires_at && row.expires_at < Date.now()) return null;
  return row;
}

/** Records that a link was just opened. */
export function noteViewLinkUse(id: string): void {
  store.touchViewLink(id);
}
