#!/usr/bin/env bash
# Dispatch a prompt to an already-spawned Herdr agent, in the background, verifiably.
#
# Why this exists. `herdr agent prompt` without `--wait` returns immediately and the
# submission is not reliably delivered — twice here an agent sat at 0.0% context with no
# prompt while the caller believed it was working. But `--wait` blocks until the agent
# settles, which serialises a parallel fleet.
#
# So: run `--wait` in the background (one process per agent) and *verify* delivery by
# polling the agent's own state. Delivery is confirmed by the agent leaving `idle`, not by
# the exit code of a fire-and-forget call.
#
# Usage: dispatch-worker.sh <agent-name> <prompt-file> [timeout-ms]
# Prints: {"agent":..,"delivered":true|false,"log":..}
set -euo pipefail

NAME=${1:?agent name required}
PROMPT_FILE=${2:?prompt file required}
TIMEOUT=${3:-3600000}
LOG=/tmp/dispatch-${NAME}.log

[ -f "$PROMPT_FILE" ] || { echo "prompt file not found: $PROMPT_FILE" >&2; exit 2; }

submit() {
  # Background the blocking call so several agents can run at once.
  nohup herdr agent prompt "$NAME" "$(cat "$PROMPT_FILE")" \
    --wait --timeout "$TIMEOUT" >"$LOG" 2>&1 &
  # Confirm the agent actually picked it up: it must leave `idle` within ~40s.
  for _ in $(seq 1 20); do
    sleep 2
    st=$(herdr agent list 2>/dev/null \
         | jq -r --arg n "$NAME" '.result.agents[]|select(.name==$n)|.agent_status')
    case "$st" in working|blocked|done) return 0 ;; esac
  done
  return 1
}

# `agent_prompt_stalled` (no observed state change within 5 s) is transient and has been
# seen on a freshly started agent that was still settling. One retry clears it; a second
# failure is real and must be surfaced rather than silently leaving an idle agent that the
# caller believes is working.
delivered=false
if submit; then delivered=true; else sleep 5; submit && delivered=true; fi

printf '{"agent":"%s","delivered":%s,"log":"%s"}\n' "$NAME" "$delivered" "$LOG"
[ "$delivered" = true ] || exit 1
