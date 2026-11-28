#!/usr/bin/env node
/**
 * Real-behavior proof for PR #207250 / issue #206800.
 *
 * Bug: opening a local Claude catalog entry in the Control UI forwards the
 * catalog route key (agent:<agent>:catalog:<catalog>:<host>:<thread>) into
 * talk.catalog. A catalog entry is an external identity the Talk resolver can
 * never resolve, so the Gateway logs INVALID_REQUEST / "No session found".
 *
 * This script runs the actual dist build end to end:
 *   - a real isolated Gateway process (dist/index.js gateway),
 *   - the real bundled Anthropic plugin, which registers the native Claude
 *     session catalog and discovers a synthetic local Claude Code transcript
 *     under $HOME/.claude/projects (exactly the issue's scenario),
 *   - the real built Control UI in real Chromium (Playwright).
 *
 * It records every talk.catalog / talk.config RPC the composer issues across
 * catalog open, reopen, and a focus refresh, then drives a real adoption
 * (sessions.catalog.continue) and confirms discovery resumes with the adopted
 * chat key. No product source is imported: only Playwright and node builtins.
 *
 * Usage:
 *   node catalog-talk-discovery-real-gateway.mjs [--repo <path>] [--out <dir>]
 */

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

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
  args.get("out") ?? path.join(repo, ".artifacts", "proof", "catalog-talk-discovery");
const NODE_BIN = process.execPath;
const log = (...parts) => console.log("[proof]", ...parts);
const fail = (message) => {
  console.error("[proof] FAIL:", message);
  process.exitCode = 1;
  throw new Error(message);
};

