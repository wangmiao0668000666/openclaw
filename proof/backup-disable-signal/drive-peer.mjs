// Synthetic loopback WebSocket gateway peer speaking the real OpenClaw wire
// protocol. Completes the challenge/connect handshake, answers `cron.list`
// (two backup schedules), then holds the first `cron.remove` (never replies)
// so the CLI mutation read stays pending while SIGINT is delivered to the PTY.
// The peer counts every remove it receives.
import { createRequire } from "node:module";
import path from "node:path";
import { createInterface } from "node:readline";
const checkout = process.argv[2];
const { WebSocketServer } = createRequire(path.join(checkout, "package.json"))("ws");
let removes = 0;
const record = (event, facts = {}) =>
  process.stdout.write(JSON.stringify({ event, wallMs: Date.now(), ...facts }) + "\n");
const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
server.on("listening", () => record("listening", { port: server.address().port }));
server.on("connection", (ws) => {
  record("front-connected");
  ws.send(
    JSON.stringify({
      type: "event",
      event: "connect.challenge",
      payload: { nonce: "synthetic-nonce", ts: Date.now() },
    }),
  );
  record("challenge-sent");
  ws.on("message", (raw) => {
    const f = JSON.parse(raw.toString());
    if (f.type === "req" && f.method === "connect") {
      record("connect-request");
      ws.send(
        JSON.stringify({
          type: "res",
          id: f.id,
          ok: true,
          payload: { type: "hello-ok", protocol: 4, policy: { tickIntervalMs: 10000 } },
        }),
      );
      record("hello-ok-sent");
    } else if (f.type === "req" && f.method === "health") {
      ws.send(JSON.stringify({ type: "res", id: f.id, ok: true, payload: { status: "ok" } }));
      record("health-ok-sent");
    } else if (f.type === "req" && f.method === "cron.list") {
      const job = (id, declarationKey) => ({
        id,
        name: id,
        enabled: true,
        createdAtMs: 1,
        updatedAtMs: 1,
        declarationKey,
        schedule: { kind: "every", everyMs: 60_000 },
        payload: { kind: "command", argv: ["openclaw", "backup", "git", "create"] },
        sessionTarget: "isolated",
        wakeMode: "now",
        state: {},
      });
      const jobs = [
        job("git-job", "openclaw-backup-scheduled"),
        job("offsite-job", "openclaw-backup-offsite-scheduled"),
      ];
      ws.send(
        JSON.stringify({
          type: "res",
          id: f.id,
          ok: true,
          payload: {
            jobs,
            snapshotRevision: "1",
            total: jobs.length,
            offset: 0,
            limit: 200,
            hasMore: false,
            nextOffset: null,
          },
        }),
      );
      record("cron-list-ok", { jobCount: jobs.length });
    } else if (f.type === "req" && f.method === "cron.remove") {
      removes += 1;
      record("remove-held", { requestId: f.id, params: f.params, removes });
      // Never reply: the CLI mutation read stays pending until SIGINT or launcher kill.
    } else {
      record("other-request", { method: f.method });
    }
  });
  ws.on("close", () => record("front-closed", { removes }));
});
const lines = createInterface({ input: process.stdin, terminal: false });
lines.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.op === "port") {
    process.stdout.write(
      JSON.stringify({ event: "port-reply", port: server.address().port }) + "\n",
    );
  } else if (msg.op === "stop") {
    server.close(() => process.exit(0));
    lines.close();
  }
});
process.on("SIGTERM", () => {
  server.close(() => process.exit(0));
});
