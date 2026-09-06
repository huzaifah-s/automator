# Changelog

What changed, why, and what was traded away. Newest first.

Entries record the *reasoning*, not just the diff — `git log` already has the
diff. If a change settled a question, say what was settled and what the losing
option was, so nobody relitigates it from scratch.

## 2026-09-06

### The deploy now says when PUBLIC_URL cannot reach it

Monday refuses every webhook registration with `Internal Server Error
[DOWNSTREAM_SERVICE_ERROR]`, and means by it that *it* failed calling *us*. The
error describes Monday's plumbing rather than the endpoint, and it is identical
for a bad event name, a malformed config and a domain that does not resolve —
so it cannot be used to tell those apart. Two rounds of debugging went into a
cause the provider was never going to name.

`reconcileWebhooks` now fetches our own `/healthz` over `PUBLIC_URL` before the
first subscription is created, and warns with what happened: the DNS error, the
TLS error, the timeout, the wrong status. `/healthz` rather than a hook path —
it is unauthenticated, purpose-built for the question, and its body is a
contract rather than an error string somebody might reword. The body is checked
for `ok: true` and not just the status, which is what catches the case that
looks healthiest and is worst: a stale deployment still holding the domain.

It warns and does not block, and that is the whole design. A container
frequently cannot reach its own public hostname — no NAT hairpin,
split-horizon DNS — so a failed probe is evidence, not a verdict, and the
provider may well get through where we did not. A diagnostic that refused to
register would be worse than the fault it diagnoses. The message says so, so
nobody reads a false negative as a diagnosis.

Verified against all four outcomes: a domain that does not resolve, a domain
answering 404, a domain answering 200 with somebody else's JSON, and a URL that
reaches this process. One warning per boot, before the failures rather than
after them.

The same round of blind debugging also fixed the failure log itself, which
named the provider's message but not the URL it had been given — the success
line printed it and the failure line did not, which is exactly backwards.

### Monday's webhook registration was wrong in two ways, and silent about one

Setting the six board variables turned self-registration on for the first time,
and all seven subscriptions failed at boot. Two separate causes.

The two create-item subscriptions were refused outright: `create_pulse` is not
in `WebhookEventType`. Monday has two names for one event — you subscribe with
`create_item`, and the payload that arrives says `"type": "create_pulse"`. The
old name is all through Monday's own sample payloads, and this port read the
receiving side from a captured delivery and reused the string for the
subscription. Only the subscription side changed; `mondayEvent` still documents
`create_pulse`, because that is still what is sent.

The five `change_specific_column_value` subscriptions failed with `Internal
Server Error` on five different boards with five different column ids, which
is the call rather than the boards. `config` is Monday's `JSON` scalar: passing
it as a declared variable validates fine and then dies inside their resolver.
Every example Monday publishes inlines it as a string literal. This file had
already hit exactly this with `compare_value` in `itemsByName` and solved it the
same way — the lesson did not generalise the first time, so it is written down
here now: **Monday's custom scalars are not reliably variable-safe, and the
documented inline form is the one to copy.**

Stated plainly, the second fix is the best-supported explanation rather than a
confirmed one. The other candidate was Monday failing the URL challenge it
sends when a subscription is created; our side of that is verified — posting
`{"challenge":"…"}` at four of the paths echoes it back before the auth gate —
so if the 500s survive, the remaining suspect is whether `PUBLIC_URL` is
reachable from Monday, not the handler.

What made both of these cost more than they should have is that the client threw
away the error code. Monday answers a rejected `create_webhook` with `Internal
Server Error` twice and an `extensions.code` beside it naming the real
complaint, and only the sentence reached the log. Both error shapes now carry
the code.

### A sub-workflow call that is refused now leaves a run behind

`ctx.run()` decides everything that can go wrong before it starts anything — an
unknown name, a disabled workflow, a cycle, the depth limit — and each of those
threw before `runWorkflow` was reached, so no run row was ever written. That is
fine when the caller lets the error through: the caller's own run fails and
carries the reason. It is not fine when the caller catches it, and the two
places that call a sub-workflow in this repo both do, deliberately —
`notify()` and `welcome-message` downgrade a failed contact write to a warning
so a bookkeeping row cannot mark a delivered WhatsApp message as failed.

The result was a workflow that had genuinely been called reporting that it had
never run. `studentqr-add-contact` showed no runs at all while every
notification went out green, and the only trace was one `warn` line on the
caller's page. "Never called" and "called and refused" are different facts and
the dashboard was stating the wrong one.

A refusal is now recorded as a failed run of the child, parented to the caller,
with the input it was called with — so it appears on the runs list, on the
child's own page, and under "Workflows it ran" on the caller's run. An unknown
name is recorded under the name that was asked for, even though no page answers
to that link: the typo is the thing you need to see. The shutdown skip, which
also returned without writing anything, is recorded as `skipped` for the same
reason.

Deliberately no alert from this path. A refusal that matters already reaches
the alert channel through whichever run finally fails because of it, and a
caller that swallows one has decided it is not worth waking anyone — alerting
anyway would put a Telegram message behind every catch block. The cost is that
a swallowed refusal is a red run nobody is paged about, which is the same
bargain the rest of the dashboard makes.

### Five-piece and magnetic badges stay unconfirmed, as they were in n8n

