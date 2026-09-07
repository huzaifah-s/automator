#!/usr/bin/env sh
#
# Applies a workflow-only change to a running deployment, with no redeploy and
# no restart.
#
# The container reads workflows/ from a read-only bind mount of this checkout
# and reloads a changed file on its own (see "Changing a workflow without a
# restart" in README.md). So getting a push live is just: fast-forward the
# checkout. That has to happen on the host — the mount is read-only and the
# image has no git — which is why this is a shell script and not a workflow.
#
# Run it from cron on the server:
#
#   * * * * * /path/to/checkout/scripts/pull-workflows.sh >> /var/log/pull-workflows.log 2>&1
#
# On Coolify, run it from a *separate clean clone* and point AUTOMATOR_LIVE_DIR
# at the deployed checkout:
#
#   * * * * * AUTOMATOR_LIVE_DIR=/data/coolify/applications/<uuid> \
#     /opt/automator-sync/scripts/pull-workflows.sh >> /var/log/pull-workflows.log 2>&1
#
# The separation is forced, not tidiness. Coolify rewrites tracked files in the
# directory it deploys from — it injects ARG lines into the Dockerfile and
# rebuilds docker-compose.yml — so that checkout is permanently dirty and no
# git operation there is safe. With AUTOMATOR_LIVE_DIR set, git only ever runs
# in the clean clone and the deployed directory is touched in exactly one way:
# workflows/ is copied into it. Coolify does not modify workflows/, so nothing
# collides.
#
# and turn Coolify's automatic deploy off, or the two race: a push would start
# a redeploy (a restart) and this pull at the same time. Pick one. With auto
# deploy off, a push carrying only workflow changes goes live within a minute
# without a restart, and anything else waits for a deploy you trigger.
#
# Exit codes: 0 nothing to do or applied, 1 refused (needs a real deploy),
# 2 the checkout is not in a state this can safely touch.

set -eu

cd "$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"

