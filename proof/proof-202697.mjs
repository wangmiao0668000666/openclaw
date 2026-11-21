// Real-Gateway proof for PR #202697: paste a clipboard image into the shipped
// terminal composer and observe the real terminal.upload RPC + real staged file.
//
// Not a repo test: drives a REAL Gateway (real PTY, real terminal.upload, real
// stageTerminalUpload writing to disk) with a real Chromium and the real OS
// clipboard. The Gateway runs in a Debian container (glibc 2.36) reached over an
// SSH tunnel, so the changed Control UI bundle and the changed paste handler are
// the shipped ones from this PR's branch.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

const BASE = process.env.PROOF_BASE_URL ?? "http://127.0.0.1:39711";
const TOKEN = process.env.PROOF_TOKEN ?? "testtoken123";
const SHOTS = process.env.PROOF_SHOTS ?? "/tmp/proof-202697";
const REMOTE = process.env.PROOF_REMOTE ?? "root@10.54.159.54";
const CONTAINER = process.env.PROOF_CONTAINER ?? "pr202143-build";

const log = (...args) => console.log(...args);

function inContainer(script) {
  return execFileSync(
    "sshpass",
    [
      "-p", "88ECSS@dcs2025#",
      "ssh", "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null",
      REMOTE,
      `docker exec ${CONTAINER} sh -c ${JSON.stringify(script)}`,
    ],
    { encoding: "utf8", timeout: 60_000 },
  );
}

// Real staged files live under tmpdir() on Linux inside the Gateway container.
function stagedFiles() {
  const out = inContainer("bash /tmp/staged-list.sh");
  return out.split("\n").filter(Boolean).map((line) => {
    const [dir, file, size] = line.split("\t");
    return { dir, file, size: Number(size), key: `${dir}/${file}` };
  });
}

function readStagedFile(dir, file) {
  return inContainer(`base64 -w0 '${dir}/${file}'`).trim();
}

const browser = await (await import("/tmp/wt-202645/node_modules/playwright/index.mjs")).chromium.launch({
  args: ["--disable-partial-raster", "--disable-gpu-rasterization"],
});
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  permissions: ["clipboard-read", "clipboard-write"],
  serviceWorkers: "block",
});
await context.grantPermissions(["clipboard-read", "clipboard-write"], {
  origin: new URL(BASE).origin,
});
const page = await context.newPage();
page.on("console", (msg) => {
  const text = msg.text();
  if (/error|fail|warn/iu.test(text)) log("  [browser]", msg.type(), text.slice(0, 200));
});

const before = stagedFiles();
log(`staged files before: ${before.length} (${before.map((f) => f.key).join(", ") || "none"})`);

// Track the real RPCs the browser sends over the real WebSocket.
const rpcs = [];
page.on("websocket", (ws) => {
  ws.on("framesent", (frame) => {
    try {
      const payload = JSON.parse(frame.payload);
      const method = payload?.method ?? payload?.[0]?.method;
      if (typeof method === "string") rpcs.push(method);
    } catch {
      /* binary or non-JSON frames */
    }
  });
});

await page.goto(`${BASE}/?token=${encodeURIComponent(TOKEN)}`);
await page.waitForLoadState("domcontentloaded");
const pane = page.locator("openclaw-chat-pane.chat-pane-cache__pane--active");
await pane.first().waitFor({ state: "visible", timeout: 90_000 });
log(`control UI loaded at ${page.url()}`);

// Open the Terminal side panel: Panels toggle, then the "Toggle terminal" action.
const panelsToggle = pane.locator(".sidebar-region__panels-toggle").first();
await panelsToggle.waitFor({ state: "visible", timeout: 60_000 });
if ((await panelsToggle.getAttribute("aria-expanded")) !== "true") {
  await panelsToggle.click();
}
const toggleTerminal = page
  .locator(".side-panel-launcher__item")
  .filter({ hasText: /终端|terminal/iu })
  .first();
await toggleTerminal.waitFor({ state: "visible", timeout: 30_000 });
await toggleTerminal.click();
const embedded = page.locator('[data-panel-slot="terminal"] openclaw-terminal-panel');
await embedded.waitFor({ state: "attached", timeout: 60_000 });
log("terminal panel attached");

const currentSession = embedded.locator(".tp-session.is-current");
try {
  await currentSession.first().waitFor({ state: "visible", timeout: 30_000 });
  await currentSession.first().click();
} catch {
  log("no current session entry to dismiss (picker may already be closed)");
}
const composer = embedded.locator(".tp-composer input");
await composer.waitFor({ state: "visible", timeout: 60_000 });
log("composer visible");

// 1) Text paste stays native.
await page.evaluate(() => navigator.clipboard.writeText("plain text paste"));
await composer.click();
await page.keyboard.press("Control+V");
await page.waitForTimeout(1_500);
const textValue = await composer.inputValue();
log(`text paste -> composer value contains "plain text paste": ${textValue.includes("plain text paste")}`);
log(`terminal.upload after text paste: ${rpcs.filter((m) => m === "terminal.upload").length}`);

// 2) Real PNG on the real clipboard, delivered with a real keystroke.
const rpcsBefore = rpcs.length;
await page.evaluate(async () => {
  const canvas = document.createElement("canvas");
  canvas.width = 2;
  canvas.height = 2;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ff0000";
  ctx.fillRect(0, 0, 2, 2);
  const blob = await new Promise((resolve) => {
    canvas.toBlob((value) => resolve(value), "image/png");
  });
  if (!blob) throw new Error("canvas produced no PNG blob");
  await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
});
await composer.click();
await page.keyboard.press("Control+V");

// Wait for the real staged file to appear on disk (real stageTerminalUpload).
let staged = null;
for (let i = 0; i < 60; i += 1) {
  await page.waitForTimeout(500);
  const now = stagedFiles();
  const fresh = now.filter((f) => !before.some((b) => b.key === f.key));
  if (fresh.length > 0) {
    staged = fresh[0];
    break;
  }
}
log(`real staged file: ${staged ? `${staged.key} (${staged.size} bytes)` : "NONE"}`);

const attachment = embedded.locator(".tp-attachment");
let attachmentText = "";
try {
  await attachment.first().waitFor({ state: "visible", timeout: 20_000 });
  attachmentText = (await attachment.first().textContent()) ?? "";
} catch {
  log("attachment chip did not render");
}
log(`attachment chip text: ${JSON.stringify(attachmentText.trim())}`);

const newRpcs = rpcs.slice(rpcsBefore);
log(`RPCs during image paste: ${JSON.stringify(newRpcs)}`);
log(`terminal.upload sent: ${newRpcs.includes("terminal.upload")}`);
log(`terminal.input sent before Send: ${newRpcs.includes("terminal.input")}`);

if (staged) {
  const bytes = Buffer.from(readStagedFile(staged.dir, staged.file), "base64");
  log(`staged bytes: ${bytes.length}, PNG magic: ${bytes.subarray(0, 4).toString("hex")}`);
  log(`sha256: ${createHash("sha256").update(bytes).digest("hex")}`);
}

await page.screenshot({ path: `${SHOTS}/composer-pasted-image.png`, fullPage: false });
log(`screenshot: ${SHOTS}/composer-pasted-image.png`);

await context.close();
await browser.close();
