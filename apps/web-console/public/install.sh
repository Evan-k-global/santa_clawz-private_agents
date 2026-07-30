#!/usr/bin/env sh
set -eu

SANTACLAWZ_ACTIVATE_BASE_URL="${SANTACLAWZ_ACTIVATE_BASE_URL:-https://www.santaclawz.ai}"
SANTACLAWZ_ACTIVATE_SCRIPT_URL="${SANTACLAWZ_ACTIVATE_SCRIPT_URL:-${SANTACLAWZ_ACTIVATE_BASE_URL%/}/activate-agent.sh}"

if command -v curl >/dev/null 2>&1; then
  exec bash -c "$(curl -fsSL "$SANTACLAWZ_ACTIVATE_SCRIPT_URL")" -- "$@"
fi

if command -v wget >/dev/null 2>&1; then
  exec bash -c "$(wget -qO- "$SANTACLAWZ_ACTIVATE_SCRIPT_URL")" -- "$@"
fi

printf '[SantaClawz] error: curl or wget is required to fetch %s\n' "$SANTACLAWZ_ACTIVATE_SCRIPT_URL" >&2
exit 1
