// Offline tests for extensions/friends/tunnel.ts with a fake ssh (test/fake_ssh.mjs).
//   node --experimental-strip-types --test test/*.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureTunnel, portOpen } from "../extensions/friends/tunnel.ts";

const FAKE = join(dirname(fileURLToPath(import.meta.url)), "fake_ssh.mjs");

async function freePort(): Promise<number> {
	const s = createServer();
	await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
	const p = (s.address() as any).port;
	await new Promise((r) => s.close(r));
	return p;
}

test("starts when down, reuses when up, restarts on a host change, cleans up", async () => {
	const d = mkdtempSync(join(tmpdir(), "tunnel-"));
	const state = join(d, "tunnel.json"), log = join(d, "ssh.log");
	process.env.FAKE_SSH_LOG = log;
	const port = await freePort();
	const t = { host: "user@a", localPort: port, remotePort: 11500, sshCommand: FAKE };
	assert.equal(await portOpen(port), false);
	assert.equal(await ensureTunnel(t, state), "started");
	assert.equal(await portOpen(port), true);
	assert.equal(await ensureTunnel(t, state), "up");
	const pid1 = JSON.parse(readFileSync(state, "utf8")).pid;
	assert.equal(await ensureTunnel({ ...t, host: "user@b" }, state), "restarted");
	const st = JSON.parse(readFileSync(state, "utf8"));
	assert.notEqual(st.pid, pid1);
	assert.equal(st.cfg.host, "user@b");
	assert.throws(() => process.kill(pid1, 0)); // old ssh is gone
	assert.deepEqual(readFileSync(log, "utf8").trim().split("\n").map((l) => l.split(" ")[1]), ["user@a", "user@b"]);
	process.kill(st.pid, "SIGTERM");
});

test("restarts our ssh if it is alive but its port is closed", async () => {
	const d = mkdtempSync(join(tmpdir(), "tunnel-"));
	const state = join(d, "tunnel.json");
	const port = await freePort();
	const t = { host: "user@a", localPort: port, remotePort: 11500, sshCommand: FAKE };
	await ensureTunnel(t, state);
	const pid = JSON.parse(readFileSync(state, "utf8")).pid;
	// same settings but a different local port in the request: our ssh is alive, nothing listens there
	const port2 = await freePort();
	assert.equal(await ensureTunnel({ ...t, localPort: port2 }, state), "restarted");
	assert.throws(() => process.kill(pid, 0));
	process.kill(JSON.parse(readFileSync(state, "utf8")).pid, "SIGTERM");
});

test("a port opened by someone else is left alone", async () => {
	const d = mkdtempSync(join(tmpdir(), "tunnel-"));
	const s = createServer((c) => c.end());
	await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
	const port = (s.address() as any).port;
	try {
		assert.equal(await ensureTunnel({ host: "user@a", localPort: port, remotePort: 1, sshCommand: FAKE }, join(d, "t.json")), "up");
	} finally {
		s.close();
	}
});

test("ssh failure is reported with its error", async () => {
	const d = mkdtempSync(join(tmpdir(), "tunnel-"));
	const port = await freePort();
	await assert.rejects(
		ensureTunnel({ host: "fail@x", localPort: port, remotePort: 1, sshCommand: FAKE }, join(d, "t.json"), 5000),
		/could not open the SSH tunnel to fail@x \(ssh exited 255\): ssh: connect to host x/,
	);
});
