// Planted bugs for the review harness: the fixture is generated FROM the real client.ts at run time,
// so it cannot drift silently — if a `find` string stops matching exactly once, the harness fails loudly
// and says so. Each plant must be proven to change behaviour by ground.test.ts; a plant that does not
// change behaviour is not a bug and measures nothing (one of the three did exactly that on 2026-10-31).
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export interface Plant {
	id: string;
	claim: string; // the defect, as it would be reported to a human
	why: string; // what it does to a real user
	find: string; // exact text in client.ts
	replace: string; // the same code, broken
	// A finding counts as having caught this plant only if its text matches ALL of these.
	match: RegExp[];
}

const CLIENT = new URL("../../extensions/friends/client.ts", import.meta.url);
const TUNNEL = new URL("../../extensions/friends/tunnel.ts", import.meta.url);

export const PLANTS: Plant[] = [
	{
		id: "queue-no-serialization",
		claim: "Queue.run starts the task immediately instead of chaining on this.tail, and pending++/-- both happen synchronously",
		why: "two generations hit the single-generation server at once and queue.length always reads 0, so the 'waiting for N calls' progress lies",
		find: "\trun<T>(task: () => Promise<T>): Promise<T> {\n\t\tthis.pending++;\n\t\tconst go = () => task().finally(() => this.pending--);\n\t\tconst next = this.tail.then(go, go);\n\t\tthis.tail = next.catch(() => undefined);\n\t\treturn next;\n\t}",
		replace: "\trun<T>(task: () => Promise<T>): Promise<T> {\n\t\tthis.pending++;\n\t\tconst next = Promise.resolve().then(task);\n\t\tthis.tail = next.catch(() => undefined);\n\t\tthis.pending--;\n\t\treturn next;\n\t}",
		match: [/queue|run\(|pending|tail/i, /serial|concurren|overlap|one at a time|immediately|without waiting/i],
	},
	{
		id: "content-no-typeguard",
		claim: "delta.content is appended without a typeof guard",
		why: 'a gateway that sends content as an object or array puts "[object Object]" into the answer the agent will apply',
		find: "if (typeof d.content === \"string\") answer += d.content;",
		replace: "if (d.content) answer += d.content;",
		match: [/content|delta|answer/i, /object object|typeof|not a string|non-string|as an object|array/i],
	},
	{
		id: "timeout-seconds",
		claim: "AbortSignal.timeout(cfg.timeoutMin * 1000) — minutes treated as seconds",
		why: "every real call is killed ~60x early; a 20 minute budget becomes 20 seconds, so slow reasoning never finishes",
		find: "const timeout = AbortSignal.timeout(cfg.timeoutMin * 60_000);",
		replace: "const timeout = AbortSignal.timeout(cfg.timeoutMin * 1000);",
		match: [/timeout|abortsignal|timeoutmin/i, /second|minute|1000|60_?000|premature|early/i],
	},
];

/** client.ts with the named plants applied. Throws on fixture drift. */
export function plantedSource(ids: string[]): string {
	let src = readFileSync(CLIENT, "utf8");
	for (const id of ids) {
		const p = PLANTS.find((x) => x.id === id);
		if (!p) throw new Error(`harness: no plant called ${id} (have: ${PLANTS.map((x) => x.id).join(", ")})`);
		const hits = src.split(p.find).length - 1;
		if (hits !== 1) throw new Error(`harness: plant ${id} matched ${hits} times in client.ts, expected exactly 1 — the fixture drifted, update test/review-harness/plants.ts`);
		src = src.replace(p.find, p.replace);
	}
	return src;
}

/** Import a mutated copy of client.ts (fresh module each call, so variants never share state). */
export async function loadVariant(ids: string[] = []): Promise<any> {
	const dir = mkdtempSync(join(tmpdir(), "pi-friends-variant-"));
	copyFileSync(TUNNEL, join(dir, "tunnel.ts")); // client.ts has a type-only import of it; keep the copy self-contained
	const p = join(dir, "client.ts");
	writeFileSync(p, plantedSource(ids));
	return import(pathToFileURL(p).href);
}

/** The artifact a review trial sends: the whole file, since there is no diff against anything. */
export function sourceUnderTest(ids: string[] = []): string {
	return plantedSource(ids);
}
