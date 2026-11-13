// Synthetic loopback WebSocket gateway peer speaking the real OpenClaw wire
// protocol. It completes the challenge/connect handshake, then holds the
// `audit.activity.list` request (never replies) so the CLI read stays pending
// while SIGINT is delivered to the controlling PTY.
import { createRequire } from "node:module";
import path from "node:path";
import { createInterface } from "node:readline";
const checkout = process.argv[2];
const { WebSocketServer } = createRequire(path.join(checkout, "package.json"))("ws");
let held = null;
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
    } else if (f.type === "req" && f.method === "audit.activity.list") {
      record("audit-held", { requestId: f.id, params: f.params });
      held = { ws, id: f.id };
    } else {
      record("other-request", { method: f.method });
      // Unknown reads: let them hang too (never reply) so nothing spuriously settles.
    }
  });
  ws.on("close", () => record("front-closed"));
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
