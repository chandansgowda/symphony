#!/usr/bin/env bash
# Symphony Service Manager
# Manages Symphony as a background daemon with health-check-based restart
#
# Usage:
#   ./scripts/service.sh start [--dev]   # Start service in background
#   ./scripts/service.sh stop            # Gracefully stop service
#   ./scripts/service.sh restart [--dev] # Health-check restart (zero-downtime)
#   ./scripts/service.sh status          # Show service status
#   ./scripts/service.sh logs            # Tail service logs
#
# Environment variables:
#   SYMPHONY_PORT    Web UI port (default: 3000)
#   SYMPHONY_LOG     Log file path (default: ./symphony.log)
#   SYMPHONY_PID     PID file path (default: ./symphony.pid)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

SYMPHONY_PORT="${SYMPHONY_PORT:-3000}"
SYMPHONY_LOG="${SYMPHONY_LOG:-$ROOT_DIR/symphony.log}"
SYMPHONY_PID="${SYMPHONY_PID:-$ROOT_DIR/symphony.pid}"
HEALTH_URL="http://localhost:${SYMPHONY_PORT}/api/health"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-30}"  # seconds to wait for health check
HEALTH_INTERVAL=1                        # seconds between health check polls

# ─── Helpers ────────────────────────────────────────────────────────────────

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"
}

die() {
  echo "ERROR: $*" >&2
  exit 1
}

get_pid() {
  if [[ -f "$SYMPHONY_PID" ]]; then
    local pid
    pid=$(cat "$SYMPHONY_PID")
    if kill -0 "$pid" 2>/dev/null; then
      echo "$pid"
      return 0
    fi
    # Stale PID file
    rm -f "$SYMPHONY_PID"
  fi
  return 1
}

wait_for_health() {
  local timeout="$1"
  local elapsed=0

  log "Waiting for health check at $HEALTH_URL (timeout: ${timeout}s)..."

  while [[ $elapsed -lt $timeout ]]; do
    if curl -sf "$HEALTH_URL" >/dev/null 2>&1; then
      log "Health check passed after ${elapsed}s"
      return 0
    fi
    sleep "$HEALTH_INTERVAL"
    elapsed=$((elapsed + HEALTH_INTERVAL))
  done

  log "Health check timed out after ${timeout}s"
  return 1
}

build_prod() {
  log "Building production bundle..."
  cd "$ROOT_DIR"
  npm run build 2>&1 | tee -a "$SYMPHONY_LOG"
  log "Build complete."
}

# ─── Commands ───────────────────────────────────────────────────────────────

cmd_start() {
  local dev_mode=false
  for arg in "$@"; do
    [[ "$arg" == "--dev" ]] && dev_mode=true
  done

  if pid=$(get_pid); then
    log "Symphony already running (PID $pid)"
    return 0
  fi

  cd "$ROOT_DIR"

  if [[ "$dev_mode" == true ]]; then
    log "Starting Symphony in development mode..."
    nohup npx tsx src/cli.ts \
      --port "$SYMPHONY_PORT" \
      >> "$SYMPHONY_LOG" 2>&1 &
  else
    if [[ ! -f "$ROOT_DIR/dist/cli.js" ]]; then
      build_prod
    fi
    log "Starting Symphony in production mode..."
    nohup node dist/cli.js \
      --port "$SYMPHONY_PORT" \
      >> "$SYMPHONY_LOG" 2>&1 &
  fi

  local pid=$!
  echo "$pid" > "$SYMPHONY_PID"
  log "Symphony started (PID $pid)"
  log "Logs: $SYMPHONY_LOG"
  log "Web UI: http://localhost:$SYMPHONY_PORT"

  # Wait for health before returning
  if ! wait_for_health "$HEALTH_TIMEOUT"; then
    log "Warning: service started but health check did not pass within ${HEALTH_TIMEOUT}s"
    log "Check logs: tail -f $SYMPHONY_LOG"
  fi
}

cmd_stop() {
  local pid
  if ! pid=$(get_pid); then
    log "Symphony is not running"
    return 0
  fi

  log "Stopping Symphony (PID $pid)..."
  kill -TERM "$pid"

  # Wait for graceful shutdown (up to 15 seconds)
  local elapsed=0
  while kill -0 "$pid" 2>/dev/null && [[ $elapsed -lt 15 ]]; do
    sleep 1
    elapsed=$((elapsed + 1))
  done

  if kill -0 "$pid" 2>/dev/null; then
    log "Graceful shutdown timed out, sending SIGKILL..."
    kill -KILL "$pid" 2>/dev/null || true
  fi

  rm -f "$SYMPHONY_PID"
  log "Symphony stopped"
}

