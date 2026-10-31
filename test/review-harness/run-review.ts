// The scored review bench: sends the same code to a friend twice — once clean, once with the plants
// applied — and grades the answer against ground truth from ground.test.ts. This is what turns the
// README's "design review is unmeasured" into a number with a result file next to it.
//
//   node --experimental-strip-types test/review-harness/run-review.ts [--friend flint] [--trials clean,planted] [--dry-run]
//
// Writes results/<stamp>-<friend>.json (everything) and .md (the summary) — both public-safe by
// construction: friend NAME only, never baseUrl, and the writer refuses to emit a URL or a non-loopback IP.
// Exit 0 even on a bad review: this measures, it does not assert. The assertions live in ground.test.ts.
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { askFriend, loadFriends, readKey } from "../../extensions/friends/client.ts";
import { buildReviewBrief, parseReview, REVIEW_SYSTEM, type Review } from "../../extensions/friends/review.ts";
import { PLANTS, sourceUnderTest } from "./plants.ts";

const RESULTS = new URL("./results/", import.meta.url);
const argv = process.argv.slice(2);
const flag = (k: string, d?: string) => {
	const i = argv.indexOf(`--${k}`);
	return i < 0 ? d : argv[i + 1];
};
const friendName = flag("friend", "flint");
const trials = (flag("trials", "clean,planted") as string).split(",").map((s) => s.trim()).filter(Boolean);
const dryRun = argv.includes("--dry-run");

/** Fixed, neutral framing: any change here invalidates comparison with stored results. */
const CONTEXT = [
	"WHAT THIS CODE IS: the client half of a pi (coding agent) extension that consults a second, slower",
	"reasoning model over an OpenAI-compatible HTTP endpoint. The friend server is single-generation",
	"(llama.cpp / rec / vLLM single worker): exactly ONE generation at a time, which is why calls go",
	"through the queue. The agent calls a tool with one self-contained text brief; this module streams",
	"the reply, separating reasoning tokens (counted, never returned) from the answer. Config lives in",
	"~/.config/pi-friends/config.json; the API key lives in a 600-mode file read at call time.",
	"",
	"HOW IT IS CALLED (context only, not under review):",
	"  const bad = checkBrief(cfg, params.brief); if (bad) throw new Error(bad);",
	"  const key = readKey(cfg);",
	"  const r = await queue.run(() => askFriend(cfg, key, params.brief, signal, onProgress, system));",
	"  // r.answer empty -> the tool throws; r.finish === \"length\" -> reported as token-budget exhaustion",
	"`signal` is the agent's abort signal (the user pressed escape). onProgress fires at most every 2 s.",
	"",
	"EXISTING TESTS, all passing against this exact code (offline, fake SSE server): streaming (reasoning",
	"in delta.reasoning, answer in delta.content, usage in a final empty-choices chunk), request shape and",
	"Authorization header, HTTP-error surfacing, unreachable server, timeout on a stalled stream, caller",
	"abort, queue one-at-a-time in order surviving a failure, brief empty/over/at limit, config load",
	"(missing file, overrides, bad JSON), key file read and trim, per-name keyFile default, name sanitizing.",
].join("\n");
const QUESTION =
	"Where would this break for a real user of the tool? Look hardest at the queue, the SSE parsing " +
	"loop, the timeout/abort handling, and the config and key-file paths.";

/** What a good reviewer SHOULD raise on this file today (each verified by reading the code). The six
 *  latent defects that were here — abort mislabel, skipped SSE errors, pending leak, missing flush,
 *  fatal JSON.parse, name collisions — were FIXED on 2026-10-31; keeping them would turn every clean
 *  run into a wall of misses. Re-curate this list whenever you fix something it names. */
