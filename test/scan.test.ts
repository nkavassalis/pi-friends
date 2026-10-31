// Offline tests for the outbound secret gate (client.ts). A brief is a disclosure and a review brief is a
// diff, so this is the guard that stops a path, a hostname or a token from reaching someone else's machine.
// Two properties matter most: it must not block on ordinary code, and it must never echo the matched text.
//
// Every fake credential here is ASSEMBLED at run time. If a whole one ever sat on a single source line, the
// last test ("the gate does not block on this repo's own tracked files") would refuse a diff of pi-friends
// itself — which is exactly how this file ate a 8-minute review call on 2026-10-31 before it was tracked.
//   node --experimental-strip-types --test test/scan.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { DEFAULTS, describeScan, gateBrief, loadFriends, scanBrief } from "../extensions/friends/client.ts";

const ROOT = new URL("../", import.meta.url).pathname;
const rules = (t: string, allow?: string[]) => scanBrief(t, allow).map((h) => `${h.tier}:${h.rule}`);
const assign = (k: string, v: string) => `${k} = "${v}"`; // built at run time, never written whole

const PRIV = "-----BEGIN RSA " + "PRIVATE KEY-----";
const AWS_ID = "AKIA" + "ABCDEFGHIJKLMNOP";
const GH = "ghp_" + "a".repeat(36);
const HF = "hf_" + "a".repeat(34);
const SK = "sk-" + "a".repeat(35);
const XOX = "xoxb-" + "a".repeat(20);
const JWT = ["eyJ", "a".repeat(20), ".", "b".repeat(20), ".", "c".repeat(20)].join("");
const AWS_SECRET = ["wJalrXUtnFEMI", "K7MDENG", "bPxRfiCYEXAMPLEKEY"].join("/"); // the docs example, 40 chars with its slashes
const STRONG = ["aB3dE5fG", "7hI9jK1l", "M3nO"].join(""); // 20 chars, mixed case + digits

test("token and key shapes are blocked", () => {
	const cases: [string, string][] = [
		[PRIV, "block:private-key"],
		[assign("aws_access_key_id", AWS_ID), "block:aws-key-id"],
		[assign("token", GH), "block:github-token"],
		[assign("hf_token", HF), "block:huggingface-token"],
		[assign("openai_key", SK), "block:openai-style-key"],
		[assign("slack_token", XOX), "block:slack-token"],
		[assign("authorization", JWT), "block:jwt"],
		[assign("aws_secret_access_key", AWS_SECRET), "block:aws-secret-key"],
	];
	for (const [line, want] of cases) assert.ok(rules(line).includes(want), `expected ${want} in ${JSON.stringify(rules(line))}`);
});

test("ordinary code is not flagged at all", () => {
	const clean = [
		'const url = "http://127.0.0.1:11501/v1";',
		'assert.equal(auth, "Bearer k123");',
		'const token = "example";',
		'key: "<YOUR_TOKEN>",',
		'password: "changeme",',
		"const maxBriefChars = 64000; // ~16-18K tokens",
		'if (typeof d.content === "string") answer += d.content;',
		"throw new Error(`friends: cannot read the API key file ${cfg.keyFile}: ${e.message}`);",
	].join("\n");
	assert.deepEqual(scanBrief(clean), []);
});

test("warn tier catches the things that are merely identifying", () => {
	// Every value below is a made-up fixture for the rule under test, not this repo's topology: the
	// house rule is placeholder examples, so use documentation-ish addresses and never a real hostname.
	assert.ok(rules("host = 192.168.254.254").includes("warn:lan-ip"));
	assert.ok(rules("proxy 10.255.255.1 and 172.31.255.255").includes("warn:lan-ip"));
	assert.ok(rules("169.254.1.1").includes("warn:lan-ip"));
	assert.ok(rules('cfg = "/home/example/app/config.json"').includes("warn:home-path"));
	assert.ok(rules("C:\\Users\\example\\secrets").includes("warn:home-path"));
	assert.ok(rules("key at /root/.ssh/id_ed25519").includes("warn:home-path"));
	assert.ok(rules("relay http://box.lan:11502").includes("warn:internal-hostname"));
	assert.ok(rules(["srv4", "int", "example", "org"].join(".")).includes("warn:internal-hostname")); // assembled, so this file holds no hostname-shaped literal
	assert.ok(rules("db.internal").includes("warn:internal-hostname"));
	// loopback and public IPs are not leaks: this repo's own tests and docs use 127.0.0.1
	assert.ok(!rules("http://127.0.0.1:11501/v1").some((r) => r.includes("lan-ip")));
	assert.ok(!rules("8.8.8.8").some((r) => r.includes("lan-ip")));
});

