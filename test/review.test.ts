// Offline tests for the reviewer half (extensions/friends/review.ts): the parser has to survive a
// reasoning model that wraps JSON in prose, or ignores the contract entirely, and the demotion rule
// is what keeps a hallucinated finding from becoming an edit — both are measured behaviour, see
// test/review-harness/README.md.
//   node --experimental-strip-types --test test/review.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildReviewBrief, MAX_FINDINGS, parseReview, renderReview, REVIEW_SYSTEM } from "../extensions/friends/review.ts";

const GOOD_TEST = "run queue.run twice without awaiting and assert the second job starts only after the first resolves";
const finding = (o: Partial<Record<string, string>> = {}) => ({ severity: "major", where: "Queue.run", claim: "the queue does not serialize", why: "two generations hit the server", test: GOOD_TEST, ...o });

test("fenced json block is parsed, findings and needs kept", () => {
	const text = "Here is my review:\n```json\n" + JSON.stringify({ findings: [finding()], needs: ["what the caller does with r.answer"] }) + "\n```\nHope that helps.";
	const r = parseReview(text);
	assert.equal(r.format, "json");
	assert.equal(r.findings.length, 1);
	assert.equal(r.findings[0].severity, "major");
	assert.equal(r.findings[0].demoted, false);
	assert.deepEqual(r.needs, ["what the caller does with r.answer"]);
	assert.match(r.raw, /Hope that helps/); // the original answer is never thrown away
});

test("json wrapped in prose is still found (widest brace slice)", () => {
	const text = `I looked at this carefully. ${JSON.stringify({ findings: [finding({ severity: "blocker" })], needs: [] })} Those were the only issues.`;
	const r = parseReview(text);
	assert.equal(r.format, "json");
	assert.equal(r.findings[0].severity, "blocker");
});

test("a finding with no runnable test is demoted to note and flagged", () => {
	for (const test_ of ["", "n/a", "add a test", "would be nice to have coverage", "maybe something in test/"]) {
		const r = parseReview(JSON.stringify({ findings: [finding({ test: test_ })] }));
		assert.equal(r.findings[0].severity, "note", `should demote test=${JSON.stringify(test_)}`);
		assert.equal(r.findings[0].demoted, true);
	}
	const kept = parseReview(JSON.stringify({ findings: [finding()] }));
	assert.equal(kept.findings[0].severity, "major");
	assert.equal(kept.findings[0].demoted, false);
});

test("answers that ignore the contract degrade to prose, they do not throw or vanish", () => {
	const r = parseReview("The code looks fine to me, I would add more tests around the stream.");
	assert.equal(r.format, "prose");
	assert.deepEqual(r.findings, []);
	assert.match(r.raw, /looks fine/);
	assert.match(renderReview(r, "flint"), /did not return the JSON contract/);
});

test("needs survives a prose answer via a NEEDS section", () => {
	const r = parseReview("Findings: none.\n\nNEEDS:\n- what the server sends for delta.content\n- the tool wrapper\n");
	assert.equal(r.needs.length, 2);
	assert.match(r.needs[0], /delta\.content/);
});

test("findings sort by severity, cap at MAX_FINDINGS, and report what was dropped", () => {
	const many = ["note", "minor", "blocker", "major", "note"].map((s, i) => finding({ severity: s, claim: `c${i}` }));
	for (let i = 0; i < 20; i++) many.push(finding({ severity: "minor", claim: `pad${i}` }));
	const r = parseReview(JSON.stringify({ findings: many }));
	assert.equal(r.findings.length, MAX_FINDINGS);
	assert.equal(r.dropped, many.length - MAX_FINDINGS);
	assert.equal(r.findings[0].severity, "blocker");
	assert.equal(r.findings[1].severity, "major");
	assert.ok(r.findings.every((f, i) => i === 0 || ["blocker", "major", "minor", "note"].indexOf(f.severity) >= ["blocker", "major", "minor", "note"].indexOf(r.findings[i - 1].severity)));
});

test("claim aliases are accepted, entries with no claim are dropped, unknown severity becomes note", () => {
	const r = parseReview(JSON.stringify({ findings: [{ severity: "critical", issue: "x is wrong", where: "f()" }, { severity: "major", where: "g()" }, {}] }));
	assert.equal(r.findings.length, 1);
	assert.equal(r.findings[0].claim, "x is wrong");
	assert.equal(r.findings[0].severity, "note"); // "critical" is not in our vocabulary
	assert.equal(r.findings[0].demoted, false); // already note, so there was nothing to demote
	const demotedToo = parseReview(JSON.stringify({ findings: [{ severity: "blocker", issue: "y is wrong" }] }));
	assert.equal(demotedToo.findings[0].severity, "note"); // a blocker with no test cannot stay a blocker
	assert.equal(demotedToo.findings[0].demoted, true);
});

test("the persona carries the two rules the measurement depends on", () => {
	assert.match(REVIEW_SYSTEM, /earns its keep/);
	assert.match(REVIEW_SYSTEM, /empty findings list is a valid/);
	assert.match(REVIEW_SYSTEM, /`needs` is not optional/);
});

