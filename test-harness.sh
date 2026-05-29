#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────
# Detour Agent — Comprehensive Test Harness
#
# Usage:
#   export DETOUR_EVAL_TOKEN="your-token-here"
#   ./test-harness.sh [phase]
#
# Phases: all, health, actions, smoke, prompt, pensieve, earn,
#         printing-press, overwatch, eval, goals, cron, integration
# ──────────────────────────────────────────────────────────────────
set -euo pipefail

PORT="${DETOUR_PORT:-2138}"
BASE="http://127.0.0.1:${PORT}"
TOKEN="${DETOUR_EVAL_TOKEN:-}"
RESULTS_DIR="${HOME}/.detour/eval-results/$(date -u +%Y%m%d-%H%M%S)"
PHASE="${1:-all}"

# ── Colors ─────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

pass=0
fail=0
skip=0

log()  { echo -e "${CYAN}[TEST]${NC} $*"; }
ok()   { echo -e "${GREEN}  ✅ PASS${NC} $*"; ((pass++)); }
fail() { echo -e "${RED}  ❌ FAIL${NC} $*"; ((fail++)); }
warn() { echo -e "${YELLOW}  ⚠️  SKIP${NC} $*"; ((skip++)); }
hdr()  { echo -e "\n${BOLD}═══════════════════════════════════════${NC}"; echo -e "${BOLD}  Phase: $*${NC}"; echo -e "${BOLD}═══════════════════════════════════════${NC}"; }

# ── Helpers ────────────────────────────────────────────
mkdir -p "$RESULTS_DIR"

api() {
  local method="$1" path="$2" label="$3"
  shift 3
  local outfile="$RESULTS_DIR/$(echo "$label" | tr ' /' '__').json"
  local http_code
  http_code=$(curl -s -o "$outfile" -w '%{http_code}' \
    -X "$method" \
    -H "X-Detour-Eval-Token: $TOKEN" \
    -H "Content-Type: application/json" \
    "$@" \
    "${BASE}${path}" 2>/dev/null || echo "000")

  if [[ "$http_code" == "200" ]]; then
    local is_ok
    is_ok=$(jq -r '.ok // empty' "$outfile" 2>/dev/null || echo "")
    if [[ "$is_ok" == "true" ]]; then
      ok "$label (${http_code})"
    else
      fail "$label (${http_code}, ok!=true)"
    fi
  elif [[ "$http_code" == "000" ]]; then
    fail "$label (connection refused — agent not running?)"
  else
    fail "$label (HTTP ${http_code})"
  fi
  # Print response summary
  if [[ -f "$outfile" ]]; then
    jq -c '.' "$outfile" 2>/dev/null | head -c 200 || true
    echo
  fi
  echo "$http_code" > "$outfile.status"
}

action() {
  local name="$1" label="$2" options="${3:-{}}"
  api POST "/api/eval/action/run" "$label" -d "{\"name\":\"$name\",\"options\":$options}"
}

prompt() {
  local text="$1" label="$2" timeout="${3:-90000}"
  api POST "/api/eval/send" "$label" -d "{\"text\":$(echo "$text" | jq -Rs .),\"source\":\"eval-test\",\"callerId\":\"test-harness\",\"timeoutMs\":$timeout}"
}

# ── Prereq check ───────────────────────────────────────
if [[ -z "$TOKEN" ]]; then
  echo -e "${RED}ERROR: DETOUR_EVAL_TOKEN is not set.${NC}"
  echo "  Run: export DETOUR_EVAL_TOKEN=detour-eval-test-2026"
  exit 1
fi

echo -e "${BOLD}Detour Agent Test Harness${NC}"
echo "  Port:    $PORT"
echo "  Token:   ${TOKEN:0:4}****"
echo "  Results: $RESULTS_DIR"
echo "  Phase:   $PHASE"

# ── Phase 1: Health ────────────────────────────────────
run_health() {
  hdr "1 — Health & Connectivity"

  log "Basic health ping..."
  local health_code
  health_code=$(curl -s -o "$RESULTS_DIR/health.json" -w '%{http_code}' \
    "${BASE}/api/health" 2>/dev/null || echo "000")
  if [[ "$health_code" == "200" ]]; then
    ok "GET /api/health ($health_code)"
  else
    fail "GET /api/health ($health_code) — is the agent running?"
    echo -e "${RED}Cannot proceed without a running agent. Start Detour first.${NC}"
    return 1
  fi

  log "Eval API health..."
  api GET "/api/eval/health" "eval-health"

  log "Checking runtime..."
  local provider
  provider=$(jq -r '.activeProvider // "none"' "$RESULTS_DIR/eval-health.json" 2>/dev/null || echo "unknown")
  local agent_name
  agent_name=$(jq -r '.agentName // "unknown"' "$RESULTS_DIR/eval-health.json" 2>/dev/null || echo "unknown")
  echo "  Provider: $provider"
  echo "  Agent:    $agent_name"
}

