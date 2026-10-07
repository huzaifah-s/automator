# 01 · Push her latest playbook

**Goal:** Maria runs the rules written on 7 Oct, not the ones from before
them.

**Why:** The last three playbook commits never reached GitHub. The push hit
a GitHub 500, and the retry was blocked. The routine clones GitHub on every
run, so since then she has had the new server tools but her old
instructions. That means she has none of these yet:

- "only act on messages meant for him"
- the phone formatting
- the `digest` tool
- trashing her own wrong tasks
- questions that expire

Automator `909b084` (the server side) is already deployed, so the deploy
order is fine. The playbook is the only piece missing.

**Repo:** `../maria-personal-assistant` only. Read the rules in
[README.md](README.md) first.

## Steps

1. Check what's waiting:
   ```bash
   git -C ../maria-personal-assistant status -sb
   git -C ../maria-personal-assistant log origin/main..HEAD --oneline
   ```
   Expect `ahead 3` and three commits:
   - "Only act on messages meant for him…"
   - "Write for his phone…"
   - "Expired questions and the weekly lessons card"

   If there's anything else, or fewer, stop and tell the user.
2. Confirm the deployed automator is at or after `909b084`: run the coolify
   MCP `list_deployments` for the automator app. If it isn't, deploy
   automator first (ask the user).
3. **Ask the user**, then `git -C ../maria-personal-assistant push`.
4. Clean up what the old playbook left behind, through the `assistant` MCP:
   - `drafts status=revise`: a 7 Oct draft that replied to a group message
     meant for a teammate. Take it back with `withdraw_draft` and a one-line
     reason.
   - `questions status=open`: any "Who is *Hidden number (WhatsApp)*?"
     question with nothing he could recognise him by. Close it with
     `close_question`.
5. Wait for one run. It starts at the top of the hour, or he can send Maria a
   note to start one early.

## Done when

- `status -sb` shows `main...origin/main` with nothing ahead.
- The next message Maria sends him is laid out with headings, bullets and
  bold. That's the cheapest proof the new playbook is live, so ask him.
- The newest `run_log` row (on the dashboard's Tables tab) is newer than the
  push.
