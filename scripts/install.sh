#!/usr/bin/env bash
# install.sh: install ask_flint for pi on this machine.
#  - links extensions/ask-flint into ~/.pi/agent/extensions/ (pi loads it at the next start; a symlink, so a git pull updates it)
#  - copies the Flint server's API key from the Mac into ~/.config/pi-escalation/flint_key (mode 600)
#  - writes ~/.config/pi-escalation/config.json if it doesn't exist: baseUrl = FLINT_URL from .env (edit baseUrl there to change
#    the Mac's address). Without FLINT_URL it writes the optional SSH tunnel settings instead (LOCAL_PORT).
#   scripts/install.sh [--uninstall]
set -euo pipefail
cd "$(dirname "$0")/.."; R=$PWD
EXT=~/.pi/agent/extensions/ask-flint; CFG=~/.config/pi-escalation
if [ "${1:-}" = --uninstall ]; then rm -f "$EXT"; echo "removed $EXT (key and config in $CFG kept)"; exit 0; fi
. ./.env; : "${MAC:?MAC unset in .env}" "${MAC_SSH_KEY:?MAC_SSH_KEY unset in .env}"
mkdir -p ~/.pi/agent/extensions "$CFG"; chmod 700 "$CFG"
if [ -e "$EXT" ] && [ ! -L "$EXT" ]; then echo "$EXT exists and is not our symlink; not touching it" >&2; exit 1; fi
ln -sfn "$R/extensions/ask-flint" "$EXT"
( umask 077; ssh -i "$MAC_SSH_KEY" -o BatchMode=yes "$MAC" 'cat ~/.local/share/rec/config/api-key' > "$CFG/flint_key.tmp" )
[ -s "$CFG/flint_key.tmp" ] || { rm -f "$CFG/flint_key.tmp"; echo "could not read the key from the Mac" >&2; exit 1; }
mv "$CFG/flint_key.tmp" "$CFG/flint_key"
P=${LOCAL_PORT:-11501}
if [ ! -e "$CFG/config.json" ]; then
  if [ -n "${FLINT_URL:-}" ]; then
    printf '{\n  "baseUrl": "%s"\n}\n' "$FLINT_URL" > "$CFG/config.json"
  else cat > "$CFG/config.json" <<JSON
{
  "baseUrl": "http://127.0.0.1:$P/v1",
  "tunnel": { "host": "$MAC", "identity": "$MAC_SSH_KEY", "localPort": $P, "remotePort": 11500 }
}
JSON
  fi
  chmod 600 "$CFG/config.json"
fi
echo "installed: $EXT -> $R/extensions/ask-flint; key and config in $CFG (baseUrl there is the Mac's address)."