# ── Phase 2: Actions ───────────────────────────────────
run_actions() {
  hdr "2 — Registered Actions"

  log "Listing all registered actions..."
  api GET "/api/eval/actions" "list-actions"

  local count
  count=$(jq -r '.count // 0' "$RESULTS_DIR/list-actions.json" 2>/dev/null || echo "0")
  echo "  Total actions registered: $count"

  # Check for our critical actions
  local expected_actions=(
    "EVAL_PERSIST" "EVAL_GRADE" "EVAL_HISTORY"
    "OVERWATCH_TRAJECTORIES" "OVERWATCH_TRAJECTORY_DETAIL" "OVERWATCH_RUNTIME"
    "OVERWATCH_TEST_PROMPT" "OVERWATCH_ACTION_STATS"
    "PENSIEVE_WRITE" "PENSIEVE_READ" "PENSIEVE_LIST" "PENSIEVE_SEARCH"
    "SUPERTEAM_EARN_SCAN"
    "PRINTING_PRESS_INSTALLED"
  )

  for action_name in "${expected_actions[@]}"; do
    local found
    found=$(jq -r --arg n "$action_name" '.actions[]? | select(.name == $n) | .name' \
      "$RESULTS_DIR/list-actions.json" 2>/dev/null || echo "")
    if [[ "$found" == "$action_name" ]]; then
      ok "Action registered: $action_name"
    else
      fail "Action MISSING: $action_name"
    fi
  done
}

# ── Phase 3: Smoke Tests ──────────────────────────────
run_smoke() {
  hdr "3 — Action Smoke Tests"

  log "OVERWATCH_RUNTIME..."
  action "OVERWATCH_RUNTIME" "overwatch-runtime"

  log "OVERWATCH_TRAJECTORIES..."
  action "OVERWATCH_TRAJECTORIES" "overwatch-trajectories" '{"parameters":{"limit":5}}'

  log "OVERWATCH_ACTION_STATS..."
  action "OVERWATCH_ACTION_STATS" "overwatch-action-stats" '{"parameters":{"limit":10}}'

  log "PENSIEVE_LIST..."
  action "PENSIEVE_LIST" "pensieve-list" '{"parameters":{"path":"/"}}'

  log "PRINTING_PRESS_INSTALLED..."
  action "PRINTING_PRESS_INSTALLED" "pp-installed"

  log "EVAL_PERSIST (test write)..."
  action "EVAL_PERSIST" "eval-persist-test" \
    "{\"parameters\":{\"path\":\"/test/smoke-$(date +%s)\",\"data\":{\"test\":true,\"ts\":\"$(date -u +%FT%TZ)\"},\"type\":\"benchmark\"}}"

  log "EVAL_GRADE (test grade)..."
  action "EVAL_GRADE" "eval-grade-test" \
    '{"parameters":{"job":"smoke-test","grade":"B","scores":{"accuracy":80,"completeness":75,"insightDepth":60,"actionQuality":85,"overall":75},"corrections":["test correction"],"additions":[],"recommendations":["test recommendation"],"trend":"stable"}}'
}

# ── Phase 4: Prompt-Response ──────────────────────────
run_prompt() {
  hdr "4 — Prompt-Response Flow"

  log "Sending test prompt..."
  prompt "What is your name and what model are you running on? Keep it brief — one sentence." "basic-prompt"

  log "Checking trajectory was created..."
  api GET "/api/eval/trajectories?limit=1" "latest-trajectory"

  local traj_id
  traj_id=$(jq -r '.trajectories[0]?.id // empty' "$RESULTS_DIR/latest-trajectory.json" 2>/dev/null || echo "")
  if [[ -n "$traj_id" ]]; then
    log "Inspecting trajectory $traj_id..."
    api GET "/api/eval/trajectory/${traj_id}/simple" "trajectory-detail"
    ok "Trajectory created and inspectable"
  else
    warn "No trajectory found (may not have been recorded yet)"
  fi
}

# ── Phase 5: Pensieve ─────────────────────────────────
run_pensieve() {
  hdr "5 — Pensieve Memory System"

  log "Testing write → read cycle via prompt..."
  prompt "Use PENSIEVE_WRITE to save: path=/test/eval-harness, text='Test memory from eval harness at $(date -u +%FT%TZ)'. Then use PENSIEVE_READ at /test/eval-harness and confirm the content." \
    "pensieve-write-read" 60000

  log "Listing memories via API..."
  api GET "/api/eval/memories?limit=5" "memories-list"

  log "Listing entities via API..."
  api GET "/api/eval/entities?limit=5" "entities-list"
}

