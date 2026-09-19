#!/usr/bin/env bash
# Start the dashboard on this Mac with REAL data and open it in the browser.
#
#   scripts/launch-local.sh          start (or reuse) the local dashboard, open it
#   scripts/launch-local.sh stop     stop the copy this script started
#
# Runs `next dev`, so the page always reflects the code in this folder as it is
# right now: edit a file and the dashboard picks it up, no rebuild step.
#
# Secrets never touch the disk. Anything .env.local already sets wins; for what
# it doesn't, this script fills the process environment only:
#   GITHUB_TOKEN        -> `gh auth token` (your existing GitHub CLI login)
#   DASHBOARD_PASSWORD  -> a random one for this run, printed below
#   SESSION_SECRET      -> random for this run (only alongside a random password)
# Signed-out visitors on a local run get the /login screen, not the demo: the
# public demo is forced off here, whatever the env files say.
#
# Safe to run twice: if the dashboard is already listening on the port, it just
# opens the browser. PORT overrides the default 3000.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${PORT:-3000}"
URL="http://localhost:${PORT}"
STATE_DIR="${TMPDIR:-/tmp}"
STATE_DIR="${STATE_DIR%/}"
LOG="${STATE_DIR}/loop-dashboard-${PORT}.log"
PIDFILE="${STATE_DIR}/loop-dashboard-${PORT}.pid"
ENV_FILES=(".env" ".env.local" ".env.development" ".env.development.local")

die() { echo "launch-local: $*" >&2; exit 1; }

listener_pid() { lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null | head -n 1; }

# The dashboard is whatever answers /api/health AND serves a page titled
# "Loop Dashboard" — an unrelated app on the port fails one or the other.
is_dashboard() {
  curl -fsS -m 3 "${URL}/api/health" 2>/dev/null | grep -q '"ok":true' &&
    curl -fsS -m 10 "${URL}/login" 2>/dev/null | grep -q '<title>Loop Dashboard</title>'
}

# Whether one of the env files Next loads sets KEY to a non-empty value.
env_file_sets() {
  local f
  for f in "${ENV_FILES[@]}"; do
    [ -f "${ROOT}/${f}" ] &&
      grep -Eq "^[[:space:]]*(export[[:space:]]+)?$1=[^[:space:]]" "${ROOT}/${f}" &&
      return 0
  done
  return 1
}

random_hex() { openssl rand -hex "$1"; }

stop_server() {
  local pid=""
  [ -f "$PIDFILE" ] && pid="$(cat "$PIDFILE")"
  if [ -z "$pid" ] || ! kill -0 "$pid" 2>/dev/null; then
    rm -f "$PIDFILE"
    echo "No dashboard started by this script is running on port ${PORT}."
    return 0
  fi
  kill "$pid"
  for _ in $(seq 1 20); do
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.5
  done
  kill -0 "$pid" 2>/dev/null && kill -9 "$pid"
  rm -f "$PIDFILE"
  echo "Stopped the dashboard on port ${PORT}."
}

case "${1:-}" in
  "") ;;
  stop) stop_server; exit 0 ;;
  *) die "usage: $0 [stop]" ;;
esac

command -v node >/dev/null || die "Node.js is not installed (need Node 22+)."

# ---- Already running? -------------------------------------------------------

holder="$(listener_pid || true)"
if [ -n "$holder" ]; then
  if is_dashboard; then
    open "$URL"
    echo "The dashboard is already running (pid ${holder}). Opened ${URL}"
    exit 0
  fi
  what="$(ps -o command= -p "$holder" 2>/dev/null | cut -c1-120 || true)"
  die "port ${PORT} is taken by something that is not the dashboard (pid ${holder}: ${what}).
Quit that program, or pick another port: PORT=3001 $0"
fi

# ---- Dependencies, only when missing or out of date -------------------------

cd "$ROOT"
if [ ! -f node_modules/.package-lock.json ] || [ package-lock.json -nt node_modules/.package-lock.json ]; then
  echo "Installing dependencies (first run, or package-lock.json changed)..."
  npm ci --no-audit --no-fund
fi

# ---- Environment: real data, secrets in memory only -------------------------

export LOOP_DASHBOARD_PUBLIC_DEMO=0
env_file_sets LOOP_DASHBOARD_LOCAL_MODE || export LOOP_DASHBOARD_LOCAL_MODE=1

if [ -z "${GITHUB_TOKEN:-}" ] && ! env_file_sets GITHUB_TOKEN; then
  command -v gh >/dev/null || die "no GITHUB_TOKEN in .env.local and the GitHub CLI (gh) is not installed."
  GITHUB_TOKEN="$(gh auth token 2>/dev/null)" ||
    die "no GITHUB_TOKEN in .env.local and the GitHub CLI is not signed in. Run: gh auth login"
  export GITHUB_TOKEN
fi

password_note=""
if [ -z "${DASHBOARD_PASSWORD:-}" ] && ! env_file_sets DASHBOARD_PASSWORD; then
  DASHBOARD_PASSWORD="$(random_hex 12)"
  SESSION_SECRET="$(random_hex 32)"
  export DASHBOARD_PASSWORD SESSION_SECRET
  password_note="Password for this run: ${DASHBOARD_PASSWORD} (new each launch; the browser stays signed in until you stop the server)"
else
  password_note="Password: the DASHBOARD_PASSWORD line in ${ROOT}/.env.local"
fi

# ---- Start ------------------------------------------------------------------

echo "Starting the dashboard on ${URL} (log: ${LOG})"
# Bound to loopback only: this server has a GitHub token and local-machine
# features switched on, so nothing else on the network should reach it.
nohup node node_modules/next/dist/bin/next dev --hostname 127.0.0.1 --port "$PORT" >"$LOG" 2>&1 &
pid=$!
echo "$pid" >"$PIDFILE"

for _ in $(seq 1 120); do
  kill -0 "$pid" 2>/dev/null || { tail -n 30 "$LOG" >&2; die "the dashboard exited during startup (full log: ${LOG})."; }
  is_dashboard && break
  sleep 1
done
is_dashboard || die "the dashboard did not answer within 2 minutes (log: ${LOG})."

open "$URL"
echo "Opened ${URL}"
echo "$password_note"
echo "Stop it with: $0 stop"
