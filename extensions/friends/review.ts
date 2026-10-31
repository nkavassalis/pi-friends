// The reviewer half of a friend: persona, brief builder, and a lenient parser for the structured answer.
// No pi imports (same rule as client.ts) so the harness and `node --test` can exercise it offline.
// Why a persona at all: measured 2026-10-31, the solve persona ("answer with the solution itself: the code")
// fights a review task — the model returned an answer-shaped rewrite and an empty `needs`. Review is a
// different job, so it gets its own system message and its own output contract.

export type Severity = "blocker" | "major" | "minor" | "note";

export interface Finding {
	severity: Severity;
	where: string; // function or line the reviewer points at
	claim: string; // what is wrong
	why: string; // how it breaks at runtime
	test: string; // the test that fails here and passes once fixed; "" = the reviewer could not name one
	demoted: boolean; // true: we downgraded it to "note" because `test` was missing or vague
}

export interface Review {
	findings: Finding[];
	needs: string[]; // what the reviewer admitted to guessing about
	raw: string; // the answer as it came back, always kept: a parse failure must not lose the review
	format: "json" | "prose"; // did the structured contract survive the round trip
	dropped: number; // findings beyond MAX_FINDINGS (we keep the most severe, never a silent cut)
}

export const MAX_FINDINGS = 12;

const RANK: Record<Severity, number> = { blocker: 0, major: 1, minor: 2, note: 3 };

/**
 * The reviewer persona. Two rules are load-bearing and were earned by measurement, not taste:
 * the `test` field is how a finding earns its keep (it is what caught a hallucinated finding on
 * 2026-10-31 in seconds), and `needs` is pushed hard because the same run guessed silently
 * while sounding confident.
 */
export const REVIEW_SYSTEM =
	"You are a senior code reviewer consulted by another coding agent. The brief below is all the context you have: " +
	"you cannot see the repository, the files, or the conversation. Your job is to find defects in the code under " +
	"review — not to rewrite it, and not to solve anything else. " +
	'Return exactly ONE JSON object and nothing around it: {"findings":[{"severity":"blocker|major|minor|note",' +
	'"where":"function or line","claim":"what is wrong","why":"how it breaks at runtime for a real user",' +
	'"test":"the concrete test that fails on this code and passes once it is fixed"}],' +
	'"needs":["what you would need to see to be sure of something you are currently guessing about"]}. ' +
	"Severity: blocker = breaks the feature in normal use; major = wrong in a way a user would actually hit; " +
	"minor = real but low impact; note = speculation. " +
	"The `test` field is how a finding earns its keep: if you cannot state a test that fails on this code and passes " +
	"once fixed, set that finding's severity to \"note\" yourself. " +
	"Prefer few high-confidence findings; an empty findings list is a valid and useful answer, so do not pad. " +
	"No formatting, naming or linter comments, and no redesign proposals. " +
	"`needs` is not optional to think about: if you guessed about anything — a caller, a config default, what the " +
	"server actually sends — say so there. Guessing silently is worse than asking.";

export interface ReviewRequest {
	target: string; // one line: what is being reviewed
	diff: string; // the code under review, pasted in full (never truncated by us)
	question?: string; // the agent's explicit uncertainty — where to focus
	context?: string; // surrounding code, conventions, invariants the reviewer cannot see
	answers?: string; // round 2: what the agent fetched after the reviewer's `needs`
}

/** The whole context the reviewer gets. Kept separate from the persona so the harness can diff them. */
export function buildReviewBrief(r: ReviewRequest): string {
	const parts = [
		`# Review request: ${r.target.trim()}`,
		"## What the caller is unsure about",
		r.question?.trim() || "(none stated — review the whole change for correctness and for missing tests)",
		"## Code under review",
		"```",
		r.diff.replace(/\s+$/, ""),
		"```",
		"## Context the reviewer cannot see",
		r.context?.trim() || "(none provided)",
	];
	if (r.answers?.trim()) parts.push("## Round 2: what you asked for, and what I fetched", r.answers.trim());
	parts.push("Answer with the single JSON object described in the system message.");
	return parts.join("\n\n");
}

function isRealTest(t: string): boolean {
	const s = t.trim();
	if (s.length < 20) return false; // "add a test", "n/a", "-"
	if (/^(n\/?a|none|none\.|-+|tbd|todo|unknown)\.?$/i.test(s)) return false;
	if (/^(would be nice|maybe|perhaps|some(?:where)?|a test|any test|not sure)\b/i.test(s)) return false;
	return true;
}

/** First fenced ```json block that mentions findings, else the widest {...} slice; undefined if neither parses. */
function extractJson(text: string): any {
	const blocks = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map((m) => m[1].trim());
	for (const b of [...blocks].reverse()) if (/findings/.test(b) && b.startsWith("{")) return tryJson(b);
	for (const b of blocks) if (b.startsWith("{")) {
		const v = tryJson(b);
		if (v) return v;
	}
	const first = text.indexOf("{");
	const last = text.lastIndexOf("}");
	if (first >= 0 && last > first) return tryJson(text.slice(first, last + 1));
	return undefined;
}

