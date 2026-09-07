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

if printf '%s\n' "$changed" | grep -Eq "$RUNTIME_PATHS"; then
  blocking=$(printf '%s\n' "$changed" | grep -E "$RUNTIME_PATHS" | sed 's/^/  /')
  echo "not pulling: $target changes code the running container cannot re-read —"
  printf '%s\n' "$blocking"
  echo "deploy it instead."
  # The short sha is in the message on purpose: it makes each waiting commit its
  # own alert, so a second push while the first is still undeployed is heard,
  # and the alert cooldown still collapses the per-minute repeats of one.
  notify "$(printf 'A deploy is waiting — %s changes code the running container cannot reload:\n%s\n\nDeploy it in Coolify.' "$(git rev-parse --short "$target")" "$blocking")"
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
