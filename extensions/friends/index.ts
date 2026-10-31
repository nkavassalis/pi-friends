// friends: consult other models on hard, self-contained problems (or plans/code to review) from the session model to a
// "friend" — another machine's model that sees ONLY the brief, never the conversation or the files. Friends are config:
// ~/.config/pi-friends/config.json holds {"friends":[...]} or (legacy) one friend inline:
// {"friends":[{name, baseUrl, model, keyFile, system?, reviewSystem?, scanBrief?, scanAllow?, description?, label?, guidelines?,
// maxTokens?, temperature?, topP?, topK?, timeoutMin?, maxBriefChars?, tunnel?}, ...]}. Each friend registers an ask_<name>
// and a review_<name> tool, sharing one queue (each server serves one generation at a time).
// Design and measurements: README.md and test/review-harness/README.md.
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	askFriend,
	checkBrief,
	CONFIG_PATH,
	gateBrief,
	loadFriends,
	Queue,
	readKey,
	scanBrief,
	type FriendConfig,
} from "./client.ts";
import { buildReviewBrief, gitArgsFor, parseDiffFiles, parseReview, planDiffChunks, renderReview, REVIEW_SYSTEM, type DiffSource } from "./review.ts";
import { ensureTunnel } from "./tunnel.ts";

const DEFAULT_SYSTEM =
	"You are consulted by another coding agent on a hard problem. The brief below is all the context you have. " +
	"Reason it through, then answer with the solution itself: the code (complete functions, not fragments) and a short " +
	"explanation of the key idea and why it is correct. If the brief lacks something you need, say exactly what.";

// The brief carries the code plus framing; leave room for the framing so the check measures what is sent.
const BRIEF_FRAMING_RESERVE = 2500;

/** Per-friend queues, shared by that friend's ask_ and review_ tools: one server, one generation at a time. */
const queues = new Map<string, Queue>();
const queueFor = (name: string) => queues.get(name) ?? (queues.set(name, new Queue()), queues.get(name)!);

function statsLine(toolName: string, r: { seconds: number; promptTokens: number; cachedTokens: number; completionTokens: number; finish: string }) {
	return `[${toolName}: ${Math.round(r.seconds)} s, ${r.promptTokens} prompt tokens (${r.cachedTokens} cached), ${r.completionTokens} completion tokens, finish=${r.finish}]`;
}

/** Send one brief to the friend through its queue, tunnel included. */
async function ask(cfg: FriendConfig, queue: Queue, label: string, toolName: string, brief: string, system: string, signal?: AbortSignal, onUpdate?: any) {
	const bad = checkBrief(cfg, brief);
	if (bad) throw new Error(bad.replace(/^friends:/, `${toolName}:`));
	const notice = gateBrief(cfg, toolName, brief); // refuses block-tier content before anything is sent
	const key = readKey(cfg);
	const ahead = queue.length;
	if (ahead > 0) onUpdate?.({ content: [{ type: "text", text: `Waiting for ${ahead} earlier ${label} call(s)...` }], details: undefined });
	const r = await queue.run(async () => {
		if (cfg.tunnel) {
			const t = await ensureTunnel(cfg.tunnel);
			if (t !== "up") onUpdate?.({ content: [{ type: "text", text: `SSH tunnel to ${cfg.tunnel.host} ${t}` }], details: undefined });
		}
		return askFriend(cfg, key, brief, signal, (p) =>
			onUpdate?.({
				content: [{ type: "text", text: `${label} thinking: ${Math.round(p.seconds)} s, ${p.reasoningChars} reasoning chars, ${p.answerChars} answer chars` }],
				details: undefined,
			}),
			system,
		);
	});
	return { r, notice };
}

