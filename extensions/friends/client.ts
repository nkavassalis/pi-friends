// Friend client: config, a one-at-a-time queue, and one streamed chat request.
// No pi imports, so `node --test` can run it (test/client.test.ts) against a fake server.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { TunnelConfig } from "./tunnel.ts";

export interface FriendConfig {
	name?: string; // friend name; the tool is ask_<name>. Default "friend" (a legacy single-friend config loads as one friend named "friend")
	baseUrl: string; // OpenAI-compatible base, e.g. http://<mac>:11502/v1 (mac-tuning's LAN relay in front of rec)
	model: string;
	keyFile: string; // file holding the server's API key
	maxTokens: number; // reasoning + answer; reasoning models need a large budget
	reviewMaxTokens?: number; // budget for review_<name>; reviews reason longer than they answer, and hitting the cap means NO review
	temperature: number;
	topP: number;
	topK: number;
	timeoutMin: number; // whole request, queue wait excluded
	maxBriefChars: number; // longer briefs are refused (slow hosts prefill ~600 tok/s), never cut
	tunnel?: TunnelConfig; // set: the tool opens/repairs the SSH tunnel itself before each call (tunnel.ts)
	system?: string; // persona for the one-turn chat (index.ts has a default)
	reviewSystem?: string; // persona override for review_<name>; REVIEW_SYSTEM is the default
	scanBrief?: "block" | "warn" | "off"; // outbound secret gate on every brief (scanBrief below). Default "block"
	scanAllow?: string[]; // literal substrings; a line containing one is skipped by the scanner (fixtures, docs examples)
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
	reviewMaxTokens: 40960, // measured 2026-10-31: a 5-file review used 25K tokens and a 6-file one exhausted 32768 reasoning tokens and returned nothing
	temperature: 0.6, // measured best for the flint friend (see README benchmarks)
	topP: 0.95,
	topK: 20,
	timeoutMin: 20,
	maxBriefChars: 64000, // ~16-18K tokens, ~30 s of prefill on a slow host
	scanBrief: "block",
};

export const CONFIG_PATH = join(homedir(), ".config", "pi-friends", "config.json");

const expand = (p: string) => (p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);

/** "" or "  " counts as unset, not as a path: found by the review bench 2026-10-31 (an empty keyFile used to
 *  fail as "cannot read the API key file :"), and by the friend on the second round — the first fix covered
 *  only the friends[] branch, while a spread lets an explicit "" overwrite the DEFAULTS value. */
const keyOrDefault = (given: unknown, name: string) =>
	typeof given === "string" && given.trim() ? given : `~/.config/pi-friends/${name}_key`;

export function loadConfig(p = CONFIG_PATH): FriendConfig {
	let file: Partial<FriendConfig> = {};
	try {
		file = JSON.parse(readFileSync(p, "utf8"));
	} catch (e: any) {
		if (e?.code !== "ENOENT") throw new Error(`friends: cannot read ${p}: ${e.message}`);
	}
	const cfg = { ...DEFAULTS, ...file };
	// keyOrDefault must see the RAW value: after the spread, cfg.keyFile is always truthy (DEFAULTS
	// supplies one), so the per-name fallback could never fire and a named inline friend used friend_key.
	cfg.keyFile = keyOrDefault(file.keyFile, cfg.name ?? DEFAULTS.name!);
	return cfg;
}

/**
 * All friends to register. config.json is either the original single-friend shape
 * (loads as one friend named "friend" — existing installs keep working) or
 * {"friends":[{name, baseUrl, ...}, ...]}. Each named friend defaults its keyFile to
 * ~/.config/pi-friends/<name>_key; names are sanitized to [a-z0-9_] so the tool
 * name ask_<name> is always valid.
 */