const proof = {
  what: "Catalog route key must not reach Talk discovery; adoption resumes it with the real chat key",
  issue: "openclaw/openclaw#206800",
  gateway: "real isolated Gateway from dist build",
  catalog: "real bundled Anthropic plugin discovering a synthetic local Claude Code transcript",
  browser: "real Chromium via Playwright, built Control UI (dist/control-ui)",
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
let browser;
let stateRoot;
let gatewayToken;

// A single synthetic local Claude Code transcript. The discovery scanner reads
// $HOME/.claude/projects/<project>/<sessionId>.jsonl and accepts a row whose
// sessionId matches the filename, entrypoint is a CLI entrypoint, and the first
// user message supplies the display name.
const CLAUDE_SESSION_ID = "11111111-2222-3333-4444-555555555555";
const AGENT_ID = "main";

async function seedClaudeTranscript(configDir, workspaceDir) {
  const projectDir = path.join(configDir, "projects", "proof-project");
  await fs.mkdir(projectDir, { recursive: true, mode: 0o700 });
  const transcript = path.join(projectDir, `${CLAUDE_SESSION_ID}.jsonl`);
  const rows = [
    {
      sessionId: CLAUDE_SESSION_ID,
      entrypoint: "cli",
      type: "user",
      isSidechain: false,
      cwd: workspaceDir,
      version: "1.0.0",
      gitBranch: "main",
      timestamp: "2026-11-28T00:00:00.000Z",
      message: { role: "user", content: "Synthetic catalog talk-discovery proof session" },
    },
    {
      sessionId: CLAUDE_SESSION_ID,
      entrypoint: "cli",
      type: "assistant",
      isSidechain: false,
      timestamp: "2026-11-28T00:00:05.000Z",
      message: { role: "assistant", content: [{ type: "text", text: "Acknowledged." }] },
    },
  ];
  await fs.writeFile(transcript, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
  return transcript;
}

async function main() {
  await fs.mkdir(outDir, { recursive: true });
  await fs.access(path.join(repo, "dist", "index.js"));
  await fs.access(path.join(repo, "dist", "control-ui", "index.html"));
  await fs.access(path.join(repo, "dist", "extensions", "anthropic"));

  const playwrightEntry = path.join(repo, "node_modules", "playwright", "index.js");
  const playwrightModule = await import(`file://${playwrightEntry}`);
  const { chromium } = playwrightModule.default ?? playwrightModule;

  // The Gateway refuses a group/world-writable ancestor above its state root, so
  // the run lives under $HOME (0700); only captured artifacts go to --out.
  stateRoot = await fs.mkdtemp(path.join(os.homedir(), "openclaw-catalog-proof-"));
  const homeDir = path.join(stateRoot, "home");
  const stateDir = path.join(stateRoot, "state");
  const workspaceDir = path.join(stateRoot, "workspace");
  for (const dir of [homeDir, stateDir, workspaceDir]) {
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    await fs.chmod(dir, 0o700);
  }
  await fs.chmod(stateRoot, 0o700);

  // Point the bundled Anthropic plugin at an explicit Claude config dir. The
  // Gateway isolates process-HOME scans by default (allowProcessHomeFallback is
  // false for a non-loopback caller), and an explicit CLAUDE_CONFIG_DIR is the
  // documented way to keep the local catalog available under that isolation.
  const claudeConfigDir = path.join(stateRoot, "claude-config");
  await fs.mkdir(claudeConfigDir, { recursive: true, mode: 0o700 });
  await fs.chmod(claudeConfigDir, 0o700);
  const transcriptPath = await seedClaudeTranscript(claudeConfigDir, workspaceDir);
  redactions.push([claudeConfigDir, "[claude-config]"]);
  log("seeded synthetic Claude transcript:", redact(transcriptPath));

  const port = await reservePort();
  gatewayToken = `proof-token-${randomUUID()}`;
  redactions.push([gatewayToken, "[gateway-token]"]);
  redactions.push([stateRoot, "[state-root]"]);
  redactions.push([os.homedir(), "[home]"]);

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
      defaults: { workspace: workspaceDir },
      entries: { [AGENT_ID]: { identity: { name: "Catalog proof assistant" }, workspace: workspaceDir } },
    },
    // Enable the bundled Anthropic plugin so its native Claude session catalog
    // registers and discovers the synthetic transcript. No model provider is
    // configured: this proof never runs an inference turn.
    plugins: { allow: ["anthropic"], slots: { memory: "none" } },
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
    CLAUDE_CONFIG_DIR: claudeConfigDir,
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

  log("confirming the Anthropic catalog lists the synthetic Claude session");
  const catalogList = await cli([
    "gateway",
    "call",
    "sessions.catalog.list",
    "--params",
    JSON.stringify({ agentId: AGENT_ID }),
  ]);
  await fs.writeFile(
    path.join(outDir, "catalog-list.json"),
    `${redact(JSON.stringify(catalogList, null, 2))}\n`,
  );
  const flat = JSON.stringify(catalogList);
  proof.catalogListed = flat.includes(CLAUDE_SESSION_ID);
  if (!proof.catalogListed) {
    fail(`Anthropic catalog did not list the synthetic session: ${redact(flat.slice(0, 800))}`);
  }

  log("launching Chromium and pairing the Control UI");
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ locale: "en-US", viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  // Capture every RPC request frame the built Control UI sends over its real
  // Gateway WebSocket. This is the runtime RPC capture the review asked for: it
  // observes the actual wire, not an in-page test hook. Frames are
  // { type: "req", id, method, params }.
  const talkFrames = [];
  await page.routeWebSocket(/.*/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((message) => {
      try {
        const frame = JSON.parse(typeof message === "string" ? message : message.toString("utf8"));
        if (
          frame?.type === "req" &&
          (frame.method === "talk.catalog" || frame.method === "talk.config")
        ) {
          talkFrames.push({
            method: frame.method,
            sessionKey:
              frame.params && typeof frame.params === "object" ? frame.params.sessionKey : undefined,
          });
        }
      } catch {
        // Non-JSON or non-request frame; ignore.
      }
      server.send(message);
    });
    server.onMessage((message) => ws.send(message));
  });

  const handoff = await cli(["dashboard"], { withPort: false });
  if (!handoff.ok || !handoff.browserUrl) {
    fail(`dashboard pairing failed: ${JSON.stringify(handoff)}`);
  }
  await page.goto(handoff.browserUrl);
  try {
    await page.waitForFunction(() => window.openclawControlUi?.snapshot()?.ready === true, undefined, {
      timeout: 90_000,
    });
    proof.controlUiReady = true;
  } catch (error) {
    const snap = await page.evaluate(() => ({
      url: window.location.href,
      snapshot: window.openclawControlUi?.snapshot() ?? null,
      bodyText: document.body?.innerText?.slice(0, 600) ?? "",
    }));
    fail(`Control UI never became ready: ${JSON.stringify(snap, null, 2)}`);
  }

  const catalogKey = `agent:${AGENT_ID}:catalog:claude:gateway%3Alocal:${CLAUDE_SESSION_ID}`;
  const catalogSearch = `?${new URLSearchParams({
    catalog: "claude",
    host: "gateway:local",
    thread: CLAUDE_SESSION_ID,
  })}`;
  const catalogRoute = `/chat/${AGENT_ID}${catalogSearch}`;

  let mark = 0;
  const talkSince = (from) => talkFrames.slice(from);
  const catalogKeyed = (frames) =>
    frames.filter((entry) => String(entry.sessionKey ?? "").includes(":catalog:"));

  // The Control UI is a single-page app, so navigate with the product's own
  // router instead of full page loads (which would drop the WebSocket).
  const spaNavigate = async (search) => {
    await page.evaluate(
      ({ agentId, s }) => window.openclawControlUi.navigate("chat", { pathname: `/chat/${agentId}`, search: s }),
      { agentId: AGENT_ID, s: search },
    );
    // Let any misdirected discovery fire before asserting absence.
    await page.waitForTimeout(1500);
  };

  // 1) Open the catalog route: its external key must not reach Talk discovery.
  proof.stage = "open catalog route";
  mark = talkFrames.length;
  await spaNavigate(catalogSearch);
  const onOpen = talkSince(mark);

  // 2) Reopen the same catalog URL.
  proof.stage = "reopen catalog route";
  mark = talkFrames.length;
  await spaNavigate("?lang=en");
  await page.waitForTimeout(400);
  mark = talkFrames.length;
  await spaNavigate(catalogSearch);
  const onReopen = talkSince(mark);

  // 3) A focus refresh cannot revive discovery while the route names a catalog entry.
  proof.stage = "focus refresh";
  mark = talkFrames.length;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page.waitForTimeout(1200);
  const onFocus = talkSince(mark);

  proof.catalogRouteKey = catalogKey;
  proof.talkRequests = {
    all: talkFrames,
    onOpenCatalogKeyed: catalogKeyed(onOpen),
    onReopenCatalogKeyed: catalogKeyed(onReopen),
    onFocusCatalogKeyed: catalogKeyed(onFocus),
  };
  await page.screenshot({ path: path.join(outDir, "catalog-route.png"), fullPage: false });

  const catalogLeaks = [
    ...catalogKeyed(onOpen),
    ...catalogKeyed(onReopen),
    ...catalogKeyed(onFocus),
  ];
  proof.catalogKeyReachedTalk = catalogLeaks.length > 0;
  if (catalogLeaks.length > 0) {
    fail(
      `catalog key reached Talk discovery ${catalogLeaks.length}x: ${JSON.stringify(catalogLeaks)}`,
    );
  }
  log("catalog route sent zero catalog-keyed talk requests across open/reopen/focus");

  // 4) Real adoption: sessions.catalog.continue returns the adopted chat key, the
  // pane navigates to it, and discovery resumes scoped to that real session key.
  proof.stage = "adoption resumes discovery with the real chat key";
  const continued = await cli([
    "gateway",
    "call",
    "sessions.catalog.continue",
    "--params",
    JSON.stringify({
      agentId: AGENT_ID,
      catalogId: "claude",
      hostId: "gateway:local",
      threadId: CLAUDE_SESSION_ID,
    }),
    "--timeout",
    "60000",
  ]);
  const adoptedKey = continued?.sessionKey;
  proof.adoptedSessionKey = adoptedKey ?? null;
  if (!adoptedKey || typeof adoptedKey !== "string" || adoptedKey.includes(":catalog:")) {
    fail(`adoption did not return a real chat key: ${redact(JSON.stringify(continued))}`);
  }
  log("adoption returned real chat key:", adoptedKey);

  // Adoption created an ordinary Gateway session (the CLI returned its key). The
  // Control UI addresses that session by its exact key: /chat/<agent>/<rest
  // segments>. Navigating there must resume discovery scoped to that real,
  // non-catalog session key. Assert on the session-key shape the wire carries.
  const adoptedSegments = adoptedKey.split(":").slice(1).map(encodeURIComponent).join("/");
  const adoptedPath = `/chat/${AGENT_ID}/${adoptedSegments}`;
  mark = talkFrames.length;
  await page.evaluate(
    ({ p }) => window.openclawControlUi.navigate("chat", { pathname: p, search: "?lang=en" }),
    { p: adoptedPath },
  );
  await page.waitForTimeout(2500);
  const adoptedWindow = talkSince(mark);
  const adoptedCatalogLeak = catalogKeyed(adoptedWindow);
  // Discovery resumed = a talk.catalog scoped to a real, non-catalog session key
  // (the adopted key the Control UI canonicalizes for the adopted session).
  const resumedTalk = adoptedWindow.filter(
    (entry) =>
      entry.method === "talk.catalog" &&
      typeof entry.sessionKey === "string" &&
      entry.sessionKey.length > 0 &&
      !entry.sessionKey.includes(":catalog:"),
  );
  proof.adoption = {
    adoptedKey,
    adoptedPath,
    talkAfterAdoption: adoptedWindow,
    nonCatalogTalkAfterAdoption: resumedTalk,
    catalogKeyedAfterAdoption: adoptedCatalogLeak,
  };
  await page.screenshot({ path: path.join(outDir, "adopted-route.png"), fullPage: false });

  if (adoptedCatalogLeak.length > 0) {
    fail(`catalog key still reached Talk after adoption: ${JSON.stringify(adoptedCatalogLeak)}`);
  }
  proof.discoveryResumedAfterAdoption = resumedTalk.length > 0;
  log(
    `after adoption: ${resumedTalk.length} non-catalog talk.catalog request(s), zero catalog-keyed`,
  );
  if (!proof.discoveryResumedAfterAdoption) {
    fail("discovery did not resume with a real chat key after adoption");
  }

  await fs.writeFile(path.join(outDir, "gateway.private.log"), redact(readGateway()));
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
