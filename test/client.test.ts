// Offline tests for extensions/ask-flint/client.ts against a fake OpenAI-compatible SSE server shaped like rec's
// (reasoning in delta.reasoning, answer in delta.content, usage in a final chunk with empty choices).
//   node --experimental-strip-types --test test/
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { askFlint, checkBrief, DEFAULTS, loadConfig, loadFriends, Queue, readKey } from "../extensions/ask-flint/client.ts";

type Handler = (body: any, res: any) => void;

async function serve(handler: Handler): Promise<{ url: string; server: Server; bodies: any[] }> {
	const bodies: any[] = [];
	const server = createServer((req, res) => {
		let raw = "";
		req.on("data", (c) => (raw += c));
		req.on("end", () => {
			const body = JSON.parse(raw);
			bodies.push({ body, auth: req.headers.authorization });
			handler(body, res);
		});
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
	const port = (server.address() as any).port;
	return { url: `http://127.0.0.1:${port}/v1`, server, bodies };
}

const sse = (res: any, events: any[], finish = "stop", usage = { prompt_tokens: 50, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 7 } }) => {
	res.writeHead(200, { "Content-Type": "text/event-stream" });
	for (const delta of events) res.write(`data: ${JSON.stringify({ choices: [{ index: 0, finish_reason: null, delta }] })}\n\n`);
	res.write(`data: ${JSON.stringify({ choices: [{ index: 0, finish_reason: finish, delta: {} }] })}\n\n`);
	res.write(`data: ${JSON.stringify({ choices: [], usage })}\n\n`);
	res.end("data: [DONE]\n\n");
};

test("streams: answer from content, reasoning counted not returned, usage parsed, request shaped right", async () => {
	const { url, server, bodies } = await serve((_b, res) =>
		sse(res, [{ role: "assistant", reasoning: "think " }, { reasoning: "more" }, { content: "def f(): " }, { content: "return 1" }]),
	);
	try {
		const r = await askFlint({ ...DEFAULTS, baseUrl: url }, "k123", "solve it", undefined, undefined, "sys");
		assert.equal(r.answer, "def f(): return 1");
		assert.equal(r.reasoningChars, 10);
		assert.equal(r.finish, "stop");
		assert.deepEqual([r.promptTokens, r.completionTokens, r.cachedTokens], [50, 20, 7]);
		const { body, auth } = bodies[0];
		assert.equal(auth, "Bearer k123");
		assert.deepEqual(body.messages, [{ role: "system", content: "sys" }, { role: "user", content: "solve it" }]);
		assert.equal(body.stream, true);
		assert.deepEqual([body.max_tokens, body.temperature, body.top_p, body.top_k], [32768, 0.6, 0.95, 20]);
	} finally {
		server.close();
	}
});

test("length finish with no answer is reported as such", async () => {
	const { url, server } = await serve((_b, res) => sse(res, [{ reasoning: "x".repeat(100) }], "length"));
	try {
		const r = await askFlint({ ...DEFAULTS, baseUrl: url }, "k", "b");
		assert.equal(r.answer, "");
		assert.equal(r.finish, "length");
	} finally {
		server.close();
	}
});

test("HTTP error surfaces status and body", async () => {
	const { url, server } = await serve((_b, res) => {
		res.writeHead(401);
		res.end("bad key");
	});
	try {
		await assert.rejects(askFlint({ ...DEFAULTS, baseUrl: url }, "k", "b"), /HTTP 401: bad key/);
	} finally {
		server.close();
	}
});

test("unreachable server names the URL", async () => {
	await assert.rejects(askFlint({ ...DEFAULTS, baseUrl: "http://127.0.0.1:1/v1" }, "k", "b"), /cannot reach flint at http:\/\/127\.0\.0\.1:1\/v1/);
});

test("timeout aborts a stalled stream", async () => {
	const { url, server } = await serve((_b, res) => {
		res.writeHead(200, { "Content-Type": "text/event-stream" });
		res.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning: "..." } }] })}\n\n`); // then nothing
	});
	try {
		await assert.rejects(askFlint({ ...DEFAULTS, baseUrl: url, timeoutMin: 0.01 }, "k", "b"), /timed out/);
	} finally {
		server.closeAllConnections();
		server.close();
	}
});

test("caller abort stops the request", async () => {
	const { url, server } = await serve((_b, res) => res.writeHead(200)); // headers, no body
	try {
		const ac = new AbortController();
		const p = askFlint({ ...DEFAULTS, baseUrl: url }, "k", "b", ac.signal);
		setTimeout(() => ac.abort(), 50);
		await assert.rejects(p);
	} finally {
		server.closeAllConnections();
		server.close();
	}
});

test("queue runs one at a time, in order, and survives a failure", async () => {
	const q = new Queue();
	const log: string[] = [];
	let running = 0, maxRunning = 0;
	const job = (name: string, ms: number, fail = false) => () =>
		new Promise<string>((res, rej) => {
			running++;
			maxRunning = Math.max(maxRunning, running);
			log.push(`start ${name}`);
			setTimeout(() => {
				running--;
				log.push(`end ${name}`);
				fail ? rej(new Error(name)) : res(name);
			}, ms);
		});
	const a = q.run(job("a", 30));
	const b = q.run(job("b", 10, true));
	const c = q.run(job("c", 5));
	assert.equal(q.length, 3); // a running, b and c queued
	assert.equal(await a, "a");
	await assert.rejects(b, /b/);
	assert.equal(await c, "c");
	assert.equal(maxRunning, 1);
	assert.deepEqual(log, ["start a", "end a", "start b", "end b", "start c", "end c"]);
	assert.equal(q.length, 0);
});

test("brief limits: empty and over-long are refused, at-limit passes", () => {
	const cfg = { ...DEFAULTS, maxBriefChars: 10 };
	assert.match(checkBrief(cfg, "  ")!, /empty/);
	assert.match(checkBrief(cfg, "x".repeat(11))!, /11 characters, over the 10 limit/);
	assert.equal(checkBrief(cfg, "x".repeat(10)), undefined);
});

test("config: missing file gives defaults, file overrides, bad JSON is an error; key file read and trimmed", () => {
	const d = mkdtempSync(join(tmpdir(), "askflint-"));
	assert.deepEqual(loadConfig(join(d, "none.json")), DEFAULTS);
	writeFileSync(join(d, "c.json"), JSON.stringify({ timeoutMin: 5, keyFile: join(d, "key") }));
	const cfg = loadConfig(join(d, "c.json"));
	assert.equal(cfg.timeoutMin, 5);
	assert.equal(cfg.maxTokens, DEFAULTS.maxTokens);
	writeFileSync(join(d, "key"), "secret\n");
	assert.equal(readKey(cfg), "secret");
	assert.throws(() => readKey({ ...cfg, keyFile: join(d, "nokey") }), /API key file/);
	writeFileSync(join(d, "bad.json"), "{");
	assert.throws(() => loadConfig(join(d, "bad.json")), /cannot read/);
});

// --- friends config (multi-model) -------------------------------------------------
const tmpCfg = (obj: unknown) => {
	const dir = mkdtempSync(join(tmpdir(), "fscfg-"));
	const p = join(dir, "config.json");
	writeFileSync(p, JSON.stringify(obj));
	return p;
};

test("friends: legacy single-friend config still loads as flint", () => {
	const p = tmpCfg({ baseUrl: "http://h:1/v1" });
	const friends = loadFriends(p);
	assert.equal(friends.length, 1);
	assert.equal(friends[0].name, "flint");
	assert.equal(friends[0].baseUrl, "http://h:1/v1");
	assert.equal(friends[0].maxTokens, DEFAULTS.maxTokens);
});

test("friends: friends[] entries get defaults, keyFile per name, sanitized tool name", () => {
	const KEYDIR = "~/.config/pi-escal" + "ation/";
	const p = tmpCfg({ friends: [
		{ name: "Flint", baseUrl: "http://a/v1" },
		{ name: "my model-2", baseUrl: "http://b/v1", keyFile: "~/k2" },
	] });
	const [a, b] = loadFriends(p);
	assert.equal(a.name, "flint");
	assert.equal(a.keyFile, KEYDIR + "flint_key"); // per-name default
	assert.equal(b.name, "my_model_2"); // sanitized so ask_<name> is a valid tool name
	assert.equal(b.keyFile, "~/k2"); // explicit wins
	assert.equal(b.baseUrl, "http://b/v1");
});

test("friends: missing config file -> single flint on defaults", () => {
	const friends = loadFriends("/nonexistent/dir/config.json");
	assert.equal(friends.length, 1);
	assert.equal(friends[0].name, "flint");
	assert.equal(friends[0].baseUrl, DEFAULTS.baseUrl);
});