const usageOf = (r: { promptTokens: number; completionTokens: number; cachedTokens: number }) => ({
	input: r.promptTokens,
	output: r.completionTokens,
	cacheRead: r.cachedTokens,
	cacheWrite: 0,
	totalTokens: r.promptTokens + r.completionTokens,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

function makeAskTool(f: FriendConfig) {
	const name = f.name ?? "friend";
	const toolName = `ask_${name}`;
	const label = f.label ?? name;
	const queue = queueFor(name);

	const description =
		f.description ??
		`Hand a hard, self-contained problem to ${label}. It sees ONLY the brief, not this conversation or the files, so the ` +
		`brief must contain everything: the goal, the relevant code, the exact failing test or error output, constraints ` +
		`(language, signatures, limits) and what was already tried. Slow: expect 1-10 minutes. Returns the answer; verify it ` +
		`(apply it, run the tests) before relying on it. For reviewing code or a plan, use review_${name} instead.`;

	const guidelines = (
		f.guidelines ?? [
			"Use {{tool}} for hard algorithmic problems, or after two failed attempts at the same failing test. Do not use it for routine edits, file lookups or questions about this repository.",
			"Write the {{tool}} brief so that a strong engineer who has never seen this repository could solve it: paste the code and error output, do not refer to files by path alone.",
			"Anything in a brief is disclosed to that endpoint's operator: no secrets, keys, tokens, hostnames or home paths. The tool refuses a brief that looks like it contains one.",
		]
	).map((g) => g.replaceAll("{{tool}}", toolName));

	return defineTool({
		name: toolName,
		label: `Ask ${label}`,
		description,
		promptSnippet: `${toolName}: hand a hard self-contained algorithm or debugging problem to ${label} (slow)`,
		promptGuidelines: guidelines,
		parameters: Type.Object({
			brief: Type.String({ description: `Self-contained problem statement with all code, errors and constraints ${label} needs` }),
		}),
		// No executionMode: "sequential" — that flag makes pi serialize the WHOLE tool batch for the turn
		// (pi-agent-core agent-loop.js), so it would stop two different friends from running at once. The
		// per-friend Queue is what actually protects a single-generation server. Measured 2026-10-31.

		async execute(_toolCallId, params, signal, onUpdate) {
			const cfg = loadFriends().find((x) => x.name === name) ?? f; // re-read per call: baseUrl/key edits need no restart
			const { r, notice } = await ask(cfg, queue, label, toolName, params.brief, cfg.system ?? DEFAULT_SYSTEM, signal, onUpdate);
			const stats = statsLine(toolName, r);
			if (!r.answer) {
				throw new Error(
					r.finish === "length"
						? `${toolName}: ${label} used the whole ${cfg.maxTokens}-token budget reasoning and gave no answer. ${stats} Narrow the problem or split it, then retry.`
						: `${toolName}: ${label} returned no answer. ${stats}`,
				);
			}
			const cut = r.finish === "length" ? "\n\nNote: the answer was cut off at the token budget; it may be incomplete." : "";
			return {
				content: [{ type: "text", text: `${r.answer}${cut}${notice ? `\n\n${notice}` : ""}\n\n${stats}` }],
				details: { friend: name, kind: "ask", seconds: r.seconds, finish: r.finish, reasoningChars: r.reasoningChars, scanNotice: !!notice },
				usage: usageOf(r),
			};
		},
	});
}

function makeReviewTool(f: FriendConfig) {
	const name = f.name ?? "friend";
	const toolName = `review_${name}`;
	const label = f.label ?? name;
	const queue = queueFor(name);

	return defineTool({
		name: toolName,
		label: `Review with ${label}`,
		description:
			`Have ${label} review code, blind: it sees ONLY what you send, never the repo or this conversation. It returns ` +
			`findings ranked blocker/major/minor/note, each with the test that should catch it, plus what it wanted to see. ` +
			`Give it your uncertainty in \`question\` — "I'm not sure the queue accounting is right if task() rejects early; ` +
			`attack this" gets a far better answer than a bare diff. The diff is fetched by this tool (staged by default, or ` +
			`\`base\`/\`files\`/\`diff\`), so it never passes through your own tokens. Slow: 2-5 minutes. It is a second pair of ` +
			`eyes, NOT a gate: measured 2/3 recall on planted bugs, so its silence means nothing. A finding counts only if its ` +
			`test fails on the code as it is and passes once fixed — run it, then decide.`,
		promptSnippet: `${toolName}: ${label} reviews a diff blind (slow); pass your uncertainty in question`,
		promptGuidelines: [
			`Use ${toolName} before a push or before implementing a risky plan, not after every edit — one review per push, and only when you can name what you are unsure about.`,
			`Never auto-apply a finding. Run its test; a finding whose test cannot fail before and pass after is a note. Say what you adopted and what you rejected.`,
			`If it asks for more context (\`needs\`) and that would change a verdict, call again with \`answers\` — two rounds maximum, each costs minutes.`,
		],
		parameters: Type.Object({
			target: Type.String({ description: "One line: what is being reviewed, e.g. 'queue + SSE parser in client.ts'" }),
			question: Type.Optional(Type.String({ description: "Your uncertainty — where to focus. The highest-value field." })),
			staged: Type.Optional(Type.Boolean({ description: "false = review the UNSTAGED working-tree diff; default (true/unset) is the staged diff" })),
			base: Type.Optional(Type.String({ description: "Review git diff <base>...HEAD instead, e.g. 'main'" })),
			files: Type.Optional(Type.Array(Type.String(), { description: "Restrict to these repo-relative paths (also how you split an oversized change)" })),
			diff: Type.Optional(Type.String({ description: "Review this text instead of asking git (no repo, or a hand-picked hunk)" })),
			context: Type.Optional(Type.String({ description: "Conventions/invariants/callers it cannot see — paste the relevant AGENTS.md rules" })),
			answers: Type.Optional(Type.String({ description: "Round 2: what you fetched after its previous `needs`" })),
		}),

		async execute(_toolCallId, p, signal, onUpdate) {
			const cfg = loadFriends().find((x) => x.name === name) ?? f;
			// 1. get the code under review, from git, without the model re-typing it
			let diff = p.diff?.trim() ?? "";
			let source = "the diff you passed";
			if (!diff) {
				const src: DiffSource = { staged: p.staged, base: p.base, files: p.files };
				const { args, error } = gitArgsFor(src);
				if (!args) throw new Error(`${toolName}: ${error}`);
				onUpdate?.({ content: [{ type: "text", text: `git ${args.join(" ")} ...` }], details: undefined });
				try {
					diff = execFileSync("git", args, { cwd: process.cwd(), encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
				} catch (e: any) {
					throw new Error(`${toolName}: git ${args.join(" ")} failed: ${String(e?.stderr || e?.message).slice(0, 300)}`);
				}
				source = `git ${args.join(" ")}`;
				if (!diff.trim())
					throw new Error(
						`${toolName}: ${source} produced no diff, so there is nothing to review. Stage it, or pass base:"<ref>", files:[...], or the diff text itself.`,
					);
			}
			// 2. budget: refuse with a plan, never cut (same rule as checkBrief)
			const budget = cfg.maxBriefChars - BRIEF_FRAMING_RESERVE;
			if (diff.length > budget) {
				const plan = planDiffChunks(diff, budget);
				const bits = [`${toolName}: the change is ${diff.length} characters from ${source}, over the ${budget}-character budget. Nothing was sent.`];
				if (plan.oversize.length)
					bits.push(`Too big on its own: ${plan.oversize.map((o) => `${o.file} (${o.chars})`).join(", ")}. Review a subset with files:[...], or pass a smaller diff.`);
				if (plan.groups.length > 1)
					bits.push(`Otherwise review it in ${plan.groups.length} calls, one group each: ${plan.groups.map((g) => `[${parseDiffFiles(g).map((x) => x.file).join(", ")}]`).join(" then ")}.`);
				throw new Error(bits.join(" "));
			}
			// 3. brief, gate, send. A review reasons far longer than it writes, so it gets its own budget:
			// measured 2026-10-31, a 6-file review burned all 32768 reasoning tokens and returned nothing at all.
			const brief = buildReviewBrief({ target: p.target, diff, question: p.question, context: p.context, answers: p.answers });
			// Diff-aware pre-check, so the refusal can say what a plain gate cannot: removed lines are scanned
			// too, because they are sent too. A commit that DELETES a credential-shaped literal is refused on
			// purpose, and that reads like a false positive unless you are told (hit 2026-10-31).
			if ((cfg.scanBrief ?? "block") === "block") {
				const removed = scanBrief(diff, cfg.scanAllow ?? []).filter((h) => h.tier === "block" && (diff.split("\n")[h.line - 1] ?? "").startsWith("-"));
				if (removed.length)
					throw new Error(
						`${toolName}: refused — ${removed.length} block-tier hit(s) are on REMOVED lines (${removed.map((h) => `${h.rule} line ${h.line}`).join(", ")}). `
							+ `Deleted lines are still sent to the friend, so this is not a false alarm. Review a subset with files:[...], `
							+ `or add the literal to scanAllow in config.json if it is a test fixture. Nothing was sent.`,
					);
			}
			const rt = cfg.reviewMaxTokens && cfg.reviewMaxTokens > 0 ? cfg.reviewMaxTokens : cfg.maxTokens; // reviewMaxTokens: 0 must not mean "no budget"
			const rcfg = { ...cfg, maxTokens: rt };
			const { r, notice } = await ask(rcfg, queue, label, toolName, brief, cfg.reviewSystem ?? REVIEW_SYSTEM, signal, onUpdate);
			const stats = statsLine(toolName, r);
			if (!r.answer) {
				throw new Error(
					r.finish === "length"
						? `${toolName}: ${label} spent the whole ${rt}-token review budget reasoning and returned no review. ${stats} Narrow the diff with files:[...] or ask about one file at a time.`
						: `${toolName}: ${label} returned no review. ${stats}`,
				);
			}
			const review = parseReview(r.answer);
			const text = `${renderReview(review, label)}${notice ? `\n\n${notice}` : ""}\n\n${stats}\n${r.promptTokens} prompt tokens in, brief ${brief.length} chars (${source}).`;
			return {
				content: [{ type: "text", text }],
				details: {
					friend: name,
					kind: "review",
					seconds: r.seconds,
					format: review.format,
					findings: review.findings.length,
					bySeverity: review.findings.reduce((a: Record<string, number>, x) => ((a[x.severity] = (a[x.severity] ?? 0) + 1), a), {}),
					demoted: review.findings.filter((x) => x.demoted).length,
					needs: review.needs.length,
					scanNotice: !!notice,
				},
				usage: usageOf(r),
			};
		},
	});
}

export default function (pi: ExtensionAPI) {
	for (const f of loadFriends()) {
		pi.registerTool(makeAskTool(f));
		pi.registerTool(makeReviewTool(f));
	}

	// /friends — who is configured, and which tools are live. Status only: the key FILE's presence is
	// reported, its contents never are (same rule as meta-guard's FORBIDDEN list).
	pi.registerCommand("friends", {
		description: "List configured friends (escalation models): tools, endpoint, model, key status",
		handler: async (_args, ctx) => {
			const cur = loadFriends(); // fresh read: config edits show up without a restart
			const lines = [`${cur.length} friend(s) configured — every one is an active ask_/review_ pair (no single "current" friend):`];
			if (cur.length === 0) {
				// Deleting the pre-rename fallback (2026-10-31) could otherwise look like the extension is broken:
				// zero tools and no clue that the config is one directory over.
				const legacy = join(homedir(), ".config", "pi-escalation", "config.json");
				lines.push(existsSync(legacy) ? `  none: a pre-rename config exists at ${legacy} — move it to ${CONFIG_PATH}` : `  none: write ${CONFIG_PATH} (see the README)`);
			}
			for (const f of cur) {
				const kf = f.keyFile?.startsWith("~/") ? join(homedir(), f.keyFile.slice(2)) : f.keyFile ?? "";
				const key = kf && existsSync(kf) ? (readFileSync(kf, "utf8").trim() ? "key ok" : "key EMPTY") : "key MISSING";
				const bits = [
					`ask_${f.name} + review_${f.name}`,
					f.baseUrl,
					`model=${f.model}`,
					key,
					f.tunnel ? `tunnel via ${f.tunnel.host}` : "direct",
					`scan ${f.scanBrief ?? "block"}`,
					f.system ? "custom ask persona" : "default ask persona",
					f.reviewSystem ? "custom review persona" : "default review persona",
				];
				lines.push(`  ${f.name}: ${bits.join(" | ")}`);
			}
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
