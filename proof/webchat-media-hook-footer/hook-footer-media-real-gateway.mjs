#!/usr/bin/env node
/**
 * Real-Gateway proof for PR #206651 (fixes #206571): a `before_message_write`
 * plugin hook that appends a footer to a final reply must keep that footer in
 * `openclawDisplayContent` for media replies, exactly once, in `chat.history`
 * and after a Control UI reload. A text-only reply gets no footer.
 *
 * Runs the actual dist build (Gateway + Control UI + scripted OpenAI Responses
 * transport + a real on-disk plugin registering a real `before_message_write`
 * handler). No product code is imported: only Playwright and node builtins.
 *
 * Usage:
 *   node hook-footer-media-real-gateway.mjs [--repo <path>] [--out <dir>] [--expect base|head]
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
const expectMode = args.get("expect") ?? "head"; // "head" = fix present, "base" = fix absent
const outDir =
  args.get("out") ?? path.join(repo, ".artifacts", "proof", `hook-footer-media-${expectMode}`);
const NODE_BIN = process.execPath;
const log = (...parts) => console.log("[proof]", ...parts);
const fail = (message) => {
  console.error("[proof] FAIL:", message);
  process.exitCode = 1;
  throw new Error(message);
};

const FOOTER = "FOOTER_FROM_HOOK";
const CAPTION = "Caption text.";
// A 1x1 PNG written into the agent workspace and referenced as MEDIA:./reply.png.
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=";

const proof = {
  what: "before_message_write footer survives the media display rewrite in chat.history",
  expectMode,
  gateway: "real isolated Gateway from dist build",
  provider: "scripted loopback OpenAI Responses transport (not external-provider live proof)",
  hook: "real on-disk plugin registering a real before_message_write handler",
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

// The fixture drives two turns on the same parent session:
//   turn A (media):  tool call `read`, then a final reply "Caption text.\n\nMEDIA:./reply.png"
//   turn B (text):   a plain text reply with no MEDIA directive (control)
// The provider counts requests per session by inspecting the last user message.
const state = {
  mediaTurnRequests: 0,
  textTurnRequests: 0,
};
const failures = [];

function contentToText(content) {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content.map((part) => (typeof part === "string" ? part : (part?.text ?? ""))).join(" ");
  }
  return "";
}

function lastUserText(input) {
  const items = Array.isArray(input) ? input : [];
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i];
    if (item?.role === "user" || (item?.type === "message" && item?.role === "user")) {
      const text = contentToText(item.content);
      if (text) {
        return text;
      }
    }
  }
  return "";
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
      const hasToolOutput = (body.input ?? []).some(
        (item) => item?.type === "function_call_output",
      );

      // Route by turn, not by user text (OpenClaw wraps user input in a runtime
      // context envelope, so the raw text is not directly matchable). The media
      // turn is: one tool call, then a media-bearing final. Once that final is
      // sent, the next request belongs to the text-only control turn.
      if (state.mediaFinalSent) {
        state.textTurnRequests += 1;
        textReply(response, "Plain text answer with no media.", `text_${id}`);
        return;
      }
      state.mediaTurnRequests += 1;
      if (!hasToolOutput) {
        // First media request: make a tool call so the turn settles through the
        // embedded runner's tool-turn finalization (which stamps transcript ownership).
        toolCall(response, "read", { path: "notes.txt" }, `media_tool_${id}`);
        return;
      }
      // After the tool result: the final media-bearing reply.
      state.mediaFinalSent = true;
      textReply(response, `${CAPTION}\n\nMEDIA:./reply.png`, `media_final_${id}`);
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

// -------------------------------------------------------------------- main ---

let gatewayChild;
let gatewayToken;
let stateRoot;
let browser;
let providerServer;

const HOOK_PLUGIN_SOURCE = `module.exports = { id: "footer-hook", register(api) {
  // A real before_message_write handler: append a footer to the text block that
  // carries a MEDIA directive, matching the reported shape "Caption.\\n\\nMEDIA:...".
  api.on("before_message_write", (event) => {
    const message = event?.message;
    if (!message || message.role !== "assistant" || !Array.isArray(message.content)) {
      return;
    }
    const hasMedia = message.content.some(
      (block) => block?.type === "text" && typeof block.text === "string" && /MEDIA:/u.test(block.text),
    );
    if (!hasMedia) {
      return;
    }
    return {
      message: {
        ...message,
        content: message.content.map((block) =>
          block?.type === "text" && typeof block.text === "string" && /MEDIA:/u.test(block.text)
            ? { ...block, text: block.text + "\\n\\n${FOOTER}" }
            : block,
        ),
      },
    };
  });
} };`;

async function writeHookPlugin(root) {
  const dir = path.join(root, "footer-hook");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "package.json"),
    JSON.stringify({
      name: "footer-hook",
      version: "1.0.0",
      openclaw: { extensions: ["./index.cjs"] },
    }),
  );
  await fs.writeFile(
    path.join(dir, "openclaw.plugin.json"),
    JSON.stringify({
      id: "footer-hook",
      activation: { onStartup: true },
      configSchema: { type: "object" },
    }),
  );
  await fs.writeFile(path.join(dir, "index.cjs"), HOOK_PLUGIN_SOURCE);
  return dir;
}

async function main() {
  await fs.mkdir(outDir, { recursive: true });
  await fs.access(path.join(repo, "dist", "index.js"));
  await fs.access(path.join(repo, "dist", "control-ui", "index.html"));

  const playwrightEntry = path.join(repo, "node_modules", "playwright", "index.js");
  const playwrightModule = await import(`file://${playwrightEntry}`);
  const { chromium } = playwrightModule.default ?? playwrightModule;

  stateRoot = await fs.mkdtemp(path.join(os.homedir(), "openclaw-hook-footer-proof-"));
  const homeDir = path.join(stateRoot, "home");
  const stateDir = path.join(stateRoot, "state");
  const workspaceDir = path.join(stateRoot, "workspace");
  const pluginRoot = path.join(stateRoot, "plugins");
  await fs.mkdir(homeDir, { recursive: true, mode: 0o700 });
  await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });
  await fs.mkdir(workspaceDir, { recursive: true, mode: 0o700 });
  await fs.mkdir(pluginRoot, { recursive: true, mode: 0o700 });
  await fs.chmod(stateRoot, 0o700);

  // Seed the workspace with the media file the reply references, plus a notes file
  // for the read tool call.
  await fs.writeFile(path.join(workspaceDir, "reply.png"), Buffer.from(TINY_PNG_BASE64, "base64"));
  await fs.writeFile(path.join(workspaceDir, "notes.txt"), "Release notes.\n");

  const hookPluginDir = await writeHookPlugin(pluginRoot);

  const provider = await startProvider();
  providerServer = provider.server;

  const port = await reservePort();
  gatewayToken = `proof-token-${randomUUID()}`;
  redactions.push([gatewayToken, "[gateway-token]"]);
  redactions.push([stateRoot, "[state-root]"]);

  const config = {
    update: { checkOnStart: false },
    gateway: {
      port,
      bind: "loopback",
      controlUi: { enabled: true, root: path.join(repo, "dist", "control-ui") },
      auth: { mode: "token", token: gatewayToken },
    },
    cron: { enabled: false },
    agents: {
      ownership: "explicit",
      defaults: {
        model: "hook-fixture/main",
        modelPolicy: { allow: ["hook-fixture/*"] },
        workspace: workspaceDir,
        skipBootstrap: true,
      },
      entries: { main: { identity: { name: "Hook proof assistant" } } },
    },
    models: {
      catalogRefresh: { enabled: false },
      providers: {
        "hook-fixture": {
          api: "openai-responses",
          apiKey: `proof-key-${randomUUID()}`,
          baseUrl: `http://127.0.0.1:${provider.port}/v1`,
          models: [{ id: "main", name: "main" }],
        },
      },
    },
    plugins: {
      allow: ["footer-hook"],
      load: { paths: [hookPluginDir] },
      slots: { memory: "none" },
      entries: { "footer-hook": { hooks: { allowConversationAccess: true } } },
    },
    tools: { profile: "full", codeMode: false, toolSearch: false },
    skills: { load: { watch: false } },
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
    OPENCLAW_SKIP_CHANNELS: "1",
    OPENCLAW_SKIP_GMAIL_WATCHER: "1",
    OPENCLAW_SKIP_CRON: "1",
    OPENCLAW_SKIP_CANVAS_HOST: "1",
    OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
    NO_COLOR: "1",
  };
  delete env.VITEST;

  log(`starting real Gateway from dist build (expect=${expectMode})`);
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

  const sessionKey = "agent:main:dashboard:hook-footer-proof";
  log("creating the dashboard session");
  await cli(
    [
      "gateway",
      "call",
      "sessions.create",
      "--params",
      JSON.stringify({ key: sessionKey, agentId: "main", label: "Hook footer proof" }),
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
  try {
    await page.waitForFunction(
      () => window.openclawControlUi?.snapshot()?.ready === true,
      undefined,
      { timeout: 90_000 },
    );
    proof.controlUiReady = true;
  } catch (error) {
    const snap = await page.evaluate(() => ({
      hasHook: Boolean(window.openclawControlUi),
      snapshot: window.openclawControlUi ? window.openclawControlUi.snapshot() : null,
      url: window.location.href,
      bodyText: document.body?.innerText?.slice(0, 600) ?? "",
    }));
    fail(`Control UI never became ready: ${JSON.stringify(snap, null, 2)}`);
  }

  const sessionPath = `/chat/${sessionKey.split(":").slice(1).join("/")}`;
  await page.goto(new URL(`${sessionPath}?lang=en`, baseUrl).toString());
  await page.waitForFunction(
    () => window.openclawControlUi?.snapshot()?.ready === true,
    undefined,
    { timeout: 90_000 },
  );
  await page.waitForFunction(
    (key) => window.openclawControlUi?.snapshot()?.sessionKey === key,
    sessionKey,
    { timeout: 60_000 },
  );

  // --- helper: read chat.history and summarize the media assistant row ---
  const readHistory = async () =>
    await cli([
      "gateway",
      "call",
      "chat.history",
      "--params",
      JSON.stringify({ sessionKey, limit: 50 }),
    ]);

  // The Control UI renders `openclawDisplayContent` when present, else the raw
  // `content`. The bug (#206571) drops/duplicates the hook footer in
  // `openclawDisplayContent` specifically. We assert on the field the UI renders,
  // falling back to `content` only when no display rewrite was applied.
  const summarize = (history) => {
    const messages = history.messages ?? [];
    const assistantRows = messages.filter((m) => m.role === "assistant");
    // The media assistant row is the one whose rendered blocks carry an image.
    const perRow = [];
    for (const m of assistantRows) {
      const rendered = Array.isArray(m.openclawDisplayContent)
        ? m.openclawDisplayContent
        : Array.isArray(m.content)
          ? m.content
          : [];
      const texts = [];
      let images = 0;
      for (const block of rendered) {
        if (block?.type === "image") {
          images += 1;
        }
        if (block?.type === "text" && typeof block.text === "string") {
          texts.push(block.text.trim());
        }
      }
      perRow.push({
        images,
        texts,
        usedDisplayContent: Array.isArray(m.openclawDisplayContent),
        footer: texts.filter((t) => t === FOOTER).length,
        caption: texts.filter((t) => t === CAPTION).length,
      });
    }
    const mediaRow = perRow.find((row) => row.images > 0) ?? {
      images: 0,
      texts: [],
      usedDisplayContent: false,
      footer: 0,
      caption: 0,
    };
    return {
      footerCount: mediaRow.footer,
      captionCount: mediaRow.caption,
      imageBlocks: mediaRow.images,
      usedDisplayContent: mediaRow.usedDisplayContent,
      displayTexts: mediaRow.texts,
      rawRowCount: assistantRows.length,
      perRow,
    };
  };

  // --- turn A: media reply through the Control UI composer (webchat deliver path) ---
  proof.stage = "send media turn";
  const pane = page.locator("openclaw-chat-pane.chat-pane-cache__pane--active").first();
  const composer = pane.getByRole("textbox", { name: "Chat composer", exact: true });
  await composer.waitFor({ timeout: 60_000 });
  await composer.fill("Show me the chart");
  await pane.locator(".chat-send-btn--send").click();

  // Wait until the media assistant row is projected with an image block.
  const mediaDeadline = Date.now() + 180_000;
  let mediaSummary;
  for (;;) {
    const history = await readHistory();
    mediaSummary = summarize(history);
    if (mediaSummary.imageBlocks >= 1 || Date.now() > mediaDeadline) {
      if (mediaSummary.imageBlocks >= 1) {
        await fs.writeFile(
          path.join(outDir, "chat-history.media.private.json"),
          `${JSON.stringify(history, null, 2)}\n`,
        );
        break;
      }
    }
    if (Date.now() > mediaDeadline) {
      await fs.writeFile(
        path.join(outDir, "chat-history.media.private.json"),
        `${JSON.stringify(history, null, 2)}\n`,
      );
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  proof.media = mediaSummary;

  // --- reload: navigate away and back, re-read chat.history (fresh projection) ---
  proof.stage = "reload and re-read";
  await page.goto(new URL(`${sessionPath}?lang=en&reload=1`, baseUrl).toString());
  await page.waitForFunction(
    () => window.openclawControlUi?.snapshot()?.ready === true,
    undefined,
    { timeout: 90_000 },
  );
  await page.waitForFunction(
    (key) => window.openclawControlUi?.snapshot()?.sessionKey === key,
    sessionKey,
    { timeout: 60_000 },
  );
  const reloadedHistory = await readHistory();
  const reloadedSummary = summarize(reloadedHistory);
  proof.mediaAfterReload = reloadedSummary;

  // --- turn B: text-only control ---
  proof.stage = "send text-only control";
  const composer2 = pane.getByRole("textbox", { name: "Chat composer", exact: true });
  await composer2.waitFor({ timeout: 60_000 });
  await composer2.fill("TEXT_CONTROL please answer in plain text");
  await pane.locator(".chat-send-btn--send").click();

  const PLAIN_TEXT = "Plain text answer with no media.";
  // Summarize only the assistant row that carries the text-control reply, not the
  // earlier media row from the same session.
  const summarizeTextControl = (history) => {
    const row = (history.messages ?? []).find(
      (m) =>
        m.role === "assistant" &&
        Array.isArray(m.content) &&
        m.content.some(
          (b) => b?.type === "text" && typeof b.text === "string" && b.text.includes(PLAIN_TEXT),
        ),
    );
    if (!row) {
      return { found: false, footerCount: 0, texts: [] };
    }
    const rendered = Array.isArray(row.openclawDisplayContent)
      ? row.openclawDisplayContent
      : row.content;
    const texts = rendered
      .filter((b) => b?.type === "text" && typeof b.text === "string")
      .map((b) => b.text.trim());
    return { found: true, footerCount: texts.filter((t) => t === FOOTER).length, texts };
  };
  const textDeadline = Date.now() + 120_000;
  let textSummary;
  let lastTextHistory;
  for (;;) {
    lastTextHistory = await readHistory();
    textSummary = summarizeTextControl(lastTextHistory);
    if (textSummary.found || Date.now() > textDeadline) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  proof.textControl = textSummary;
  proof.providerCounts = { ...state };
  await fs.writeFile(
    path.join(outDir, "chat-history.text.private.json"),
    `${JSON.stringify(lastTextHistory, null, 2)}\n`,
  );

  await page.screenshot({ path: path.join(outDir, "control-ui.png"), fullPage: false });
  await fs.writeFile(path.join(outDir, "gateway.private.log"), redact(readGateway()));

  // --- assertions ---
  const problems = [];
  // Media turn: footer exactly once, caption exactly once, image exactly once.
  if (mediaSummary.footerCount !== 1) {
    problems.push(`media footer count = ${mediaSummary.footerCount} (want 1)`);
  }
  if (mediaSummary.captionCount !== 1) {
    problems.push(`media caption count = ${mediaSummary.captionCount} (want 1)`);
  }
  if (mediaSummary.imageBlocks !== 1) {
    problems.push(`media image blocks = ${mediaSummary.imageBlocks} (want 1)`);
  }
  // After reload: same.
  if (reloadedSummary.footerCount !== 1) {
    problems.push(`reloaded footer count = ${reloadedSummary.footerCount} (want 1)`);
  }
  if (reloadedSummary.imageBlocks !== 1) {
    problems.push(`reloaded image blocks = ${reloadedSummary.imageBlocks} (want 1)`);
  }
  // Text control: no footer.
  if (textSummary.footerCount !== 0) {
    problems.push(`text-control footer count = ${textSummary.footerCount} (want 0)`);
  }

  proof.problems = problems;

  if (expectMode === "base") {
    // On the base (no fix), the footer is dropped or duplicated on the keyed/retained path.
    if (problems.length === 0) {
      fail(
        `BASE expected the bug to reproduce, but all assertions passed: ${JSON.stringify(mediaSummary)}`,
      );
    }
    proof.reproduced = true;
    proof.complete = true;
    await saveProof();
    log("BASE reproduced the bug (red), as expected:");
    log(JSON.stringify({ media: mediaSummary, reloaded: reloadedSummary, problems }, null, 2));
    return;
  }

  if (problems.length > 0) {
    fail(`HEAD assertions failed: ${problems.join("; ")}`);
  }
  proof.complete = true;
  proof.stage = "complete";
  await saveProof();
  log("PASS");
  log(
    JSON.stringify({ media: mediaSummary, reloaded: reloadedSummary, text: textSummary }, null, 2),
  );
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
