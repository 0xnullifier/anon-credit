#!/usr/bin/env bash
# Stop the services that tooling/dev/run-services.sh started.
#
# Usage: tooling/dev/stop-services.sh [run-dir]   default: data/run/latest
#
# The script reads <run-dir>/services.pids and stops only those processes, in the reverse
# order: the gateway, the issuer, then the sidecar. It sends SIGTERM, waits up to 10 s, then
# sends SIGKILL. It does not touch other processes.
set -euo pipefail

repo="$(cd "$(dirname "$0")/../.." && pwd)"
run_dir="${1:-$repo/data/run/latest}"
pids="$run_dir/services.pids"
[ -f "$pids" ] || {
  echo "stop-services: no $pids" >&2
  exit 1
}

# Lines are name=pid, in start order. Stop in the reverse order.
entries=()
while IFS= read -r line; do
  [ -n "$line" ] && entries=("$line" "${entries[@]+"${entries[@]}"}")
done <"$pids"

for entry in "${entries[@]+"${entries[@]}"}"; do
  name="${entry%%=*}"
  pid="${entry#*=}"
  if ! kill -0 "$pid" 2>/dev/null; then
    echo "stop-services: $name (pid $pid) is not running"
    continue
  fi
  kill -TERM "$pid" 2>/dev/null || true
  for _ in $(seq 1 20); do
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.5
  done
  if kill -0 "$pid" 2>/dev/null; then
    kill -KILL "$pid" 2>/dev/null || true
    echo "stop-services: $name (pid $pid) did not stop in 10 s; sent SIGKILL"
  else
    echo "stop-services: stopped $name (pid $pid)"
  fi
done