# Where the running container reads workflows/ from, when that is not this
# checkout. Unset means the two are the same directory, which is the plain
# Compose deployment and the simpler case.
# This file, relative to the checkout — so the staleness check below can ask
# git about the script that is actually running.
SELF=$(cd -- "$(dirname -- "$0")" && pwd)/$(basename -- "$0")
SELF=${SELF#"$PWD"/}

LIVE_DIR=${AUTOMATOR_LIVE_DIR:-}
if [ -n "$LIVE_DIR" ] && [ ! -d "$LIVE_DIR/workflows" ]; then
  echo "refusing: AUTOMATOR_LIVE_DIR=$LIVE_DIR has no workflows/ directory"
  exit 2
fi

# Copies workflows/ into the deployed checkout. Every run, not only after a
# pull: rsync writes nothing when the files already match, so it costs nothing
# and it repairs the case where a Coolify deploy reset the directory underneath
# us. --delete because a workflow deleted upstream has to disappear here too,
# and workflows/ holds nothing Coolify put there.
sync_live() {
  [ -n "$LIVE_DIR" ] || return 0
  rsync -a --delete workflows/ "$LIVE_DIR/workflows/"
}

# How to recognise the running container. Coolify appends a per-deployment
# suffix, so the name changes every deploy and cannot be pinned.
CONTAINER_MATCH=${AUTOMATOR_CONTAINER:-^automator[-_]}

# Says something on the alert channel — Telegram, Slack, wherever ALERT_CHANNEL
# points. Through the container on purpose: it already holds the token, and the
# host has no business holding a second copy of it.
#
# `docker exec` on a container found by name, not `docker compose exec`. Compose
# resolves a project from the working directory, and once AUTOMATOR_LIVE_DIR is
# in play the working directory is the clean clone — which has a compose file
# and no containers, so every alert failed silently against a project that was
# never running.
#
# A failure is still not fatal: this is a notification about a cron job whose
# real work has already been decided, and a Telegram outage must not turn "there
# is a deploy waiting" into "the pull script is broken". But it is no longer
# *silent* — swallowing the error with no trace is exactly what hid the bug
# above, and a log line is the difference between a broken alert you find in a
# minute and one you find when it fails to warn you about something real.
notify() {
  container=$(docker ps --format '{{.Names}}' 2>/dev/null | grep -m1 -E "$CONTAINER_MATCH" || true)
  if [ -z "$container" ]; then
    echo "  (could not alert: no running container matches $CONTAINER_MATCH)"
    return 0
  fi
  if ! docker exec -i "$container" bun src/index.ts --alert "$1" >/dev/null 2>&1; then
    echo "  (could not alert through $container)"
  fi
}

# Paths whose contents the running container does *not* re-read. A change to
# any of them is baked into the image, so pulling it would leave the checkout
# claiming to be something the container is not — and the next person to read
# `git log` on the server would be reading a version that is not deployed.
#
# Everything else is either workflows/ (hot-reloaded) or documentation (inert).
# The list is what runs, rather than "anything outside workflows/", because
# nearly every commit here also touches CHANGELOG.md — blocking on that would
# block almost every push.
RUNTIME_PATHS='^(src/|package\.json|bun\.lock|Dockerfile|docker-compose\.yml|compose\.local\.yml|tsconfig\.json)'

# Files in the deployed directory whose contents say nothing about which commit
# was deployed. workflows/ is copied in by sync_live above, from *this*
# checkout, so it always reads as whatever HEAD is here. Coolify rewrites the
# other three in the directory it deploys from: ARG lines injected into the
# Dockerfile, docker-compose.yml rebuilt, README.md overwritten with a
# deployment note.
UNSPOKEN_FOR='^(workflows/|Dockerfile$|docker-compose\.yml$|README\.md$)'

# Whether the deploy this run is about to ask for has already happened.
#
# Without this the answer was assumed to be no, forever. HEAD here only moves
# when this script fast-forwards, and it refuses to on a runtime change — so
# after the deploy it asks for, nothing advances this checkout and every run
# for the rest of time re-decides that the same deploy is still waiting. The
# cooldown collapses the per-minute repeats into one message every half hour,
# which is worse than the flood would have been: the alert that means "go and
# deploy" kept arriving, unchanged, at a person who already had.
#
# Coolify's checkout is the commit it last deployed, so those files are the
# answer. Reading them is not a git operation in the directory where no git
# operation is safe — the hashing runs here, against a path over there.
#
# It judges by every changed file it can trust rather than by the blocking ones
# alone, so a commit that changes only a file Coolify rewrites is still
# answerable as long as it carries anything else (a CHANGELOG entry, usually).
# With nothing trustworthy in the diff the honest answer is "cannot tell", and
# that alerts — a deploy wrongly asked for costs a message, one wrongly assumed
# done costs the deploy.
already_deployed() {
  [ -n "$LIVE_DIR" ] || return 1
  # The question is whether the files that *block* are live, not whether every
  # file in the gap is. A documentation commit landing between a runtime push
  # and its deploy changes CHANGELOG.md without changing anything the container
  # runs; counting it as a witness answers "not deployed" about code that is.
  witnesses=$(printf '%s\n' "$blocking" | grep -Ev "$UNSPOKEN_FOR" || true)
  # Every blocking file is one Coolify rewrites — a Dockerfile-only change. The
  # blocking files cannot answer for themselves, so fall back to the rest of the
  # diff, which at least says which commit is deployed. This is the case the
  # whole-diff rule was written for, and the only one it was right about.
  if [ -z "$witnesses" ]; then
    witnesses=$(printf '%s\n' "$changed" | grep -Ev "$UNSPOKEN_FOR" || true)
  fi
  [ -n "$witnesses" ] || return 1
  printf '%s\n' "$witnesses" | while IFS= read -r path; do
    want=$(git rev-parse --quiet --verify "$target:$path" 2>/dev/null || true)
    if [ -z "$want" ]; then
      # Deleted by $target, so a deployed tree does not have it either.
      [ ! -e "$LIVE_DIR/$path" ] || exit 1
      continue
    fi
    [ -f "$LIVE_DIR/$path" ] || exit 1
    got=$(git hash-object --no-filters -- "$LIVE_DIR/$path" 2>/dev/null || true)
    [ "$got" = "$want" ] || exit 1
  done
}

branch=$(git rev-parse --abbrev-ref HEAD)
if [ "$branch" = "HEAD" ]; then
  echo "refusing: detached HEAD — this checkout is pinned to a commit, not following a branch"
  exit 2
fi

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "refusing: the checkout has uncommitted changes — fast-forwarding would fight them"
  exit 2
fi

# Before anything is decided about pulling. Whatever is checked out here is
# what the container is meant to be running, and every exit below — a refusal,
# an unreachable remote, nothing to do — has to leave that true. Syncing only
# after a successful pull meant a Coolify deploy that reset the live directory
# stayed reset until the next workflow change, which on a pending src/ refusal
# could be days.
sync_live

# Retried, and a total failure is a silent exit rather than an error.
#
# Reaching GitHub is the one part of this that is somebody else's network, and
# it does not have to work on the first try — the next run is sixty seconds
# away, and a fetch that fails now and succeeds then has cost nothing. Treating
# it as a fault would mean a log full of failures on a lossy link, and a person
# learning to ignore the log this script writes to.
#
# The important half is that a failed fetch must never reach the code below: the
# comparison would then be against a stale origin/$branch and could conclude
# there is nothing to do.
fetched=0
for attempt in 1 2 3; do
  if git fetch --quiet origin "$branch" 2>/dev/null; then
    fetched=1
    break
  fi
  [ "$attempt" -lt 3 ] && sleep 5
done
if [ "$fetched" -eq 0 ]; then
  exit 0
fi

target="origin/$branch"
if [ "$(git rev-parse HEAD)" = "$(git rev-parse "$target")" ]; then
  exit 0
fi

# Not a fast-forward means somebody committed on the server, or the branch was
# rewritten. Either way this is not the script's business.
if ! git merge-base --is-ancestor HEAD "$target"; then
  echo "refusing: $target is not ahead of HEAD — resolve it by hand"
  exit 2
fi

changed=$(git diff --name-only HEAD "$target")

blocking=$(printf '%s\n' "$changed" | grep -E "$RUNTIME_PATHS" || true)

if [ -n "$blocking" ]; then
  if already_deployed; then
    # The deploy happened; only this checkout was left behind. Catching up is
    # what makes the refusal above true again — HEAD is once more the commit
    # the container is running, and the next runtime change is measured from
    # there rather than from a commit that went live hours ago.
    git merge --ff-only --quiet "$target"
    sync_live
    echo "caught up to $(git rev-parse --short HEAD) — its runtime changes are already deployed"
    exit 0
  fi
  listed=$(printf '%s\n' "$blocking" | sed 's/^/  /')

  # The refusal is the one path that cannot repair itself: it is reached by
  # deciding not to fast-forward, and fast-forwarding is what would install a
  # newer version of this file. So a stale script refusing is a stale script
  # refusing forever, and the only exit is a person running the merge by hand.
  # `d87fe11` was a fix for exactly this failure and could not reach the machine
  # that needed it, because the script it fixed was the one refusing to pull it.
  # Saying it out loud costs one git call and turns six hours into one minute.
  stale_note=""
  if ! git diff --quiet HEAD "$target" -- "$SELF" 2>/dev/null; then
    stale_note=$(printf '\n\nNOTE: this script is older than %s and may be judging this wrongly. It cannot update itself from here — fast-forward by hand:\n  git -C %s merge --ff-only %s' "$target" "$PWD" "$target")
  fi
  echo "not pulling: $target changes code the running container cannot re-read —"
  printf '%s\n' "$listed"
  echo "deploy it instead."
  [ -n "$stale_note" ] &&
    echo "  (and this script is itself behind $target — fast-forward $PWD by hand)"
  # The short sha is in the message on purpose: it makes each waiting commit its
  # own alert, so a second push while the first is still undeployed is heard,
  # and the alert cooldown still collapses the per-minute repeats of one.
  notify "$(printf 'A deploy is waiting — %s is the tip; these files need one:\n%s\n\nDeploy it in Coolify.%s' "$(git rev-parse --short "$target")" "$listed" "$stale_note")"
  exit 1
fi

if ! printf '%s\n' "$changed" | grep -q '^workflows/'; then
  # Documentation only. Nothing for the container to notice, but the checkout
  # may as well be current — reading a stale README on the server is its own
  # small trap.
  git merge --ff-only --quiet "$target"
  sync_live
  exit 0
fi

git merge --ff-only --quiet "$target"
sync_live
echo "pulled $(git rev-parse --short "$target") — workflow files changed:"
printf '%s\n' "$changed" | grep '^workflows/' | sed 's/^/  /'
echo "the runner reloads them on its own; check its log for the swap."
