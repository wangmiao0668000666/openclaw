#!/usr/bin/env node
/**
 * Real-Gateway proof for PR #204717: a Control UI session with
 * messages.visibleReplies="message_tool" must be able to deliver its completion
 * reply from the settle wake that resumes the parent after its child finishes.
 *
 * Runs the actual dist build (Gateway + Control UI + scripted OpenAI Responses
 * transport). No product code is imported: only Playwright and node builtins.
 *
 * Usage:
 *   node control-ui-completion-reply.mjs [--repo <path>] [--out <dir>]
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 1) {
  const token = process.argv[i];
  if (token.startsWith("--")) {
    args.set(token.slice(2), process.argv[i + 1]);
    i += 1;
  }
}

const repo = path.resolve(args.get("repo") ?? process.cwd());
const outDir =
  args.get("out") ?? path.join(repo, ".artifacts", "proof", "control-ui-completion-reply");
const NODE_BIN = process.execPath;
const log = (...parts) => console.log("[proof]", ...parts);
const fail = (message) => {
  console.error("[proof] FAIL:", message);
  process.exitCode = 1;
  throw new Error(message);
};

const proof = {
  what: "Control UI completion wake delivers its reply under visibleReplies=message_tool",
  gateway: "real isolated Gateway from dist build",
  provider: "scripted loopback OpenAI Responses transport (not external-provider live proof)",
  browser: "real Chromium via Playwright",
  complete: false,
};
const saveProof = async () => {
  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(path.join(outDir, "proof.json"), `${JSON.stringify(proof, null, 2)}\n`);
};

const redactions = [];
const redact = (text) =>
  redactions.reduce(
    (acc, [needle, replacement]) => (needle ? acc.split(needle).join(replacement) : acc),
    String(text),
  );

// ---------------------------------------------------------------- provider ---

function sse(response, events) {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-store",
    connection: "keep-alive",
  });
  response.end(
    `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`,
  );
}

function textReply(response, text, id) {
  const message = {
    type: "message",
    id: `${id}_message`,
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  };
  sse(response, [
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...message, status: "in_progress", content: [] },
    },
    {
      type: "response.output_text.delta",
      item_id: message.id,
      output_index: 0,
      content_index: 0,
      delta: text,
    },
    {
      type: "response.output_text.done",
      item_id: message.id,
      output_index: 0,
      content_index: 0,
      text,
    },
    { type: "response.output_item.done", output_index: 0, item: message },
    {
      type: "response.completed",
      response: {
        id: `${id}_response`,
        status: "completed",
        output: [message],
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      },
    },
  ]);
}

function toolCall(response, name, callArgs, id) {
  const item = {
    type: "function_call",
    id: `fc_${id}`,
    call_id: `call_${id}`,
    name,
    arguments: JSON.stringify(callArgs),
    status: "completed",
  };
  sse(response, [
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...item, status: "in_progress", arguments: "" },
    },
    {
      type: "response.function_call_arguments.done",
      item_id: item.id,
      output_index: 0,
      arguments: item.arguments,
    },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id: `resp_${id}`,
        status: "completed",
        output: [item],
        usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
      },
    },
  ]);
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

const fixture = {
  key: "agent:main:dashboard:completion-reply-proof",
  label: "Completion reply proof",
  childLabel: "Check the release notes",
  childTask: "Check the synthetic release notes and report when the review is complete.",
  initialPrompt: "Start a separate review session, then wait for its result.",
  acknowledgment: "The review is running in a separate session. I will return with the result.",
  childReply: "The release notes review is complete. No issues found.",
  // The completion reply is sent with the message tool and no target. This is the
  // exact call the source-reply guard used to refuse on a Control UI session.
  resumedReply: "The review finished successfully. No issues found in the release notes.",
};

const receipts = [];
const recordedMessageArgs = [];
let parentRequests = 0;
let childResponse;
let childReleased = false;
let childStartedResolve;
const childStarted = new Promise((resolve) => {
  childStartedResolve = resolve;
});
const failures = [];

function lastToolOutput(input, toolName) {
  const call = [...(input ?? [])]
    .reverse()
    .find((item) => item.type === "function_call" && item.name === toolName);
  if (!call) {
    return undefined;
  }
  return [...(input ?? [])]
    .reverse()
    .find((item) => item.type === "function_call_output" && item.call_id === call.call_id)?.output;
}

function startProvider() {
  const server = createServer(async (request, response) => {
    try {
      if (request.method !== "POST" || request.url !== "/v1/responses") {
        request.resume();
        response.writeHead(404).end();
        return;
      }
      const body = JSON.parse(await readBody(request));
      const id = randomUUID();

      if (body.model === "child") {
        if (childReleased) {
          textReply(response, fixture.childReply, `child_followup_${id}`);
          return;
        }
        childResponse = response;
        childStartedResolve();
        return; // held until the parent turn settles and the wake resumes
      }

      const step = parentRequests;
      parentRequests += 1;
      if (step === 0) {
        toolCall(
          response,
          "sessions_spawn",
          {
            runtime: "subagent",
            visible: true,
            agentId: "main",
            context: "isolated",
            label: fixture.childLabel,
            taskName: "review-notes",
            task: fixture.childTask,
            model: "wait-fixture/child",
          },
          id,
        );
        return;
      }
      if (step === 1) {
        receipts.push({
          step,
          tool: "sessions_spawn",
          output: lastToolOutput(body.input, "sessions_spawn"),
        });
        toolCall(response, "sessions_yield", { acknowledgment: fixture.acknowledgment }, id);
        return;
      }
      if (step === 2) {
        // Completion wake: the child has finished and the parent resumes. The reply
        // must go out through the message tool with no channel/target.
        const messageArgs = { action: "send", message: fixture.resumedReply };
        recordedMessageArgs.push(messageArgs);
        toolCall(response, "message", messageArgs, id);
        return;
      }
      if (step === 3) {
        receipts.push({ step, tool: "message", output: lastToolOutput(body.input, "message") });
        textReply(response, "NO_REPLY", `after_${id}`);
        return;
      }
      textReply(response, "NO_REPLY", `extra_${id}`);
    } catch (error) {
      failures.push(error);
      response.destroy();
    }
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

// ----------------------------------------------------------------- process ---

const children = new Set();
function spawnChild(argv, options) {
  const child = spawn(argv[0], argv.slice(1), { ...options, stdio: ["ignore", "pipe", "pipe"] });
  children.add(child);
  child.once("exit", () => children.delete(child));
  return child;
}

function collect(child) {
  let out = "";
  child.stdout?.on("data", (chunk) => (out += chunk));
  child.stderr?.on("data", (chunk) => (out += chunk));
  return () => out;
}

function probePort(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    const done = (ok) => {
      socket.destroy();
      resolve(ok);
    };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.setTimeout(1000, () => done(false));
  });
}

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitFor(read, predicate, label, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate(read())) {
      return;
    }
    if (Date.now() > deadline) {
      fail(`timed out waiting for ${label}\n--- captured output ---\n${redact(read())}`);
    }
    if (failures.length > 0) {
      fail(`provider error: ${failures[0]?.stack ?? failures[0]}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

// -------------------------------------------------------------------- main ---

let gatewayChild;
let gatewayLog = "";
let gatewayToken;
let stateRoot;
let browser;
let providerServer;

async function main() {
  await fs.mkdir(outDir, { recursive: true });
  await fs.access(path.join(repo, "dist", "index.js"));
  await fs.access(path.join(repo, "dist", "control-ui", "index.html"));

  // Resolve Playwright from the repo's own install; this script lives outside it.
  // The package is CommonJS, so the named exports live under `default`.
  const playwrightEntry = path.join(repo, "node_modules", "playwright", "index.js");
  const playwrightModule = await import(`file://${playwrightEntry}`);
  const { chromium } = playwrightModule.default ?? playwrightModule;

  // The Gateway refuses a group/world-writable ancestor anywhere above its state
  // root. $HOME is 0700 here while the repo mount is 0777, so the run lives there
  // and only the captured artifacts go to --out.
  stateRoot = await fs.mkdtemp(path.join(os.homedir(), "openclaw-completion-proof-"));
  const homeDir = path.join(stateRoot, "home");
  const stateDir = path.join(stateRoot, "state");
  const workspaceDir = path.join(stateRoot, "workspace");
  await fs.mkdir(homeDir, { recursive: true, mode: 0o700 });
  await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });
  await fs.mkdir(workspaceDir, { recursive: true, mode: 0o700 });
  await fs.chmod(stateRoot, 0o700);
  await fs.chmod(homeDir, 0o700);
  await fs.chmod(stateDir, 0o700);
  await fs.chmod(workspaceDir, 0o700);

  const provider = await startProvider();
  providerServer = provider.server;

  const port = await reservePort();
  gatewayToken = `proof-token-${randomUUID()}`;
  redactions.push([gatewayToken, "[gateway-token]"]);
  redactions.push([stateRoot, "[state-root]"]);

  const config = {
    update: { checkOnStart: false },
    gateway: {
      // Pin the port so `dashboard` resolves THIS instance instead of a default
      // port that may host someone else's live Gateway.
      port,
      bind: "loopback",
      controlUi: { enabled: true, root: path.join(repo, "dist", "control-ui") },
      auth: { mode: "token", token: gatewayToken },
    },
    cron: { enabled: false },
    messages: { visibleReplies: "message_tool" },
    tools: { profile: "full", codeMode: false, toolSearch: false },
    agents: {
      ownership: "explicit",
      defaults: {
        model: "wait-fixture/parent",
        modelPolicy: { allow: ["wait-fixture/*"] },
        workspace: workspaceDir,
      },
      entries: { main: { identity: { name: "Review assistant" } } },
    },
    models: {
      catalogRefresh: { enabled: false },
      providers: {
        "wait-fixture": {
          api: "openai-responses",
          apiKey: `proof-key-${randomUUID()}`,
          baseUrl: `http://127.0.0.1:${provider.port}/v1`,
          models: [
            { id: "parent", name: "parent" },
            { id: "child", name: "child" },
          ],
        },
      },
    },
    plugins: { allow: [] },
  };
  const configPath = path.join(stateDir, "openclaw.json");
  await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);

  const env = {
    ...process.env,
    HOME: homeDir,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_WORKSPACE_DIR: workspaceDir,
    PROC_SAFE_NATIVE: "off",
    OPENCLAW_DISABLE_UPDATE_CHECK: "1",
    NO_COLOR: "1",
  };
  delete env.VITEST;

  log("starting real Gateway from dist build");
  gatewayChild = spawnChild(
    [
      NODE_BIN,
      path.join(repo, "dist", "index.js"),
      "gateway",
      "--port",
      String(port),
      "--bind",
      "loopback",
      "--allow-unconfigured",
    ],
    { cwd: repo, env },
  );
  const readGateway = collect(gatewayChild);
  const baseUrl = `http://127.0.0.1:${port}`;
  // Wait for the port to actually accept connections, not just a log line.
  const deadline = Date.now() + 120_000;
  let listening = false;
  while (Date.now() < deadline) {
    if (await probePort(port)) {
      listening = true;
      break;
    }
    if (gatewayChild.exitCode !== null) {
      fail(`gateway exited ${gatewayChild.exitCode}\n${redact(readGateway())}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  if (!listening) {
    fail(`gateway never listened on ${port}\n${redact(readGateway())}`);
  }
  proof.gatewayPort = port;
  console.log("[proof] gateway output:\n" + redact(readGateway()));

  const cli = async (cliArgs, { withPort = true, timeoutMs } = {}) => {
    const argv = [
      NODE_BIN,
      path.join(repo, "dist", "index.js"),
      ...cliArgs,
      ...(withPort ? ["--port", String(port)] : []),
      ...(timeoutMs ? ["--timeout", String(timeoutMs)] : []),
      "--json",
    ];
    const child = spawnChild(argv, { cwd: repo, env });
    const read = collect(child);
    const code = await new Promise((resolve) => child.once("exit", resolve));
    const output = read();
    if (code !== 0) {
      fail(`cli ${cliArgs.join(" ")} exited ${code}\n${redact(output)}`);
    }
    const start = output.indexOf("{");
    const end = output.lastIndexOf("}");
    return start >= 0 && end > start ? JSON.parse(output.slice(start, end + 1)) : output;
  };

  log("waiting for Gateway RPC readiness");
  const rpcDeadline = Date.now() + 120_000;
  for (;;) {
    try {
      await cli(["gateway", "call", "health"], { timeoutMs: 5_000 });
      break;
    } catch (error) {
      if (Date.now() > rpcDeadline) {
        fail(`Gateway RPC never became ready: ${error?.message ?? error}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
  proof.gatewayRpcReady = true;

  log("creating the dashboard session");
  await cli(
    [
      "gateway",
      "call",
      "sessions.create",
      "--params",
      JSON.stringify({ key: fixture.key, agentId: "main", label: fixture.label }),
    ],
    { timeoutMs: 60_000 },
  );

  log("launching Chromium and pairing the Control UI");
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    locale: "en-US",
    viewport: { width: 1280, height: 900 },
  });
  const page = await context.newPage();
  const handoff = await cli(["dashboard"], { withPort: false });
  if (!handoff.ok || !handoff.browserUrl) {
    fail(`dashboard pairing failed: ${JSON.stringify(handoff)}`);
  }
  await page.goto(handoff.browserUrl);
  // The handoff URL is single-use: let the app consume it and finish its Gateway
  // handshake before navigating, or the page falls back to "Connect to gateway".
  try {
    await page.waitForFunction(
      () => window.openclawControlUi?.snapshot()?.ready === true,
      undefined,
      { timeout: 90_000 },
    );
    proof.controlUiReady = true;
  } catch (error) {
    const snap = await page.evaluate(() => {
      const app = window.openclawControlUi;
      return {
        hasHook: Boolean(app),
        snapshot: app ? app.snapshot() : null,
        url: window.location.href,
        title: document.title,
        bodyText: document.body?.innerText?.slice(0, 600) ?? "",
      };
    });
    fail(`Control UI never became ready: ${JSON.stringify(snap, null, 2)}`);
  }

  // The handoff is consumed and the Gateway client is authenticated, so a plain
  // route change is enough; the app resolves the exact session key itself.
  // Use the product's own path builder so the route matches what the app expects
  // for an exact session key.
  const { buildControlUiSessionPath } = await import(
    `file://${path.join(repo, "packages", "session-url-contract", "src", "index.ts")}`
  ).catch(() => ({ buildControlUiSessionPath: null }));
  const sessionPath =
    buildControlUiSessionPath?.({
      namespace: "chat",
      sessionKey: fixture.key,
      fallbackAgentId: "main",
      exactKey: true,
    }) ?? `/chat/${fixture.key.split(":").slice(1).join("/")}`;
  proof.sessionPath = sessionPath;
  // Pairing already stored the Gateway credential, so a normal navigation to the
  // exact session route keeps the authenticated client and mounts that pane.
  await page.goto(new URL(`${sessionPath}?lang=en`, baseUrl).toString());
  await page.waitForFunction(
    () => window.openclawControlUi?.snapshot()?.ready === true,
    undefined,
    { timeout: 90_000 },
  );
  await page
    .waitForFunction(
      (sessionKey) => window.openclawControlUi?.snapshot()?.sessionKey === sessionKey,
      fixture.key,
      { timeout: 60_000 },
    )
    .catch(async (error) => {
      const snap = await page.evaluate(() => ({
        url: window.location.href,
        snapshot: window.openclawControlUi?.snapshot() ?? null,
      }));
      fail(`session route did not settle: ${JSON.stringify(snap, null, 2)}`);
    });

  proof.stage = "spawn child and yield";
  const pane = page.locator("openclaw-chat-pane.chat-pane-cache__pane--active").first();
  const composer = pane.getByRole("textbox", { name: "Chat composer", exact: true });
  await composer.waitFor({ timeout: 60_000 });
  await composer.fill(fixture.initialPrompt);
  await pane.locator(".chat-send-btn--send").click();
  await Promise.race([
    childStarted,
    new Promise((_, reject) => setTimeout(() => reject(new Error("child never started")), 120_000)),
  ]);
  proof.childStarted = true;

  proof.stage = "release child completion; parent resumes and must deliver with the message tool";
  childReleased = true;
  textReply(childResponse, fixture.childReply, "child");

  // The settle wake ends at the tool call (stopReason=toolUse), so there is no
  // second model turn to hand back the tool's return string. The real proof is
  // the delivered reply in the session transcript plus the recorded tool call.
  proof.stage = "wait for the delivered reply in the real transcript";
  const historyDeadline = Date.now() + 180_000;
  let history;
  for (;;) {
    history = await cli([
      "gateway",
      "call",
      "chat.history",
      "--params",
      JSON.stringify({ sessionKey: fixture.key, limit: 50 }),
    ]);
    const delivered = (history.messages ?? []).some(
      (message) =>
        message.role === "assistant" &&
        Array.isArray(message.content) &&
        message.content.some(
          (part) =>
            part?.type === "text" &&
            typeof part.text === "string" &&
            part.text.includes(fixture.resumedReply),
        ),
    );
    if (delivered) {
      break;
    }
    if (Date.now() > historyDeadline) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  const serialized = JSON.stringify(history);
  // Keep the raw transcript for review: it distinguishes a delivered assistant
  // message from the model's own tool-call arguments echoing the same text.
  await fs.writeFile(
    path.join(outDir, "chat-history.private.json"),
    `${JSON.stringify(history, null, 2)}\n`,
  );

  // The model's tool-call arguments contain the same text, so a substring match on
  // the whole transcript proves nothing. Require a non-tool assistant message that
  // actually carries the reply text.
  const visibleReplyMessages = (history.messages ?? []).filter((message) => {
    if (message.role !== "assistant" || !Array.isArray(message.content)) {
      return false;
    }
    return message.content.some(
      (part) =>
        part?.type === "text" &&
        typeof part.text === "string" &&
        part.text.includes(fixture.resumedReply),
    );
  });
  proof.visibleReplyMessages = visibleReplyMessages.length;
  // This is the only transcript signal that counts: the model's tool-call
  // arguments echo the same text, so a whole-document substring match is useless.
  proof.replyInTranscript = visibleReplyMessages.length > 0;
  proof.transcriptReplyDelivered = visibleReplyMessages.length > 0;
  proof.messageToolCalls = receipts
    .filter((entry) => entry.tool === "message")
    .map((entry) => redact(String(entry.output ?? "")));

  const denied = /authoritative current conversation|message_source_reply_policy_denied/.test(
    serialized + JSON.stringify(receipts) + readGateway(),
  );
  proof.refused = denied;
  // The model's own tool call is the invocation proof: the wake ends at the call,
  // so no second model turn returns the tool's string.
  proof.messageToolInvoked = recordedMessageArgs.length > 0;
  proof.messageToolArgs = recordedMessageArgs;

  await page.screenshot({ path: path.join(outDir, "control-ui.png"), fullPage: false });
  await fs.writeFile(path.join(outDir, "gateway.private.log"), redact(readGateway()));

  if (denied) {
    fail(`the completion reply was refused: ${proof.messageReceipt ?? "(no receipt)"}`);
  }
  if (!proof.messageToolInvoked) {
    fail("the completion wake never called the message tool");
  }
  if (!proof.replyInTranscript) {
    fail("the completion reply is missing from the real session transcript");
  }

  proof.complete = true;
  proof.stage = "complete";
  await saveProof();
  log("PASS");
  log(JSON.stringify(proof, null, 2));
}

async function cleanup() {
  try {
    await saveProof();
  } catch {}
  for (const child of [...children]) {
    child.kill("SIGTERM");
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
  for (const child of [...children]) {
    child.kill("SIGKILL");
  }
  try {
    await browser?.close();
  } catch {}
  try {
    providerServer?.closeAllConnections();
    providerServer?.close();
  } catch {}
  if (stateRoot) {
    try {
      await fs.rm(stateRoot, { recursive: true, force: true });
    } catch {}
  }
}

try {
  await main();
} catch (error) {
  console.error("[proof] error:", error?.stack ?? error);
  process.exitCode = 1;
} finally {
  await cleanup();
}
process.exit(process.exitCode ?? 0);
