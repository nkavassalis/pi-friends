# AGENTS.md: pi-escalation

Purpose and design: `README.md`. Private repo (nkavassalis), personal project, not Origin.

Rules:
- Never commit IPs, hostnames, usernames, home paths or keys. Hosts and keys live in an untracked `.env`.
- Every claim about quality or speed is measured, with the result file next to it, or labelled unmeasured.
- Don't change how either server runs here: serving belongs to spark-tuning and mac-tuning.
- Dates YYYY-MM-DD; date every statement of current state.

## Layout
| Path | What |
|---|---|
| `extensions/ask-flint/index.ts` | the pi extension: registers `ask_flint`, queue, result and usage |
| `extensions/ask-flint/client.ts` | config, one-at-a-time queue, the streamed request to Flint, brief check (no pi imports) |
| `extensions/ask-flint/tunnel.ts` | on-demand SSH tunnel: start if down, restart on a host change (no service manager on this box) |
| `test/client.test.ts`, `test/tunnel.test.ts`, `test/fake_ssh.mjs` | offline tests: fake rec-shaped SSE server, fake ssh |
| `scripts/tunnel.sh` | manual alternative: loopback-only SSH tunnel to the Mac, self-restarting |
| `scripts/install.sh [--uninstall]` | symlink into `~/.pi/agent/extensions`, fetch the key, write the default config |

## Tests (run before every commit)
```bash
node --experimental-strip-types --test test/*.test.ts
bash -n scripts/*.sh
git diff --cached | grep -nE '([0-9]{1,3}\.){3}[0-9]{1,3}|/home/|/Users/|hf_[A-Za-z0-9]{10,}|gh[pousr]_[A-Za-z0-9]{10,}'   # 127.0.0.1 is fine
```
Run pi from scripts with `< /dev/null`: piped stdin becomes part of the prompt.
