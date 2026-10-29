#!/usr/bin/env bash
# tunnel-flint.sh: (fallback for the optional per-friend "tunnel" config) keep a loopback-only SSH tunnel to the Mac (127.0.0.1:$LOCAL_PORT -> Mac 127.0.0.1:11500),
# restarting it within 5 s if it drops. Nothing is exposed on the LAN. Run in the foreground or as a background job.
set -euo pipefail
cd "$(dirname "$0")/.."; . ./.env
: "${MAC:?MAC unset in .env}" "${MAC_SSH_KEY:?MAC_SSH_KEY unset in .env}"; LOCAL_PORT=${LOCAL_PORT:-11501}
while true; do
  ssh -i "$MAC_SSH_KEY" -N -o BatchMode=yes -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=4 \
    -L "127.0.0.1:$LOCAL_PORT:127.0.0.1:11500" "$MAC" || true
  echo "$(date -u +%FT%TZ) tunnel exited, restarting" >&2; sleep 5
done
