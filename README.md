# pi-escalation

Use two local models from one [pi](https://pi.dev/) agent. Qwen on the 2× DGX Spark cluster does the agent loop. Recursive
Flint on a Mac mini is called for hard, self-contained reasoning problems.

**Status 2026-10-29:** a plan, not built yet. It waits for the Mac mini to be on the network as a Flint server.

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

## Open before building

1. Check pi's extension API for registering a tool.
2. Put the Mac's `rec` server on the LAN with an API key. It binds 127.0.0.1 today.
3. Measure whether escalation helps: 10–20 real tasks, with and without `ask_flint`, comparing tests passed and wall-clock time.
   Nothing here is measured on agent tasks yet; the numbers above are benchmarks.
