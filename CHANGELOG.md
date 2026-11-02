# Changelog

Dates YYYY-MM-DD. Measured claims link to a result file next to them.

## Unreleased

### Added
- **`/friends off [name]` / `/friends on [name]`** — switch a friend's `ask_`/`review_` tools off without
  restarting pi, for when its box is down. Off means the tools are not declared to the model at all; a
  call that arrives anyway fails in milliseconds and names the switch. Persisted in
  `~/.config/pi-friends/state.json` (kept out of `config.json` so config stays shareable), so it survives
  a restart.
- **`/friends` now probes every friend** (`GET /models`, 2 s budget): `up 18 ms`, `DOWN: ECONNREFUSED`,
  `DOWN: no answer in 2s (host unreachable? is the box on?)`, or `HTTP 401 (reachable; key missing or
  wrong)` — reachable-but-mis-keyed is deliberately not reported as "the box is down".
- **`connectTimeoutSec`** (default 10), a second clock bounding only the wait for the server to *start*
  answering. Measured: a stopped server refuses in ~17 ms, but a powered-off box blackholes the SYN and
  the call sat for the full `timeoutMin` — 20 minutes, per call, and the agent may retry.

### Fixed
- `review_<name>`, one tool per friend alongside `ask_<name>`, sharing the friend's one queue. It
  fetches the diff itself (`staged` / `base` / `files` / `diff`) so a large diff never passes through
  the model's output tokens, reviews it blind with its own persona, and returns findings ranked
  `blocker/major/minor/note`, each with the test that should catch it, plus what it wanted to see.
  Over-budget changes are refused with a concrete split plan, never truncated.
- Outbound secret gate on every brief (`scanBrief`, `gateBrief`): block-tier token/key shapes and
  high-entropy credential assignments, warn-tier LAN IPs, home paths and internal hostnames. Reports
  rule names and line numbers only — never the matched text. Knobs: `scanBrief: block|warn|off`,
  `scanAllow`.
- Reviewer half in `extensions/friends/review.ts`: `REVIEW_SYSTEM`, `buildReviewBrief`, a tolerant
  `parseReview` (fenced JSON → widest brace slice → prose; `needs` from JSON or a `NEEDS:` section;
  severity sort; 12-cap) and `renderReview`. A finding with no runnable test is demoted to `note`.
- `reviewMaxTokens` (default 40960): reasoning-only exhaustion returns *no* review at all, and a
  6-file review was measured doing exactly that at 32768 tokens.
- Review bench under `test/review-harness/` with committed results, and its differential ground truth
  (`ground.test.ts`) that proves each planted bug changes behaviour before any number is trusted.

### Fixed
- A named friend in the legacy inline shape resolved to the *default* key file instead of its own —
  found by the friend on a second review round, reproduced as a failing test, then fixed.
- The pre-rename config-dir fallback is gone (it read the old config but looked for the key in the new
  dir, so it half-worked). `/friends` now reports zero friends and points at the stale config.
- `{"friends": []}` no longer yields a phantom friend on the default endpoint.
- `staged: false` was accepted and ignored; there was no way to review uncommitted work.
- Six defects the bench found, each now pinned by the test that was missing: caller abort reported as
  an unreachable server; SSE `error` events silently skipped; `Queue.run` wedged forever by a task
  that throws synchronously; a trailing SSE event without a newline dropped; one malformed `data:`
  line killing the whole call; friend names colliding or sanitizing to an empty tool name.
- `tunnel.ts` state now lives in the one config dir (its own comment had claimed so for a release) and
  the directory is created before the write.

### Changed
- Friend tools no longer set `executionMode: "sequential"` — that flag makes pi serialize the whole
  tool batch for the turn, which blocked per-friend fan-out; the per-friend queue is the real
  single-generation protection.
- Docs: the reviewer claim is now measured, with two result tables and their limits
  (`test/review-harness/README.md`) instead of "promising but unmeasured".
- `/friends` status lines lead with `on`/`OFF` and the probe result, before endpoint and model.

## 1.0.0

- `ask_<name>` per configured friend: one-turn, brief-only escalation over any OpenAI-compatible
  endpoint, per-friend one-at-a-time queue, streamed SSE with reasoning counted but not returned,
  brief size refused rather than truncated, optional on-demand SSH tunnel, `/friends`.
