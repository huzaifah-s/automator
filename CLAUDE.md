# CLAUDE.md

This project's agent instructions live in [AGENTS.md](AGENTS.md) — read that
file before making changes. It covers the layout, how to add a workflow, the
invariants that have already caused bugs, and how to verify work.

Human-facing documentation is in [README.md](README.md).

## Quick reminders

- `bun run check` (tsc) and `bun run test` must pass before you finish. The
  tests only cover webhook payload shapes, so still verify by actually running
  the server and exercising the path.
- Changed a webhook's schema or filter? Add a sample payload under its
  `__fixtures__/` folder — made-up values only (AGENTS.md, "Webhook samples").
- Workflow files import only from `src/core/define.ts` — re-export new public
  helpers there.
- Nothing that reaches SQLite or stdout may contain a raw credential.