export function loadFriends(p = CONFIG_PATH): FriendConfig[] {
	let file: any = {};
	try {
		file = JSON.parse(readFileSync(p, "utf8"));
	} catch (e: any) {
		if (e?.code !== "ENOENT") throw new Error(`friends: cannot read ${p}: ${e.message}`);
	}
	if (Array.isArray(file?.friends)) {
		// An explicit empty list means "no friends", not "give me a bogus default one on 127.0.0.1".
		const list = file.friends.map((f: any) => {
			// collapse runs and trim edges, or "!!!" becomes the perfectly valid-looking tool name ask___
			const clean = String(f?.name ?? "friend").toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
			if (!clean) throw new Error(`friends: a friend name sanitizes to an empty tool name (ask_); use letters, digits and _ (got ${JSON.stringify(f?.name)})`);
			return { ...DEFAULTS, ...f, name: clean, keyFile: keyOrDefault(f.keyFile, clean) } as FriendConfig;
		});
		// Two names that collapse to one tool ("My Model" / "my-model") would silently shadow each other.
		const counts = new Map<string, number>();
		for (const f of list) counts.set(f.name, (counts.get(f.name) ?? 0) + 1);
		const dupes = [...counts].filter(([, n]) => n > 1).map(([n, c]) => `${n} x${c}`);
		if (dupes.length) throw new Error(`friends: these names collide as ask_<name>/review_<name>: ${dupes.join(", ")} — give every friend a distinct name`);
		return list;
	}
	const one = { ...DEFAULTS, ...file } as FriendConfig; // legacy inline shape
	one.keyFile = keyOrDefault(file.keyFile, one.name ?? DEFAULTS.name!); // raw value, same reason as loadConfig
	return [one];
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
		// Promise.resolve + try/catch around task(): if task() THROWS SYNCHRONOUSLY the .finally is never
		// attached, pending leaks, and this friend is wedged for the rest of the session (review bench, 2026-10-31).
		const go = () => {
			try {
				return Promise.resolve(task()).finally(() => this.pending--);
			} catch (e) {
				this.pending--;
				return Promise.reject(e);
			}
		};
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
	badChunks: number; // SSE lines that were not valid JSON — tolerated, but never silently
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
		// Order matters. A caller abort (the user pressed escape) is not a connectivity problem, and
		// "is the server up?" sends someone debugging a perfectly good server in the wrong direction.
		if (signal?.aborted) throw new Error(`friends: cancelled by the caller before ${cfg.name ?? "friend"} answered`);
		if (timeout.aborted) throw new Error(`friends: timed out after ${cfg.timeoutMin} min`);
		throw new Error(`friends: cannot reach ${cfg.name ?? "friend"} at ${cfg.baseUrl} (is the server up, and is baseUrl right?): ${e.message}`);
	}
	if (!res.ok || !res.body) {
		const text = await res.text().catch(() => "");
		throw new Error(`friends: ${cfg.name ?? "friend"} answered HTTP ${res.status}: ${text.slice(0, 300)}`);
	}
	let answer = "", reasoningChars = 0, finish = "", buf = "", lastTick = 0, badChunks = 0;
	let usage: any = {};
	const dec = new TextDecoder();
	const consume = (raw: string) => {
		const line = raw.trim();
		if (!line.startsWith("data:")) return;
		const data = line.slice(5).trim();
		if (data === "[DONE]" || !data) return;
		let ev: any;
		try {
			ev = JSON.parse(data); // one malformed heartbeat line must not kill a 4-minute generation; counted, not silent
		} catch {
			badChunks++;
			return;
		}
		if (ev.error) throw new Error(`friends: ${cfg.name ?? "friend"} sent a stream error: ${String(ev.error?.message ?? ev.error).slice(0, 300)}`);
		if (ev.usage) usage = ev.usage;
		for (const ch of ev.choices ?? []) {
			const d = ch.delta ?? {};
			if (typeof d.content === "string") answer += d.content;
			const r = d.reasoning ?? d.reasoning_content;
			if (typeof r === "string") reasoningChars += r.length;
			if (ch.finish_reason) finish = ch.finish_reason;
		}
	};
	try {
		for await (const chunk of res.body as any) {
			buf += dec.decode(chunk, { stream: true });
			let nl: number;
			while ((nl = buf.indexOf("\n")) >= 0) {
				consume(buf.slice(0, nl));
				buf = buf.slice(nl + 1);
			}
			if (onProgress && Date.now() - lastTick > 2000) {
				lastTick = Date.now();
				onProgress({ seconds: (lastTick - t0) / 1000, reasoningChars, answerChars: answer.length });
			}
		}
		buf += dec.decode(); // flush a multibyte character split across chunks
		if (buf.trim()) consume(buf); // a final event with no trailing newline used to be dropped silently
	} catch (e: any) {
		if (signal?.aborted) throw new Error(`friends: cancelled by the caller after ${reasoningChars} reasoning chars`);
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
		badChunks,
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

// ---- outbound secret gate ---------------------------------------------------------------
// A brief is a disclosure: it goes to another machine, over plain HTTP by default, and whatever is in
// it must be treated as known to that endpoint's operator. A review brief makes this sharp, because
// the artifact being sent is a diff — the single most likely place to find a path, a hostname or a
// token. So the gate runs on every outbound brief, and a hit reports the RULE NAME and LINE NUMBER
// ONLY, never the matched text (that would copy the secret into the transcript and the session log).

export interface ScanHit {
	rule: string;
	tier: "block" | "warn";
	line: number;
}

const BLOCK_RULES: [string, RegExp][] = [
	["private-key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
	["aws-key-id", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
	["github-token", /\bgh[pousr]_[A-Za-z0-9]{20,}\b/],
	["huggingface-token", /\bhf_[A-Za-z0-9]{20,}\b/],
	["openai-style-key", /\bsk-[A-Za-z0-9_-]{20,}\b/],
	["slack-token", /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/],
	["jwt", /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/],
	["aws-secret-key", /\baws[a-z0-9_ :=-]{0,30}["'][A-Za-z0-9/+=]{40}["']/i], // the separator run must allow " = " too — it took two tries to notice
];

const WARN_RULES: [string, RegExp][] = [
	["lan-ip", /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|169\.254\.\d{1,3}\.\d{1,3})\b/],
	["home-path", /\/home\/[a-z0-9._-]{2,}|\/Users\/[a-z0-9._-]{2,}|\/root\/[a-z0-9._-]{2,}|[A-Za-z]:\\Users\\/i],
	["internal-hostname", /\b[\w-]+\.(?:internal|lan|local|home|corp|localdomain)\b|\b[\w-]+\.int\.[\w-]+\.[a-z]{2,}\b/i],
];

// `key: "value"` shapes. Blocked only when the value looks like a real credential, so that docs and
// test fixtures ("token": "example", "<YOUR_TOKEN>", "x".repeat(20)) do not stop work.
const ASSIGNMENT = /["']?(api[_-]?key|apikey|secret|secret[_-]?key|token|access[_-]?token|auth[_-]?token|password|passwd|access[_-]?key)["']?\s*[:=]\s*["']([^"'\s]{8,})["']/gi;
const PLACEHOLDER = /^<[^<>]*>$|^(?:x+|\.+|\*+|0+|change[_-]?me|replace[_-]?me|your[_-]?\w*|my[_-]?\w*|placeholder|dummy|sample|example[\w-]*|fixture|test[_-]?\w*|fake[_-]\w*|redacted|removed|todo|secret|token|key|password)$/i;

const highEntropy = (v: string) => v.length >= 16 && /[A-Za-z]/.test(v) && (/[0-9]/.test(v) || (/[^\s]/.test(v) && /[A-Z]/.test(v) && /[a-z]/.test(v)));

/** What a brief would disclose. Order is block-then-warn, then by line. */
export function scanBrief(text: string, allow: string[] = []): ScanHit[] {
	const hits: ScanHit[] = [];
	text.split("\n").forEach((line, i) => {
		if (allow.some((a) => a && line.includes(a))) return;
		for (const [rule, re] of BLOCK_RULES) if (re.test(line)) hits.push({ rule, tier: "block", line: i + 1 });
		for (const [rule, re] of WARN_RULES) if (re.test(line)) hits.push({ rule, tier: "warn", line: i + 1 });
		for (const m of line.matchAll(ASSIGNMENT)) {
			const value = m[2];
			if (PLACEHOLDER.test(value)) continue;
			hits.push({ rule: `credential-assignment(${m[1].toLowerCase()})`, tier: highEntropy(value) ? "block" : "warn", line: i + 1 });
		}
	});
	return hits.sort((a, b) => (a.tier === b.tier ? a.line - b.line : a.tier === "block" ? -1 : 1));
}

/** The refusal/notice text. Never contains the matched content, only rule names and line numbers. */
export function describeScan(hits: ScanHit[], toolName: string, mode: "block" | "warn"): string {
	const list = hits.map((h) => `${h.rule} (line ${h.line})`).join(", ");
	return mode === "block"
		? `${toolName}: refused — the brief would disclose ${list}. Redact it, or pass the file through your own scrub first. `
			+ `Nothing was sent. If a hit is a fixture or a docs example, add its literal text to scanAllow in config.json; `
			+ `scanBrief: "warn" downgrades everything to a notice and "off" disables the gate (know what you are sending).`
		: `${toolName}: notice — the brief contains ${list}. Sent anyway; treat all of it as disclosed to that endpoint's operator.`;
}

/**
 * Apply the gate for one outbound brief. Returns a notice to append to the result, or throws when
 * something block-tier is present and the mode is "block". Lives here rather than in index.ts so it
 * is covered by the offline suite — it is the guard that keeps a diff from carrying a secret to
 * someone else's machine.
 */
export function gateBrief(cfg: FriendConfig, toolName: string, brief: string): string | undefined {
	const mode = cfg.scanBrief ?? "block";
	if (mode === "off") return undefined;
	const hits = scanBrief(brief, cfg.scanAllow ?? []);
	if (!hits.length) return undefined;
	const blocks = hits.filter((h) => h.tier === "block");
	if (blocks.length && mode === "block") throw new Error(describeScan(blocks, toolName, "block"));
	return describeScan(hits, toolName, "warn");
}
