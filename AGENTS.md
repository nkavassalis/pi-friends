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
| `extensions/friends/index.ts` | the pi extension: per configured friend an `ask_<name>` and a `review_<name>` tool, plus `/friends` |
| `extensions/friends/client.ts` | config (legacy + `friends[]` shapes), per-friend one-at-a-time queue, the streamed request, brief check, the outbound secret gate, the on/off state file, the reachability probe (no pi imports) |
| `extensions/friends/review.ts` | the reviewer half: `REVIEW_SYSTEM` persona, `buildReviewBrief`, the lenient `parseReview`, `renderReview` (no pi imports) |
| `extensions/friends/tunnel.ts` | optional on-demand SSH tunnel (used only with a `tunnel` config block) |
| `test/client.test.ts`, `test/tunnel.test.ts`, `test/fake_ssh.mjs` | offline tests: fake OpenAI-compatible SSE server, fake ssh |
| `test/scan.test.ts` | the outbound secret gate: every rule, the allow list, no echoed secrets, and that the gate does not refuse this repo's own files |
| `test/review.test.ts` | offline tests for the reviewer half (contract parsing, prose fallback, demotion, sorting, cap) |
| `test/review-harness/plants.ts` | the review fixture, generated from the real `client.ts` by textual patch — drift fails loudly |
| `test/review-harness/ground.test.ts` | differential ground truth: clean behaves, each plant misbehaves. Read this before trusting any bench number |
| `test/review-harness/run-review.ts` | the scored bench: sends clean + planted to a friend, classifies findings, writes `results/` |
| `test/review-harness/results/` | committed measurements; a claim in the README needs a file here next to it |
| `scripts/tunnel-flint.sh` | manual alternative: loopback-only SSH tunnel to the Mac, self-restarting |
| `scripts/install-flint.sh [--uninstall]` | provisions the flint example: symlink, key, default config |

## Tests (run before every commit)
```bash
node --experimental-strip-types --test test/*.test.ts test/review-harness/*.test.ts
bash -n scripts/*.sh
git diff --cached | grep -nE '([0-9]{1,3}\.){3}[0-9]{1,3}|/home/|/Users/|hf_[A-Za-z0-9]{10,}|gh[pousr]_[A-Za-z0-9]{10,}'   # 127.0.0.1 is fine
```
Run pi from scripts with `< /dev/null`: piped stdin becomes part of the prompt.

The bench is not in that list because it needs a live friend and costs ~5 min per trial:
`node --experimental-strip-types test/review-harness/run-review.ts --friend flint`. Its offline tier
(`ground.test.ts`) is in the list and is what makes the bench's numbers mean anything.

## Notes for agents
- `client.ts` and `review.ts` must stay importable without pi (that is what makes the tests offline);
  all pi imports live in `index.ts`. Tests must therefore never import `index.ts`.
- A friend's server is assumed single-generation. `Queue` is per friend, not global — two different
  servers should not serialize against each other — and `ask_<name>` and `review_<name>` **share** it.
  The protection is per process: two pi sessions against one friend still overlap.
- Friend tools deliberately do **not** set `executionMode: "sequential"`: that flag makes pi take the
  sequential path for the whole tool batch (`pi-agent-core` `agent-loop.js`), which would stop two
  different friends from running in one turn. The `Queue` is what protects a single-generation server.
- **Two clocks** on the request. `timeoutMin` bounds the whole generation (reasoning models are slow,
  that is normal); `connectTimeoutSec` (default 10) bounds only the wait for the server to *start*
  answering. Measured 2026-10-31: a stopped server gives `ECONNREFUSED` in ~17 ms, but a **powered-off
  box blackholes the SYN** and the call sat for the full 20 minutes. The connect abort fires only until
  headers arrive (`clearTimeout` after that), so a slow-but-alive server is never cut off.
- **Off means undeclared, not unregistered.** `/friends off` sets `defaultActive: false` at registration
  and removes the pair from `pi.setActiveTools()`; the tools stay loaded so `/friends on` works in the
  same session. `guardDisabled` at the top of both `execute`s is the belt — it also covers the case where
  the state file changed after startup. State lives in `state.json`, **not** `config.json`, so config
  stays shareable. `loadState` treats a corrupt file as "nothing disabled" (a half-written file must not
  take the extension down), unlike `loadConfig`, which is loud: a broken config is worth an error.
- `probeFriend` is `GET /models` with its own 2 s budget. `HTTP 401/403` is reported as *reachable, key
  wrong* — that is not "the box is down", and conflating the two would send you to check the power.
