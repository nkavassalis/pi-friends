# pi-escalation

Use two local models from one [pi](https://pi.dev/) agent. Qwen on the 2× DGX Spark cluster does the agent loop. Recursive
Flint on a Mac mini is called for hard, self-contained reasoning problems.

**Status 2026-10-29:**
- `ask_flint` is written (`extensions/ask-flint/`), and its offline tests pass.
- First end-to-end run: pi with Qwen calling Flint on the Mac through the SSH tunnel (see "Tested").
- Since 2026-10-29 Flint is reached over the LAN through a relay on the Mac, which starts at boot along with Flint (see "Install and run").
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
- **When to call it:** after Qwen fails the same test twice, when the user asks, or to review a
  proposed design/plan before implementation starts (added 2026-10-29; **unmeasured** — Flint's
  edge is measured on competitive programming, not design review, so its critiques are a strong
  second opinion that Qwen weighs, not an authority).
- **Never switch the session's model to Flint.** pi would re-send the whole history, which at 100K takes 6.5–9 min to prefill
  on the Mac.

## Install and run

```bash
cp .env.example .env            # MAC, MAC_SSH_KEY, FLINT_URL (never commit)
scripts/install.sh              # links the extension into ~/.pi/agent/extensions, fetches the key, writes the config
pi --extension extensions/ask-flint/index.ts   # or: try it for one run without installing
scripts/install.sh --uninstall
```
**Flint is reached over the LAN (2026-10-29).** `rec serve` binds loopback only, so the Mac runs a small TCP relay in front of
it: LAN `:11502` to `127.0.0.1:11500`. Both run as user LaunchAgents and start at boot (the Mac logs in automatically). They
live in mac-tuning: `scripts/flint_relay.py` and `scripts/install_launchd.sh`. rec's API key still guards every request (401
without it). The traffic is plain HTTP on the LAN.

**To change the Mac's address,** edit `baseUrl` in `~/.config/pi-escalation/config.json` (`http://<new-ip-or-name>:11502/v1`).
The next call uses it; nothing needs restarting. `.env` is only read by `install.sh` when it first writes that config.

**Optional SSH tunnel instead** (from before the relay, kept for a Mac without it): add a `tunnel` block and point `baseUrl`
at `127.0.0.1:<localPort>`.
- Before every call, `ask_flint` starts `ssh -N -L` if nothing listens on the local port, and restarts it if the host changed.
  This box has no service manager, so the tool manages the tunnel itself.
- State is kept in `~/.config/pi-escalation/tunnel.json`.
- `scripts/tunnel.sh` is the manual alternative.

Settings live in `~/.config/pi-escalation/config.json`, which overrides the defaults in `client.ts`:

| Setting | Default | Notes |
|---|---|---|
| `baseUrl` | `http://127.0.0.1:11501/v1` | `install.sh` writes `FLINT_URL` here (the Mac's LAN relay) |
| `tunnel` | unset | optional: `host` (the Mac's ssh target), `identity`, `localPort`, `remotePort` |
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
