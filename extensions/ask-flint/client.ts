// Flint client for the ask_flint tool: config, a one-at-a-time queue, and one streamed chat request.
// No pi imports, so `node --test` can run it (test/client.test.ts) against a fake server.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface FlintConfig {
	baseUrl: string; // OpenAI-compatible base, e.g. http://127.0.0.1:11501/v1 (the SSH tunnel to the Mac)
	model: string;
	keyFile: string; // file holding the server's API key
	maxTokens: number; // reasoning + answer; Flint's card asks for >= 32K
	temperature: number;
	topP: number;
	topK: number;
	timeoutMin: number; // whole request, queue wait excluded
	maxBriefChars: number; // longer briefs are refused (the Mac prefills ~600 tok/s), never cut
}

export const DEFAULTS: FlintConfig = {
	baseUrl: "http://127.0.0.1:11501/v1",
	model: "flint",
	keyFile: "~/.config/pi-escalation/flint_key",
	maxTokens: 32768,
	temperature: 0.6, // Flint's best LiveCodeBench setting (mac-tuning FLINT.md)
	topP: 0.95,
	topK: 20,
	timeoutMin: 20,
	maxBriefChars: 64000, // ~16-18K tokens, ~30 s of prefill on the Mac
};

export const CONFIG_PATH = join(homedir(), ".config", "pi-escalation", "config.json");

const expand = (p: string) => (p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);

export function loadConfig(path = CONFIG_PATH): FlintConfig {
	let file: Partial<FlintConfig> = {};
	try {
		file = JSON.parse(readFileSync(path, "utf8"));
	} catch (e: any) {
		if (e?.code !== "ENOENT") throw new Error(`ask_flint: cannot read ${path}: ${e.message}`);
	}
	return { ...DEFAULTS, ...file };
}

export function readKey(cfg: FlintConfig): string {
	try {
		return readFileSync(expand(cfg.keyFile), "utf8").trim();
	} catch (e: any) {
		throw new Error(`ask_flint: cannot read the API key file ${cfg.keyFile}: ${e.message}`);
	}
}

/** Runs tasks one at a time: rec on the Mac serves a single generation, so parallel calls would only queue there blind. */
export class Queue {
	private tail: Promise<unknown> = Promise.resolve();
	private pending = 0;
	/** Calls queued or running. */
	get length() {
		return this.pending;
	}
	run<T>(task: () => Promise<T>): Promise<T> {
		this.pending++;
		const go = () => task().finally(() => this.pending--);
		const next = this.tail.then(go, go);
		this.tail = next.catch(() => undefined);
		return next;
	}
}

export interface FlintResult {
	answer: string;
	reasoningChars: number;
	finish: string; // "stop" | "length" | ...
	promptTokens: number;
	completionTokens: number;
	cachedTokens: number;
	seconds: number;
}

export type Progress = (p: { seconds: number; reasoningChars: number; answerChars: number }) => void;

/** One fresh single-turn chat: the brief is the whole context, no session history. Streams so long reasoning never hits a
 *  header timeout; reasoning is counted, not returned. */
export async function askFlint(
	cfg: FlintConfig,
	key: string,
	brief: string,
	signal?: AbortSignal,
	onProgress?: Progress,
	system?: string,
): Promise<FlintResult> {
	const t0 = Date.now();
	const timeout = AbortSignal.timeout(cfg.timeoutMin * 60_000);
	const sig = signal ? AbortSignal.any([signal, timeout]) : timeout;
	const messages = [...(system ? [{ role: "system", content: system }] : []), { role: "user", content: brief }];
	let res: Response;
	try {
		res = await fetch(`${cfg.baseUrl.replace(/\/$/, "")}/chat/completions`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
			body: JSON.stringify({
				model: cfg.model,
				messages,
				stream: true,
				stream_options: { include_usage: true },
				max_tokens: cfg.maxTokens,
				temperature: cfg.temperature,
				top_p: cfg.topP,
				top_k: cfg.topK,
			}),
			signal: sig,
		});
	} catch (e: any) {
		throw new Error(timeout.aborted ? `ask_flint: timed out after ${cfg.timeoutMin} min` : `ask_flint: cannot reach Flint at ${cfg.baseUrl} (is the SSH tunnel up?): ${e.message}`);
	}
	if (!res.ok || !res.body) {
		const text = await res.text().catch(() => "");
		throw new Error(`ask_flint: Flint answered HTTP ${res.status}: ${text.slice(0, 300)}`);
	}
	let answer = "", reasoningChars = 0, finish = "", buf = "", lastTick = 0;
	let usage: any = {};
	const dec = new TextDecoder();
	try {
		for await (const chunk of res.body as any) {
			buf += dec.decode(chunk, { stream: true });
			let nl: number;
			while ((nl = buf.indexOf("\n")) >= 0) {
				const line = buf.slice(0, nl).trim();
				buf = buf.slice(nl + 1);
				if (!line.startsWith("data:")) continue;
				const data = line.slice(5).trim();
				if (data === "[DONE]") continue;
				const ev = JSON.parse(data);
				if (ev.usage) usage = ev.usage;
				for (const ch of ev.choices ?? []) {
					const d = ch.delta ?? {};
					if (typeof d.content === "string") answer += d.content;
					const r = d.reasoning ?? d.reasoning_content;
					if (typeof r === "string") reasoningChars += r.length;
					if (ch.finish_reason) finish = ch.finish_reason;
				}
			}
			if (onProgress && Date.now() - lastTick > 2000) {
				lastTick = Date.now();
				onProgress({ seconds: (lastTick - t0) / 1000, reasoningChars, answerChars: answer.length });
			}
		}
	} catch (e: any) {
		if (timeout.aborted) throw new Error(`ask_flint: timed out after ${cfg.timeoutMin} min (${reasoningChars} reasoning chars so far)`);
		throw e;
	}
	return {
		answer: answer.trim(),
		reasoningChars,
		finish: finish || "unknown",
		promptTokens: usage.prompt_tokens ?? 0,
		completionTokens: usage.completion_tokens ?? 0,
		cachedTokens: usage.prompt_tokens_details?.cached_tokens ?? 0,
		seconds: (Date.now() - t0) / 1000,
	};
}

export function checkBrief(cfg: FlintConfig, brief: string): string | undefined {
	if (!brief.trim()) return "ask_flint: the brief is empty.";
	if (brief.length > cfg.maxBriefChars)
		return (
			`ask_flint: the brief is ${brief.length} characters, over the ${cfg.maxBriefChars} limit (the Mac prefills slowly). ` +
			"Send only the code and context the problem needs, then call ask_flint again."
		);
	return undefined;
}