cmd_restart() {
  local dev_mode=false
  for arg in "$@"; do
    [[ "$arg" == "--dev" ]] && dev_mode=true
  done

  local old_pid=""
  old_pid=$(get_pid 2>/dev/null || echo "")

  if [[ "$dev_mode" == false ]]; then
    # Build first, validate before switching
    log "Building new version..."
    if ! build_prod; then
      die "Build failed — keeping current process running"
    fi
  fi

  # Start new process on a temporary port to validate health
  local tmp_port=$(( SYMPHONY_PORT + 1000 ))
  log "Starting candidate process on port $tmp_port for health validation..."

  if [[ "$dev_mode" == true ]]; then
    SYMPHONY_PORT="$tmp_port" nohup npx tsx src/cli.ts \
      --port "$tmp_port" --no-web \
      >> "${SYMPHONY_LOG}.candidate" 2>&1 &
  else
    SYMPHONY_PORT="$tmp_port" nohup node dist/cli.js \
      --port "$tmp_port" --no-web \
      >> "${SYMPHONY_LOG}.candidate" 2>&1 &
  fi

  local candidate_pid=$!
  log "Candidate process started (PID $candidate_pid)"

  # Wait for candidate to pass health check
  local candidate_health_url="http://localhost:${tmp_port}/api/health"
  local elapsed=0
  local candidate_healthy=false

  log "Waiting for candidate health check at $candidate_health_url..."
  while [[ $elapsed -lt $HEALTH_TIMEOUT ]]; do
    if curl -sf "$candidate_health_url" >/dev/null 2>&1; then
      candidate_healthy=true
      break
    fi
    sleep "$HEALTH_INTERVAL"
    elapsed=$((elapsed + HEALTH_INTERVAL))
  done

  if [[ "$candidate_healthy" == false ]]; then
    log "Candidate health check failed — killing candidate, keeping old process"
    kill -KILL "$candidate_pid" 2>/dev/null || true
    rm -f "${SYMPHONY_LOG}.candidate"
    die "Restart aborted: new version failed health check"
  fi

  log "Candidate is healthy — switching over"

  # Kill candidate (it was just for validation)
  kill -TERM "$candidate_pid" 2>/dev/null || true

  # Stop old process
  if [[ -n "$old_pid" ]]; then
    log "Stopping old process (PID $old_pid)..."
    kill -TERM "$old_pid" 2>/dev/null || true
    local stop_elapsed=0
    while kill -0 "$old_pid" 2>/dev/null && [[ $stop_elapsed -lt 15 ]]; do
      sleep 1
      stop_elapsed=$((stop_elapsed + 1))
    done
    if kill -0 "$old_pid" 2>/dev/null; then
      kill -KILL "$old_pid" 2>/dev/null || true
    fi
    rm -f "$SYMPHONY_PID"
  fi

  # Start the real new process
  log "Starting new process on port $SYMPHONY_PORT..."
  rm -f "${SYMPHONY_LOG}.candidate"

  # Rotate log
  if [[ -f "$SYMPHONY_LOG" ]]; then
    mv "$SYMPHONY_LOG" "${SYMPHONY_LOG}.prev"
  fi

  if [[ "$dev_mode" == true ]]; then
    nohup npx tsx src/cli.ts \
      --port "$SYMPHONY_PORT" \
      >> "$SYMPHONY_LOG" 2>&1 &
  else
    nohup node dist/cli.js \
      --port "$SYMPHONY_PORT" \
      >> "$SYMPHONY_LOG" 2>&1 &
  fi

  local new_pid=$!
  echo "$new_pid" > "$SYMPHONY_PID"
  log "New process started (PID $new_pid)"

  if ! wait_for_health "$HEALTH_TIMEOUT"; then
    log "Warning: new process health check did not pass within ${HEALTH_TIMEOUT}s"
    log "Check logs: tail -f $SYMPHONY_LOG"
  else
    log "Restart complete. Web UI: http://localhost:$SYMPHONY_PORT"
  fi
}

cmd_status() {
  local pid
  if pid=$(get_pid 2>/dev/null); then
    log "Symphony is running (PID $pid)"
    log "Web UI: http://localhost:$SYMPHONY_PORT"
    if curl -sf "$HEALTH_URL" >/dev/null 2>&1; then
      log "Health check: PASSING"
    else
      log "Health check: FAILING (service may still be starting)"
    fi
  else
    log "Symphony is not running"
  fi
}

cmd_logs() {
  if [[ -f "$SYMPHONY_LOG" ]]; then
    tail -f "$SYMPHONY_LOG"
  else
    die "Log file not found: $SYMPHONY_LOG"
  fi
}

# ─── Entry Point ─────────────────────────────────────────────────────────────

COMMAND="${1:-help}"
shift 2>/dev/null || true

case "$COMMAND" in
  start)   cmd_start "$@" ;;
  stop)    cmd_stop "$@" ;;
  restart) cmd_restart "$@" ;;
  status)  cmd_status "$@" ;;
  logs)    cmd_logs "$@" ;;
  help|--help|-h)
    cat <<EOF
Symphony Service Manager

Usage: $0 <command> [options]

Commands:
  start [--dev]    Start Symphony as a background daemon
  stop             Gracefully stop Symphony
  restart [--dev]  Restart with health-check validation (safe)
  status           Show running status and health
  logs             Tail the service log

Options:
  --dev            Use tsx (development mode, no build required)

Environment variables:
  SYMPHONY_PORT    Web UI port (default: 3000)
  SYMPHONY_LOG     Log file (default: ./symphony.log)
  SYMPHONY_PID     PID file (default: ./symphony.pid)
  HEALTH_TIMEOUT   Seconds to wait for health (default: 30)

Examples:
  make dev          # Start in development mode (background)
  make prod         # Build and start in production mode (background)
  make service-stop # Stop the service
  make restart      # Rebuild and restart with health validation
EOF
    ;;
  *)
    die "Unknown command: $COMMAND. Run '$0 help' for usage."
    ;;
esac
