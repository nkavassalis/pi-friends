# Review bench

Measures what a friend actually catches when you ask it to review code. The README's claim that
design review is "promising but unmeasured" is only allowed to exist while this directory says so too.

```bash
node --experimental-strip-types test/review-harness/run-review.ts --friend flint        # ~4 min per trial
node --experimental-strip-types test/review-harness/run-review.ts --dry-run             # brief sizes, no call
node --experimental-strip-types --test test/review-harness/ground.test.ts               # offline, no friend
```

One run does both trials (clean, then all plants applied). The friend server is single-generation, so
do not run two of these, or a `review_<name>` call, at the same time.

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
| `genuine_found` / `genuine_missed` | latent concerns listed in `KNOWN_GENUINE` (each verified by reading the code) |
| `spurious` | matched nothing — a human must label it: real-but-unlisted, or hallucinated |

`KNOWN_GENUINE` is re-curated when its entries get fixed. On 2026-10-31 it named six defects; all six
were fixed the same day, so the list now names six *current* ones (per-process queue, orphaned server
generation on abort, no retry, unauthenticated plain HTTP, char-vs-token budget, the progress race).
Stored results therefore score against the list that was live when they ran — check the date.

Results land in `results/<stamp>-<friend>.{json,md}` and are committed next to any claim made about
them. The writer refuses to emit a URL, a non-loopback IP, a home path, a bearer token, or an
internal hostname.

## Measured — 2026-10-31, friend `flint`, persona `dbb7fa74bbf6`

Against the file as it stood before the six defect fixes (three repeats, byte-identical):

| trial | s | tokens in/out | contract | findings | demoted | plants caught | genuine found | spurious | `needs` |
|---|---|---|---|---|---|---|---|---|---|
| clean | 259–261 | 4613/21459 | json | 3 | 0 | — | 2/8 | 0 | 2 items |
| planted | 246–247 | 4596/20553 | json | 3 | 0 | **2/3** | 1/8 | 0 | 3 items |

Against the fixed file (one run, `2026103119441`):

| trial | s | tokens in/out | contract | findings | demoted | plants caught | genuine found | spurious | `needs` |
|---|---|---|---|---|---|---|---|---|---|
| clean | 288 | 5376/23152 | json | 2 | 1 | — | 0/6 | 1 (**real — a regression we had just introduced**) | 2 items |
| planted | 300 | 5380/24089 | json | 1 | 0 | 1/3 | 0/6 | 0 | 1 item |

**Read the two tables together: recall is 1–2 of 3 depending on the run, not a stable 2/3.** Two
samples of one deterministic run each is not an error bar; it is a warning that the denominator is too
small and the variance unknown. What has not varied across any run: it never fabricated a finding that
survived the test mandate, and the one hallucination it produced twice (`completionTokens` reads the
wrong usage field) was demoted to `note` by the parser and killed by a five-second look at the line.

The clean-trial finding above is the strongest evidence in this file: `keyOrDefault` was being fed the
*merged* config, so `DEFAULTS.keyFile` was always truthy and a friend named `work` would have silently
used `friend_key`. No test we had covered it; the reviewer's test failed before and passed after.

What it caught, every run: the queue-serialization plant (as a blocker, with the right test). What it
missed, every run: the missing `typeof` guard on `delta.content`. The timeout-units plant was caught in
the pre-fix runs and missed post-fix.

Same code and plants **before** the reviewer persona existed (an ad-hoc brief that overrode the solve
persona in prose, persona `488d6e456a28`, one run): 1/3 plants, 1 hallucinated finding, `needs` empty.
The persona is the difference between a reviewer that admits what it guessed and one that does not.

## What these numbers do not support

- **n=1 per configuration.** Three identical completions from a deterministic server are one sample,
  and the pre-fix and post-fix runs disagree on recall. Say "reproducible", not "3/3 runs", and never
  quote recall without the run file next to it.
- **Three plants is a tiny recall denominator**, and the same three every time. More plants, and
  paraphrased briefs, are the way to get real spread.
- **Classification is regex against the reviewer's own phrasing.** A correct finding expressed
  unusually scores as `spurious`; `answers` in the JSON is the ground truth, and `KNOWN_GENUINE` is a
  hand-curated list that grew out of these runs — `genuine_missed` means "not in our list", not
  "everything a reviewer should have found".
- **Latency is the real cost: ~4 minutes and 20K reasoning tokens per trial**, and reasoning-only
  exhaustion is a total loss (a 6-file review once used all 32768 tokens and returned nothing), which
  is why `reviewMaxTokens` exists and the bench uses the same budget the tool ships with.
- Playwright, live servers and anything needing the network are out of scope here by design; the
  offline tier is the fake SSE server only.

## Adding a plant

Add an entry to `PLANTS` with `find`/`replace` copied from the current `client.ts`, plus `match`
regexes, then add its differential assertion to `ground.test.ts`. Run the ground tier: if the
planted and clean assertions both pass, your plant is not a bug — make it one, or drop it.
