# Review bench

Measures what a friend actually catches when you ask it to review code. The README's claim that
design review is "promising but unmeasured" is only allowed to exist while this directory says so too.

```bash
node --experimental-strip-types test/review-harness/run-review.ts --friend flint        # ~5 min per trial
node --experimental-strip-types test/review-harness/run-review.ts --dry-run             # brief sizes, no call
node --experimental-strip-types --test test/review-harness/ground.test.ts               # offline, no friend
```

## How it works

`plants.ts` generates the fixture **from the real `extensions/friends/client.ts`** by applying
textual patches, so it cannot drift silently: if a `find` string stops matching exactly once, the
harness fails and says which plant drifted.

`ground.test.ts` is what licenses every number below. It asserts, on the same assertion, that the
clean copy behaves correctly and each planted copy behaves wrongly. A plant that does not change
behaviour measures nothing — one of the three did exactly that when first written (the queue patch
broke the counter but left the tail-chaining intact, so calls still serialized), and this file is
how it got caught before it could produce a fake "missed".

`run-review.ts` sends the same file to the friend twice — clean, and with all plants applied — using
the real `askFriend()` and the real `REVIEW_SYSTEM` persona, parses the answer with `parseReview()`,
and classifies each finding by matching the reviewer's own words:

| bucket | meaning |
|---|---|
| `hits` / `misses` | the planted bugs, planted trial only |
| `genuine_found` / `genuine_missed` | latent defects listed in `KNOWN_GENUINE` (each verified by hand before being listed) |
| `spurious` | matched nothing — a human must label it: real-but-unlisted, or hallucinated |

Results land in `results/<stamp>-<friend>.{json,md}` and are committed next to any claim made about
them. The writer refuses to emit a URL, a non-loopback IP, a home path, a bearer token, or an
internal hostname.

## Measured — 2026-10-31, friend `flint`, persona `488d6e456a28`, n=1 per trial

| trial | s | tokens in/out | contract | findings | demoted | plants caught | genuine found | spurious | `needs` |
|---|---|---|---|---|---|---|---|---|---|
| clean | 227 | 2954/19897 | json | 3 | 0 | — | 2/6 (+1 newly verified) | 0 | 3 items |
| planted | 300 | 2937/25147 | json | 3 | 0 | 2/3 | 1/6 | 0 | 2 items |

All three clean-trial findings were real: the caller-abort-masquerading-as-unreachable-server bug,
SSE `error` events being skipped, and — not previously known to us — the pre-rename config dir being
read while `keyFile` still defaults to the new dir, which breaks a half-migrated install. Zero
hallucinations. In the planted trial it caught the timeout-units and queue-serialization bugs and
missed the missing `typeof` guard on `delta.content`.

Same code, same plants, **before** the reviewer persona existed (an ad-hoc brief that overrode the
solve persona in prose, 2026-10-31): 1/3 plants, 1 hallucinated finding, `needs` empty. The persona
is the difference between a reviewer that admits what it guessed and one that does not.

## What these numbers do not support

- **n=1 per trial, one friend, no seeds, no repeats.** The 2/3 vs 1/3 comparison is one sample each;
  it is a direction, not a measurement with an error bar. Re-run before quoting it anywhere.
- **Classification is regex against the reviewer's own phrasing.** A correct finding expressed
  unusually scores as `spurious`; `answers` in the JSON is the ground truth, and `KNOWN_GENUINE` is
  a hand-curated list of seven defects that grew out of these runs — it is not exhaustive, so
  `genuine_missed` means "not in our list", not "the reviewer should have found everything".
- **Three plants is a tiny recall denominator.** Treat recall as directional until there are more.
- **Latency is the real cost: 4–5 minutes and 20–25K reasoning tokens per trial.** One review per
  push, not per edit.
- Playwright, live servers and anything needing the network are out of scope here by design; the
  offline tier is the fake SSE server only.

## Adding a plant

Add an entry to `PLANTS` with `find`/`replace` copied from the current `client.ts`, plus `match`
regexes, then add its differential assertion to `ground.test.ts`. Run the ground tier: if the
planted and clean assertions both pass, your plant is not a bug — make it one, or drop it.