test("brief: focus, code fence, context and round-2 section all land; empty optionals say so", () => {
	const b = buildReviewBrief({ target: "Queue.run", diff: "class Queue {}\n\n\n", question: "does pending leak?", context: "single-generation server" });
	assert.match(b, /# Review request: Queue\.run/);
	assert.match(b, /does pending leak\?/);
	assert.match(b, /class Queue \{\}/);
	assert.match(b, /single-generation server/);
	assert.match(b, /single JSON object described in the system message/);
	const bare = buildReviewBrief({ target: "x", diff: "y" });
	assert.match(bare, /none stated/);
	assert.match(bare, /\(none provided\)/);
	assert.doesNotMatch(bare, /Round 2/);
	assert.match(buildReviewBrief({ target: "x", diff: "y", answers: "here is the wrapper" }), /Round 2/);
});

test("renderReview states the acceptance rule where the agent will read it", () => {
	const r = parseReview(JSON.stringify({ findings: [finding(), finding({ claim: "guess", test: "" })], needs: ["the wrapper"] }));
	const out = renderReview(r, "flint");
	assert.match(out, /MAJOR/);
	assert.match(out, /demoted: no runnable test/);
	assert.match(out, /Wanted to see/);
	assert.match(out, /FAILS on the code as it is and PASSES on the fixed code/);
});

// --- where the code under review comes from -------------------------------------------------
import { gitArgsFor, parseDiffFiles, planDiffChunks } from "../extensions/friends/review.ts";

const file = (n: string, body = "x".repeat(40)) => `diff --git a/${n} b/${n}\nindex 111..222 100644\n--- a/${n}\n+++ b/${n}\n@@ -1 +1 @@\n+${body}\n`;

test("gitArgsFor: staged by default, base when given, paths appended, explicit diff means no git", () => {
	assert.deepEqual(gitArgsFor({}).args, ["diff", "--no-ext-diff", "--cached"]);
	assert.deepEqual(gitArgsFor({ staged: true }).args, ["diff", "--no-ext-diff", "--cached"]);
	assert.deepEqual(gitArgsFor({ base: "main" }).args, ["diff", "--no-ext-diff", "main...HEAD"]);
	assert.deepEqual(gitArgsFor({ base: "v1.0.0", files: ["a.ts", "b.ts"] }).args, ["diff", "--no-ext-diff", "v1.0.0...HEAD", "--", "a.ts", "b.ts"]);
	// staged:false means the unstaged working tree — found by a real pi run on 2026-10-31, where the
	// flag was plumbed in and then ignored, so there was no way to review uncommitted work.
	assert.deepEqual(gitArgsFor({ staged: false }).args, ["diff", "--no-ext-diff"]);
	assert.deepEqual(gitArgsFor({ staged: false, files: ["a.ts"] }).args, ["diff", "--no-ext-diff", "--", "a.ts"]);
	assert.deepEqual(gitArgsFor({ staged: true }).args, ["diff", "--no-ext-diff", "--cached"]);
	assert.match(gitArgsFor({ diff: "hello" }).error!, /no git needed/);
	assert.equal(gitArgsFor({ diff: "hello" }).args, undefined);
});

test("gitArgsFor refuses flag injection through base or files (the model supplies these)", () => {
	for (const base of ["--output=/tmp/x", "--ext-diff", "main; rm -rf /", "-b", "", "main --help"]) {
		const { args, error } = gitArgsFor({ base });
		assert.equal(args, undefined, `base ${JSON.stringify(base)} must not reach git`);
		assert.match(error!, /unsafe git ref/);
	}
	for (const f of ["--cached", "../secret", "a\\b\u0000"]) {
		const { args, error } = gitArgsFor({ files: [f] });
		assert.equal(args, undefined, `path ${JSON.stringify(f)} must not reach git`);
		assert.match(error!, /unsafe path/);
	}
});

test("parseDiffFiles names each file section and drops the preamble", () => {
	const d = "some preamble\n" + file("a.ts") + file("b.ts");
	const parts = parseDiffFiles(d);
	assert.deepEqual(parts.map((p) => p.file), ["a.ts", "b.ts"]);
	assert.match(parts[0].text, /^diff --git a\/a\.ts/);
	assert.deepEqual(parseDiffFiles(""), []);
});

test("planDiffChunks packs whole files under budget and reports an oversize file instead of cutting it", () => {
	const small = file("a.ts") + file("b.ts");
	assert.equal(planDiffChunks(small, 100000).groups.length, 1);
	const big = file("a.ts", "x".repeat(500)) + file("b.ts", "y".repeat(500)) + file("c.ts", "z".repeat(500));
	const plan = planDiffChunks(big, 700);
	assert.ok(plan.groups.length >= 2, "must split rather than truncate");
	assert.ok(plan.groups.every((g) => g.join("").length <= 700));
	assert.deepEqual(plan.groups.flat().length, 3, "no file may be dropped");
	const one = planDiffChunks(file("huge.ts", "h".repeat(5000)), 700);
	assert.deepEqual(one.groups, []);
	assert.equal(one.oversize[0].file, "huge.ts");
	assert.ok(one.oversize[0].chars > 700);
});
