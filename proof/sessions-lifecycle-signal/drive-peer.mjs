// Synthetic loopback WebSocket gateway peer speaking the real OpenClaw wire
// protocol. It completes the challenge/connect handshake, answers `sessions.describe`
// (so keys enter the delete loop), then holds the first `sessions.delete` request
// until the harness sends a `release` line, at which point it replies with a
// successful delete receipt. This proves an already-admitted mutation keeps its
// receipt across Ctrl+C while later mutations are never started.
import { createRequire } from "node:module";
import path from "node:path";
import { createInterface } from "node:readline";
const checkout = process.argv[2];
const { WebSocketServer } = createRequire(path.join(checkout, "package.json"))("ws");
let deletes = 0;
let held = null;
let heldWs = null;
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
    } else if (f.type === "req" && f.method === "sessions.describe") {
      const key = f.params?.key ?? "unknown";
      ws.send(
        JSON.stringify({
          type: "res",
          id: f.id,
          ok: true,
          payload: {
            session: {
              key,
              sessionId: "session-1",
              kind: "direct",
              agentId: "main",
              archived: false,
              isMain: false,
            },
          },
        }),
      );
      record("describe-ok", { key });
    } else if (f.type === "req" && f.method === "sessions.delete") {
      deletes += 1;
      held = f;
      heldWs = ws;
      record("delete-held", { requestId: f.id, params: f.params, deletes });
      // Hold: reply only when the harness sends a `release` line.
    } else {
      record("other-request", { method: f.method });
    }
  });
  ws.on("close", () => record("front-closed", { deletes }));
});
const lines = createInterface({ input: process.stdin, terminal: false });
lines.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.op === "port") {
    process.stdout.write(
      JSON.stringify({ event: "port-reply", port: server.address().port }) + "\n",
    );
  } else if (msg.op === "release") {
    if (held && heldWs) {
      heldWs.send(
        JSON.stringify({
          type: "res",
          id: held.id,
          ok: true,
          payload: {
            ok: true,
            key: held.params?.key,
            deleted: true,
            archived: [],
          },
        }),
      );
      record("delete-released", { requestId: held.id, params: held.params });
      held = null;
      heldWs = null;
    } else {
      record("release-noop");
    }
  } else if (msg.op === "stop") {
    server.close(() => process.exit(0));
    lines.close();
  }
});
process.on("SIGTERM", () => {
  server.close(() => process.exit(0));
});
