# pi-friends

A [pi](https://pi.dev/) extension for consulting **other models on hard problems** — without ever
handing them your session. Each *friend* is any OpenAI-compatible chat endpoint; each gets its own
`ask_<name>` tool. The agent writes a self-contained brief, the friend sees **only the brief** (no
conversation history, no files), and only the final answer comes back.

```json
{ "friends": [
  { "name": "flint", "baseUrl": "http://<reasoning-box>:11502/v1", "model": "flint" },
  { "name": "sage",  "baseUrl": "http://<review-box>:8000/v1",  "model": "sage",
    "system": "You review plans. Answer with flaws ranked by severity." }
]}
```
→ tools `ask_flint` and `ask_sage`, each with its own queue, persona, description and key file.
Adding a friend is a config entry plus a key file — no code.

## Why this shape

Big-model escalation usually means switching the session's model, which re-sends the whole
conversation. That is slow (prefill dominates on small hardware), leaks the entire history to a
third endpoint, and pollutes the friend's context with tool-call noise. Friends invert it:

- **One turn, brief only.** The friend prefills ~1–16K tokens you *chose*, not 100K you didn't.
- **Answer, not transcript.** Reasoning tokens are counted for stats but never returned; the agent
  gets the solution, applies it, and runs the tests. (Verification is the agent's job — a friend's
  answer is a strong suggestion, not authority.)
- **Good briefs are a skill, so the tool teaches it.** The tool description tells the agent what a
  brief must contain (goal, code pasted, failing output, constraints, what was tried) and refuses
  briefs over `maxBriefChars` instead of silently truncating them.
- **Per-friend queues with progress.** Local servers (llama.cpp, rec, vLLM single-worker) serve one
  generation at a time; the tool serializes and reports "waiting for N earlier call(s)".

A measured example of the trade-off (same problems, seeds and sandbox on both machines; details in
[spark-tuning](https://github.com/nkavassalis/spark-tuning) and
[mac-tuning](https://github.com/nkavassalis/mac-tuning)): a local agent model (Qwen FP4, 2× GB10)
solves ~51% of hard LiveCodeBench problems; a reasoning model on a Mac mini (Recursive Flint int4)
solves ~71% of the same set — and solves almost everything the agent model solves. Routing the hard
problems to the friend beat racing both models. **Your numbers will differ; measure before you
trust any friend.** Flint's edge is measured on competitive programming; its use as a *design
reviewer* (which the tool also supports) is promising but unmeasured.

## Install

```bash
pi install git:github.com/nkavassalis/pi-friends@v1.0.0     # or npm: pi install npm:pi-friends
# or from a clone, for development:
pi --extension extensions/friends/index.ts                  # one run, nothing installed globally
```

Then write `~/.config/pi-friends/config.json` (see the shape above) and a key file per friend that
auths: `~/.config/pi-friends/<name>_key` (mode 600; contents never displayed by anything here).
`/friends` inside pi lists configured friends — tool, endpoint, model, key status, tunnel/direct.
Config is re-read per call, so `baseUrl`/key edits take effect without a restart; a **new friend**
needs a pi restart (tools register at startup).

If you host Flint with [Recursive's `rec`](https://github.com/recursive-org) on a Mac,
`scripts/install-flint.sh` provisions that one friend (fetches the key over SSH, writes the config);
`scripts/tunnel-flint.sh` is the manual SSH-tunnel fallback. Everything else in this repo is
friend-agnostic.

## Settings

`~/.config/pi-friends/config.json` — either `{"friends":[{...}, ...]}` or a single friend inline
(legacy shape; loads as one friend named `friend`). Unknown keys are passed through; missing keys
take the defaults in `client.ts`.

| Setting | Default | Notes |
|---|---|---|
| `name` | `friend` | tool becomes `ask_<name>` (sanitized to `[a-z0-9_]`) |
| `baseUrl` | `http://127.0.0.1:11501/v1` | OpenAI-compatible base URL |
| `model` | `friend` | sent as `model` in the request |
| `keyFile` | `~/.config/pi-friends/<name>_key` | bearer token; read at call time, never logged |
| `system` | built-in | one-turn persona; set per friend (e.g. reviewer vs solver) |
| `description` / `label` / `guidelines` | built-in | override the tool's prompt text; `{{tool}}` is substituted |
| `maxTokens` | 32768 | reasoning **and** answer share this; reasoning-only exhaustion is reported as such |
| `temperature` / `topP` / `topK` | 0.6 / 0.95 / 20 | the measured-best setting for flint; tune per friend |
| `timeoutMin` | 20 | whole request, queue wait excluded |
| `maxBriefChars` | 64000 | longer briefs are refused with advice, never truncated |
| `tunnel` | unset | optional `{host, identity, localPort, remotePort}`: the tool opens/repairs a loopback `ssh -N -L` itself — for friends on machines that aren't always reachable |

## Privacy & safety

- The friend receives **only** the brief and the system persona. No session history, no file paths
  unless the agent pasted them, no environment variables.
- Keys live in 600-mode files and are read at call time; nothing prints their contents.
- Briefs travel as plain HTTP by default — fine on a trusted LAN, put TLS or a tunnel in front of
  anything else. Treat anything in a brief as disclosed to that endpoint's operator.
- The tool refuses empty and oversized briefs; it never silently cuts.

## Tests

```bash
node --experimental-strip-types --test test/*.test.ts   # offline: fake OpenAI-compatible SSE server + fake ssh
bash -n scripts/*.sh
```

16 tests cover streaming (reasoning in `delta.reasoning`, answer in `delta.content`, usage in the
final empty-choices chunk), request shape and auth headers, timeouts, abort, the queue, the brief
limit, config loading (legacy + friends shapes, name sanitizing, per-name key defaults) and the
tunnel state machine.

## License

MIT