const KNOWN_GENUINE: { id: string; label: string; match: RegExp[] }[] = [
	{ id: "queue-is-per-process", label: "the queue only serializes within one pi session; two sessions still overlap", match: [/queue|serial|one at a time/i, /process|session|two |another |concurrent/i] },
	{ id: "abort-orphansthe-generation", label: "aborting the fetch does not stop the server's generation, so the single slot stays busy", match: [/abort|cancel/i, /server|generation|slot|keep|still|busy|orphan|waste/i] },
	{ id: "no-retry-on-transient-failure", label: "a dropped connection loses the whole 4-minute generation; there is no retry or resume", match: [/retry|retries|backoff|transient|reconnect|resume|dropped|partial/i] },
	{ id: "unauthenticated-plain-http", label: "the endpoint is trusted blindly: plain HTTP, no TLS, no proof you are talking to your own server", match: [/http|tls|https|authenticat|trust|verif|mitm/i, /endpoint|server|url|lan|network|anyone/i] },
	{ id: "budget-measured-in-chars", label: "the brief budget is counted in characters while prefill cost is in tokens", match: [/char/i, /token|prefill|budget|limit/i] },
	{ id: "progress-counter-race", label: "queue.length is read outside the queue for the waiting message", match: [/queue\.length|progress|waiting/i, /race|stale|outside|before|misleading|wrong/i] },
];

const textOf = (f: { where: string; claim: string; why: string; test: string }) => `${f.where} ${f.claim} ${f.why} ${f.test}`;
const hits = (f: any, match: RegExp[]) => match.every((re) => re.test(textOf(f)));

function grade(review: Review, plantIds: string[]) {
	const claimed = new Set<string>();
	const matchedPlants = new Set<string>();
	const matchedGenuine = new Set<string>();
	const spurious: string[] = [];
	for (const f of review.findings) {
		const plant = PLANTS.find((p) => plantIds.includes(p.id) && !matchedPlants.has(p.id) && hits(f, p.match));
		if (plant) {
			matchedPlants.add(plant.id);
			claimed.add(f.claim);
			continue;
		}
		const g = KNOWN_GENUINE.find((k) => !matchedGenuine.has(k.id) && hits(f, k.match));
		if (g) {
			matchedGenuine.add(g.id);
			claimed.add(f.claim);
			continue;
		}
		if (f.severity === "note") continue; // a demoted guess costs nothing; only acting-on-able noise is scored
		spurious.push(`${f.severity}: ${f.where} — ${f.claim}`);
	}
	return {
		plants: plantIds,
		hits: [...matchedPlants],
		misses: plantIds.filter((id) => !matchedPlants.has(id)),
		genuine_found: [...matchedGenuine],
		genuine_missed: KNOWN_GENUINE.map((k) => k.id).filter((id) => !matchedGenuine.has(id)),
		spurious, // needs a human label: real-but-unlisted, or hallucinated
	};
}

async function runTrial(name: string, ids: string[]) {
	const friends = loadFriends();
	const cfg = friends.find((f) => f.name === friendName);
	if (!cfg) throw new Error(`no friend named ${friendName} (configured: ${friends.map((f) => f.name).join(", ") || "none"})`);
	const brief = buildReviewBrief({ target: `extensions/friends/client.ts — the whole file, review it as the change`, diff: sourceUnderTest(ids), question: QUESTION, context: CONTEXT });
	if (dryRun) {
		console.log(`${name}: brief ${brief.length} chars (limit ${cfg.maxBriefChars}), persona sha ${createHash("sha256").update(REVIEW_SYSTEM).digest("hex").slice(0, 12)}`);
		return { trial: name, briefChars: brief.length, dry: true };
	}
	const t0 = Date.now();
	// Same budget the shipped tool uses (including its > 0 guard), or the bench measures a configuration nobody runs.
	const rt = cfg.reviewMaxTokens && cfg.reviewMaxTokens > 0 ? cfg.reviewMaxTokens : cfg.maxTokens;
	const r = await askFriend({ ...cfg, maxTokens: rt }, readKey(cfg), brief, undefined, (p) => process.stderr.write(`\r${name}: ${Math.round(p.seconds)}s ${p.reasoningChars} reasoning ${p.answerChars} answer   `), REVIEW_SYSTEM);
	process.stderr.write("\n");
	const review = parseReview(r.answer);
	return {
		trial: name,
		plants: ids,
		seconds: Math.round(r.seconds),
		promptTokens: r.promptTokens,
		completionTokens: r.completionTokens,
		finish: r.finish,
		briefChars: brief.length,
		format: review.format,
		answerSha: createHash("sha256").update(review.raw).digest("hex").slice(0, 12), // identical shas across runs = the server answered deterministically, not that the result is robust
		findingCount: review.findings.length,
		bySeverity: review.findings.reduce((a: Record<string, number>, f) => ((a[f.severity] = (a[f.severity] ?? 0) + 1), a), {}),
		demoted: review.findings.filter((f) => f.demoted).length,
		needs: review.needs,
		...grade(review, ids),
		answers: review.findings.map((f) => ({ severity: f.severity, demoted: f.demoted, where: f.where, claim: f.claim, test: f.test })),
		raw: review.raw,
	};
}

