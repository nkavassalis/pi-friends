// ask-flint: escalate hard, self-contained problems (or plans to review) from the session model to a "friend" —
// another machine's model that sees ONLY the brief, never the conversation or the files. Friends are config:
// ~/.config/pi-escalation/config.json either holds one friend inline (the original flint shape) or
// {"friends":[{name, baseUrl, model, keyFile, system?, description?, label?, guidelines?, maxTokens?, temperature?,
// topP?, topK?, timeoutMin?, maxBriefChars?, tunnel?}, ...]}. Each friend registers its own ask_<name> tool with its
// own queue (each server serves one generation at a time). Design and measurements: README.md.
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { askFlint, checkBrief, loadFriends, Queue, readKey, type FlintConfig } from "./client.ts";
import { ensureTunnel } from "./tunnel.ts";

const DEFAULT_SYSTEM =
	"You are consulted by another coding agent on a hard problem. The brief below is all the context you have. " +
	"Reason it through, then answer with the solution itself: the code (complete functions, not fragments) and a short " +
	"explanation of the key idea and why it is correct. If the brief lacks something you need, say exactly what.";

function makeTool(f: FlintConfig) {
	const name = f.name ?? "friend";
	const toolName = `ask_${name}`;
	const label = f.label ?? name;
	const queue = new Queue(); // per friend: separate servers, independent one-at-a-time slots

	const description =
		f.description ??
		`Hand a hard, self-contained problem to ${label}. It sees ONLY the brief, not this conversation or the files, so the ` +
		`brief must contain everything: the goal, the relevant code, the exact failing test or error output, constraints ` +
		`(language, signatures, limits) and what was already tried. Also useful as a design reviewer: send the plan plus its ` +
		`constraints and invariants and ask for flaws ranked by severity. Slow: expect 1-10 minutes. Returns the answer; ` +
		`verify it (apply it, run the tests) before relying on it.`;

	const guidelines = (
		f.guidelines ?? [
			"Use {{tool}} for hard algorithmic problems, or after two failed attempts at the same failing test. Do not use it for routine edits, file lookups or questions about this repository.",
			"Use it to review a proposed design or feature plan before implementation starts when the user asks for a second opinion: paste the plan, the interfaces it touches, the constraints and invariants it must respect, and ask for flaws ranked by severity, concrete alternatives, and tests that are missing. You decide whether to adopt the critique; say what you took and what you rejected and why.",
			"Write the {{tool}} brief so that a strong engineer who has never seen this repository could solve it: paste the code and error output, do not refer to files by path alone.",
		]
	).map((g) => g.replaceAll("{{tool}}", toolName));

	return defineTool({
		name: toolName,
		label: `Ask ${label}`,
		description,
		promptSnippet: `${toolName}: hand a hard self-contained algorithm or debugging problem (or a plan to review) to ${label} (slow)`,
		promptGuidelines: guidelines,
		parameters: Type.Object({
			brief: Type.String({ description: `Self-contained problem statement with all code, errors and constraints ${label} needs` }),
		}),
		executionMode: "sequential",

		async execute(_toolCallId, params, signal, onUpdate) {
			// re-read config per call so baseUrl/key edits take effect without a restart
			const cfg = loadFriends().find((x) => x.name === name) ?? f;
			const bad = checkBrief(cfg, params.brief);
			if (bad) throw new Error(bad.replace(/^ask_flint:/, `ask_${name}:`));
			const key = readKey(cfg);
			const ahead = queue.length;
			if (ahead > 0) onUpdate?.({ content: [{ type: "text", text: `Waiting for ${ahead} earlier ${toolName} call(s)...` }], details: undefined });
			const r = await queue.run(async () => {
				if (cfg.tunnel) {
					const t = await ensureTunnel(cfg.tunnel);
					if (t !== "up") onUpdate?.({ content: [{ type: "text", text: `SSH tunnel to ${cfg.tunnel.host} ${t}` }], details: undefined });
				}
				return askFlint(cfg, key, params.brief, signal, (p) =>
					onUpdate?.({
						content: [{ type: "text", text: `${label} thinking: ${Math.round(p.seconds)} s, ${p.reasoningChars} reasoning chars, ${p.answerChars} answer chars` }],
						details: undefined,
					}), cfg.system ?? DEFAULT_SYSTEM);
			});
			const stats = `[${toolName}: ${Math.round(r.seconds)} s, ${r.promptTokens} prompt tokens (${r.cachedTokens} cached), ${r.completionTokens} completion tokens, finish=${r.finish}]`;
			if (!r.answer) {
				throw new Error(
					r.finish === "length"
						? `${toolName}: ${label} used the whole ${cfg.maxTokens}-token budget reasoning and gave no answer. ${stats} Narrow the problem or split it, then retry.`
						: `${toolName}: ${label} returned no answer. ${stats}`,
				);
			}
			const cut = r.finish === "length" ? "\n\nNote: the answer was cut off at the token budget; it may be incomplete." : "";
			return {
				content: [{ type: "text", text: `${r.answer}${cut}\n\n${stats}` }],
				details: { friend: name, seconds: r.seconds, finish: r.finish, reasoningChars: r.reasoningChars },
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
}

export default function (pi: ExtensionAPI) {
	for (const f of loadFriends()) pi.registerTool(makeTool(f));

	// /friends — who is configured, and which tools are live. Status only: the key FILE's
	// presence is reported, its contents never are (same rule as meta-guard's FORBIDDEN list).
	pi.registerCommand("friends", {
		description: "List configured friends (escalation models): tool, endpoint, model, key status",
		handler: async (_args, ctx) => {
			const cur = loadFriends(); // fresh read: config edits show up without a restart
			const lines = [`${cur.length} friend(s) configured — every one is an active tool (no single "current" friend):`];
			for (const f of cur) {
				const kf = f.keyFile?.startsWith("~/") ? join(homedir(), f.keyFile.slice(2)) : f.keyFile ?? "";
				const key = kf && existsSync(kf) ? (readFileSync(kf, "utf8").trim() ? "key ok" : "key EMPTY") : "key MISSING";
				const bits = [
					`tool ask_${f.name}`,
					f.baseUrl,
					`model=${f.model}`,
					key,
					f.tunnel ? `tunnel via ${f.tunnel.host}` : "direct",
					f.system ? "custom persona" : "default persona",
				];
				lines.push(`  ${f.name}: ${bits.join(" | ")}`);
			}
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
