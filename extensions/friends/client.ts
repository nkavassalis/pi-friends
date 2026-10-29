// Friend client: config, a one-at-a-time queue, and one streamed chat request.
// No pi imports, so `node --test` can run it (test/client.test.ts) against a fake server.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { TunnelConfig } from "./tunnel.ts";

export interface FriendConfig {
	name?: string; // friend name; the tool is ask_<name>. Default "friend" (a legacy single-friend config loads as one friend named "friend")
	baseUrl: string; // OpenAI-compatible base, e.g. http://<mac>:11502/v1 (mac-tuning's LAN relay in front of rec)
	model: string;
	keyFile: string; // file holding the server's API key
	maxTokens: number; // reasoning + answer; reasoning models need a large budget
	temperature: number;
	topP: number;
	topK: number;
	timeoutMin: number; // whole request, queue wait excluded
	maxBriefChars: number; // longer briefs are refused (slow hosts prefill ~600 tok/s), never cut
	tunnel?: TunnelConfig; // set: the tool opens/repairs the SSH tunnel itself before each call (tunnel.ts)
	system?: string; // persona for the one-turn chat (index.ts has a default)
	description?: string; // tool description override
	label?: string; // display name in the tool UI
	guidelines?: string[]; // prompt-guideline overrides; {{tool}} is replaced with the tool name
}

export const DEFAULTS: FriendConfig = {
	name: "friend",
	baseUrl: "http://127.0.0.1:11501/v1",
	model: "friend",
	keyFile: "~/.config/pi-friends/friend_key",
	maxTokens: 32768,
	temperature: 0.6, // measured best for the flint friend (see README benchmarks)
	topP: 0.95,
	topK: 20,
	timeoutMin: 20,
	maxBriefChars: 64000, // ~16-18K tokens, ~30 s of prefill on a slow host
};

export const CONFIG_PATH = join(homedir(), ".config", "pi-friends", "config.json");
const LEGACY_CONFIG_PATH = join(homedir(), ".config", "pi-escalation", "config.json"); // pre-rename location, read-fallback only

/** New location wins; fall back to the pre-rename dir so a half-migrated box still works. */
function resolveCfg(p: string): string {
	return p === CONFIG_PATH && !existsSync(p) && existsSync(LEGACY_CONFIG_PATH) ? LEGACY_CONFIG_PATH : p;
}

const expand = (p: string) => (p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);

export function loadConfig(p = CONFIG_PATH): FriendConfig {
	const path = resolveCfg(p);
	let file: Partial<FriendConfig> = {};
	try {
		file = JSON.parse(readFileSync(path, "utf8"));
	} catch (e: any) {
		if (e?.code !== "ENOENT") throw new Error(`friends: cannot read ${path}: ${e.message}`);
	}
	return { ...DEFAULTS, ...file };
}

/**
 * All friends to register. config.json is either the original single-friend shape
 * (loads as one friend named "friend" — existing installs keep working) or
 * {"friends":[{name, baseUrl, ...}, ...]}. Each named friend defaults its keyFile to
 * ~/.config/pi-friends/<name>_key; names are sanitized to [a-z0-9_] so the tool
 * name ask_<name> is always valid.
 */
export function loadFriends(p = CONFIG_PATH): FriendConfig[] {
	const path = resolveCfg(p);
	let file: any = {};
	try {
		file = JSON.parse(readFileSync(path, "utf8"));
	} catch (e: any) {
		if (e?.code !== "ENOENT") throw new Error(`friends: cannot read ${path}: ${e.message}`);
	}
	if (Array.isArray(file?.friends) && file.friends.length > 0) {
		return file.friends.map((f: any) => {
			const clean = String(f?.name ?? "friend").toLowerCase().replace(/[^a-z0-9_]/g, "_");
			return { ...DEFAULTS, ...f, name: clean, keyFile: f.keyFile ?? `~/.config/pi-friends/${clean}_key` } as FriendConfig;
		});
	}
	return [{ ...DEFAULTS, ...file }]; // legacy single-friend config
}

export function readKey(cfg: FriendConfig): string {
	try {
		return readFileSync(expand(cfg.keyFile), "utf8").trim();
	} catch (e: any) {
		throw new Error(`friends: cannot read the API key file ${cfg.keyFile}: ${e.message}`);
	}
}

/** Runs tasks one at a time: most local servers serve a single generation, so parallel calls would only queue there blind. */
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

export interface FriendResult {
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
export async function askFriend(
	cfg: FriendConfig,
	key: string,
	brief: string,
	signal?: AbortSignal,
	onProgress?: Progress,
	system?: string,
): Promise<FriendResult> {
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
		throw new Error(timeout.aborted ? `friends: timed out after ${cfg.timeoutMin} min` : `friends: cannot reach ${cfg.name ?? "friend"} at ${cfg.baseUrl} (is the server up, and is baseUrl right?): ${e.message}`);
	}
	if (!res.ok || !res.body) {
		const text = await res.text().catch(() => "");
		throw new Error(`friends: ${cfg.name ?? "friend"} answered HTTP ${res.status}: ${text.slice(0, 300)}`);
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
		if (timeout.aborted) throw new Error(`friends: timed out after ${cfg.timeoutMin} min (${reasoningChars} reasoning chars so far)`);
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

export function checkBrief(cfg: FriendConfig, brief: string): string | undefined {
	if (!brief.trim()) return "friends: the brief is empty.";
	if (brief.length > cfg.maxBriefChars)
		return (
			`friends: the brief is ${brief.length} characters, over the ${cfg.maxBriefChars} limit (the Mac prefills slowly). ` +
			"Send only the code and context the problem needs, then call the tool again."
		);
	return undefined;
}