function tryJson(s: string): any {
	try {
		return JSON.parse(s);
	} catch {
		return undefined;
	}
}

const str = (v: unknown) => (typeof v === "string" ? v.trim() : v == null ? "" : String(v));

function toFinding(raw: any): Finding | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const claim = str(raw.claim ?? raw.issue ?? raw.description ?? raw.problem ?? raw.text ?? raw.title);
	if (!claim) return undefined; // nothing to act on; a heading with no claim is not a finding
	const sev = str(raw.severity).toLowerCase() as Severity;
	const severity: Severity = sev in RANK ? sev : "note"; // `in`, not truthiness: RANK.blocker is 0
	const test = str(raw.test ?? raw.verification ?? raw.repro ?? raw.evidence);
	const demoted = severity !== "note" && !isRealTest(test);
	return { severity: demoted ? "note" : severity, where: str(raw.where ?? raw.location ?? raw.file) || "(not stated)", claim, why: str(raw.why ?? raw.impact ?? raw.effect), test, demoted };
}

/**
 * `needs` from a prose section, for answers that ignore the contract entirely. Line-based on purpose:
 * a regex with /m and `\s*$` stopped at the end of the first bullet and silently lost the rest.
 */
function proseNeeds(text: string): string[] {
	const lines = text.split("\n");
	const at = lines.findIndex((l) => /^\s*(?:#{1,4}\s*)?needs\b/i.test(l));
	if (at < 0) return [];
	const out: string[] = [];
	const inline = lines[at].replace(/^\s*(?:#{1,4}\s*)?needs\b\s*:?\s*/i, "").trim();
	if (inline) out.push(inline);
	for (const l of lines.slice(at + 1)) {
		if (!l.trim()) {
			if (out.length) break; // the section ended
			continue;
		}
		const bullet = l.match(/^\s*[-*]\s+(.*)$/);
		if (bullet) out.push(bullet[1].trim());
		else if (out.length) break; // a new section began
		else break;
	}
	return out.filter((s) => s.length > 3 && !/^\(?(none|nothing|n\/a)\)?\.?$/i.test(s));
}

/**
 * Tolerant by design: a reasoning model that wraps the JSON in prose, or ignores the contract and
 * writes a paragraph, still has to yield something usable. `raw` is always kept so a failed parse
 * degrades to "here is the reviewer's prose" rather than to nothing.
 */
export function parseReview(text: string): Review {
	const raw = text ?? "";
	const obj = extractJson(raw);
	const list = Array.isArray(obj) ? obj : Array.isArray(obj?.findings) ? obj.findings : undefined;
	let findings: Finding[] = [];
	let needs: string[] = [];
	let format: Review["format"] = "prose";
	if (list) {
		format = "json";
		findings = list.map(toFinding).filter((f): f is Finding => !!f);
		needs = (Array.isArray(obj?.needs) ? obj.needs : []).map(str).filter((s) => s.length > 3);
	}
	if (needs.length === 0) needs = proseNeeds(raw);
	findings.sort((a, b) => RANK[a.severity] - RANK[b.severity]);
	const dropped = Math.max(0, findings.length - MAX_FINDINGS);
	return { findings: findings.slice(0, MAX_FINDINGS), needs, raw, format, dropped };
}

/** What the agent reads back. The footer is the acceptance rule, restated where it will actually be seen. */
export function renderReview(r: Review, label: string): string {
	const head = r.format === "json" ? `${r.findings.length} finding(s) from ${label}` : `${label} did not return the JSON contract; treating its prose as notes`;
	const body = r.findings.length
		? r.findings
				.map((f, i) => {
					const bits = [`**${f.severity.toUpperCase()}**${f.demoted ? " (demoted: no runnable test)" : ""} — ${f.claim}`, `where: ${f.where}`];
					if (f.why) bits.push(`why: ${f.why}`);
					bits.push(f.test ? `test: ${f.test}` : "test: (none named — a guess, do not act on it without writing one)");
					return `${i + 1}. ${bits.join("\n   ")}`;
				})
				.join("\n\n")
		: "_No findings._";
	const needs = r.needs.length ? `\n\nWanted to see (a second round is worth it only if one of these would change a verdict):\n${r.needs.map((n) => `- ${n}`).join("\n")}` : "";
	const cut = r.dropped ? `\n\n(${r.dropped} further finding(s) dropped after the ${MAX_FINDINGS} most severe.)` : "";
	const rule =
		"\n\nA finding counts only if its test FAILS on the code as it is and PASSES on the fixed code. " +
		"Run it; anything that cannot do both is a note, not a fix. You decide what to adopt — say what you took and what you rejected.";
	return `${head}\n\n${body}${needs}${cut}${rule}`;
}
