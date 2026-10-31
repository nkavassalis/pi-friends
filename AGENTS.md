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
| `extensions/friends/review.ts` | the reviewer half: `REVIEW_SYSTEM` persona, `buildReviewBrief`, the lenient `parseReview`, `renderReview` (no pi imports) |
| `extensions/friends/tunnel.ts` | optional on-demand SSH tunnel (used only with a `tunnel` config block) |
| `test/client.test.ts`, `test/tunnel.test.ts`, `test/fake_ssh.mjs` | offline tests: fake OpenAI-compatible SSE server, fake ssh |
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
- `client.ts` must stay importable without pi (that is what makes the tests offline); all pi
  imports live in `index.ts`.
- A friend's server is assumed single-generation, so `Queue` is per friend, not global — two
  different servers should not serialize against each other.
- `loadFriends()` re-reads the file on every call (config edits need no restart) but tools register
  once at startup, so adding a friend needs a pi restart; changing its `baseUrl` does not.
- The pre-rename config dir `~/.config/pi-escalation/` is still read as a fallback
  (`resolveCfg`); remove that fallback once no install uses it (dated 2026-10-29).

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
  The per-friend `Queue` is what actually protects a single-generation server. Not yet changed —
  see TODOs.

## Known issues / TODOs
- `review.ts` is used by the bench but **no `review_<name>` tool is wired yet**; today a review means
  the agent pasting code into `ask_<name>` itself. Next: the tool (which should run `git diff`
  itself in `index.ts`, so a 40 KB diff never passes through the model's output tokens), the
  secret-scan gate on outbound briefs, and dropping `executionMode: "sequential"` after measuring
  overlap from `tool_execution_start/end` timestamps in a session log.
- Legacy key path: `resolveCfg` falls back to the pre-rename config dir but `keyFile` still defaults
  to the new one, so a half-migrated box cannot find its key (pinned by a test in `client.test.ts`).
  Fix by deleting the fallback, not by guessing a filename in the old dir.
- Real defects the bench found and nobody has fixed yet, all small: a caller abort is rewrapped as
  "cannot reach the server"; SSE `data:` events carrying an error are skipped; `Queue.run` leaks
  `pending` if `task()` throws synchronously; no final buffer/`TextDecoder` flush; one malformed
  `data:` line aborts the whole call; friend names can sanitize to the same or an empty tool name.

## Not verified (2026-10-31)
- Every bench number is **n=1 per trial, one friend, no seeds, no repeats**. Directional only.
- `KNOWN_GENUINE` in `run-review.ts` is a hand-curated list of seven defects that grew out of these
  runs; `genuine_missed` means "not in our list", not "everything a reviewer should have found".
- Finding classification is regex against the reviewer's own phrasing, so a correct finding worded
  unusually scores as `spurious`. The `answers` array in each result JSON is the real record.
- The `executionMode` claim above is from reading shipped JS, not from a timed run.

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