test("credential assignment: real-looking secret blocks, placeholder passes, weak value warns", () => {
	assert.ok(rules(assign("apiKey", STRONG)).some((r) => r.startsWith("block:credential-assignment")));
	assert.deepEqual(scanBrief(assign("apiKey", "example-key")), []);
	assert.deepEqual(scanBrief(assign("apiKey", "<YOUR_KEY_HERE>")), []);
	assert.ok(rules(assign("apiKey", "hunter2")).every((r) => r.startsWith("warn:")), "a weak value is a notice, not a refusal");
});

test("scanAllow skips a line by literal text (fixtures and docs examples)", () => {
	const line = assign("fakeApiKey", STRONG);
	assert.ok(rules(line).length > 0, "the fixture must look like a credential, or it tests nothing");
	assert.deepEqual(scanBrief(line, ["fakeApiKey"]), []);
});

test("the report names rules and lines and never the matched content", () => {
	const hits = scanBrief(assign("token", GH), []);
	const msg = describeScan(hits, "review_flint", "block");
	assert.match(msg, /review_flint: refused/);
	assert.match(msg, /github-token \(line 1\)/);
	assert.ok(!msg.includes(GH), "the secret must never be echoed back into the transcript");
	assert.match(msg, /scanAllow/);
});

test("gateBrief: block refuses, warn notices, off is silent, clean passes", () => {
	const bad = assign("token", GH);
	const warnOnly = "host = 192.168.254.254"; // fixture
	assert.throws(() => gateBrief(DEFAULTS, "review_flint", bad), /refused/);
	assert.match(gateBrief(DEFAULTS, "review_flint", warnOnly)!, /notice/);
	assert.equal(gateBrief(DEFAULTS, "review_flint", "nothing to see"), undefined);
	assert.equal(gateBrief({ ...DEFAULTS, scanBrief: "off" }, "review_flint", bad), undefined);
	assert.match(gateBrief({ ...DEFAULTS, scanBrief: "warn" }, "review_flint", bad)!, /notice/); // warn mode sends, but says so
	assert.equal(gateBrief({ ...DEFAULTS, scanAllow: ["token"] }, "review_flint", bad), undefined);
});

test("an explicit empty friends list means no friends, not a phantom one on the default endpoint", () => {
	const p = join(mkdtempSync("/tmp/fr-empty-"), "config.json");
	writeFileSync(p, JSON.stringify({ friends: [] }));
	assert.deepEqual(loadFriends(p), []); // before 2026-10-31 this silently returned one friend at 127.0.0.1
});

test("removed lines in a diff are scanned too — deleting a secret still discloses it", () => {
	// The gate runs on the whole brief, and a review brief contains the diff pre-image. A commit that
	// deletes a credential-shaped literal must therefore still be refused: scanning only '+' lines would
	// send the secret and look clean. This is what refused our own diff on 2026-10-31.
	const diff = [`diff --git a/t.ts b/t.ts`, `index 111..222 100644`, `--- a/t.ts`, `+++ b/t.ts`, `@@ -1,2 +1,1 @@`, `-${assign("token", GH)}`, `+const removed = true;`].join("\n");
	const hits = scanBrief(diff).filter((h) => h.tier === "block");
	assert.ok(hits.some((h) => h.rule === "github-token"), "the removed line must be caught");
	assert.ok(diff.split("\n")[hits[0].line - 1].startsWith("-"), "and it is the deletion, not the addition");
});

test("the gate does not block on this repo's own tracked files", () => {
	// If this fails, the gate would refuse a normal diff of pi-friends itself — fix the rule (or the
	// fixture's construction), never by weakening the gate.
	const files = execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" }).split("\n").filter(Boolean);
	assert.ok(files.length > 10, "git ls-files should list the repo");
	for (const rel of files) {
		const hits = scanBrief(readFileSync(join(ROOT, rel), "utf8")).filter((h) => h.tier === "block");
		assert.deepEqual(hits, [], `${rel} would be blocked: ${hits.map((h) => h.rule).join(", ")}`);
	}
});
