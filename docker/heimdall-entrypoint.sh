#!/bin/sh
# Codex needs a writable CODEX_HOME — it keeps session state and the rollout
# recorder there — but Heimdall deliberately bind-mounts the shared host config
# read-only, to close the cross-agent tampering hole in the baseline kit
# (HEIMDALL_CODEX_HOME_RO is only set on that path; the baseline runner leaves
# CODEX_HOME writable and this script is then a no-op passthrough).
#
# So: copy the one file Codex needs out of the read-only mount into a fresh
# writable CODEX_HOME, then hand off to the real command. The shared mount
# itself is never written to.
set -eu

if [ -n "${HEIMDALL_CODEX_HOME_RO:-}" ]; then
  mkdir -p "$CODEX_HOME"
  if [ -f "$HEIMDALL_CODEX_HOME_RO/config.toml" ]; then
    cp "$HEIMDALL_CODEX_HOME_RO/config.toml" "$CODEX_HOME/config.toml"
  fi
fi

exec "$@"