- `loadFriends()` re-reads the file on every call (config edits need no restart) but tools register
  once at startup, so adding a friend needs a pi restart; changing its `baseUrl` does not.
  `{"friends": []}` means no friends — it no longer silently yields a phantom friend on the default
  endpoint, and `/friends` says so (and points at the pre-rename dir if a config is sitting there).
- The pre-rename config-dir fallback (the project's old name, same location under the user's config
  directory) was **deleted 2026-10-31**: it read the old config but still looked for the key in the new
  dir, so it half-worked and confused more than it helped. The inline single-friend *shape* is still
  supported. There is one config location now — `tunnel.ts` state moved to the same dir on the same
  date (its comment already said so; the code did not). `/friends` points there if a config is left.
- A review brief is a diff, so it goes through `gateBrief` before anything is sent. Keep gate logic in
  `client.ts` (offline-testable), never in `index.ts`.
- Fake credentials in tests must be **assembled at run time** (`"AKIA" + "ABC…"`, `.join("/")`). A whole
  credential on one source line makes `test/scan.test.ts`'s last test refuse a diff of pi-friends
  itself — which is exactly what ate an 8-minute review call on 2026-10-31 while that file was still
  untracked.
- **To exercise `index.ts` (tool registration, `/friends`) without pi:** copy `extensions/friends/*.ts`
  to a scratch dir, symlink that dir's `node_modules` to the pi install's, run a driver with `HOME=` a
  temp dir (so `CONFIG_PATH`/`FRIENDS_STATE_PATH` resolve there) and a stub `ExtensionAPI`
  (`registerTool`/`registerCommand` capture, `getActiveTools`/`setActiveTools` over an array, `ui.notify`
  collects) against an in-process fake SSE server. That is how the off/on switch was verified on
  2026-10-31 — `pi --print "/friends"` prints nothing, because slash commands do not run in print mode.
  Keep it out of `npm test`: it depends on pi's packages being installed.

## Design decisions, reviewer half (2026-10-31)

- **Review is a separate persona, not a hint in the tool description.** With the solve persona
  overridden only in brief prose, the bench got 1/3 plants, one hallucinated finding and an empty
  `needs`. With `REVIEW_SYSTEM` it got 2/3 plants, no hallucinations, and it named what it had
  guessed. Same model, same code, same plants — the persona is the mechanism, so it lives in code.
- **A finding must earn its keep with a runnable test.** `parseReview` mechanically demotes any
  finding whose `test` is missing or vague to `note`, and `renderReview` restates the acceptance
  rule where the agent reads it: the test must FAIL on the code as it is and PASS on the fixed code.
  This is what caught a hallucinated finding in seconds during the first trial.