The port routed PRODUCT indices 2 ("Lencana QR (5 Keping)") and 7 ("Lencana QR
Magnetik") to the badges branch, on the reading that n8n's `[0,1] / [3,4,5] /
6` mapping had simply missed two live options — index 5 does not exist on that
board, and five-piece is one of the commonest choices on the form. That was
raised as the one behavioural change in the port worth signing off, and the
answer is no: the silence was intended. Both entries are gone and the two
products fall through to the unrouted branch again.

What is not restored is the *manner* of the silence. n8n's fall-through was an
unhandled branch and looked identical to a successful run; here it warns on the
run page, naming the product and its index. So the outcome matches n8n — no
message to the school — while the reason is visible to whoever goes looking.
The cost is that a genuinely unmapped new board option now looks the same as
these two deliberate ones; the comment on `FAMILY` is what tells them apart.

### A WhatsApp message that fails to send is now an alert, not a silence

Meta reports the fate of every message the StudentQR number sends to the same
callback URL the relay already listens on. The relay read `messages` and
ignored everything else, so `"status": "failed"` payloads — a number that is
not on WhatsApp, a paused template, an unpaid bill — were accepted, counted as
"not a text message", and dropped. n8n did the same. A school simply never
heard back, and nobody found out until it asked.

Failed statuses now fail the run, which puts them on the runner's alert
channel with the reason, Meta's own resolution link, and a link to the run.
Failing the run was chosen over sending a Telegram message from inside the
workflow: the alert channel already carries the 🚨 format, the run link, and
the 30-minute cooldown, and a delivery that never arrived *is* a failure. What
it costs is the two retries this workflow declares, which cannot fix a
rejection Meta has already made — roughly six seconds of the relay's queue per
failed message.

The alert names the reason but not the recipient, and that is deliberate. The
cooldown keys on the exact text sent, so putting the school in it would turn
an account-level problem — a lapsed bill fails *every* send — into one Telegram
message per school. The reason is what repeats; every recipient is logged on
the run, one click away.

### The tab row scrolls sideways instead of wrapping onto two lines

Adding Variables made four tabs, and four labels with their badges want about
400px where a phone has 347. The even split that carried three tabs clipped
"Credentials" and pushed the last tab off the screen, so they were wrapped
onto two rows of two — which kept every label whole at the cost of a second
line of vertical space on the one screen that has none to spare, directly
under a sticky bar.

They are one row that scrolls horizontally now. That is the trade: the tabs
you are not on may be off-screen, where wrapping showed all four at once. Two
things pay it back. The strip runs to the screen edges rather than stopping at
the 14px gutter, so an off-screen tab is cut by the edge — a row that ends
neatly reads as a row that has ended. And the current tab is scrolled into
view on load, because a tab bar whose highlighted tab you cannot see is worse
than either layout.

The offset is carried across the dashboard's background refresh. That refresh
replaces `.wrap`, the tab strip is inside it, and a replaced element starts
scrolled to the left — on the executions tab that would have dragged the row
back under the reader's thumb every fifteen seconds.

### StudentQR — ten workflows off n8n, and three things the port had to fix

Four n8n exports, rebuilt. The "StudentQR" canvas was never one workflow: it
was seven independent flows sharing a drawing surface, joined only by having
been dragged onto the same page. They are seven files now, plus the contact
upsert, the two-way WhatsApp relay, and the monthly report.

Two integrations carry the mechanics — `ctx.monday` (GraphQL, column readers,
the webhook payload's schema) and `ctx.whatsapp` (approved templates, free-form
text inside the 24-hour window). Two Credentials-tab providers, `monday` and
`whatsapp`, so the tokens go from a person into the encrypted store without
passing through an agent's transcript.

Three things were wrong in the graph and are not wrong here.

**One notification told every school its courier was its tracking number.**
`notification_delivering` was sent from six nodes. Five passed
`(status, tracking, courier)`; the teacher-facing badges node passed
`(status, courier, tracking)`. A template's placeholders are positional, so
that school read "Tracking Number: J&T, Courier: MY43206650254". Nothing on a
canvas shows you that. There is now one line that says what order that template
takes its parameters in, in `workflows/studentqr/_studentqr.ts`, and six
callers that cannot disagree with it.

**Two of the seven product options were never confirmed to anyone.** The
"order received" switch routed status indices `[0,1]`, `[3,4,5]` and `6`. On
that board index 5 does not exist, and 2 ("Lencana QR (5 Keping)") and 7
("magnetic") do — so a school ordering five-piece badges, one of the commonest
options on the form, fell through every branch in silence. Both are badges by
label and are routed as badges now. That is the one deliberate behavioural
change in the port; it is commented as such in `order-created.ts` and reverts
by deleting two lines.

**The monthly report could feed itself.** It sets the row's status when it
sends, and it fires on a status change. n8n survived that only because the
Monday recipe happened to be narrowed to one label — a property of a dropdown
in somebody's browser, not of the automation. The workflow now ignores the two
statuses it writes itself. It also picks the report by matching the asset id in
the Report column rather than taking `assets[0]`, which was whichever file
Monday listed first across every file column on the row.

Smaller: the order-created flow copies support before checking for a phone
number, like the other five already did, so an order submitted without one is
no longer invisible to everyone; and `ctx.run()` replaces the HTTP calls each
flow made back into its own webhook to record a contact.

**A fourth thing was wrong, and it was ours.** The relay finds out who a
support reply belongs to by looking up a board item whose *name* is the
forwarded message's WhatsApp id. The first cut of that used
`items_page_by_column_values`, copying what the n8n node did — and that query
does not accept `name`, only real columns. n8n got away with it because the
older `items_by_column_values` did, and Monday has since removed it. Caught by
reading Monday's docs rather than by running anything, because the API rejects
an unauthenticated request before it validates the query: a wrong query shape
is indistinguishable from a wrong token until a live token exists. It now uses
`items_page` with a `name` rule, filters the result for an exact match
client-side (the rule's matching is not documented as exact, and a prefix match
on a message id would hand one school's conversation to another), and inlines
`compare_value` as Monday's own example does rather than declaring a variable
of a scalar type whose name the docs do not pin down.

**Two things that succeed are no longer allowed to report failure.** Recording
a contact is bookkeeping that happens after both WhatsApp messages have gone,
and the contacts sheet is the only piece of this needing a Google service
account — so a deployment that skipped that would have seen every notification
run fail while every message arrived, retrying only the part that did not
matter. The monthly report had the same shape with worse consequences: its
support copy is a receipt sent after the school already has the PDF, and
letting it fail meant `onFailure` marked a delivered report Failed, inviting
the next person who read the board to send it again. Both are caught, logged,
and reported in the run's result instead.

**Not ported, deliberately.** Every Google Sheets "Messages" node in the
StudentQR canvas was already orphaned — nothing connected into them — and the
"Zahra AI - Functions" OpenAI assistant is referenced by nothing now that a
human answers the relay. Both were left out rather than resurrected. The
Contacts sheet, which *is* live, is ported; its two formula columns still read
the Messages tab and still render empty, which is what they did before.

### Variables — a second store, for the things that must stay readable

Configuration that is not a credential had nowhere to live but `.env`, which
made every board id a redeploy. Putting one in the secret store instead is
worse, not better: that store registers everything it holds with the log
redactor, because it cannot tell a token from a hostname — so a board id kept
there is scrubbed out of every run page, and *which board did this come from*
becomes unanswerable exactly when a notification has gone to the wrong school.

So: a `variables` table, plaintext, mirrored into `process.env`, with a CLI
(`bun run variable`), an API, and a dashboard tab that renders values in full.
The precedence is the secret store's — variable over environment — for the same
reason: if the environment won, changing a value a deploy had set would need
another deploy.

**The objection to this was that it inverts a safety default**, and it does. The
secret store protects by default; this one does not. That is answered at the
write rather than accepted:

- a **name** that reads like a credential is refused (`*_TOKEN`, `*_KEY`,
  `SIGNING`, `PRIVATE`, …), because the mistake people actually make is naming
  something `FOO_TOKEN` and not thinking about it again;
- a **value** that is unmistakably one is refused — JWT, PEM block, `sk-…`,
  `xox…` — from a short, high-confidence list, because a heuristic that rejects
  real configuration is one people route around;
- a key that exists in the **other** store is refused, in both directions, so
  there is no precedence rule between the two stores to get wrong;
- and a variable that a workflow *later* declares with `defineSecrets` is
  warned about every boot, naming the two commands that move it. That one
  cannot be a refusal — the workflow is deployed after the variable was
  written, and refusing to boot would not un-store the value.

The cross-store guard was wrong first time and shipped only because it was
tested: it asked `storedSecretKeys()`, which answers from memory and is empty
until `loadSecretStore()` has run — and the CLI is precisely the caller that
had not run it, so the guard passed everything. Both checks read their table
directly now.

Rejected: making this "a secret with a `redact: false` flag". One store with
two safety defaults is one store where the safe one can be turned off by
typing, and the flag would have had to be trusted on every read rather than
checked once at the write.

### Monday boards subscribe themselves

`mondayWebhook()` is a `register` block for a Monday board, so the six
StudentQR webhooks are created by the deploy instead of pasted into Monday's
integration centre six times. It returns `undefined` when the board's variable
is unset, so a board nobody has filled in yet simply does not self-register —
"not configured" should not be a boot alert on every restart.

It subscribes to `change_specific_column_value` on the status column rather
than `change_column_value`. The n8n recipes fired on every column, so a
corrected address or an added note woke a workflow that fetched the item and
did nothing; that traffic is now gone.

This is only possible because of `handshake` above: `create_webhook` sends a
`{"challenge":"…"}` POST that must be echoed, and before that existed there was
no way to answer it.

One caveat, documented rather than solved: the subscription URL carries
`WEBHOOK_SECRET` in the query string, because Monday has nowhere to put a
header, and reconciliation compares the bare URL. Rotating that secret does not
re-register anything, and Monday keeps sending the old one until the
subscription is cleared from the workflow's state.

### One board described once, and three boards sharing one workflow

Two kinds of repetition across the StudentQR files, only one of which was a
problem.

`issue-received.ts` and `issue-solved.ts` each hard-coded the column ids of
**the same board**. That is one fact stored twice, and the failure mode has no
error in it: the form gets rebuilt, somebody updates the file they had open,
and from then on half the messages carry a blank school name. Not hypothetical
— that form has already been rebuilt once, which is why `issue` and `info` each
carry a new column id and an old one. It lives in `_studentqr.ts` now.

The three order-status workflows were the other kind: ~60 identical lines each,
differing only in a column map and which labels that board uses. They are now
`orderStatusWorkflow({ columns, stages })` calls, so each file is nothing but
what makes it that board — 34, 36 and 49 lines. The reason to do it is the same
reason the template catalogue exists: the bug this port inherited was one copy
of a call disagreeing with five others, and it was invisible because you had to
read all six to know.

The cost is real and worth stating: `badges-status.ts` no longer shows you what
it *does*. It shows you what is true about that board, and the steps are in
`_studentqr.ts`. That trade is only worth taking where the files are genuinely
the same workflow — order-created, the relay, the monthly report and the
contact upsert look similar in outline and do different things, so they stay
written out.

### `handshake` on a webhook, for the request that proves the URL is yours

Meta will not send a WhatsApp message to a callback URL until it has GET'd it
with a `hub.challenge` and been handed **the bare string** back. Monday.com
POSTs `{"challenge":"…"}` and wants the same object. Neither response mode
could answer either: async returns `{"accepted":true}` with a 202, sync returns
`{"runId":…,"status":…,"result":…}`, and both providers compare at the top
level.

`handshake` answers directly and starts no run. `metaVerification()` and
`mondayChallenge()` cover the two shapes.

Three decisions worth keeping:

**It runs before the auth gate, and so authenticates itself.** That is what a
handshake *is* — the request that arrives before the shared secret exists on
the far side. Meta's is a GET with no body, so `x-hub-signature-256` cannot
exist on it. The alternative was a route-level exemption, which would have been
a hole with nobody responsible for it; instead each helper is strict about what
it will treat as a handshake, and one of them does a constant-time token
compare. `mondayChallenge` needs no check because the only thing it can be made
to do is echo back a string the caller already had.

**It answers on any method on its path.** Meta verifies with GET and delivers
with POST, to one URL, and a workflow has one method. An exact method match
always wins, so this only ever picks up what would have been a 404 — it cannot
divert a real delivery. The rejected alternative was a second workflow on the
same path whose `run()` was unreachable, which would have put a workflow on the
dashboard that never runs.

**It composes with `secret` and `verify` instead of replacing them**, unlike
those two, which are mutually exclusive. Returning `undefined` means "not a
handshake" and the request carries on through the normal checks, so a route
does not become less guarded by gaining one.

Verified by curl against a running server: the Monday challenge echoes as JSON,
Meta's GET returns the bare challenge as `text/plain`, a wrong verify token is
a 404, an unsigned POST is a 401, a tampered signature is a 401, and a
correctly signed delivery runs.

### `_`-prefixed files in `workflows/` are not workflows

Every file under `workflows/` had to default-export one, and failing to was an
error rather than a silent skip — which is the right guard, because a typo'd
export should not vanish. But it left a folder of related workflows with
nowhere to put code they share, and `src/` is for what the whole runner uses,
not one client's message catalogue.

A leading underscore is the explicit opt-out. Explicit, rather than "skip
anything with no default export", so the guard survives.

The thing it bought immediately: `workflows/studentqr/_studentqr.ts` holds the
WhatsApp template catalogue, which is why the parameter-order bug above cannot
recur. The boundary is that `_` files are for what one folder owns — the moment
two folders want the same helper, it is an integration.


### The filter bar on a phone, fixed where a phone is what found it

Five things the desktop layout hid, all of them in the executions toolbar.

**A date field committed on the first tap.** Both inputs carried
`data-autosubmit`, and a native date picker fires `change` the moment it opens
— so touching an empty "from" field navigated away with today's date before
you had chosen anything. A range needs two values, so it now waits for an
**Apply dates** button. That button existed already but only inside
`<noscript>`, which is to say only where it was never seen.

**An empty date field paints nothing at all on a phone.** The menu ended in
two blank boxes and an arrow between them, which reads as a broken panel
rather than as a range. Each field has a FROM / TO label above it now; the
`aria-label` that was there was doing this job for screen readers only.

**"All time" is gone.** With `RUN_RETENTION_DAYS` pruning at 14 days the
widest chip already covers every run that exists, so the chip promised
something it could not deliver and cost a second concept to carry — the key
`all` existed only because an absent `?range=` had come to mean the default.
The workflow page's "All executions →" link points at the widest window, which
is the same set of runs.

**The closed menus put their value in the middle of the bar.** Full-width and
`space-between`, a label, a value and a chevron spread themselves evenly, so
"7 days" sat centred and looked like a centring that had failed. An auto
margin sends the value and its chevron to the right edge together.

**The workflow picker was a control from another page.** A native `<select>`
brings its own font and its own arrow, and next to two custom `<details>`
menus that is exactly what it looked like. It cannot carry a pseudo-element,
so the chevron moved to a wrapper and is now the same corner the menus draw —
which also means it follows the theme, where a background image could not. The
three controls are one type size on a phone, and it is 16px because that is
what stops a browser zooming the page when a field takes focus.

The tab row also gets a bottom margin. Without one it sat directly on the
sticky bar's border and read as part of it.

### The dashboard opens on a week, and every number counts the same week

The executions tab used to open on **all time** and print counts above the
list that were also all time — but the tab badge beside "Executions" was
hard-wired to the last 24 hours, and so were the two stat cards on the
workflows tab. Three numbers on one screen, each counting a different span,
none of them saying which. Picking a window moved one of them.

**The default window is 7 days, everywhere.** A runner that has been up for a
month opens on the runs from this week, not on every run it has ever recorded.
The tabs with no chips of their own — workflows, credentials — count over the
same seven days, so the red badge means the same thing on whichever tab you
are looking at, and the "runs · 24h" card is now "runs · 7 days".

**The badge follows every filter on the page.** The old comment said the
badge did not follow the chips *because* it had to mean the same thing on
every page. That was solving the wrong half: a red `3` sitting above a list
showing 24 hours of runs had no way to say it was counting a different
fortnight. It is now drawn from the same counts as the cards — the window and
the workflow or folder — so a number on screen can always be traced to rows on
the page it is sitting on.

The losing option was a badge that followed only the window and stayed
runner-wide across workflows, on the argument that it answers "is anything
wrong" and a workflow filter emptying it would hide failures you filtered away
from. That was rejected: a red count you cannot reach from the list under it is
a number you cannot act on, and the workflows tab already carries the
runner-wide figure. The status chip stays excluded either way — filtering to
"success" must not claim nothing failed.

**"All time" had to be given a name.** With an absent `?range=` now meaning
the default, the empty string could no longer stand for everything — asking
for all time and not asking at all were the same URL. The chip carries
`range=all`, and the workflow page's "All executions →" link carries it too,
rather than promising all and landing on a week.

An unparseable `?range=` now lands on the default rather than widening to all
of time. The old rule was that a filter should never narrow into an empty tab
you cannot explain; the default window is not that failure, because it is the
same thing you see when you open the tab fresh.

### Run history is kept for two weeks, and the 30-day chip goes with it

`RUN_RETENTION_DAYS` defaults to **14**. Thirty days was chosen before the
executions tab had windows; a month of rows was mostly history nothing on the
dashboard was going to ask for. Pruning a run still takes its logs, steps, HTTP
calls and settled inbox rows with it, `0` still means keep everything, and the
poll table was never in scope — it is one overwritten row per workflow and does
not grow.

**The 30-day chip is removed, because it would have lied.** With pruning at 14
days it could only ever return the same rows as the 14-day chip, while implying
there were older runs it was reaching for. The widest window the dashboard
offers and the point at which history is deleted are now the same number, which
is the property worth keeping: raising retention is what earns a wider chip,
not the other way round. A bookmarked `?range=30d` is an unknown key now and
lands on the default, like any other.

**A bad value is loud now.** `Number("abc")` is `NaN`, `NaN > 0` is false, and
the nightly prune therefore did nothing at all — a typo in one environment
variable silently switched retention off, which you discover a month later
from the disk graph. A value that is not a non-negative number logs an error
and falls back to 14.

### The dashboard reads on a phone, and the rows stop being columns

Below 560px every `.row` grid becomes a wrapping flex line: the name takes the
first line to itself and everything still worth showing wraps under it. The
880px layout narrows the same grids instead, and on a 375px screen that is
what the columns were eating — the credentials tab rendered rows whose name
was squeezed to nothing while a 210px button column kept its width, so the
page said `● Brevo Primary` and never said *which* credential.

**A stacked row shows more, not less.** Three cells that the 880px grid drops
come back on the second line — a run's start time, a credential's connection
pill, a secret's last update — marked `keep-sm`. The tablet grid still hides
them because it has nowhere to put them; a stacked row has a whole line spare.

**The tabs take a line of their own.** Brand, three tabs and their badges have
never fitted across a phone: "Credentials" was cut off at the right edge, and
the breadcrumb that follows them was off-screen entirely, so a run page
arrived with nothing on it naming the run. The tabs now split a second row
evenly and the breadcrumb sits beside the brand on the first.

**A filter menu opens the width of the toolbar.** The two date fields inside
the window menu were 55px each in a popover sized to its own list of links.
Full-width also means the panel cannot hang off whichever edge it opened near,
which the folder menu did.

Text inputs go to 16px on a phone, because anything smaller makes the browser
zoom the page in when the field takes focus and leaves it there. Log lines put
the timestamp and level on one line and give the message the full width — held
to a 110px column, a JSON payload was a stripe of punctuation.

### Content cross-posts itself, and three more graphs became one

`workflows/the-mantra/cross-poster.ts` replaces the n8n "Cross-post Checker",
"Cross-post (IG, FB & Threads)" and "Cross-post Error Handler". The collapse is
the same one the Threads poster made and for the same two reasons — `poll()`
files no run on a quiet tick, so the checker has nothing left to do, and
`onFailure` is a property of the workflow that failed, so the error handler
cannot be wired to the wrong graph.

**The Postings checklist is the design, and it is kept as-is.** Three platforms
are three independent chances to fail, and a row that reached Instagram must not
restart at Instagram. Each platform is ticked in the Notion page the moment it
lands, the row is released back to `Posted` if anything failed, and the next
tick re-posts only what is still unticked. It was the best idea in the n8n
version and it is ported unchanged.

**A failed row now makes the run red.** n8n caught everything and returned a
status string, so the execution went green and only Telegram knew. That also
buys the retry for free: a poll marks its items seen only after a *successful*
run, so a red run is what puts the row back in the queue.

**The window stayed as it was, and the rows it drops are now reported.** It only
sees rows whose TikTok post date is 3–10 days old. Widening it would have
silently back-posted a pile of old content on the first deploy, so the fix went
the other way — see the stale alert below.

**The Facebook page token was in the workflow.** n8n had it pasted literally
into two HTTP nodes, which put it in its database, in every execution record and
in the exported JSON. It is now a `meta` credential. The old token has to be
treated as compromised and rotated by hand — nothing in this repo can do that.

### Content that will never post no longer says nothing about it

`workflows/the-mantra/cross-post-stale-alert.ts` reports the two ways a row goes
quietly missing: **aged out** past the cross-poster's ten-day ceiling, and
**stuck on `Posting`** after a run died holding the lock. Neither is retried by
anything and neither surfaces anywhere, which made "it just never posted" a
thing you found out about weeks later, by noticing.

**A separate workflow, not part of the cross-poster.** The cross-poster polls
every five minutes; answering this there would be a second Notion query 288
times a day to report something that changes once a day. And the natural place
for it — the poll's `fetch` — is the one place that cannot alert, because it
runs outside a run.

**The query is the exact complement of the cross-poster's, not "old rows".**
Its floor is `on_or_after`; this uses `before` on the same instant. The two
partition the set cleanly, so a row is either still due or reported here, never
both and never neither. A looser filter would report rows merely waiting out the
three-day stagger, and an alert that cries wolf about healthy content is worse
than the silence it replaced.

**It does not nag, and that is a correctness property.** A list nobody has dealt
with, re-sent every morning, is how an alert stops being read — and an unread
alert is the same silence. So: a message when something new appears, then quiet,
then one reminder a week while anything is outstanding. The remembered set is
refreshed even on the quiet mornings, so a row that goes stale, gets fixed, and
goes stale again is reported the second time; and `lastSentAt` is deliberately
*not* refreshed then, or the weekly reminder would reset every quiet day and
never fire. A hand-started run always speaks, which is how you test it.

**Stuck rows are found by the row's own last-edited time**, which the lock write
sets — so it measures "untouched since it was claimed" rather than "claimed long
ago", and a run legitimately in flight is never flagged.

### ctx.drive and ctx.s3, because media has to be somewhere Meta can fetch it

Instagram, Facebook and Threads all publish by URL: you hand Meta a link and it
fetches the bytes itself. The source media is in Google Drive, which cannot
serve a link Meta can reliably fetch — the interstitial on large files is the
end of that idea — so the cross-poster stages each file in an S3 bucket, hands
over the public URL, and deletes it again.

**R2 was kept rather than replaced.** Serving the media from this runner's own
Hono server was the obvious alternative and would have avoided the signing code
entirely. It was rejected: it makes a public unauthenticated route part of every
publish, and puts the runner's uptime and bandwidth in the path of a post. The
bucket already existed and was already proven against Meta.

**SigV4 is ~120 lines instead of `@aws-sdk/*`.** Same trade `sheets.ts` made
against `googleapis`: image size is a core goal. It is verified against AWS's
published S3 "GET Object" test vector rather than against a live bucket.

**Neither client goes through `ctx.http`.** That client JSON-encodes anything
that is not a string, retries, and records request and response bodies onto the
run page — all correct for an API call and all wrong for a 200MB video. They use
`fetch` directly and let the step record the outcome.

**The Google service-account JWT moved to `google-auth.ts`.** It was private to
`sheets.ts` with the spreadsheets scope hard-coded into the claim. Drive needs a
different scope against the same key, and the cache is keyed by scope — one
cache would hand a Sheets token to Drive, and the 403 that follows says nothing
about why.

### The brand Threads token has a refresher, 60 days late

`threads-token-auto-refresh.ts` now refreshes both accounts — the founder's and
The Mantra's — in one weekly run, a step each. The n8n cross-post graph never
had one and admitted it in a sticky note: *"Threads token expires in 60 days -
no refresh workflow yet."* A Threads token that goes 60 days unrefreshed dies
permanently, and the only recovery is a full manual re-auth.

**One workflow, not two.** A second file differing only in a credential name
would be 240 lines maintained in parallel, and the failure mode of forgetting to
add an account is silent for 59 days. Accounts are rows in one array; adding a
third is a `defineOAuth` and one entry.


### A quiet poll and a dead one no longer look the same

`poll()` starts no run when nothing is new — the property the whole trigger
exists for. The cost of it only shows up on the dashboard: a workflow whose last
run was an hour ago is either polling happily with nothing due, or has not
polled since the process died, and the runs list is identical either way. Every
tick now stamps a `polls` row, and the workflow page shows it as **last polled**
with what the fetch saw.

**It is a table of its own, not `ctx.state`.** State is where a poll's other
bookkeeping already lives, so putting it there was the small change. It is
also the one table written *unredacted* on purpose — a rotating OAuth token has
to come back byte for byte — and the invariant that keeps that safe is that
state is never displayed. A fetch's thrown error is workflow-authored text
headed for a web page, so it belongs in a table that redacts and caps on the
way in like every other observational column.

**One row per workflow, overwritten.** Keeping tick history would be 360 rows a
day per poll to answer a question the newest row already answers, and the ticks
that did find something are already runs.

**No "overdue" colouring.** Comparing the stamp against the cron interval was
the obvious next step and is wrong here: croner runs these jobs with
`protect: true`, so a fifteen-minute poll run legitimately suppresses three
ticks, and the workflow doing the most work would be the one flagged red. The
stat goes red only when the last fetch actually threw. The timestamp is stated;
whether it is too old is the reader's call.

## 2026-09-05

### The runner tells you when a workflow can't run, and you choose where

`ALERT_WEBHOOK_URL` did one thing: post to a Slack- or Discord-shaped incoming
webhook when a run exhausted its retries. It is now `ALERT_CHANNEL`, which
names a platform and a *connected credential* — `telegram:the-mantra`,
`slack:ops/#alerts`, `discord:ops`, or `webhook:<url>` for the old behaviour,
which still works unchanged.

**The channel is chosen in the environment, not in the database.** A
Credentials-tab-style Alerts form was the obvious alternative and was rejected:
it would be the first piece of runner configuration living as rows, and the
thing the credential system buys — the token in the encrypted store, rotatable
without a redeploy — is already had by naming a credential from an env var. The
env var carries the *choice*; the store carries the secret.

**Naming a credential means only that credential is consulted.** A named
Telegram credential with no chat id is an error, not a fall back to
`TELEGRAM_CHAT_ID`. The convenience of guessing is not worth its failure mode,
which is an alert about a brand arriving in another brand's chat.

**Three new things alert, and all three were previously invisible.** A run
refused because a credential is not connected (it was recorded as a failed run
and logged, and nobody reads either); a boot problem — workflows that would not
load, credentials nothing can run without, a webhook subscription that failed to
register, which means the provider is calling nobody and the workflow simply
never fires; and a rejected webhook delivery, where a provider calling with the
wrong secret is otherwise indistinguishable from silence.

Boot alerts fire on the server path only. `bun run list` failing is already on
the screen of the person who ran it.

**Every workflow is connected by default, and can opt out or route elsewhere.**
`alerts: false`, or `alerts: { channel: "telegram:pblsh" }`. Default-on was the
decision worth making deliberately: the whole point is problems you did not
think to look for, and an opt-in list only ever contains the workflows you were
already worried about. Per-workflow routing exists because this server already
sends as three different bots.

**A bad channel in a workflow file stops the boot; a bad `ALERT_CHANNEL` does
not.** The first is a typo in code, like an unknown credential platform. The
second is an operator's environment, and a mistake in the alerting must never be
the thing that stops the runner from running. Same reason a broken channel is a
log line and never an exception: nothing in `src/core/alerts.ts` may throw out
into a run, a boot, or a webhook response.

**Repeats are throttled to one per problem per `ALERT_COOLDOWN_MS`** (30
minutes), and the next alert that gets through carries the count it stands for.
Without it a five-minute cron that fails every time is twelve messages an hour
and the alerts stop being read, which is the same outcome as not sending them.
The counters live in shared `ctx.state` under a hashed `@alert:` key rather than
in memory, so a crash-looping process does not re-send the same boot failure on
every restart — hashed because state is the one thing not redacted on its way to
disk, and a counter row has no reason to hold an error message. The trade: the
cooldown is stamped before delivery is attempted, so a channel that is down
costs that alert rather than thirty minutes of retries against it.


### Threads posts itself, and three n8n graphs became one workflow

Ported the n8n graphs "The Mantra - Threads - Checker", "The Mantra - Notion
(Threads) - Founder's Contents" and its "- Error Handler" into a single file,
`workflows/the-mantra/threads-poster.ts`. Every four minutes it takes the
Approved rows whose Post Date has arrived, turns each Notion page into a chain
of Threads posts, and writes Status, Log and Thread URL back to the row.

**Three graphs became one because all three splits were n8n mechanics.** The
checker existed so the poster's execution list stayed readable — n8n records a
run per trigger, and 360 empty runs a day buries it. That is what `poll()`
already is: its `fetch` runs outside a run, and a tick that finds nothing due
creates no run record. The "do the Notion query exactly once" property the
checker's sticky note was proud of stops being a convention two graphs have to
honour and becomes structural. The error handler was `errorTrigger`, which has
no equivalent here because `onFailure` is a property of the workflow that
failed — it cannot be wired to the wrong graph or left unwired in Settings.

The alternative was a faithful three-workflow port with `ctx.run()` in place of
Execute Workflow. Rejected: it would have reproduced n8n's shape and n8n's
sharpest edge with it — the poster had no query of its own, so pressing play on
it threw, and the two files had to agree about a database id neither of them
owned.

**A failed row makes the run red.** n8n's Code node caught everything and
returned a status string, so the execution went green and the whole story lived
in a Telegram message. This throws at the end of the batch, after every row has
been attempted and alerted individually. The error carries a flag so
`onFailure` knows not to send a second, vaguer message about the same failures;
`onFailure` therefore only ever speaks about a genuine crash.

**And therefore `retries: 0`, which is the one setting worth arguing about.**
Everything worth retrying is already retried closer to the failure: the http
client retries a 429 or a 5xx, the chain retries a container three times, and a
row this run never claimed is still Approved and comes back in four minutes.
What a whole-run retry would add is the one outcome nobody wants — re-running a
run that posted half a thread. The run going red is the alert, not the trigger
for another go.

**The lock changed jobs.** In n8n, flipping the row to Posting before
publishing was the only thing preventing a double post, because two executions
could overlap freely. Here `onOverlap: "skip"` and the poll's seen-set already
make that nearly impossible — but the lock is still load-bearing, for a better
reason: the poll's filter is `Status = Approved`, so flipping the row is what
takes it out of the query. A run that dies after publishing leaves the row on
Posting, and a row on Posting is never picked up again. That is the whole
no-double-post guarantee, verified by running two polls against a Notion mock
that honours the writes: the second found nothing and published nothing.

**A backlog no longer becomes one enormous run.** n8n handed over every due row
and worked the lot in a single execution — thirty overdue threads is well over
half an hour of API sleeps under one timeout. The query is capped at five rows,
oldest first, so a backlog drains a few per tick. The cap lives in the *query*
rather than in a slice afterwards, and that is not a detail: `poll` marks
everything it emitted as seen, so a row trimmed after emission would never be
offered again.

**No rollback, still.** The token has no `threads_delete` scope, so a chain that
breaks half way leaves what is already live. Asking for delete scope so an
automation can remove published posts unattended is a much larger blast radius
than a half thread somebody deletes by hand. The row goes Failed, the Log lists
the ids, and the Telegram alert carries the permalink.

**The token never reaches the run record.** n8n kept it in a data table and
passed it downstream as item data, so it sat in plain text in every execution.
It is read from `defineOAuth` outside any step — a step result is checkpointed
to disk — and reaches the run page only as the `access_token` query parameter
of the captured Threads calls, where the redactor scrubs it. Verified: after a
full run, `strings` over the database and its `-wal` found zero plaintext hits
for the Threads token, the Notion token or the bot token.

`defineOAuth("threads-huzaifah", …)` is declared a second time here rather than
imported from the refresher, which `defineOAuth` supports on purpose and which
is the lesser of two evils. A shared module cannot live under `workflows/` —
the loader imports every `.ts` there and fails one with no `defineWorkflow`
default export — and importing the refresher's module from this file would run
its `defineCredential` calls while the loader thinks it is loading *this* one,
attributing its Telegram credential here and leaving the refresher recorded as
needing nothing. An unconnected credential would then stop blocking it.

Seven other things the n8n version got wrong, fixed rather than reproduced:

- A publish that answered `200` with no id was retried. It should not have
  been: Threads answered, so it almost certainly published. It is now treated
  the same as a 5xx — ambiguous, not retried, and said so in the Log.
- The title was read as `properties.Name.title[0]`, so renaming that column in
  Notion would have quietly turned every alert into "Untitled". It is found by
  property *type* now.
- A Telegram outage could take the batch down. n8n needed
  `onError: continueRegularOutput` for the same reason; here the send is caught
  and logged, so the message is what is lost, not the rows still to post.
- Running the poster by hand threw "No pages were passed in". There is nothing
  to press play on now, and a *resume* from the dashboard — which carries no
  input — does nothing rather than re-posting.
- `HttpError` is re-exported from `define.ts`, because a Graph API error's
  status and body are the answer rather than the noise: the code, subcode and
  `fbtrace_id` go into the Log, and the status is what tells a definitive 4xx
  from an ambiguous 5xx on a call that must not be retried.
- `firstRun: "emit"` rather than the default. Baselining would mark every
  already-overdue row as seen without posting it, and those rows would then sit
  there until they aged out of the remembered window hours later and posted all
  at once — worse than either outcome.
- The image-processing poll, the settle waits and the container retries all
  respect `ctx.signal` now, so a run that times out unwinds instead of sleeping
  through it.

**Deploying this while the n8n checker is still active posts everything
twice.** Unlike the Telegram bot, which physically cannot deliver to two
places, this reads Notion on a timer. Deactivate the n8n workflow first.


### The Mantra's Telegram bot answers /content_id

Ported the n8n graph "Notion - Get contents from Telegram commands" —
`workflows/the-mantra/notion-contents-telegram-commands.ts`. Ask the bot for a
Contents page id and it replies with the properties, the Hook / Script /
Caption written in the page body, the unresolved comments, the post dates and
the two links.

**One bot has one webhook, so this is a migration and not an addition.**
`setWebhook` overwrites whatever was there. The moment this deploys, The Mantra
bot stops delivering to n8n and starts delivering here; nothing warns you and
there is no way to run both. The alternative was to leave the route unregistered
and have somebody paste a `setWebhook` URL by hand — rejected, because a
credential in a shell command is exactly what `register` exists to avoid, and a
webhook nothing reconciles is one that quietly points at a dead PUBLIC_URL after
the next move.

**Telegram's `secret_token`, not `WEBHOOK_SECRET`.** A bot cannot be told to
send `X-Automator-Secret`, so the shared-secret path could not guard this route
at all — n8n's answer was an unguessable path and nothing else. `verify` takes
it instead, through a new `telegramSecretToken()` alongside the Notion and Tally
verifiers. It is a constant-time string compare and is not dressed up as a
signature, because Telegram signs nothing.

The secret is *required*, unlike `NOTION_WEBHOOK_TOKEN` next door, and the
difference is worth stating: that one is minted by Notion after the route
exists, so requiring it would make the deploy that creates the endpoint the
deploy that cannot boot. This one we choose and store first, so a missing value
is an operator's omission — and the failure it would otherwise cause is a bot
that registers a webhook and then rejects every delivery from it, which from
Telegram is indistinguishable from a bot nobody is running.

**`/content_today` and `/content_date` are still not built.** They were not
built in n8n either — both Switch outputs went nowhere, so typing either got
silence. They now answer "not built yet", which is the same functionality and
less confusion. Building them means guessing a database query nobody has
specified; ask for them when they are wanted.

Six things the n8n version got wrong, fixed here rather than reproduced:

- A reply over 4096 characters failed to send. It is now split across numbered
  messages, broken only where no HTML tag is open — a script plus a caption
  plus a comment thread passes that ceiling regularly.
- The "(Posted ✅)" marks read `$json`, which at that node held the Code node's
  output, an object that has never had either key. They could not appear no
  matter what Notion said.
- A page with no post date threw on `.start` and lost the whole reply.
- A date-only property was formatted `dd/MM/yyyy hh:mm a`, inventing a time
  Notion does not hold and that shifted with the reader's zone.
- Nothing was HTML-escaped, so a script containing "Q&A" took the message down.
- `/content_id@TheMantraFragranceBot` — what Telegram sends in a group — missed
  the exact-match Switch entirely.

Two smaller changes of behaviour. The reply goes to the *chat*, not to
`message.from.id`: a command asked in a group is answered in that group, where
n8n sent a private message that fails outright if the asker never started the
bot. And a failed run tells the asker so in the chat through `onFailure`,
because a person is waiting on this one and the dashboard is not where they are
looking.

Verified by driving the real `run()` against a stubbed Notion — the full reply,
a 60-block script splitting into four messages, escaping, nested blocks, an
unrecognised heading closing a section, a date-only vs a timed property, a
loosely-spelled property name, and every ignore branch — then booting the server
and exercising the route: no token and a wrong token 401, the right one 202, the
run recorded with its steps and checkpoint reuse, the rejections shown and then
marked resolved. Swept every API route, both dashboard pages, stdout and the
database file for the test credentials: zero hits.


### A fixed webhook stops looking broken

Rejection counters shipped as a running total cleared by hand, which traded a
false alarm for a kept record: a route that was broken and is now working read
red until somebody pressed the button. That trade was stated at the time and it
was the wrong one — the first person to hit it asked why the panel was still up
after the fix, which is the question a dashboard should never provoke.

A `resolved_at` column now records when a delivery last got all the way
through. A row whose `resolved_at` is at or after its `last_at` is history: the
box turns from a red flash into a grey line, the row is tagged `resolved`, and
the workflows-list badge counts unresolved rows only. Both halves are kept —
the record survives for the morning-after question, the alarm does not survive
the fix. A fresh rejection puts `last_at` past `resolved_at` and it alarms
again, with no extra bookkeeping.

Stamped in the webhook route at the point where every door check has passed,
rather than derived at read time from the last accepted delivery. Deriving it
was the first design and it is wrong twice over: only the async branch writes to
the inbox, so a `respond: "sync"` hook would have alarmed forever, and the
inbox is pruned, so an old resolved rejection would have started alarming again
the day its evidence aged out. The `UPDATE` is narrowed to rows that are not
already settled, so the common case — a healthy hook — matches nothing and
writes nothing.

Existing databases get the column by migration, with their rows starting
unresolved, which is what they were.

Verified end to end: three unresolved rejections badge the list, a successful
delivery clears the badge and flips the panel to history while leaving another
workflow's counters alone, a still-broken workflow keeps its alarm, a new
rejection after resolution alarms again, and Clear still removes everything.
Migration checked against a database that already had rows. Full routing matrix
re-run clean afterwards.


### Webhook deliveries turned away at the door now show on the dashboard

A webhook rejected before a run exists — bad secret, failed signature,
unparseable body, schema refusal — left nothing behind but a warn line on
stdout. The dashboard showed a workflow that looked as though it had simply
never been called, which is the most misleading thing it could have said: the
one case where you go looking is the case where the runs you expected are
missing.

Found the hard way. A Notion subscription accumulated seven failed deliveries
against a route that was 401ing because its verification token had not been
stored yet, and the only way to learn that was the container log — on a
deployment whose whole point is that a teammate without SSH can operate it.

Counted per `(workflow, path, reason)` rather than logged per attempt. A public
endpoint is precisely what gets hammered, so a row per rejection is a way to
fill a disk from outside; the key bounds the table at a handful of rows. A path
no workflow claims records nothing at all — a 404, as before — or a scanner
walking URLs would write a row per guess.

The request body is never stored, and that is not a size decision. A rejected
call is by definition one nobody authenticated, so its body is whatever a
stranger chose to send, and a wrong secret is still somebody's guess at a
secret. What is kept is the reason, plus the verifier's own message where there
is one — which is the entire diagnostic, because "the token is not set" and
"that signature is wrong" are the same 401 to the caller and completely
different problems to the operator.

Shown on the workflow page above the run table, badged on the workflows list,
cleared by a button, and mirrored at `GET /api/workflows/<name>/rejections`.
The clear button is not behind `DASHBOARD_WRITE`: this is observational data
like a run record, not a credential, and the alternative is a route that reads
red forever after it was fixed.

Verified against all five reasons — bad secret, no secret supplied, failed
verification, unparseable body, validation failed — including that five
requests to unclaimed paths wrote no rows, that a wrong secret's value appears
nowhere in the database, that clearing one workflow leaves another's counters
alone, and that a successful delivery adds nothing.


### notionSignature trims its key

The verification token travels through a chat message and is pasted into a web
form that stores exactly what it is given — `PUT /api/secrets/:key` does not
trim, deliberately, because an empty value has a meaning there and trimming is
not the store's call to make for every credential.

For an HMAC key that is the wrong trade. A trailing newline off the end of a
copy produces a wrong digest, which is indistinguishable from a forged request:
a 401 at the door, no run created, nothing on the dashboard, and Notion showing
a growing pile of failed deliveries with no reason attached. Whitespace around
an HMAC key is never intentional, so the verifier trims.

Narrow on purpose — `notionSignature` only, not `hmacSignature` and not the
store. This is the one credential in the system whose delivery path is a human
copying out of a chat window.

Verified: a token stored with a trailing newline now verifies and its event
routes; a genuinely wrong token still 401s.

Also worth writing down, because it cost time: the two ways this route can
reject differ in the log and can be told apart from a browser. "Verifier …
threw — token is not set" plus no `NOTION_WEBHOOK_TOKEN` in the Secrets tab
means step 4 of the setup was never done. Only "failed verification", with the
key listed as present, means the stored value is wrong.


### The Notion verification token is handed over on Telegram, not through a shell

Setting this webhook up used to end with a `docker compose exec … bun -e …`
one-liner in a chat message, because the token could not go in the message
itself: `ctx.telegram.send` goes through the captured HTTP client, and a token
arriving for the very first time is one the redactor has never heard of, so the
message body would have written it verbatim onto the run page.

That reasoning was right and the conclusion was wrong. The handshake nudge now
carries the token and posts it with a plain `fetch` instead of `ctx.telegram`.
Nothing captures a bare fetch, so the only copy on disk is still the one in
`ctx.state`, which nothing renders — the invariant is unchanged and the setup
is now a Telegram message, Notion's modal, and one dashboard form.

The losing options were both worse. Rendering state on the dashboard breaks a
settled rule for one screen. Having the workflow write `NOTION_WEBHOOK_TOKEN`
into the secret store itself adds a fourth write surface to the store — also
settled — and would not have helped anyway, since Notion requires a human to
paste the token into its modal regardless.

What it costs: that one call does not appear on the run page, so a failed
handoff shows up as the step's error and nothing else. Worth it. The people who
will run this setup next are not the people with SSH, and an instruction only
one person can follow is an instruction that comes back to that person every
time.

Verified by triggering a real handshake and sweeping: the token appears in
exactly one database row (`state`), zero times in stdout, and zero times across
every dashboard and API route — while an ordinary event still captures all four
of its HTTP calls with the bot token redacted in the URL.


### A step's error message is redacted on the way into SQLite

`recordRun` redacted its error. `saveStep` did not — it redacted the step's
*name* and passed the message straight through. Both write to the same database
and both end up on the same run page, so the asymmetry was an oversight rather
than a decision.

It is not theoretical, and it is the same failure the credentials work already
called out: Telegram puts the bot token in the URL path, so a 401 from
`ctx.telegram.send` produces the message
`HTTP 401 https://api.telegram.org/bot<TOKEN>/sendMessage — …`. The logger
redacted it on the way to stdout; nothing redacted it on the way to disk. Found
by running the new Contents notifier against a deliberately dead bot token and
grepping the database file, which is exactly the sweep AGENTS.md asks for and
exactly what reading the code would not have shown.

Fixed at the storage boundary in `db.ts` rather than at the call site in
`runner.ts`, for the reason the rest of the file already works that way: a
caller that has to remember is a caller that eventually forgets, and `input`
and `output` are only safe today because `capture()` redacts them regardless of
who called it.

### The Mantra — Notion (Contents) — Update Notification on Telegram

Ported from n8n. A Status change in the Contents database reassigns the page to
whoever owns that status and tells them on Telegram, with the page's unresolved
comments attached when the work is Jenny's.
`workflows/the-mantra/notion-contents-update-notification.ts`.

**Two n8n graphs became one file.** n8n split "Notion - Webhook Subscriptions"
from the notifier because a Notion subscription delivers to a single URL for the
whole integration, and the first graph was the shared front door. It fans out to
exactly one consumer, so the split bought nothing and cost a second run page per
event; the database filter that made it meaningful now lives in the notifier as
one comparison. The losing option was keeping the split and wiring it with
`ctx.run()` — worth revisiting the day a second database wants its own notifier,
and not before.

**The route authenticates by signature, and the token bootstraps itself.**
n8n's endpoint was an unguessable path and nothing else, on a webhook that
mutates a database. `notionSignature()` (new, in `src/core/verify.ts`) is the
Notion shape of the existing `hmacSignature` — hex, `sha256=`,
`x-notion-signature` — with one deliberate hole: the unsigned
`{"verification_token": "…"}` handshake is accepted, because Notion sends the
key exactly once, to the endpoint being subscribed, and rejecting that delivery
would mean never having a key at all. The hole is bounded to a body that is
nothing but a token, and every real event before the token is stored fails
closed. `WEBHOOK_SECRET` in the query string was the simpler alternative and
lost on a fact nobody could confirm: Notion's docs do not say query strings on a
subscription URL survive, and a webhook that silently stops being delivered is
the worst failure available here.

**The verification token is never written where it can be read back.** It is a
live credential arriving for the first time, so the redactor has never heard of
it — meaning the inbox row, the captured input and the run page would all have
held it in plaintext. The webhook schema strips it in a transform, which is the
last boundary before any of that, and parks it in memory for the run to file
into `ctx.state` — the one store nothing renders. The Telegram nudge says where
to read it rather than carrying it, because a message body is a captured HTTP
request. Verified by grepping the database: the token appears in exactly one
row, in `state`. The cost is that a crash between the 202 and the run loses it,
which is one click on Notion's "Resend token".

**Four n8n bugs did not survive the port.** It read `changes[0]` and filtered on
it, so the pinned example — a save that touched a checkbox *and* the status —
notified nobody depending on the order Notion listed the ids in; the status
change is now found wherever it is. It wrote the same assignee back for Approved
and Posted, and each of those writes generated another
`page.properties_updated` delivery: the loop was one filter condition away from
being a cycle, and the write is now skipped when it would change nothing. It
fetched every page in the workspace before discovering it only cared about one
database. And it interpolated page titles into HTML unescaped, so "Tan & Sons"
broke the whole message.

Verified end to end against the graph's own pinned payloads with Notion and
Telegram stubbed at `fetch`: In Review reassigns and tells Huzaifah, To Fix
reassigns and tells Jenny with comments, Posted with the status listed second
still routes, a checkbox-only change costs no API call at all, an unrouted
status warns instead of going quiet, a cleared status sends nothing, and an
already-correct assignee produces no write. Plus the auth matrix — unsigned 401,
bad signature 401, handshake 202, handshake-with-an-extra-key 401 — and a sweep
of the database, the WAL, stdout and every dashboard route for all three
credentials.


### defineOAuth honours the encryption-key fallback the docs already promised

`.env.example` has said since the secret store landed that `OAUTH_ENCRYPTION_KEY`
"falls back to SECRETS_ENCRYPTION_KEY's counterpart: set either, or both to
separate them". The secret store did that. `defineOAuth` did not — it built its
cipher from `OAUTH_ENCRYPTION_KEY` alone and declared that exact name as a
required secret.

For as long as no workflow declared an OAuth credential, nothing noticed. The
Threads token refresh is the first one that does, and it took the deployment
down on the next redeploy: a server told it had set enough keys aborted its boot
over one it had been told was optional. A missing secret stopping the boot is
correct and stays; being wrong about *which* secrets are missing is not.

The cipher now reads `OAUTH_ENCRYPTION_KEY` then `SECRETS_ENCRYPTION_KEY`, and
the boot check declares whichever is actually usable, so it agrees with the
cipher instead of demanding a name. Order is load-bearing: a deployment that
deliberately separated the two still decrypts tokens written under its own key.
With neither set the error still names `OAUTH_ENCRYPTION_KEY`, the one an
operator would expect to be told about.

Verified across all three shapes: SECRETS only boots, both-set-and-different
boots and prefers OAUTH, neither aborts naming OAUTH_ENCRYPTION_KEY.

### The Mantra — Threads — Token Auto-Refresh

Ported from n8n. A Threads token that goes 60 days without a refresh dies
permanently — there is no recovery, only a full manual re-auth — so a weekly
cron trades it for a later-expiring copy of itself and alerts Telegram when
that fails. `workflows/the-mantra/threads-token-auto-refresh.ts`.

**The token is a `defineOAuth` credential, not a row somewhere.** n8n kept it
in a data table and refreshed it in a Code node. The two alternatives
considered here were writing it back into the secret store (re-exporting
`setSecret` for workflow code) and giving Threads a Credentials-tab provider —
both lose, because both add a *fourth* write surface to the store, and the
settled rule is that only the CLI, `/api` and the Credentials tab write it.
`defineOAuth` already owns exactly this problem: encrypted at rest, one refresh
per credential at a time, re-registered with the redactor on every decrypt, and
a seed rule that abandons a stored chain when you paste a new token. Nothing
new had to be proven.

The port also fixes three things the n8n graph got wrong. Its Code node caught
every failure and returned `ok: false`, so the execution went green and only
Telegram knew — here the run goes red, retries, and `onFailure` sends the
message once rather than once per attempt. Two overlapping executions would
each read the same row and write over each other; refreshes are serialised. And
the token reached the run page as item data; nothing in this workflow ever
holds it, because `status()` returns dates and `refresh()`'s return value is
dropped on purpose.

**The failure alert carries days-to-expiry and attempts-remaining.** "It
failed" is not actionable at a weekly cadence — eight quiet failures look
identical to one. "59 days left, about 8 more weekly attempts before then" is.

**Weekly at 03:00 Monday KL**, matching n8n's rule rather than the daily check
that would pin expiry further out. Eight attempts of margin was judged enough,
and the alert says when it stops being enough.

### defineOAuth speaks Meta's self-refreshing long-lived tokens

`flow: "self"` in `src/integrations/oauth.ts`. Threads and Instagram have no
client secret and no separate refresh token: you GET the endpoint with the
token you hold and receive a later-expiring replacement. Storage, encryption,
the refresh lock and the seed rule are shared with the standard flow — only the
exchange differs, and `defaultTtlSeconds` exists because a 3600-second default
on a 60-day token would make every report of its expiry a lie.

The load-bearing line is that a `self` refresh stores the **returned** token as
the next refresh token. Keeping the one we sent — which is what the RFC 6749
path correctly does when a provider omits `refresh_token` — would pin the chain
to a token still counting down on the original clock, and the whole point of
refreshing is that it isn't. Verified against a local stand-in for the Threads
endpoint: the second refresh sends the rotated token, not the seed.

`status()` was added alongside, returning the stored dates and no token, so a
keep-alive workflow can report how much life is left without ever holding the
credential.

### A shared credential now blocks every workflow that declares it

Found while verifying the above, and fixed separately.
`defineCredential` recorded a requirement once per credential, keeping only the
*first* file that declared it. `loadWorkflows()` fills `wf.credentials` by
matching on the file, so the second workflow to share a credential got an empty
list: it was not marked blocked, and it ran with an unconnected credential
instead of refusing. The token refresh would have failed silently — its alert
is the one thing it exists to send, and it sends it through the same Telegram
credential the runway alert uses. Requirements are recorded per file now. The
dashboard's "Used by" already accumulated several files per credential, which
is what it had been waiting for.

### The workflow picker no longer hangs off the side of a phone

A `<select>` is as wide as its widest option, and the widest option here is
a workflow name. On a narrow screen the picker decided the toolbar's width
and the toolbar overflowed the page, so the control you were reaching for sat
half off the screen. It is bounded to its container now, which truncates the
name in the closed control and leaves the open list — where the full name
actually needs to be readable — alone.

### Executions are grouped and filtered by folder

Every workflow name is global and flat, so a list of runs said nothing about
which project it belonged to — `threads-content-runway-alert` and
`send-signed-agreement` read as one undifferentiated pile. Each row now carries
its folder in front of the name, `?folder=` filters the list to one folder, and
the workflow select groups its options under `workflows/<folder>/`.

**The window and folder filters are menus, not chip rows.** Five windows plus
two date fields, and one chip per folder, came to three rows of controls above
a list of runs — the filters were louder than the thing being filtered. Each is
now a `<details>` that reads as its own value when closed (`Window · 7 days`,
`📁 pblsh`) and opens its options on click, so the whole filter area is one
row. They are native `<details>`, so opening one costs no script; the two
lines of script they did need keep an open menu from being swallowed by the
background refresh, and close one when you click elsewhere. The dates live
inside the window menu and still decide on their own what a custom window is —
there is no `range=custom` state for them to disagree with, which was already
settled when the chips were added.

**The status chips stay flat, above the list and below the cards.** They are
five short words, and the cards *are* the statuses — putting the same four
numbers behind a click would hide the page's summary to save nothing. The
window and folder rows moved above the cards instead, because both change every
number in them, and a control that rewrites the cards from underneath reads as
unrelated to what it just changed.

**The folder is looked up from the registry, not stored on the run.** A run
records a workflow name and nothing else, and adding a `folder` column would
have made it a second source of truth that drifts: move a file between folders
and the old rows would keep claiming the old project forever. The cost of
reading it live is the opposite skew — old runs show where the file lives
*now* — which is the one people can reason about, because the dashboard and
the repo always agree. A run whose file has since been deleted simply shows no
folder, exactly like a top-level one.

**So the folder filter is a set of names, passed as JSON.** `RunFilter` grew a
`workflows` list that the query matches with
`workflow IN (SELECT value FROM json_each(?))`, which keeps one prepared
statement instead of a generated `IN` list per folder size. `''` means "not
filtering by folder" and `'[]'` is a folder with nothing left in it, which
correctly matches nothing.

**A folder and a workflow that disagree resolve to the folder.** Picking a
folder clears the workflow in every chip link, and the route drops a workflow
that is not inside the chosen folder rather than running the impossible query —
an empty page reads as broken, not as two filters contradicting each other. An
unknown `?folder=` widens to everything, the same as an unknown `?status=`.

### An accepted webhook now survives a deploy

Every push redeploys, and a redeploy restarts the process. An async webhook
lived only in the closure a `queueMicrotask` was holding, so a restart between
the `202` and the run dropped work the caller had already been told was
accepted — silently, with no run record, nothing on the dashboard, and no
reason for the provider to send it again. That is the worst shape a loss can
take: everyone involved believes it succeeded.

Payloads are now written to an `inbox` table *before* the 202 goes back and
settled when the run they start reaches a decision; anything still pending at
boot is run with its recorded input. `/healthz` reports the pending count.

**Recovery is a replay, not a resume, and therefore at-least-once.** A resume
carries a checkpoint key and no `ctx.input` — a workflow that reads its payload
would get `{}`, which is the bug the approval-resolve workflow already found
once. So a run interrupted half way through repeats the steps it had already
done. Polling makes the same trade for the same reason: doing something twice
is recoverable, and never doing it is not.

**Two kinds of `skipped` mean opposite things.** A run the shutdown skipped has
not happened and stays pending; a run `onOverlap: "skip"` dropped *has* been
decided, and leaving it pending would resurrect a webhook the workflow
deliberately refused. The runner grew an `isShuttingDown()` to tell them apart,
rather than the delivery path matching on an error string.

**`respond: "sync"` is deliberately not recorded.** That caller is still
holding the connection, so it sees the failure and can decide for itself —
nobody was misled, which is the entire problem being fixed. A sync delivery
replayed after a restart would also produce a result nobody is waiting for.

**The inbox ignores `CAPTURE_DATA`.** It stores through `capture()`'s `force`
and against `CHECKPOINT_MAX_BYTES`, the same as step outputs, because it is
functional data rather than observational. The alternative — reusing the
capture switch — would let a disk-space setting quietly turn durability off. A
payload that does not fit is not recorded at all rather than recorded
truncated; the run still happens and the log says it will not survive a
restart.

Duplicates are judged inside a window (`INBOX_DEDUP_MS`, 5 min) rather than by
a unique index on the fingerprint, because two byte-identical payloads an hour
apart are two real events — a unique index would swallow the second "ping"
forever. The window only has to outlast a caller's retry. The fingerprint is a
sha256 of method, path and raw body: a digest of the payload, which is why it
is the one column here that needs no redaction. The stored `input` is the
parsed value and goes through `capture()` like everything else.

**What was refused: a separate receiver in front.** It is the only thing that
could catch a webhook arriving while the process is *down*, and it costs a
second always-up service that must be deployed separately to be worth
anything, becomes a single point of failure ahead of everything, breaks
`respond: "sync"`, and cannot hold a delivery long anyway — Slack and Stripe
reject signatures older than about five minutes. Provider retries cover the
down window; this covers the window where we said yes and then lost it. If the
inbox's pending count shows real losses over time, revisit with numbers.

### The executions tab can be pointed at a window of time

The **Executions** tab grew a second chip row — All time, 24 hours, 7 days,
14 days, 30 days — plus two date fields for anything else. `?range=` carries
the chip; `?from=` / `?to=` carry the dates. Every filter now cross-carries:
picking a range keeps the workflow and the status, and picking a status keeps
the dates.

**The dates win over the chip, and their presence *is* the custom range.**
There is no "Custom" chip to select first and no mode to be in — filling a date
field puts the page in a custom window, and clicking any range chip clears both
fields on the way out. A separate `range=custom` state would have meant two
places that can disagree about what window you are looking at, and a chip that
does nothing until you also fill something in.

**The date fields are UTC days, not local ones.** Every timestamp on these
pages is printed with `toISOString()`, so the day you type has to mean the day
you can read in the table. The zone the server happens to run in is not on the
screen anywhere, and a workflow's own `tz` is per-workflow — neither is a
defensible thing to silently reinterpret the input against.

**The counts above the list now follow the window instead of being fixed at
24h.** Four cards reading "· 24h" over a 30-day list is two facts that look
like a contradiction. The status *filter* is deliberately left out of them —
the cards are the statuses — so they answer "what happened in this window",
and the tab badge stays at 24h because it means the same thing on every page.

Bad input widens rather than narrows, matching what an unknown `?status=`
already did: an unparseable date is ignored, and a backwards range is swapped
rather than answered with nothing. An empty table you cannot explain is the
worse failure. The row cap stays at 100, but a capped list now says so and
gives the total it is truncating — a partial answer that looks complete is the
thing this codebase refuses everywhere else.

Not done, because nothing asked for it: `/api/runs` still takes only `limit`.

### The background refresh no longer wipes a control you are in the middle of

The 10-second poll replaces the whole `.wrap` element, and it only ever held
off for the workflows search box, matched by `id === "filter"`. Every other
control was fair game: a half-made choice in a `<select>`, or a date being
typed, would vanish under the cursor on the next tick. The guard now covers any
focused `input`, `select` or `textarea`.

Guarding by focus rather than by id is the point. Naming the controls to skip
means the list is wrong again the next time one is added — which is exactly how
this surfaced, while adding date fields to the executions tab. Focus is the
property that actually answers "is the user using this right now".

### Moving a secret between folders no longer costs you the value

The loose-secret form dropped `required` from the Value box when editing, and
`POST /secrets` now reads an empty box on an existing key as "keep it" and
writes only the folder. Creating a secret still requires a value; blank on a
name that does not exist yet is still refused.

**A blank box means "unchanged", not "clear it".** The credential form had
settled this already — its password fields are optional once filled, and the
route skips any secret field submitted empty. The loose-secret form was the
odd one out, so a folder change meant a round trip to the password manager to
retype something that was not changing. That is not just friction: retyping a
value you did not intend to touch is how it ends up mistyped, or pasted from
the wrong entry. Folders are metadata, and metadata edits should not put the
value in play at all. `updated_at` is deliberately left alone on a move for the
same reason — nothing about the value changed.

The one thing lost is the ability to blank a loose secret from this form, which
was never available anyway: `setSecret` has always refused an empty value with
"delete it instead", and Delete is the button for that.

### A credential now takes its own field rows with it when it moves

`saveCredential` applies the folder to every secret it owns, not just the
fields the submission carried values for. A folder-only credential edit sends
no values — the password boxes come back blank on purpose — so the credential
row moved and the rows holding its actual fields stayed behind in the old
folder. Nothing broke, because lookup is by owner and never by folder, but the
Credentials tab builds its folder list from both tables, so the old folder
lingered with invisible members in it. `setCredentialFolder` had the right
behaviour; `saveCredential` just was not doing the same thing.

### Each brand pings from its own Telegram bot

`ctx.telegram.send` takes a `token` override, the way `ctx.discord.send`
already took `webhookUrl`. The two workflows now name their own bot —
`defineCredential("telegram", "the-mantra")` and `("telegram", "pblsh")` — and
`MANTRA_TELEGRAM_CHAT_ID` is gone.

**The bot is a credential; the recipient is not.** This was the question worth
settling. A bot token is a secret with a Test button and a rotation story, so it
belongs in a credential. A chat id is neither: declaring it would register it
with the redactor and blank the destination out of every run page, which is
exactly the line you want to read when checking where an alert went. So the
recipient stays `TELEGRAM_CHAT_ID_HUZAIFAH`, read straight from the environment
and shared by both workflows, because both alerts go to the same person.

The cost is the one the credentials rule already documented, and it is heavier
here than it was for Notion: an unconnected credential blocks the **whole
workflow**, and for pblsh the Telegram ping shares a run with the creator's
agreement email. Until Telegram / "pblsh" is connected, a Tally submission is
refused at the door and nobody gets a PDF. Connect both credentials before
deploying, not after.

**Why the dashboard was silent about the old variable.** `process.env.X` read
inline is invisible to everything — the "wanted" list on the Credentials tab is
built from `defineCredential`, and the boot check from `defineSecrets`. A bare
env read is neither, so nothing knew the name existed to report it missing. That
is still true of `TELEGRAM_CHAT_ID_HUZAIFAH` and is the accepted price of
keeping it readable; the compensation is that it now falls back to the chat id
stored on the workflow's own Telegram credential, which *is* shown on the
dashboard in plain text, rather than to whichever bot happens to be primary.
Pairing one brand's token with another brand's default chat was a real way to
send from the wrong bot, and it can no longer happen quietly.

`PBLSH_TELEGRAM_CHAT_ID` was documented in `.env.example` and read by nothing;
it is deleted rather than wired up.

### The Mantra's Notion token is a credential, not an env var

First workflow moved onto `defineCredential`. `NOTION_API_KEY` is gone from the
environment; the alert now reads Notion through the credential named **mantra**,
connected on the Credentials tab.

The reason to move this one and not the others is what it buys: a Test button
for the token the alert actually uses, and rotation without touching `.env` or
redeploying. `BREVO_API_KEY` and `TALLY_SIGNING_SECRET` stay as `defineSecrets`
— Brevo could have become a credential, but the pblsh workflow reads it through
`defineSecrets` and a primary Brevo credential already satisfies that name
without any code change, so editing a working production workflow would have
bought nothing.

**The reference is a name you chose, not an id the database made up.** This was
the question worth settling: `defineCredential("notion", "mantra")` names a
*slot*. Revoke the integration in Notion and paste a new token into the same
credential and the file is untouched; delete the credential entirely and create
another called "mantra" and it reconnects on its own. A UUID would have inverted
that — every delete-and-recreate would mean editing the workflow to chase a new
id, which is exactly the coupling the store exists to remove. Names can collide
where uuids cannot; that is handled by refusing a colliding name at save time,
which is a better trade than making every reference opaque.

**What it costs.** This alert no longer stops the boot when its token is
missing — that is the documented credential rule, not a regression, and the
compensation is that the workflow is marked blocked and its runs are refused
rather than sending an alert computed from a failed Notion call. Deploy order
matters: connect the credential first, then deploy, or the alert sits blocked
until you do.

### Credentials, folders, and a dashboard that writes

A credential is now a first-class thing: several fields for one platform, kept
together, filed in a folder, and testable. `defineCredential("smtp", "main")`
returns a live view of it in a workflow, the Credentials tab creates and
connects one in the browser, and a **Test** button asks the platform whether the
values are live. Loose secrets got folders too, in the same tree.

This reverses two settled decisions and bends a third. All three were decided
deliberately, so here is what changed and what was traded.

**The dashboard is no longer read-only, and that was the point of the
exercise.** The old rule — no write surface in the browser, so a browser cannot
break production — was written for a person with a terminal. It reads
differently once workflows are written by an AI coding agent: `bun run secret`
means the agent runs a command with the key in it, `PUT /api/secrets/:key` means
it sends the key in a request body, and either way a live credential lands in a
chat transcript. The form is the only route where the value goes from a person
straight into the encrypted store, and the agent never sees it. That is the
whole argument for it.

The losing option was "read-only tab, copy-paste the CLI command", which keeps
the guarantee intact and does not solve the problem it was kept for.

What survives is `DASHBOARD_WRITE`. Unset, the tab renders the same page with no
buttons and every write route answers 403 — the old behaviour, kept as a
deployment choice rather than deleted from the codebase. Be honest about what
the flag is: hygiene, not access control. Anything that can read `.env` can
decrypt the store regardless, so it stops credentials passing through
conversations; it does not stop an agent with shell access.

**A platform's fields and its test live in code, not in the database.** The
tempting version is a free-form credential where you name the fields and
configure a test request in the browser — any platform, no deploy. That is a
request the server executes, configured from a form and stored as a row, which
is configuration-as-code in the database and the exact n8n shape this project
exists to avoid. `src/core/providers.ts` costs a few lines and a deploy per
platform, and that cost is what keeps the database free of anything executable.
SMTP, Notion, Telegram, Slack, Discord and Brevo ship with it.

**An unconnected credential warns instead of aborting the boot.** This bends
"boot-time secret validation — n8n failed at 3am, we fail on deploy", and only
for credentials. A missing `defineSecrets` key still kills the process. A
missing credential cannot, because of a chicken and egg: the dashboard is where
you connect it, and a server that refused to start never serves that page.
Aborting would make the one workflow that needs connecting unfixable without a
redeploy, which is the thing this feature exists to end.

Nothing runs half-configured in exchange. The loader logs the warning, the
workflow is marked **Blocked** on the dashboard, and `runWorkflow` refuses the
run — recorded as a failed run rather than dropped, because a cron trigger that
quietly does nothing is indistinguishable from a scheduler that stopped. A typo
in the *platform* name still aborts, since no amount of dashboard work fixes
`defineCredential("notionn", …)`.

**There is still one encrypted store.** A credential's fields are ordinary rows
in the `secrets` table under derived names — `SMTP_MAIN_PASS` — and the new
`credentials` table holds only the grouping: platform, folder, primary flag,
last test result. That was the cheapest correct option by a distance: redaction,
rotation, the master key, the env mirror and the cross-process refresh all apply
without being re-established, and there is no second thing that can hold a
credential. The alternative — a separate encrypted table with its own read path
— would have doubled the surface where the no-raw-credential-on-disk invariant
has to hold.

Two consequences worth knowing. Nothing outside `saveCredential` may write a
field, so the CLI, the loose-secret form and `/api/secrets` all refuse a key
whose `owner` is set — writing one directly goes around the bundle's validation
and leaves "connected" claiming something untrue. And `secret-store.ts` had to
learn that not every stored value is a credential: it registers everything with
the redactor by default because it cannot tell a token from a hostname, so
credentials.ts installs a redaction policy exempting fields a provider declared
`secret: false`. Without it the connection test reported *Connected to
«redacted»:2525* — caught by running it, not by reading it. The policy is
installed at module import, because `loadSecretStore()` has already applied
every value by the time `initCredentials()` runs and a hostname registered once
cannot be taken back out.

**A primary credential fills the bare env names.** `ctx.email` reads
`SMTP_HOST`, not `SMTP_MAIN_HOST`, so without this, connecting SMTP on the
dashboard would test green and change nothing about what `ctx.email` sends
with — the worst kind of working. One credential per platform can claim it, and
it beats an env var of the same name, which is what makes rotating an SMTP
password a form submission rather than a redeploy.

**The value rule got narrower rather than weaker.** "A credential is never
returned by an HTTP route" becomes: a field the provider declared `secret: false`
is configuration and is rendered into the edit form, because an edit form you
cannot read is not one; a field that is a credential is never sent to the
browser in any view, is never echoed back after a failed submit, and `GET
/api/credentials` reports only which fields are set.

### The Mantra — Threads — Content Runway Alert

Ported from n8n. Reads the Approved buffer in the Threads Notion database
twice a day and pings Telegram when there is not enough dated, approved
content left to keep posting 15/day with two days in hand.
`workflows/the-mantra/threads-content-runway-alert.ts`, and the folder is the
second one under `workflows/`.

Three things the port fixed rather than reproduced:

- **A manual run now always sends.** The n8n sticky note promised this as the
  way to test the alert, but the Code node read the flag off a `Time gate`
  node that was not in the graph — the lookup threw, the `try` swallowed it,
  and `manual` was permanently false. So a manual run with a healthy buffer
  sent nothing, silently, which is exactly the case you press the button to
  check. Here it is `ctx.triggeredBy`, which is not a guess.

- **A row dated today with no time counts as still due.** n8n compared it
  against KL midnight, so it was always in the past and never appeared in
  "still due to post today". Nothing in Notion says when an undated-time row
  would fire, so it counts all day.

- **`alwaysOutputData` is gone.** n8n injected one empty item when the filter
  matched nothing, and the Code node had to filter it back out to avoid
  reporting a buffer of 1 when it was 0. An empty array is an empty array.

**Notion goes through `ctx.http`, not a new integration.** One workflow reading
one database does not justify a client, and `ctx.http.paginate` does not fit
either — Notion's query endpoint is a POST with the cursor in the body. The
hand-rolled loop keeps the `maxPages`-throws discipline: running past the
ceiling raises rather than returning a short count, because a short count
under-reports the buffer and sends a nudge that is not warranted.

**`checkpointTtlHours: 1`.** The entire value of the run is that its reading is
current. An hour-old checkpoint is worth reusing across a retry; a day-old one,
resumed by hand from the dashboard, would report yesterday's buffer as today's.

The chat id is `MANTRA_TELEGRAM_CHAT_ID` — configuration, read from the
environment, so it is not blanked out of every run page the way a declared
secret would be. `NOTION_API_KEY` is declared with `defineSecrets`, so a
deploy without it stops at boot.


### A workflow's "updated" time is a content hash, not a file mtime

The dashboard could say when a workflow last *ran* and never when it last
*changed*, which is the question you actually have when a deploy lands and you
want to know what moved. The **Workflows** tab now has an **Updated** column,
the workflow page has `Updated` and `Version` rows, and `/api/workflows`
carries `version`, `addedAt` and `updatedAt`.

**The obvious implementation is `statSync(file).mtime`, and it is wrong here.**
A deploy is a fresh `git clone` into the build context, so every file lands
with the same checkout time; a Docker `COPY` faithfully preserves it. The
column would have read "updated 2m ago" for every workflow after every deploy —
worse than not having it, because it looks like an answer. So the runner hashes
each workflow file at boot and keeps `(hash, first_seen, updated_at)` in a new
`workflow_versions` table, moving `updated_at` only when the hash moves. A
restart that changed nothing writes nothing.

**Decided along the way:**

- **The write lives in `src/index.ts`, not in `loadWorkflows()`.** Loading
  workflows is a read, and the loader is already load-bearing for a boot that
  has to fail cleanly on a missing secret. One line after the registry is
  built is easier to reason about than a side effect inside the import loop.

- **The upsert has a `WHERE hash <> excluded.hash` on its `DO UPDATE`**, so an
  unchanged workflow is a no-op at the SQL level rather than a rewrite with a
  fresh timestamp. `first_seen` survives because `DO UPDATE SET` never names
  it, which is what lets the view distinguish "added" from "changed".

- **Rows for deleted workflows are left in place.** Pruning them looks tidier
  and loses the truth: a file deleted and restored unchanged genuinely has not
  been edited, and the orphan row is what lets it say so. The cost is a stale
  row per renamed workflow, which is bytes.

- **The hash covers the workflow file only** — not `src/`, not its imports. A
  workflow whose behaviour changed because the HTTP client changed will not
  show as updated. That is the right answer to "when was this workflow last
  edited" and the wrong one to "when did this last behave differently"; the
  column is labelled for the first question and README says so.

- **No migration for existing databases.** `CREATE TABLE IF NOT EXISTS` plus
  an empty table means the first boot records every workflow as added, dating
  them all to that deploy. One-off and self-correcting, against a migration
  that would have to invent a date it does not have.


### The dashboard is two tabs, and folders are the shape of the first one

One page listing every workflow above every run stopped scaling the moment
`workflows/` had subdirectories: folders were a single grey separator row, and
the run list was a fixed last-40 with no way to ask it a question. Split into
**Workflows** (`/`) and **Executions** (`/runs`).

**Folders are now the structure, not a caption.** Each is a collapsible
section with its own count, and which ones you collapse is kept in
`localStorage` rather than on the server — it is a per-eyeball preference, and
persisting it server-side would have meant a table and a notion of *whose*
preference on a dashboard with exactly one shared basic-auth login.

**Decided along the way:**

- **No CSS or client framework.** The obvious move for "make it look better"
  is Tailwind or a component library, and both were rejected: this project has
  no build step and no bundler, and a CDN stylesheet means the dashboard stops
  looking like itself on a box with no outbound network — which is the box it
  runs on. The whole front end is still one inlined `<style>` and one inlined
  `<script>` — 9.2 KB and 3.2 KB, a ten-workflow page 30 KB total and 6 KB
  gzipped, with zero external requests. Dark and light both come from the same
  token block via `prefers-color-scheme`.

- **The health strip is one windowed query, not one query per row.** A folder
  of twenty workflows would otherwise be twenty round trips to render a page;
  `recentRunsPerWorkflow` returns the last twelve runs of everything in one go
  and the view groups them in memory. Bar *height* carries duration, so a run
  that suddenly takes far longer than its neighbours is visible without
  opening it.

- **Filter state survives the background refresh; the refresh does not fight
  the user.** The 15s poll replaces `.wrap` wholesale, which throws away typed
  text, listeners and open/closed state. So the filter lives in a closure and
  the folder state in `localStorage`, both re-applied to the replacement,
  listeners are delegated off `document`, and the poll skips a beat entirely
  while the filter box has focus.

- **Collapse is persisted from the summary's `click`, not from `toggle`.** A
  search opens the folders it matched into, which fires `toggle` and is
  indistinguishable from the user opening them — persisting on `toggle` erased
  what they had collapsed the moment they typed. A click on a summary is only
  ever the user.

- **An unknown `?status=` widens to everything.** Validated in the route rather
  than the view, so a typo shows every run instead of rendering a tab that can
  only ever be empty.

- **Chrome is sentence case; stored values are verbatim.** Page titles, row
  labels, badges and filter chips are written text and read as written text.
  Statuses, log levels, trigger kinds, cron expressions, file paths and
  workflow names are echoed exactly as stored, which for this project means
  lowercase. So a `Status` row holds a `failed` pill — the pill is the string
  you would grep the database for, the label is not. The rule is written down
  next to the formatters in `views.ts` so it does not drift.


### Compose is the deploy path, and the compose file is Coolify-correct

The compose file had three things in it that a Coolify deployment trips over,
so it was unusable as a build pack even though it was checked in. Fixed, and
Coolify now points at it.

**The speed argument for this was wrong, and is recorded here so it is not
made again.** The claim was that the Dockerfile build pack rebuilds the image
on every workflow change while Compose only restarts — minutes versus seconds.
Measured: a workflow-only change invalidates one `COPY` layer and rebuilds in
**0.78s** warm, against **5.5s** for a full cold build. Coolify runs
`docker compose up -d --build` regardless, so Compose skips no build at all.
The two paths are within noise of each other for a `git push` deploy.

What Compose does buy is real but smaller: the deployment config lives in the
repo under review rather than in Coolify form fields, and the bind mount makes
`git pull && docker compose restart` (~0.2s, no build) available as an escape
hatch. Not a reason to migrate an already-working Dockerfile deployment — the
build packs use different volumes and the migration costs more than the
difference.

**Decided along the way:**

- **`expose`, not `ports`.** Publishing 3000 on the host makes the dashboard
  answerable over plain HTTP alongside the proxy's HTTPS, on basic auth alone.
  Local use needs the published port though, so it moved to a second file —
  named `compose.local.yml`, *not* `docker-compose.override.yml`. The override
  name is auto-loaded by a bare `docker compose up`, and that turned out to be
  literally Coolify's start command, so the "server never publishes" property
  would have depended on a flag nobody controls. A name Compose only loads when
  asked for makes it unconditional. Verified with `docker compose up --dry-run`
  rather than assumed.
- **`env_file` is optional.** `.env` is gitignored, so a required one fails the
  deploy on a file that is never meant to be committed, and Coolify injects the
  environment itself.
- **No `container_name`, no fixed `image` tag.** Coolify derives both per
  deployment; pinning them makes two deployments on one host collide.
- **Zero-downtime was considered and rejected as unavailable.** Two overlapping
  processes would share one SQLite file and each run their own in-process
  scheduler, so every cron fires twice across the swap. Single-process is the
  settled architecture and a couple of seconds of downtime is the price. A cron
  due inside that window is skipped rather than caught up — croner is
  constructed without a catch-up option — and a webhook arriving in it relies
  on the sender retrying.
- **The build packs use different volumes.** Switching drops you on an empty
  database — run history, state, OAuth tokens, and the secret store. The README
  carries the backup and volume-copy steps; this is the one part of the switch
  that can lose data.

### Credentials in the database, so rotating one is not a redeploy

Env vars are read once at process start, so changing a credential meant a
Coolify redeploy — an image rebuild for a one-line change, plus the restart.
`src/core/secret-store.ts` adds an encrypted table that overrides the
environment, `bun run secret -- set KEY` writes to it, and the value is live on
the next run.

The README named this shape a while ago and left it unbuilt on the grounds that
"env vars are the right answer until they aren't". The rebuild-per-rotation is
where they stopped being.

**Decided along the way:**

- **A stored value beats an env value.** The other order is the obvious one and
  it is wrong: a credential a deploy had already set could then only be changed
  by another deploy, which is the entire thing this removes. Deleting a stored
  value restores the environment's, so the fallback is never lost.
- **`defineSecrets` returns a proxy, not a snapshot.** This is what let the
  change land without editing a single workflow: the type is identical and
  `secrets.API_KEY` still reads like a property, but each access resolves the
  current value. A snapshot would have made the store a boot-time-only feature
  and bought nothing over an env var.
  - The cost is that a read at *module* scope is still frozen — a closure holds
    the string from import. `hmacSignature` now takes `string | (() => string)`
    for exactly this reason, and `tallySignature(() => secrets.X)` is the
    documented form. Rejected making every workflow read secrets inside `run()`
    instead; a getter at the one import-time call site is a smaller tax.
  - A live value that fails its schema warns once and keeps the last good one
    rather than throwing. An operator's typo should not take down a workflow
    that was working a second ago.
- **Stored values are mirrored into `process.env`.** Integrations read their own
  credentials from the environment inside their factories, so without the
  mirror the store would have covered `defineSecrets` keys and silently not
  covered `SLACK_BOT_TOKEN`. That in turn forces `loadSecretStore()` to run
  before the loader imports anything.
- **The CLI runs before the loader, and therefore without schemas.** Setting a
  credential for a workflow you have not deployed yet is the main win — it
  breaks the lockstep where a workflow and its secrets had to ship in the same
  deploy — and `loadWorkflows()` would abort on that workflow's missing key
  first. So `set` does a tolerant import pass purely to collect zod schemas,
  swallowing every failure, and warns when it could not validate. Rejected
  validating only in the API: the CLI is the path an operator reaches for, and
  an unvalidated write there is how you find out at 3am.
- **Writes go to the CLI and `/api`, not the dashboard.** A credential form in
  the browser is precisely the read-only-dashboard rule being given up, and the
  rule is what means a browser cannot break production. `GET /api/secrets`
  returns names and timestamps; no route returns a value, and `secret get`
  masks unless you pass `--reveal`.
- **The CLI writes to the database, not to the running server**, so it needs no
  URL and no auth. The server picks the write up on a `SECRET_REFRESH_MS` tick
  (default 10s) that probes one aggregate over a table with tens of rows. An
  API write skips the wait and applies in-process. Rejected making the CLI an
  HTTP client — it would stop working exactly when you need it, on a server
  that will not boot.
- **`SECRETS_ENCRYPTION_KEY` falls back to `OAUTH_ENCRYPTION_KEY`**, so an
  existing deployment needs no new variable, and setting both separates the two
  concerns for anyone who wants that. Encryption moved to `src/core/crypto.ts`
  and both callers share it; the wire format is byte-identical to what OAuth
  wrote before, because tokens in the field are already encoded that way.
- **An unreadable value warns and falls through to the environment.** Same
  recovery OAuth already took. A deployment that rotated its master key and can
  no longer start is worse than one running on env vars, and a boot that dies
  on an undecryptable row would be exactly that.
- **What did not change:** a missing credential still stops the boot. The store
  does not soften that into per-workflow quarantine, and does not need to —
  setting the secret on the running instance *before* pushing the workflow is
  now possible, which is what the lockstep actually cost.

### PBLSH authenticates Tally by its signature

`workflows/pblsh/send-signed-agreement.ts` now verifies Tally's
`tally-signature` instead of expecting `WEBHOOK_SECRET` in the request. Tally
has no field for a custom header, so the only alternative was `?secret=` in
the webhook URL — and that puts the secret in every access log between Tally
and here, ours included.

**Decided along the way:**

- **`TALLY_SIGNING_SECRET` is boot-stopping**, declared with `defineSecrets`
  like `BREVO_API_KEY`. A signing secret that is absent is a webhook with no
  authentication, and the deploy should fail rather than accept anything that
  reaches the path.
- **The old `?secret=` URL stops working.** `verify` replaces the shared-secret
  check rather than adding to it, so the query parameter is no longer read for
  this route. The webhook URL in Tally goes back to being just the URL.

### `verify`, for the providers that sign instead of echoing

`WEBHOOK_SECRET` assumes the caller sends the secret back. Most providers
don't: they keep it, HMAC the body with it, and send only the digest in a
header — so the shared-secret check can never match and every call is a 401,
however the secret is configured at either end. `webhook(path, { verify })`
authenticates those callers from the request itself, with `hmacSignature()`
for the general shape and `tallySignature()` for the one in use here.

**Decided along the way:**

- **The body reaches the verifier as undecoded text.** An HMAC recomputed over
  a parsed and re-serialised payload does not match — a reordered key or a
  dropped space is a different digest — so `app.ts` now reads the body once as
  a string and both the verifier and the schema parse work from it. This is
  the invariant that breaks if anyone reinstates a parse-before-verify.
- **`secret` and `verify` are alternatives, enforced at boot.** Declaring both
  stops the load naming the file, rather than quietly applying one. Which one
  was guarding the route would otherwise be a guess, and the guess people make
  is "both".
- **A verifier is a function, and the built-ins are just functions.** Providers
  differ on four things — header, hash, encoding, prefix — so `hmacSignature`
  takes those four and `tallySignature` is one line of it. A scheme that isn't
  an HMAC of the body writes a closure instead of waiting for a provider
  helper to be added here.
- **`hmacSignature` throws when handed no secret**, at import, rather than
  returning a verifier that rejects everything. An HMAC keyed on nothing is
  computable by the caller too, and a webhook that 401s forever with a clean
  boot log is the worse failure.
- **A verifier that throws is a failed check, not a 500.** The caller gets the
  same 401 as a bad digest; the reason is logged for us, not returned to them.
- **Verification precedes the run.** A forged call costs a warning and never
  reaches the database, so run history stays a record of real events rather
  than of everyone who probed the endpoint.
- **`parseBody` rebuilds a Request for form bodies** so multipart parsing
  stays the runtime's job. The cost is that a binary part is decoded as text;
  webhook payloads here are documents, not uploads.

### The dashboard refreshes by fetch, not by re-navigating

`<meta http-equiv="refresh" content="15">` re-ran the whole navigation every
15 seconds, which under basic auth means re-running the credential exchange
every 15 seconds. A browser that declines to reuse the credentials answers
with a prompt and an error page, so an intermittent auth hiccup became a
permanent-looking one: four chances a minute to lose the page you were reading.
`.wrap` is now swapped in from a `fetch` instead.

**Decided along the way:**

- **A failed refresh leaves the page alone.** That is the whole point. A
  re-navigation replaces what you were reading with a browser error page; a
  failed fetch is caught and the next tick tries again, so a redeploy or a
  restart no longer costs you the run you had open.
- **The interval is read back off `.wrap` after every swap.** A run page asks
  for 5 seconds while the run is `running` and `null` once it is not, so the
  polling stops on its own when the finished page arrives — a fixed
  `setInterval` would have outlived the reason it was started.
- **A hidden tab is not polled.** Same 15 seconds, but nothing is fetched
  while nobody is looking, which matters for a page people leave open.
- **No-JS loses auto-refresh, and that is accepted.** The alternative is
  keeping the meta tag as a fallback, which would keep the bug for exactly the
  case that reported it.

### A 401 a browser can render

`basicAuth` answers with its own response, and that response is an
`application/octet-stream` body reading `Unauthorized`. A browser handed a
binary content type for a top-level navigation cannot display it, so
dismissing the credential prompt showed Chrome's *this site can't be reached*
rather than a 401 — the dashboard looked down when it was only locked. The
middleware is now wrapped, and the 401 is the styled page in `views.ts`.

**Decided along the way:**

- **Wrapped rather than configured.** `basicAuth`'s `invalidUserMessage` builds
  the same `new Response(string)` with no content type, so it cannot fix this;
  a string stays octet-stream and an object becomes JSON. Catching the
  `HTTPException` is the only seam that gets to set the header.
- **The `WWW-Authenticate` header is copied off the original response**, not
  rebuilt from the realm. It is the entire reason a prompt appears, and
  re-deriving it would have been one more thing to keep in step with Hono.
- **The page says which two env vars to set.** Whoever hits this is either
  deploying it or has forgotten the password, and both are served by naming
  `DASHBOARD_USER` and `DASHBOARD_PASS` instead of the word "Unauthorized".

### `workflows/` ships only real work

The nine demo workflows are gone; `workflows/pblsh/send-signed-agreement.ts`
is the only one left. They were written to illustrate the runner's features and
they did that job in the README, which still documents every pattern they
showed.

**Decided along the way:**

- **The demos were a deploy hazard, not just clutter.** Every one that declared
  a secret was a boot-stopping requirement for a credential nobody here needs —
  `daily-digest` demanded a `GITHUB_TOKEN` to summarise commits on `oven-sh/bun`,
  a repo we have nothing to do with. Feature illustration is the README's job,
  where a wrong example costs a reread; in `workflows/` it costs a deploy.
- **The pattern docs stay, the file pointers go.** Checkpoints, pagination,
  polling, durable state, and approval gates are still documented in full —
  only the "here is the runnable example" lines were cut, because a pointer to
  a deleted file is worse than no pointer. The approval section now reads as
  the specification it always was.
- **`APPROVAL_SLACK_CHANNEL` came out of `.env.example`.** Nothing in `src/`
  ever read it; it was the deleted `approval-request` workflow's own
  configuration, and left behind it would have looked like a runner setting.
- **CHANGELOG entries were left alone.** Older entries describe files that no
  longer exist, which is what history is for — rewriting them to match the
  current tree would destroy the reasoning they exist to keep.

### Coolify deploys build the Dockerfile, not a build pack

README gained a Coolify section, because the settings that path needs are not
guessable from the repo and two of them fail quietly.

**Decided along the way:**

- **Build pack is Dockerfile, not Railpack.** Railpack autodetects Bun and
  boots, which is the trap — it ignores the non-root user, tini (so `SIGTERM`
  never reaches the process and `SHUTDOWN_TIMEOUT_MS` stops meaning anything),
  and `DATABASE_PATH=/data/automator.db`. A working dashboard on a database
  nothing persists looks like a successful deploy.
- **The `/data` mount leaves Source Path empty.** Blank is a named volume,
  which inherits `/data`'s bun:bun ownership from the image. A bind mount to a
  fresh host directory is root-owned, and the container — non-root by
  construction — cannot open the database there. The UI's placeholder in that
  field reads like a default and is not one.
- **The Compose path and the Coolify path differ on `workflows/`**, and the
  README now says so per-path instead of claiming the read-only host mount
  everywhere. Compose bind-mounts it, so a workflow edit is a restart; a
  Dockerfile build bakes it in, so it is a push and a redeploy.
- **Boot-stopping secrets are a deploy-time concern**, so the README says so
  where you set the environment. `enabled: false` does not exempt a workflow
  from its `defineSecrets` — that runs at import, before the loader reads
  `enabled` — and the asymmetry is worth one sentence there rather than a bug
  report.

### PBLSH: the signed agreement, off n8n

`workflows/pblsh/send-signed-agreement.ts` replaces the n8n graph of the same
name — Tally posts a Content Buyout Agreement submission, the creator gets the
signed PDF by email, Huzaifah gets a Telegram summary. Five nodes became four
steps, and the port fixed things on the way across rather than transcribing
them.

**Decided along the way:**

- **Fields are read by label, not by index.** The n8n Telegram node read
  `fields[2]`, `fields[3]`, `fields[7]` … so dragging a question in the Tally
  editor would have sent the KTP number as the date of birth, silently and
  forever. Labels are the only stable handle in the payload, so all of it goes
  through one lookup, and a renamed question now fails the run with the label
  named in the error instead of delivering a wrong summary.
- **Every value interpolated into the Telegram HTML is escaped.** A creator
  named "Tan & Sons" broke the whole message under `parse_mode: HTML`; the n8n
  version was one apostrophe away from finding that out in production.
- **The payload is read inside the first step, not at the top of `run()`.**
  A resumed run has no `ctx.input`, so reading it early makes a resume report
  the form's own questions missing. This is the second workflow to need that
  shape, after `approval-resolve`.
- **The PDF download is deliberately *not* checkpointed.** A few hundred KB of
  base64 as a step result would be truncated on the way into SQLite and leave
  the run page holding a useless copy, so the buffer leaves the step through a
  closure and the result is just its size — which means a checkpoint hit would
  hand a later step an empty buffer. `checkpoint: false` is the only
  combination of those two that is correct; re-downloading on a resume is
  cheap, and it was verified by resuming a run that had failed at the email.
- **Brevo over HTTP rather than `ctx.email`.** The SMTP client would work, but
  its credentials are global to the runner while `BREVO_API_KEY` is declared
  by this file — and the flow needs Brevo's verified sender, reply-to, and
  base64 attachment exactly as the n8n node had them. One `defineSecrets` key
  validated at boot beats five shared SMTP variables.
- **The route keeps `WEBHOOK_SECRET`.** Tally's webhook form has no
  custom-header field, so the secret travels as `?secret=…` in the URL pasted
  into Tally. The rejected alternative was `secret: false` plus an unguessable
  path, which is all the n8n webhook had — not good enough for a payload
  carrying a KTP number and bank details.

**Known and accepted:** a run page for this workflow holds personal data — the
captured payload has the KTP number, address, and bank details, and Tally's
signed `submissionPdfUrl` is a bearer link to the PDF while its token lives.
That is bounded by the dashboard's basic auth and `RUN_RETENTION_DAYS`, with
`CAPTURE_DATA=false` as the runner-wide off switch. The file says so at the top
rather than leaving it to be discovered.

### Folders in `workflows/`

Projects now group: `workflows/pblsh/…` loads exactly like a top-level file
(the loader always globbed `**/*.ts`), `LoadedWorkflow.folder` carries the
subdirectory, and the dashboard prints a folder header above each group — only
once there is more than one, so a flat repo looks unchanged.

**Folders are filing, not namespacing.** Workflow names stay global and flat,
because they are URLs, CLI arguments, and `ctx.run()` targets; deriving
`pblsh/send-signed-agreement` from the path would have changed all three and
made a file move a breaking change. The convention is to prefix the name with
the project instead. Nothing else is scoped by directory either — secrets,
state namespaces, and the concurrency cap are all indifferent to where a file
sits, and the only cost of moving one down a level is the import depth.

### Approval gates, without a Wait node

The last n8n gap anyone was likely to hit: a workflow that stops and waits for a
person. `workflows/approval-request.ts` and `workflows/approval-resolve.ts` are
now a runnable pair — one opens an approval in `ctx.state.shared` and hands out
decision links, the other claims it when someone clicks — and README documents
the pattern along with what it is not.

**Decided along the way:**

- **The runner does not learn to suspend, and the durable-engine question stays
  closed.** Holding a run open across a human-paced wait would break graceful
  shutdown, the concurrency cap, and the `timeoutMs` contract at once, and the
  alternative — adopting Temporal or Inngest — now means *replacing*
  `MAX_CONCURRENT_RUNS`, `ctx.run()`, and checkpoint resume rather than filling
  a hole. Two workflows joined by shared state buy most of the value for the
  price of an example file. What they do not buy is one run you can watch: the
  halves have separate run pages, joined only by an id in the result, and the
  README says so rather than implying otherwise.
- **`webhook(..., { secret: false })` is a new, explicit opt-out.** A route a
  person reaches by clicking a link cannot carry `WEBHOOK_SECRET` — the link
  would paste the runner's shared secret into a Slack channel. The rejected
  alternative was leaning on `secret: ""` already being falsy, which works by
  accident and reads like a mistake. Omitting `secret` still falls back to the
  global one, so a public route can only happen on purpose, and the burden it
  shifts onto the workflow (an unguessable single-use id, refused once spent)
  is documented where the flag is.
- **The claim is checkpointed; the payout is a separate step.** Whether a run
  won the claim has to travel back inside the step's result — as a closure
  variable it reads `false` on a retry, and the retry then refuses to finish
  what it just started. Splitting the payout out means a permanent failure is
  recoverable by resuming the run, without the resume re-deciding anything.
- **`onOverlap: "queue"`, not the default `"skip"`.** Skip drops the second of
  two clicks arriving together — including clicks on two unrelated approvals —
  and answers that person with a skipped run instead of a decision.

Found by running it: **a resumed run has no `ctx.input`.** Resume passes the
checkpoint key and nothing else, so the first version looked up
`approval:undefined` and reported a live approval missing. Anything derived
from the input has to be derived inside a step; AGENTS.md now carries that as
an invariant.


### OAuth2 credentials that refresh themselves

Every user-consent integration was blocked: `process.env` is immutable at
runtime and a refresh token *rotates*, so there was nowhere to put the new one.
`ctx.state` removed that obstacle, and `defineOAuth(name, { tokenUrl })` now
sits beside `defineSecrets` — the provider's details in the file, its
credentials in the environment, the rotating half in encrypted state.

**Decided along the way:**

- **OAuth rows are encrypted; the rest of `ctx.state` is not.** This was the
  open question the item was parked on, and the answer is neither of the
  extremes. Encrypting everything costs the documented "open the database file"
  escape hatch for debugging cursors, and buys nothing for a polling cursor.
  Encrypting nothing was defensible when state held cursors, and stops being
  defensible the moment one file holds live tokens for a dozen services. So:
  AES-256-GCM under `OAUTH_ENCRYPTION_KEY` for `@oauth:` keys, WebCrypto, no
  new dependency. Losing the key costs the stored tokens, not access — the next
  call falls back to the seed in the environment, warns once, and carries on.
- **No consent flow, deliberately.** You run the authorization-code flow by
  hand once and paste the refresh token in. The alternative is a callback
  route, session storage, and parked half-finished consent, all for an action
  performed once per credential in the lifetime of an integration.
- **The in-process refresh lock is not optional.** `ctx.state.update()` is
  synchronous by design and cannot wrap an async token refresh, so two
  concurrent runs would both refresh — and most providers kill the old refresh
  token on use, so the second write stores a credential the provider has
  already invalidated. A `Map<name, Promise<Token>>` is sufficient because we
  are single-process by design. Each lock holder re-reads state before spending
  a token, so a caller that queued behind a refresh uses its result rather than
  the token it rotated away. Verified: 20 concurrent callers, one refresh, one
  distinct token, and exactly one live refresh token at the provider.
- **The redactor has to be told about a token it reads back from disk, not
  just one it fetched.** Registering only inside the token exchange looked
  complete and passed the first run. The second run — a fresh process, token
  decrypted from state, no exchange — wrote it unredacted onto the run page.
  Caught by running it, which is the whole reason that rule exists.
- **The refresh window is clamped to half the token's life.** A flat 60s of
  skew means a provider issuing 30-second tokens gets refreshed on every single
  call, which against a rotating provider spends a credential per API request.
- **The environment stays the source of truth for which chain is legitimate.**
  Each stored chain records a hash of the env refresh token it grew from; when
  that stops matching, the operator has deliberately pasted a new one and the
  stored chain is abandoned rather than preferred. Without it, recovering from
  a revoked token would mean hand-editing SQLite.

Verified against a stand-in provider that rotates and invalidates on every use
(no credentials for a real one): cold start under 20-way concurrency, reuse
across a restart with zero refreshes, refresh after expiry using the rotated
token, a hand-pasted replacement seed, both client-authentication styles, a
forced refresh, a lost master key falling back to the environment, boot
refusing to start on a missing or malformed key, and a grep of the database
file for every token, seed, client secret, and the master key itself — zero
hits.

### Webhooks that register themselves with the provider

A webhook was a URL somebody pasted into Stripe or GitHub once and had to
remember. Nothing reconciled a subscription deleted provider-side, and nothing
told you a workflow's hook had stopped existing. A webhook trigger can now
carry a `register` block with `create` and `remove`, and the runner keeps the
subscription in step with what is on disk.

**Decided along the way:**

- **Reconcile at boot; never unregister on shutdown.** The handoff note
  suggested registering at boot and unregistering at shutdown, and that is
  wrong here: a redeploy is a process restart, so every deploy would delete the
  subscription and race to recreate it, losing events in the window — and
  `SIGKILL` skips the cleanup anyway, so the tidy path could never be trusted.
  Comparing against the stored id at boot gets the same outcome with no hole,
  and an unchanged URL costs zero provider calls.
- **Boot never fails on a provider.** Reconciliation runs after the server is
  listening (so a provider that pings its new subscription finds the route
  answering), is never awaited, and leaves state untouched on failure so the
  next start retries. Verified by taking the provider down mid-migration: the
  error was logged, the dashboard came up, the route served, and the next boot
  completed the migration.
- **A deleted workflow file strands its subscription, and we say so.** The
  `remove` function lived in the file, so there is nothing left to call. A
  directory of registered names in shared state makes the orphan visible, and
  it is warned about on every boot with its id — the honest option, where the
  alternative is a provider quietly posting to a 404 forever. Restoring the
  file with `enabled: false` for one boot cleans it up, and that advice is
  verified, not assumed.
- **The stale subscription is removed before its replacement is created**, so a
  changed `PUBLIC_URL` can't leave the provider posting to both.

Verified across eleven real boots against a stand-in provider (no credentials
for a real one): create, redeploy with no change and no provider call, URL
migration, disable, re-enable, provider down, provider back, file deleted,
`PUBLIC_URL` unset, the documented orphan cleanup, and a clean directory
afterwards — exactly one subscription at the provider at every step.

### `ctx.run()` — one workflow calling another

Composition had two bad options: import the other workflow's `run` function
directly and lose its run record, retries, and checkpoints, or POST your own
webhook and deal with the secret. `ctx.run(name, input)` resolves through the
registry, gives the child its own run page, and returns its result.

**Decided along the way:**

- **Everything that can go wrong throws, and is checked before anything
  starts.** A sub-workflow call is the caller asking for a value; returning
  `undefined` because the child was skipped is the kind of silence that shows
  up as a downstream `TypeError` an hour later. Cycles, depth, unknown names,
  disabled workflows, and a busy `onOverlap: "skip"` child all fail loudly, and
  the skip message names the fix (`onOverlap: "queue"`).
- **A child inherits its parent's concurrency slot.** Taking a second one reads
  as more correct and deadlocks the moment every slot holds a parent waiting on
  a child. The parent is blocked anyway, so the process is not doing more work
  at once. Verified with `MAX_CONCURRENT_RUNS=1`, where a nested call would
  otherwise hang forever.
- **Cycle detection is an ancestry chain, not a depth counter alone.** The
  error names the loop (`a → b → a`) instead of reporting a limit, which is the
  difference between a two-second fix and a bisect. A depth limit of 8 stays as
  the backstop for the case ancestry can't see: two separate chains calling
  into each other under `onOverlap: "queue"`.
- **A self-call is refused rather than allowed to queue.** Under
  `onOverlap: "queue"` it deadlocks outright — the child waits for the parent
  that is waiting for the child.
- **`parent_run` is a third lineage column.** `resumed_from` and
  `replayed_from` both mean "this run derives from that one"; this one means
  "that run called this one". Composition, not derivation.
- **The parent's signal is chained into the child**, so a parent timeout
  doesn't leave orphans running past it. Verified: an 800ms parent cut off a
  child that would have slept 10s, at 803ms.

Verified across 30 generated workflows: result passing, failure propagation and
catching, self-cycle, indirect cycle, the depth limit, unknown and disabled
targets, a busy skip-child, a busy queue-child (parent waited 1.4s for its
turn), nested calls under a cap of 1, timeout propagation, both run pages, and
the same path through `bun run trigger`.

### Replay a run with its original input

Developing a webhook workflow meant re-sending the payload by hand after every
change, because the `runs` table recorded everything about a run *except* what
went into it. Runs now store their trigger input, and any run that has one gets
a *Replay with this input* button plus `POST /api/runs/:id/replay`.

**Decided along the way:**

- **Replay and resume stay separate, including their lineage columns.** Resume
  reuses the parent's checkpoint key and skips completed steps; replay takes a
  fresh key and redoes everything. Reusing `resumed_from` for both — one column,
  distinguishable by whether the checkpoint key matches — would have worked and
  would have left the run page inferring which operation it was rendering. A
  `replayed_from` column costs one `ALTER TABLE` and says it outright.
- **The input obeys capture rules, not checkpoint rules.** Step outputs are
  stored with `force` because resume is functional and needs them. Input could
  have been argued the same way, but `CAPTURE_DATA=false` is somebody switching
  off payload storage on purpose, and quietly storing payloads anyway is not a
  choice to make on their behalf. Those runs are simply not replayable, and the
  endpoint says so.
- **Every refusal names its cause.** No recorded input, an input truncated past
  `CAPTURE_MAX_BYTES`, a workflow that no longer exists — each returns 409 with
  the reason. The tempting alternative, replaying with `{}` or with the
  truncated preview, produces a run that looks like it worked.
- **The stored input is the redacted copy**, like everything else that reaches
  disk. A payload carrying a credential replays with `«redacted»` in its place.
  That is the storage invariant holding, and it is documented rather than
  worked around — the alternative is credentials in a database column that the
  dashboard renders.

Migration is the existing `ALTER TABLE` pattern, so old databases pick up the
columns on boot; runs recorded before today have no input and say so.

Verified on a database created before the change: columns added at boot, a
webhook run's input recorded and replayed to an identical result with fresh
checkpoints, the input-less run and the truncated-input run each refused with
their own message, and a secret planted in the webhook body appearing zero
times across the API, both run pages, the dashboard, stdout, and the SQLite
file — while the input itself is stored and shown, redacted.

### `MAX_CONCURRENT_RUNS` — a ceiling across workflows, not just within one

`onOverlap` bounded a workflow against itself and nothing bounded the process.
Fifty webhooks arriving together meant fifty runs at once in one Bun process,
each holding sockets, memory, and a share of the event loop — the failure mode
being a burst that degrades everything else rather than queueing politely.
n8n's answer was queue mode with worker pools; ours is a counting semaphore
around `execute()`, default 10, `0` for the old unbounded behaviour.

**Decided along the way:**

- **Queue, never reject.** A dropped webhook is worse than a slow one, and most
  providers won't redeliver a 200. Runs past the cap wait their turn.
- **A queued run counts as active.** `onOverlap: "skip"` is checked against a
  set the workflow joins *before* it waits for a slot. Marking it after — the
  obvious placement — would let a burst of the same webhook slip past `skip`
  entirely while the first one sat in the queue. Verified: with one slot and
  two concurrent hits of the same workflow, the second is still skipped.
- **Shutdown skips the queue instead of draining it.** A run that hasn't
  started when `SIGTERM` arrives gets a `skipped` run record with the reason,
  so the work is visibly dropped rather than invisibly dropped. The shutdown
  loop stays alive until each one has recorded itself, which takes as long as
  the in-flight runs and no longer.
- **The slot is handed to the next waiter, not released into contention.**
  FIFO, and no wake-everyone stampede on each completion.
- **`/healthz` reports `running` and `queued`.** A cap you can't see turns a
  queue that never drains into a runner that merely looks quiet.

Verified with 50 workflows and 50 concurrent webhook POSTs: max observed
concurrency exactly 4 under a cap of 4, all 50 runs recorded and successful,
5.2s wall clock against the 5.0s the cap implies; 50 concurrent under `0`; and
a `SIGTERM` mid-burst leaving 12 successes, 38 skipped-with-reason, and a
prompt exit.

### `ctx.http.paginate()` — the one API quirk we were still hand-rolling

The part of n8n's "400 nodes" that wasn't UI was pre-solved API quirks, and
`src/integrations/http.ts` already covered the biggest slice — retries, 429 and
`Retry-After`, backoff with jitter. Pagination was what was left, rewritten by
hand for every API and got subtly wrong each time.

```ts
for await (const issue of ctx.http.paginate<Issue>(url, { query: { per_page: 100 } })) …
const all = await ctx.http.paginate<Issue>(url).all();
```

Covers the three shapes that account for nearly everything: `Link: rel="next"`
headers, a cursor token in the body, and page/offset counters. Each page is an
ordinary request, so retries, `ctx.signal`, and run-page capture all still apply.

**Decided along the way:**

- **It throws instead of returning a short answer.** Hitting the `maxPages`
  ceiling, revisiting a URL already fetched, or finding a cursor token with no
  parameter name given are all misconfigurations, and the rejected alternative —
  return what we have — produces a partial result indistinguishable from a
  complete one. That is the bug you find weeks later in a report with missing
  rows. Only the honest endings are quiet: empty page, no next link, `maxItems`.
- **Auto-detection stops where the response stops being unambiguous.** A `Link`
  header or a body field holding an actual URL is self-describing. An opaque
  token is not — nothing in `{"next_cursor":"dXNlcjox"}` says the parameter is
  called `cursor` — so guessing a name from the field would work on Slack and
  silently truncate elsewhere. Cursors and counters are configured explicitly.
- **An `items` path that misses on page one throws; on a later page it doesn't.**
  A wrong path otherwise yields zero items and reads as an empty collection.
  Missing on a later page is just how a last page often looks.
- **Iterator first, `.all()` second.** The iterator holds one page in memory,
  which is what makes it safe to point at something large; `.all()` and
  `.pages()` are there because most workflows genuinely want the array.

`workflows/paginate-demo.ts` is a `manual()` example against GitHub's public
API — no credentials, and its run page shows one recorded HTTP call per page.

### `poll()` trigger — schedule + dedupe, no empty runs

Closes the second of the two gaps that `ctx.state` unblocked. A large share of
real automation is "check this source on a schedule and act only on what's new",
and the only way to express it before was a `cron()` that re-ran a run every
interval and filtered by hand — with nowhere to keep the cursor.

```ts
trigger: poll("*/5 * * * *", {
  fetch: (ctx) => ctx.http.get("https://api.example.com/issues"),
  id: (issue) => issue.id,
})
```

`ctx.input` is the array of items never seen before. `poll` and `cron` share the
scheduler loop; they differ only in what firing does.

**Decided along the way:**

- **A quiet tick creates no run record.** The alternative — a run that returns
  `{ new: 0 }` — buries the dashboard under 288 empty runs a day on a
  five-minute poll, which makes run history useless for spotting real activity.
  The cost is that "did it poll?" is a log line, not a run; a `fetch` that
  *throws* still gets a failed run so failures are never silent.
- **Marked seen only after the run succeeds.** Marking up front is simpler and
  wrong: a failed run would drop its items permanently. At-least-once means a
  persistently failing workflow re-delivers every tick, which is noisy but
  recoverable, and `ALERT_WEBHOOK_URL` already covers the noise.
- **First poll baselines instead of firing.** Pointing a new workflow at a feed
  of 500 open issues should not send 500 messages. `firstRun: "emit"` opts out.
- **The remember-window widens to fit one page.** A fetch returning more items
  than `remember` would otherwise push its own items out of the set and
  re-deliver them forever — a silent infinite loop. The window never drops below
  one page, and the cap is warned about rather than enforced destructively.
- **`fetch` gets no `ctx.step`.** It runs outside a run, so there is nothing to
  attach steps or captured HTTP calls to. Keeping `fetch` to "return the current
  list" and the work in `run()` is what keeps the work observable.
- **One run per batch, not per item.** Per-item runs would collide with the
  default `onOverlap: "skip"` and need serialising. Looping in `run()` with
  `ctx.step(\`item ${id}\`)` already gives per-item checkpointing, which is the
  documented idiom here.

Rejected: auto-registering webhooks with providers (Stripe/GitHub push
subscriptions). Different problem, much larger surface, and polling covers the
sources that have no push at all.

### `ctx.state` — durable key/value store

Workflows had nowhere to remember anything between runs. The database held only
`runs`, `logs`, `steps`, and `calls`, and checkpoints expire by design, so a
polling cursor, a rotating OAuth refresh token, or a correlation id for a
handoff between two workflows had no home. This is the gap that made "poll an
API and emit only what's new" impossible to express.

Added `ctx.state` with `get` / `set` / `update` / `delete` / `keys`, namespaced
per workflow, plus `ctx.state.shared` for cross-workflow handoffs.

**Decided along the way:**

- **State is stored unredacted.** Everything else written to SQLite goes through
  the secret filter, because it is observational — nobody reads a log line back
  and acts on it. State is operational: a rotating refresh token has to come
  back byte-identical, so redacting on write would destroy the value rather than
  protect it. The invariant is preserved instead by never rendering state
  anywhere — no dashboard view, no API route, no log line. **Do not add a state
  viewer.** Rejected alternative: encrypt at rest with a master key from the
  environment, which is the right answer if state ever needs to be displayed.
- **`set` throws instead of degrading.** `capture()` stores a placeholder for
  values it can't serialise, which is correct for a preview. For data a workflow
  reads back and acts on, a silent placeholder is a bug you find much later, so
  `undefined`, functions, bigints, circular structures, and oversized values all
  throw with the key named.
- **`update()` over get-then-set.** Get-then-set is two awaits with a gap, and
  concurrent runs interleave in that gap. `update()` completes its
  read-modify-write in one synchronous tick. Measured under 100-way concurrency:
  `update()` counted 100, get-then-set counted 1.
- **Marked seen only after success** is the rule adopted for anything built on
  top of this (see the polling trigger), giving at-least-once delivery.

No migration needed — the table is created on boot. Expired keys vanish from
reads immediately and are swept by the nightly prune, which now runs even when
`RUN_RETENTION_DAYS` is 0.

### Fixed: `bun run trigger` never worked

The `--run` branch called `shutdown()` above the `let` declarations it depends
on, so every CLI run died with `ReferenceError: Cannot access 'shuttingDown'
before initialization` and exited non-zero regardless of the workflow's actual
result. Unrelated to the above; found while verifying it through the documented
path.
