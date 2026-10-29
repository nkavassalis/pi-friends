#!/usr/bin/env node
// Fake ssh for test/tunnel.test.ts: listens on the -L local port and records the target host in $FAKE_SSH_LOG.
// Host "fail@x" exits 255 with an error, like ssh would on a refused connection.
import { createServer } from "node:net";
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
const host = args[args.length - 1];
const port = Number(args[args.indexOf("-L") + 1].split(":")[1]);
if (process.env.FAKE_SSH_LOG) appendFileSync(process.env.FAKE_SSH_LOG, `${process.pid} ${host}\n`);
if (host.startsWith("fail@")) { process.stderr.write("ssh: connect to host x port 22: Connection refused\n"); process.exit(255); }
createServer((s) => s.end()).listen(port, "127.0.0.1");
process.on("SIGTERM", () => process.exit(0));
