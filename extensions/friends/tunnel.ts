// On-demand SSH tunnel for a friend behind SSH (e.g. a laptop that is not always on the LAN). This machine has no service manager (a container with sshd as PID 1), so
// instead of a service the tool checks the tunnel before every call: it starts ssh if nothing listens on the local port, and
// restarts it if the host in the config changed since it was started. State (pid + the settings it was started with) lives in
// ~/.config/pi-friends/tunnel.json. No pi imports (tested by test/tunnel.test.ts).
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { connect } from "node:net";

export interface TunnelConfig {
	host: string; // ssh target of the Mac, e.g. user@<mac-ip>: change this to point at another address
	identity?: string; // ssh identity file
	localPort: number; // loopback port on this machine (must match baseUrl)
	remotePort: number; // rec's port on the Mac's loopback
	sshCommand?: string; // default "ssh" (tests use a fake)
}

export const STATE_PATH = join(homedir(), ".config", "pi-escalation", "tunnel.json");
const expand = (p: string) => (p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);

export function portOpen(port: number, ms = 1000): Promise<boolean> {
	return new Promise((resolve) => {
		const s = connect({ host: "127.0.0.1", port });
		const done = (ok: boolean) => {
			s.destroy();
			resolve(ok);
		};
		s.setTimeout(ms, () => done(false));
		s.once("connect", () => done(true));
		s.once("error", () => done(false));
	});
}

const alive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

const sameSettings = (a: TunnelConfig, b: TunnelConfig) =>
	a.host === b.host && a.identity === b.identity && a.localPort === b.localPort && a.remotePort === b.remotePort;

function readState(path: string): { pid: number; cfg: TunnelConfig } | undefined {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return undefined;
	}
}

/** Make sure 127.0.0.1:localPort forwards to the configured Mac. Returns what it did, for the tool's progress line. */
export async function ensureTunnel(t: TunnelConfig, statePath = STATE_PATH, waitMs = 15000): Promise<"up" | "started" | "restarted"> {
	const st = readState(statePath);
	const ours = st && alive(st.pid);
	const open = await portOpen(t.localPort);
	if (open && (!ours || sameSettings(st!.cfg, t))) return "up"; // ours with the same settings, or one started by hand
	if (ours) {
		// settings changed (e.g. a new host), or our ssh is alive but the forward is dead
		process.kill(st!.pid, "SIGTERM");
		for (let i = 0; i < 50 && (await portOpen(t.localPort, 200)); i++) await new Promise((r) => setTimeout(r, 100));
	}
	const args = [
		...(t.identity ? ["-i", expand(t.identity)] : []),
		"-N", "-o", "BatchMode=yes", "-o", "ExitOnForwardFailure=yes", "-o", "ConnectTimeout=10",
		"-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=4",
		"-L", `127.0.0.1:${t.localPort}:127.0.0.1:${t.remotePort}`, t.host,
	];
	const child = spawn(t.sshCommand ?? "ssh", args, { detached: true, stdio: ["ignore", "ignore", "pipe"] });
	let err = "";
	child.stderr!.on("data", (d) => (err += d));
	let exited: number | null = null;
	child.once("exit", (code) => (exited = code ?? -1));
	const t0 = Date.now();
	while (Date.now() - t0 < waitMs) {
		if (await portOpen(t.localPort, 300)) {
			child.stderr!.destroy();
			child.unref(); // outlives pi; the next call reuses it
			writeFileSync(statePath, JSON.stringify({ pid: child.pid, cfg: t }), { mode: 0o600 });
			return ours ? "restarted" : "started";
		}
		if (exited !== null) break;
		await new Promise((r) => setTimeout(r, 200));
	}
	try {
		child.kill();
	} catch {}
	throw new Error(`friends: could not open the SSH tunnel to ${t.host} (${exited !== null ? `ssh exited ${exited}` : "timed out"}): ${err.trim().slice(0, 300)}`);
}
