# AGENTS.md: pi-friends

Purpose and design: `README.md`. Public repo (nkavassalis), personal project, MIT.

Rules:
- **Public-safe, always.** Never commit IPs, hostnames, usernames, home paths, keys or live config.
  Hosts and keys live in an untracked `.env` or in `~/.config/pi-friends/`. This repo gets installed
  by strangers; assume every line is read by someone who is not Nick.
- Never hardcode a friend's name, endpoint or model into code. Friends are config; the only place a
  specific friend may appear is `scripts/install-flint.sh` (it provisions one named example) and the
  README, where it is labelled as a measured example rather than a requirement.
- Every claim about quality or speed is measured, with the result file next to it, or labelled unmeasured.
- Don't change how any server runs here: serving belongs to spark-tuning and mac-tuning.
- Dates YYYY-MM-DD; date every statement of current state.

## Layout
| Path | What |
|---|---|
| `package.json` | npm/pi package manifest; the `pi-package` keyword is what makes it discoverable in the pi gallery |
| `extensions/friends/index.ts` | the pi extension: registers one `ask_<name>` tool per configured friend, plus `/friends` |
| `extensions/friends/client.ts` | config (legacy + `friends[]` shapes), per-friend one-at-a-time queue, the streamed request, brief check (no pi imports) |
| `extensions/friends/tunnel.ts` | optional on-demand SSH tunnel (used only with a `tunnel` config block) |
| `test/client.test.ts`, `test/tunnel.test.ts`, `test/fake_ssh.mjs` | offline tests: fake OpenAI-compatible SSE server, fake ssh |
| `scripts/tunnel-flint.sh` | manual alternative: loopback-only SSH tunnel to the Mac, self-restarting |
| `scripts/install-flint.sh [--uninstall]` | provisions the flint example: symlink, key, default config |

## Tests (run before every commit)
```bash
node --experimental-strip-types --test test/*.test.ts
bash -n scripts/*.sh
git diff --cached | grep -nE '([0-9]{1,3}\.){3}[0-9]{1,3}|/home/|/Users/|hf_[A-Za-z0-9]{10,}|gh[pousr]_[A-Za-z0-9]{10,}'   # 127.0.0.1 is fine
```
Run pi from scripts with `< /dev/null`: piped stdin becomes part of the prompt.

## Notes for agents
- `client.ts` must stay importable without pi (that is what makes the tests offline); all pi
  imports live in `index.ts`.
- A friend's server is assumed single-generation, so `Queue` is per friend, not global — two
  different servers should not serialize against each other.
- `loadFriends()` re-reads the file on every call (config edits need no restart) but tools register
  once at startup, so adding a friend needs a pi restart; changing its `baseUrl` does not.
- The pre-rename config dir `~/.config/pi-escalation/` is still read as a fallback
  (`resolveCfg`); remove that fallback once no install uses it (dated 2026-10-29).
