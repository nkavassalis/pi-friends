// ask_flint: let the session's model (Qwen on the Spark) hand a hard, self-contained problem to Recursive Flint on the Mac mini.
// The brief is sent as a fresh one-turn chat, so the Mac never prefills the session history; only Flint's final answer comes
// back. Calls run one at a time (rec serves one generation). Design and measurements: README.md.
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { askFlint, checkBrief, loadConfig, Queue, readKey } from "./client.ts";
import { ensureTunnel } from "./tunnel.ts";

const SYSTEM =
	"You are consulted by another coding agent on a hard problem. The brief below is all the context you have. " +
	"Reason it through, then answer with the solution itself: the code (complete functions, not fragments) and a short " +
	"explanation of the key idea and why it is correct. If the brief lacks something you need, say exactly what.";

const queue = new Queue();

const askFlintTool = defineTool({
	name: "ask_flint",
	label: "Ask Flint",
	description:
		"Hand a hard, self-contained problem to Recursive Flint, a stronger competitive-programming reasoner running on another " +
		"machine. It sees ONLY the brief, not this conversation or the files, so the brief must contain everything: the goal, the " +
		"relevant code, the exact failing test or error output, constraints (language, signatures, limits) and what was already " +
		"tried. Also useful as a design reviewer: send the plan plus its constraints and invariants and ask for flaws ranked by " +
		"severity. Slow: expect 1-10 minutes. Returns Flint's answer; verify it (apply it, run the tests) before relying on it.",
	promptSnippet: "ask_flint: hand a hard self-contained algorithm or debugging problem (or a plan to review) to a stronger reasoning model (slow)",
	promptGuidelines: [
		"Use ask_flint for hard algorithmic problems, or after two failed attempts at the same failing test. Do not use it for routine edits, file lookups or questions about this repository.",
		"Use it to review a proposed design or feature plan before implementation starts when the user asks for a second opinion: paste the plan, the interfaces it touches, the constraints and invariants it must respect, and ask for flaws ranked by severity, concrete alternatives, and tests that are missing. You decide whether to adopt the critique; say what you took and what you rejected and why.",
		"Write the ask_flint brief so that a strong engineer who has never seen this repository could solve it: paste the code and error output, do not refer to files by path alone.",
	],
	parameters: Type.Object({
		brief: Type.String({ description: "Self-contained problem statement with all code, errors and constraints Flint needs" }),
	}),
	executionMode: "sequential",

	async execute(_toolCallId, params, signal, onUpdate) {
		const cfg = loadConfig();
		const bad = checkBrief(cfg, params.brief);
		if (bad) throw new Error(bad);
		const key = readKey(cfg);
		const ahead = queue.length;
		if (ahead > 0) onUpdate?.({ content: [{ type: "text", text: `Waiting for ${ahead} earlier ask_flint call(s)...` }], details: undefined });
		const r = await queue.run(async () => {
			if (cfg.tunnel) {
				const t = await ensureTunnel(cfg.tunnel);
				if (t !== "up") onUpdate?.({ content: [{ type: "text", text: `SSH tunnel to ${cfg.tunnel.host} ${t}` }], details: undefined });
			}
			return askFlint(cfg, key, params.brief, signal, (p) =>
				onUpdate?.({
					content: [{ type: "text", text: `Flint thinking: ${Math.round(p.seconds)} s, ${p.reasoningChars} reasoning chars, ${p.answerChars} answer chars` }],
					details: undefined,
				}), SYSTEM);
		});
		const stats = `[ask_flint: ${Math.round(r.seconds)} s, ${r.promptTokens} prompt tokens (${r.cachedTokens} cached), ${r.completionTokens} completion tokens, finish=${r.finish}]`;
		if (!r.answer) {
			throw new Error(
				r.finish === "length"
					? `ask_flint: Flint used the whole ${cfg.maxTokens}-token budget reasoning and gave no answer. ${stats} Narrow the problem or split it, then retry.`
					: `ask_flint: Flint returned no answer. ${stats}`,
			);
		}
		const cut = r.finish === "length" ? "\n\nNote: the answer was cut off at the token budget; it may be incomplete." : "";
		return {
			content: [{ type: "text", text: `${r.answer}${cut}\n\n${stats}` }],
			details: { seconds: r.seconds, finish: r.finish, reasoningChars: r.reasoningChars },
			usage: {
				input: r.promptTokens,
				output: r.completionTokens,
				cacheRead: r.cachedTokens,
				cacheWrite: 0,
				totalTokens: r.promptTokens + r.completionTokens,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		};
	},
});

export default function (pi: ExtensionAPI) {
	pi.registerTool(askFlintTool);
}
