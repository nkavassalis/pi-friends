# pi-escalation

Use two local models from one [pi](https://pi.dev/) agent. Qwen on the 2× DGX Spark cluster does the agent loop. Recursive
Flint on a Mac mini is called for hard, self-contained reasoning problems.

**Status 2026-10-29:**
- `ask_flint` is written (`extensions/ask-flint/`), and its offline tests pass.
- First end-to-end run: pi with Qwen calling Flint on the Mac through the tunnel (see "Tested").
- Not installed into pi globally yet, and not measured on real tasks.

## Why

Measured with the same problems, seeds and sandbox on both machines (32K budget, T=0.6; see
[spark-tuning](https://github.com/nkavassalis/spark-tuning) COMPARISON.md / FLINT.md and
[mac-tuning](https://github.com/nkavassalis/mac-tuning) FLINT.md):

| | Qwen FP4-Local `medium` (Spark) | Flint int4 (Mac) | solved by either |
|---|---|---|---|
| LiveCodeBench (80) | 51.2% | **71.2%** (16 won / 0 lost, p<0.001) | 71.2% |
| post-cutoff AtCoder (147) | 53.7% | **68.0%** | 72.1% |
| HumanEval+ (164) | **95.7%** (16K) | 91.5% (Qwen better, p=0.039) | |

- **On hard problems Flint solves almost everything Qwen solves.** The gain comes from sending hard problems to Flint, not from
  racing both models.
- **Qwen is the better everyday agent:** better HumanEval+, several sessions at once, and ~2,800 tok/s prefill with free warm
  prefix hits.
- **Flint on the Mac is fast to answer but slow to read a prompt.** It decodes 114–120 tok/s at 1K, but prefills ~600 tok/s,
  falling to ~250 at 100K, and serves one request at a time.

## Design

- **Qwen stays pi's default model** for every session.
- **An `ask_flint` tool (pi extension):**
  - Qwen writes a brief: the problem, the relevant code, the failing test and the constraints, ~16K tokens at most.
  - The tool sends the brief to the Mac as a fresh one-turn chat, with no session history.
  - Only Flint's final answer comes back, not its reasoning. Qwen applies it and runs the tests.
  - Requests queue on the tool side, with a timeout, because the Mac serves one at a time.
- **When to call it:** after Qwen fails the same test twice, or when the user asks.
- **Never switch the session's model to Flint.** pi would re-send the whole history, which at 100K takes 6.5–9 min to prefill
  on the Mac.

## Install and run

```bash
cp .env.example .env            # MAC, MAC_SSH_KEY, LOCAL_PORT (never commit)
scripts/install.sh              # links the extension into ~/.pi/agent/extensions, fetches the key, writes the config
pi --extension extensions/ask-flint/index.ts   # or: try it for one run without installing
scripts/install.sh --uninstall
```
**The tunnel is managed by the tool, not a service.** The pi machine is a container with no service manager (no systemd, no cron).
- **Before every call**, `ask_flint` checks `127.0.0.1:11501`.
- **If nothing listens there**, it starts `ssh -N -L` itself, detached, so the tunnel outlives pi.
- **If the address in the config changed**, it kills its old ssh and starts a new one.
- **State** (pid and settings) is kept in `~/.config/pi-escalation/tunnel.json`.
- **`scripts/tunnel.sh`** is the manual alternative. If one started by hand already holds the port, the tool leaves it alone.

**To change the Mac's address,** edit `tunnel.host` in `~/.config/pi-escalation/config.json` (`"user@<new-ip-or-name>"`). The next call
reconnects there; nothing needs restarting. `.env` is only read by `install.sh` when it first writes that config.

The Mac side is mac-tuning's `scripts/serve.sh` (`rec serve` on 127.0.0.1:11500, API key on).

Settings live in `~/.config/pi-escalation/config.json`, which overrides the defaults in `client.ts`:

| Setting | Default | Notes |
|---|---|---|
| `baseUrl` | `http://127.0.0.1:11501/v1` | |
| `tunnel` | from `.env` | `host` (the Mac's ssh target), `identity`, `localPort`, `remotePort`; omit to manage the tunnel yourself |
| `maxTokens` | 32768 | |
| `temperature` / `topP` / `topK` | 0.6 / 0.95 / 20 | |
| `timeoutMin` | 20 | |
| `maxBriefChars` | 64000 | Longer briefs are refused with an error telling Qwen to shorten them, never silently cut. |

- **The tool adds a description and two guideline lines to Qwen's system prompt.** The first request of every session started
  or resumed after installing therefore prefills from scratch once (PI.md in spark-tuning: a changed prompt is a cold prefix).
- **The key is read from `~/.config/pi-escalation/flint_key`** (mode 600) at call time.

## Tested (2026-10-29, one run)

`pi --extension extensions/ask-flint/index.ts --mode json` was run on the live Qwen FP4-Local, with the Flint int4 server on the
Mac reached through the tunnel. The task: an O(n + k) rewrite of a quadratic `count_pairs`.
1. Qwen read the file, wrote a self-contained brief with the code pasted in, and called `ask_flint` once.
2. Flint answered in 43 s: 372 prompt tokens, 4,688 completion tokens, mostly reasoning, which was not returned to Qwen.
3. The answer was a correct counting-by-remainder solution.
4. Qwen checked it against the original on random inputs before replying.

This is a smoke test that the plumbing works. It is not evidence of uplift; that is the task comparison under "Open".

## Tests

```bash
node --experimental-strip-types --test test/*.test.ts   # offline: fake rec SSE server + fake ssh; 13 tests
bash -n scripts/*.sh
```
Run pi with `< /dev/null` from scripts. Piped stdin becomes part of the prompt, so pi waits for it to close.

## Open

1. Measure whether escalation helps: 10–20 real tasks, with and without `ask_flint`, comparing tests passed and wall-clock time.
   Nothing here is measured on agent tasks yet; the numbers above are benchmarks.
