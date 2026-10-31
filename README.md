# pi-friends

A [pi](https://pi.dev/) extension for consulting **other models on hard problems** — without ever
handing them your session. Each *friend* is any OpenAI-compatible chat endpoint; each gets two tools:
`ask_<name>` for a hard, self-contained problem, and `review_<name>` for a blind code review. The
agent writes a self-contained brief, the friend sees **only the brief** (no conversation history, no
files), and only the final answer comes back.

```json
{ "friends": [
  { "name": "flint", "baseUrl": "http://<reasoning-box>:11502/v1", "model": "flint" },
  { "name": "sage",  "baseUrl": "http://<review-box>:8000/v1",  "model": "sage",
    "reviewSystem": "You review plans. Answer with flaws ranked by severity." }
]}
```
→ tools `ask_flint` + `review_flint` and `ask_sage` + `review_sage`, each friend with one queue, its own
personas, descriptions and key file. Adding a friend is a config entry plus a key file — no code.

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
trust any friend.**

As a **reviewer** it is measured too, and the answer is "useful, not a gate": on a fixture generated
from this repo's own `client.ts` it caught 2 of 3 deliberately planted bugs and, on the unmodified
file, reported 3 defects that were all real with no hallucinations — including two nobody had
noticed. Reproduced three times, byte-identical (the server is deterministic for an identical prompt,
so that is reproducibility, not an error bar). Recall of 2/3 is why a friend's approval is never a
check: it is a second pair of eyes on what you told it you were unsure about. Numbers, method and the
limits of the sample: [`test/review-harness/README.md`](test/review-harness/README.md).

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
| `name` | `friend` | tools become `ask_<name>` and `review_<name>` (sanitized to `[a-z0-9_]`) |
| `baseUrl` | `http://127.0.0.1:11501/v1` | OpenAI-compatible base URL |
| `model` | `friend` | sent as `model` in the request |
| `keyFile` | `~/.config/pi-friends/<name>_key` | bearer token; read at call time, never logged |
| `system` | built-in | the solver persona for `ask_<name>` |
| `reviewSystem` | built-in | the reviewer persona for `review_<name>` (see `REVIEW_SYSTEM` in `review.ts`) |
| `reviewMaxTokens` | 40960 | review budget; reviews reason far longer than they write and a capped run returns **no** review at all |
| `scanBrief` | `block` | outbound secret gate on every brief: `block`, `warn` (send anyway, with a notice) or `off` |
| `scanAllow` | `[]` | literal substrings; a line containing one is skipped by the gate — for fixtures and docs examples |
| `description` / `label` / `guidelines` | built-in | override the tool's prompt text; `{{tool}}` is substituted |
| `maxTokens` | 32768 | reasoning **and** answer share this; reasoning-only exhaustion is reported as such |
| `temperature` / `topP` / `topK` | 0.6 / 0.95 / 20 | the measured-best setting for flint; tune per friend |
| `timeoutMin` | 20 | whole request, queue wait excluded |
| `maxBriefChars` | 64000 | longer briefs are refused with advice, never truncated |
| `tunnel` | unset | optional `{host, identity, localPort, remotePort}`: the tool opens/repairs a loopback `ssh -N -L` itself — for friends on machines that aren't always reachable |

## Reviewing code with a friend

```bash
review_flint  staged: true            # or base: "main", or files: [...], or your own diff: "..."
              question: "I'm not sure the queue accounting is right if task() rejects before pending-- — attack this"
              context: "single-generation server; the tool must never let two generations overlap"
```

- **The `question` is the highest-value field.** "Review my diff" gets style noise; naming what you
  are unsure about gets an attack on it. It is also the cheapest thing to send.
- **The diff is fetched by the tool**, not typed by the model: `staged` (default), `base`, `files`, or
  an explicit `diff`. A 40 KB diff re-emitted as answer tokens costs minutes and loses bytes.
- **Findings come back structured**, ranked `blocker/major/minor/note`, each with the test that should
  catch it, plus a `needs` list of what the reviewer wanted to see. A finding with no runnable test is
  demoted to `note` by the parser, not by the reviewer's own confidence.
- **Acceptance rule, enforced in the text the agent reads back:** a finding counts only if its test
  **fails on the code as it is and passes once fixed**. Never auto-apply a finding.
- **It is a second pair of eyes, not a gate.** Measured 2/3 recall on planted bugs
  ([`test/review-harness/README.md`](test/review-harness/README.md)) — its silence means nothing.
- **Two rounds maximum.** Each round is minutes on a single-generation server; use the second only if
  something in `needs` would change a verdict. It is worth spending sometimes: on 2026-10-31 round 2
  found a defect the fix from round 1 had missed, in a code path no test covered.
- Fan-out across *different* friends is free (separate servers, separate queues); two rounds of the
  same friend are not.

## Privacy & safety

- The friend receives **only** the brief and the system persona. No session history, no file paths
  unless the agent pasted them, no environment variables.
- Keys live in 600-mode files and are read at call time; nothing prints their contents.
- Briefs travel as plain HTTP by default — fine on a trusted LAN, put TLS or a tunnel in front of
  anything else. Treat anything in a brief as disclosed to that endpoint's operator.
- **Every outbound brief passes a secret gate** (`scanBrief`), because a review brief is a diff and a
  diff is where paths, hostnames and tokens live. Block-tier hits refuse the call and report only the
  rule name and line number — never the matched text, which would otherwise land in the transcript and
  the session log. It scans the **whole** brief including diff deletions: a removed line is sent too,
  so a commit that deletes a credential-shaped literal is refused on purpose (the tool tells you so and
  points at `files:[...]`). It is a tripwire, not DLP: `warn`/`off` and `scanAllow` exist, and a
  `scanAllow` entry suppresses a whole line, so keep entries narrow.
- The tool refuses empty and oversized briefs; it never silently cuts. An oversized diff comes back
  with a concrete split plan (`files:[...]` groups) rather than a partial review.

## Tests

```bash
node --experimental-strip-types --test test/*.test.ts test/review-harness/*.test.ts   # offline: fake OpenAI-compatible SSE server + fake ssh
bash -n scripts/*.sh
```

46 tests cover streaming (reasoning in `delta.reasoning`, answer in `delta.content`, usage in the
final empty-choices chunk), request shape and auth headers, timeouts, abort, the queue, the brief
limit, config loading (legacy + friends shapes, empty `friends: []`, name sanitizing, per-name and
empty `keyFile` defaults in every branch), the tunnel state machine, the reviewer half (`REVIEW_SYSTEM`,
the JSON contract and its prose fallback, `needs`, severity sorting, the 12-cap, the no-runnable-test
demotion, `git` argument validation and diff splitting), and the secret gate (every block rule, warn
rules, loopback and placeholders not tripping, `scanAllow`, no echoed secrets, diff deletions being
scanned, and a check that the gate does not refuse this repo's own tracked files).

The review bench is separate because it costs minutes, not milliseconds — it needs a real friend:

```bash
node --experimental-strip-types test/review-harness/run-review.ts --friend flint   # ~5 min per trial
node --experimental-strip-types test/review-harness/run-review.ts --dry-run        # brief sizes, no call
```

Its offline tier (`ground.test.ts`) is mandatory reading before trusting any number it prints: it
proves each planted bug actually changes behaviour. See
[`test/review-harness/README.md`](test/review-harness/README.md).

## License

MIT
