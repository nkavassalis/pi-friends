// Differential ground truth for the review harness. Every claim the bench makes about a planted bug
// rests on these: the clean copy must behave correctly and the planted copy must behave wrongly, on the
// same assertion. A plant that does not change behaviour measures nothing, so this file is the harness's
// licence to report a miss. Offline: fake OpenAI-compatible SSE server, no friend needed.
//   node --experimental-strip-types --test test/review-harness/ground.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { PLANTS } from "./plants.ts";

async function serve(handler: (body: any, res: any) => void): Promise<{ url: string; server: ReturnType<typeof createServer> }> {
	const server = createServer((req, res) => {
		let raw = "";
		req.on("data", (c) => (raw += c));
		req.on("end", () => handler(JSON.parse(raw), res));
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
	return { url: `http://127.0.0.1:${(server.address() as any).port}/v1`, server };
}
const sseLine = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;

/** A stream that answers `content` after `delayMs`, the way rec does (reasoning, then content, then usage). */
function delayedAnswer(delayMs: number, content = "ok") {
	return serve((_b, res) => {
		res.writeHead(200, { "Content-Type": "text/event-stream" });
		res.write(sseLine({ choices: [{ delta: { reasoning: "hm" }, finish_reason: null }] }));
		setTimeout(() => {
			res.write(sseLine({ choices: [{ delta: { content }, finish_reason: null }] }));
			res.write(sseLine({ choices: [{ delta: {}, finish_reason: "stop" }] }));
			res.write(sseLine({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
			res.end(sseLine("[DONE]"));
		}, delayMs);
	});
}

test("fixture: all plants apply to the current client.ts exactly once", async () => {
	const { loadVariant } = await import("./plants.ts");
	const m = await loadVariant(PLANTS.map((p) => p.id)); // throws on drift
	assert.equal(typeof m.askFriend, "function");
});

// --- plant: queue-no-serialization -------------------------------------------------
test("queue serializes when clean, overlaps when planted", async () => {
	const { loadVariant } = await import("./plants.ts");
	for (const [ids, expect] of [[[], 1], [["queue-no-serialization"], 2]] as [string[], number][]) {
		const { Queue } = await loadVariant(ids);
		const q = new Queue();
		let running = 0, maxRunning = 0;
		const job = () => new Promise<void>((res) => { running++; maxRunning = Math.max(maxRunning, running); setTimeout(() => { running--; res(); }, 30); });
		const p = Promise.all([q.run(job), q.run(job), q.run(job)]);
		if (ids.length) assert.ok(q.length >= 0); // the planted counter is meaningless; behaviour is what we assert
		await p;
		if (expect === 1) assert.equal(maxRunning, 1, "clean queue must never overlap");
		else assert.ok(maxRunning > 1, `planted queue must overlap, got maxRunning=${maxRunning}`);
	}
});

// --- plant: content-no-typeguard ---------------------------------------------------
test("non-string delta.content is ignored when clean, corrupts the answer when planted", async () => {
	const { loadVariant } = await import("./plants.ts");
	for (const ids of [[], ["content-no-typeguard"]]) {
		const { askFriend, DEFAULTS } = await loadVariant(ids);
		const { url, server } = await serve((_b, res) => {
			res.writeHead(200, { "Content-Type": "text/event-stream" });
			res.write(sseLine({ choices: [{ delta: { content: { text: "hi" } }, finish_reason: null }] }));
			res.write(sseLine({ choices: [{ delta: { content: "real" }, finish_reason: null }] }));
			res.write(sseLine({ choices: [{ delta: {}, finish_reason: "stop" }] }));
			res.end(sseLine("[DONE]"));
		});
		try {
			const r = await askFriend({ ...DEFAULTS, baseUrl: url }, "k", "b");
			if (ids.length) assert.equal(r.answer, "[object Object]real", "planted must corrupt the answer");
			else assert.equal(r.answer, "real", "clean must drop the non-string delta");
		} finally {
			server.close();
		}
	}
});

// --- plant: timeout-seconds --------------------------------------------------------
test("timeoutMin is minutes when clean, seconds when planted", async () => {
	const { loadVariant } = await import("./plants.ts");
	for (const ids of [[], ["timeout-seconds"]]) {
		const { askFriend, DEFAULTS } = await loadVariant(ids);
		const { url, server } = await delayedAnswer(200); // a slow-but-fine answer
		try {
			const r = await askFriend({ ...DEFAULTS, baseUrl: url, timeoutMin: 0.006 }, "k", "b"); // 360 ms budget
			if (ids.length) throw new Error("planted should have timed out at 6 ms");
			assert.equal(r.answer, "ok");
		} catch (e: any) {
			if (ids.length) assert.match(e.message, /timed out/, "planted must time out early");
			else throw e;
		} finally {
			server.closeAllConnections();
			server.close();
		}
	}
});