- **The parser is lenient and never loses the answer.** Fenced ```json, then the widest `{...}`
  slice, then prose; `needs` also comes from a `NEEDS:` section; `raw` is always kept. A reasoning
  model that ignores the contract degrades to "here is its prose", never to nothing.
- **The bench generates its fixture from the shipped file.** `plants.ts` patches the real
  `client.ts` text; a plant that no longer matches exactly once is an error, not a silent skip. And
  a plant that does not change behaviour is not a bug — `ground.test.ts` is the gate on that, and it
  caught one such fake plant on the day this was written.
- **`executionMode: "sequential"` on friend tools serializes the whole tool batch**, not just that
  tool: pi's loop takes the sequential path if *any* tool in the turn is marked sequential
  (`pi-agent-core/dist/agent-loop.js`). So per-friend fan-out is NOT free while that flag is set.
  The per-friend `Queue` is what actually protects a single-generation server. Dropped from both
  friend tools 2026-10-31; still not confirmed by a timed run — see Not verified.
- **The tool fetches the diff, the model does not type it** (`staged`/`base`/`files`/`diff`). A 40 KB
  diff re-emitted as answer tokens costs minutes and loses bytes. Because `base` and `files` come from
  the model, `gitArgsFor` validates them (no leading `-`, no `..`, no flags, `--no-ext-diff`, pathspecs
  after `--`) and the tests assert flag injection is refused.
- **Reviews get their own token budget** (`reviewMaxTokens`, default 40960, `> 0` enforced in both the
  tool and the bench). Measured: a 5-file review used 25K tokens; a 6-file one consumed all 32768
  reasoning tokens and returned **nothing** after 493 s. Reasoning-only exhaustion is a total loss, not
  a degraded answer, so the budget must be generous and the persona says so.
- **Two rounds pay for themselves — measured the same day.** Round 1 caught the queue and timeout
  plants; after we fixed the empty-`keyFile` symptom in the `friends[]` branch, round 2 found the legacy
  inline branch still had it, because `{ ...DEFAULTS, ...file }` lets an explicit `""` overwrite the
  default. No test we had would have found that. The acceptance rule worked: the session ran the
  reviewer's test (fails before, passes after) before adopting it.

## Known issues / TODOs
- **The gate is a tripwire, not DLP, and it scans the WHOLE brief including diff deletions** — a removed
  line is sent to the friend too, so a commit that deletes a credential-shaped literal is refused on
  purpose. That reads like a false positive (it refused our own diff twice on 2026-10-31), so
  `review_<name>` says so explicitly and points at `files:[...]` / `scanAllow`. Pinned by a test in
  `test/scan.test.ts`; do not "fix" it by scanning only `+` lines.
  Other gaps: `scanBrief: "warn"/"off"` and `scanAllow` are operator config (the model cannot pass its
  own allow list, but one knob disables the gate); an `scanAllow` entry suppresses a whole line, so a
  real secret on an allowed line is missed; `highEntropy` needs ≥16 chars, so a 15-char `token: "…"` is
  a notice that still sends; nothing looks inside base64 or prose. Fix a false positive by narrowing
  the rule, never by weakening it.
- Six real defects the bench found were **fixed 2026-10-31**, each pinned by the test that used to be
  missing: caller abort reported as a cancellation; SSE `error` events thrown instead of skipped;
  `Queue.run` surviving a synchronously-throwing task; final buffer/`TextDecoder` flush; a malformed
  `data:` line tolerated and counted (`badChunks`, shown in the stats line — tolerated, never silent);
  friend names that collide or sanitize to nothing are a loud config error. Also `keyFile` defaults now
  cover every config branch.
- What is still true and nobody has fixed: the queue only serializes **within one process** (two pi
  sessions against one friend overlap); aborting the fetch does not stop the server's generation, so the
  single slot stays busy; a dropped connection loses a 4-minute generation with no retry; the endpoint
  is trusted blindly over plain HTTP; the brief budget is counted in characters while prefill costs
  tokens; `queue.length` for the waiting message is read outside the queue.

## Not verified (2026-10-31)
- The off/probe/connect-timeout wiring **was** driven end-to-end against the real `index.ts` (stub
  `ExtensionAPI`, fake `$HOME`, in-process SSE server — see the note above): disabled ⇒ `defaultActive:
  false` and a call that fails before touching the socket; `/friends` ⇒ `up 18 ms`; `on`/`off` ⇒ active
  set and `state.json` both update; unknown name ⇒ error. What that driver cannot prove is how pi itself
  treats `defaultActive: false` in a real session (it reads pi's shipped types, not a live TUI), and
  whether `setActiveTools` mid-turn is honoured by the running loop.
- Every bench number is one friend, no seeds, no repeats per run. Repeats are what
  `test/review-harness/results/` is for — quote the file, not a single run.
- The `executionMode` claim above is from reading shipped JS, not from a timed two-friend run. To
  settle it: configure two friends, call both in one turn, compare `tool_execution_start/end`
  timestamps in the session JSONL.
- `KNOWN_GENUINE` in `run-review.ts` is a hand-curated list of defects that grew out of these runs;
  `genuine_missed` means "not in our list", not "everything a reviewer should have found".
- Finding classification is regex against the reviewer's own phrasing, so a correct finding worded
  unusually scores as `spurious`. The `answers` array in each result JSON is the real record.
- The gate has never been exercised against a real leaked credential in the wild; only against the
  shapes in `test/scan.test.ts`.

## Do not touch
- `client.ts` and `review.ts` must not import pi — that is what keeps the suite offline.
- Do not truncate a brief or a diff; refuse, as `checkBrief` does.
- Do not make a friend's verdict a gate, or let anything auto-apply a finding.
- Bench results in `results/` are committed: keep them public-safe (the writer enforces no URLs,
  non-loopback IPs, home paths, bearer tokens or internal hostnames — do not weaken it).

## Guardrails in effect
- `assertPublicSafe` refuses to write a bench result containing an endpoint, IP, home path, token or
  internal hostname.
- `plants.ts` refuses to run a plant whose `find` text does not match `client.ts` exactly once.
- `ground.test.ts` fails if a plant stops changing behaviour.
