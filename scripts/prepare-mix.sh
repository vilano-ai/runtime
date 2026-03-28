#!/usr/bin/env bash
set -euo pipefail

retry() {
  local attempts="$1"
  local delay_seconds="$2"
  shift 2

  local attempt=1
  while true; do
    if "$@"; then
      return 0
    fi

    if [[ "$attempt" -ge "$attempts" ]]; then
      return 1
    fi

    echo "command failed (attempt ${attempt}/${attempts}): $*" >&2
    sleep "$delay_seconds"
    attempt=$((attempt + 1))
  done
}

ATTEMPTS="${MIX_PREPARE_ATTEMPTS:-4}"
DELAY_SECONDS="${MIX_PREPARE_DELAY_SECONDS:-5}"
export HEX_HTTP_TIMEOUT="${HEX_HTTP_TIMEOUT:-120}"

retry "$ATTEMPTS" "$DELAY_SECONDS" mix local.hex --force
retry "$ATTEMPTS" "$DELAY_SECONDS" mix local.rebar --force
(
  cd kernel
  retry "$ATTEMPTS" "$DELAY_SECONDS" mix deps.get
)