/** Public-safe write: this directory gets committed. Names only, never endpoints or machine paths. */
function assertPublicSafe(s: string, where: string) {
	const bad =
		/https?:\/\/\S+/.exec(s) ||
		/\b(?!127\.0\.0\.1)(\d{1,3}\.){3}\d{1,3}\b/.exec(s) ||
		/\/home\/|\/Users\/|Bearer\s+\S/.exec(s) ||
		/\b[\w-]+\.(internal|lan|local|home|corp)\b/i.exec(s) ||
		/\b[\w-]+\.int\.[\w-]+\.[a-z]{2,}\b/i.exec(s); // <host>.int.<domain> — an internal name needs no scheme to leak
	if (bad) throw new Error(`harness: refusing to write ${where}, it contains ${JSON.stringify(bad[0])}`);
}

const persona = createHash("sha256").update(REVIEW_SYSTEM).digest("hex").slice(0, 12);
const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 13);
const out: any = { friend: friendName, persona, date: new Date().toISOString(), trials: [] };
for (const t of trials) {
	const ids = t === "planted" ? PLANTS.map((p) => p.id) : [];
	out.trials.push(await runTrial(t, ids));
}

if (dryRun) {
	console.log(JSON.stringify(out, null, 2));
} else {
	mkdirSync(RESULTS, { recursive: true });
	const base = join(RESULTS.pathname, `${stamp}-${friendName}`);
	const md = [
		`# Review bench ${stamp} — friend \`${friendName}\` (persona \`${persona}\`)`,
		"",
		"| trial | s | tokens (in/out) | contract | findings | demoted | hits | misses | genuine found | spurious |",
		"|---|---|---|---|---|---|---|---|---|---|",
		...out.trials.map((t: any) => `| ${t.trial} | ${t.seconds} | ${t.promptTokens}/${t.completionTokens} | ${t.format} | ${t.findingCount} | ${t.demoted} | ${t.hits.length}/${t.plants.length} | ${t.misses.join(", ") || "—"} | ${t.genuine_found.length}/${KNOWN_GENUINE.length} | ${t.spurious.length} |`),
		"",
		...out.trials.map((t: any) =>
			[
				`## ${t.trial}`,
				t.misses.length ? `**Missed planted bugs:** ${t.misses.map((id: string) => PLANTS.find((p) => p.id === id)?.claim ?? id).join("; ")}` : "",
				t.spurious.length ? `**Needs a human label (matched no known defect):**\n${t.spurious.map((s: string) => `- ${s}`).join("\n")}` : "",
				t.needs.length ? `**Asked to see:** ${t.needs.join("; ")}` : "**Asked to see: nothing** (it volunteered no uncertainty — treat that as a yellow flag)",
			].filter(Boolean).join("\n\n"),
		),
		"",
		"Generated by `test/review-harness/run-review.ts`. Recall is only meaningful because",
		"`ground.test.ts` proves each planted bug changes behaviour; classification is regex-matched",
		"against the reviewer's own words, so a finding phrased oddly reads as spurious — check `answers`.",
		"",
		`Answer sha: ${out.trials.map((t: any) => `${t.trial} ${t.answerSha}`).join(", ")}. Repeats with the same sha are the same`,
		"completion coming back again (the server is deterministic for an identical prompt), which proves",
		"reproducibility — NOT statistical confidence. For variance, vary the brief or the sampling.",
	].join("\n");
	assertPublicSafe(md, "results md");
	assertPublicSafe(JSON.stringify(out), "results json");
	writeFileSync(`${base}.md`, md);
	writeFileSync(`${base}.json`, JSON.stringify(out, null, 2));
	console.log(md);
	console.log(`\nwrote ${base}.md and .json`);
}