# ── Phase 6: Earn ──────────────────────────────────────
run_earn() {
  hdr "6 — Superteam Earn Integration"

  log "Running SUPERTEAM_EARN_SCAN directly..."
  action "SUPERTEAM_EARN_SCAN" "earn-scan"

  log "Verifying earn scan via prompt..."
  prompt "Use SUPERTEAM_EARN_SCAN. How many live listings are there? Summarize the top 3 by reward amount." \
    "earn-scan-prompt" 120000
}

# ── Phase 7: Printing Press ────────────────────────────
run_pp() {
  hdr "7 — Printing Press CLIs"

  log "Listing installed CLIs..."
  action "PRINTING_PRESS_INSTALLED" "pp-list-installed"

  log "Searching catalog..."
  action "PRINTING_PRESS_SEARCH" "pp-search" '{"parameters":{"query":"crypto"}}'
}

# ── Phase 8: Overwatch ─────────────────────────────────
run_overwatch() {
  hdr "8 — Overwatch Self-Inspection"

  log "Full overwatch via prompt..."
  prompt "Use OVERWATCH_TRAJECTORIES (limit: 10) to list recent trajectories. Then use OVERWATCH_ACTION_STATS (limit: 20) to show per-action success rates. Report findings concisely." \
    "overwatch-full" 90000
}

# ── Phase 9: Eval ──────────────────────────────────────
run_eval() {
  hdr "9 — Eval Plugin (Grading)"

  log "Full eval cycle via prompt..."
  prompt "Use EVAL_GRADE: job=test-harness, grade=A, scores={accuracy:90, completeness:85, insightDepth:80, actionQuality:95, overall:88}, corrections=[], additions=[\"comprehensive coverage\"], recommendations=[\"add more edge cases\"], trend=improving. Then EVAL_PERSIST at path=/self/evals/test-harness, type=eval." \
    "eval-cycle" 60000
}

# ── Phase 10: Goals ────────────────────────────────────
run_goals() {
  hdr "10 — Goals & Calendar"

  log "Checking active goal..."
  action "DETOUR_ACTIVE_GOAL" "active-goal"
}

# ── Phase 11: Cron ─────────────────────────────────────
run_cron() {
  hdr "11 — Cron Jobs"

  log "Checking cron registration via prompt..."
  prompt "What scheduled/cron jobs do you have? List their names and when they run." \
    "cron-list" 60000
}

# ── Phase 12: Integration ─────────────────────────────
run_integration() {
  hdr "12 — Full Integration Test"

  log "Running comprehensive self-eval..."
  prompt "Perform a comprehensive self-evaluation:
1. Use OVERWATCH_TRAJECTORIES (limit: 20) to list recent trajectories
2. Use OVERWATCH_ACTION_STATS (limit: 20) to get success rates
3. Use OVERWATCH_RUNTIME to verify plugins loaded
4. Use PENSIEVE_LIST at / to check memory tree
5. Use PRINTING_PRESS_INSTALLED to check CLIs
6. Grade yourself: EVAL_GRADE job=comprehensive, grade based on data
7. EVAL_PERSIST at /self/evals/comprehensive

Report ALL findings." \
    "full-integration" 180000
}

# ── Run ────────────────────────────────────────────────
case "$PHASE" in
  all)
    run_health || exit 1
    run_actions
    run_smoke
    run_prompt
    run_pensieve
    run_earn
    run_pp
    run_overwatch
    run_eval
    run_goals
    run_cron
    run_integration
    ;;
  health)       run_health ;;
  actions)      run_actions ;;
  smoke)        run_smoke ;;
  prompt)       run_prompt ;;
  pensieve)     run_pensieve ;;
  earn)         run_earn ;;
  printing-press|pp) run_pp ;;
  overwatch)    run_overwatch ;;
  eval)         run_eval ;;
  goals)        run_goals ;;
  cron)         run_cron ;;
  integration)  run_integration ;;
  *)            echo "Unknown phase: $PHASE"; exit 1 ;;
esac

# ── Summary ────────────────────────────────────────────
echo
echo -e "${BOLD}═══════════════════════════════════════${NC}"
echo -e "${BOLD}  Test Summary${NC}"
echo -e "${BOLD}═══════════════════════════════════════${NC}"
echo -e "  ${GREEN}Passed:  $pass${NC}"
echo -e "  ${RED}Failed:  $fail${NC}"
echo -e "  ${YELLOW}Skipped: $skip${NC}"
echo -e "  Results: $RESULTS_DIR"
total=$((pass + fail + skip))
if [[ $total -gt 0 ]]; then
  pct=$((pass * 100 / total))
  echo -e "  Score:   ${pct}%"
fi

if [[ $fail -gt 0 ]]; then
  exit 1
fi
