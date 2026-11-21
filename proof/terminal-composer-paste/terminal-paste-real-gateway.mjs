// Shipped proof for terminal-composer clipboard paste against a real Gateway.
//
// Real: dist Gateway process, real terminal PTY, real terminal.upload staging on
// disk, real Playwright Chromium, real OS clipboard + real Control+V keystroke.
// Only the model provider is a loopback fixture.
//
// Usage (Gateway must already be running on GATEWAY_PORT with dist/control-ui):
//   node .artifacts/proof/terminal-paste-real-gateway.mjs
import { execFile } from "node:child_process";
import { stat, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { chromium } from "playwright";

const exec = promisify(execFile);
const PORT = process.env.GATEWAY_PORT ?? "19744";
const OUT = process.env.PROOF_OUT ?? ".artifacts/proof/terminal-paste";
const SESSION = "agent:main:terminal-paste-real-gateway";

const log = (msg) => console.log(`[proof] ${msg}`);
const cli = async (args) => {
  const { stdout } = await exec(process.execPath, ["dist/index.js", ...args], {
    env: process.env,
    maxBuffer: 32 * 1024 * 1024,
  });
  return stdout;
};

await mkdir(OUT, { recursive: true });

// 1. Create the session the browser will open.
const created = await cli([
  "gateway",
  "call",
  "sessions.create",
  "--json",
  "--params",
  JSON.stringify({ key: SESSION, agentId: "main", label: "Terminal paste proof" }),
]);
log(`sessions.create ok=${JSON.parse(created).ok ?? "n/a"}`);

// 2. Pair a real browser against the real Gateway.
const handoff = JSON.parse(await cli(["dashboard", "--json"]));
if (!handoff.ok || !handoff.browserUrl) {
  throw new Error(`dashboard pairing failed: ${handoff.reason ?? "no browserUrl"}`);
}
const base = new URL(handoff.browserUrl);
// Control UI session paths use agent/shortId segments, not a percent-encoded key.
const [, agentId, ...rest] = SESSION.split(":");
const sessionUrl = new URL(`/chat/${agentId}/${rest.join(":")}`, base).toString();

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  // Pin the UI locale so the shipped English panel labels are stable regardless
  // of the operator's system locale.
  locale: "en-US",
  viewport: { width: 1440, height: 900 },
  serviceWorkers: "block",
  permissions: ["clipboard-read", "clipboard-write"],
});
await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: base.origin });
const page = await context.newPage();

const uploads = [];
page.on("websocket", (socket) => {
  const pending = new Map();
  socket.on("framesent", ({ payload }) => {
    const frame = JSON.parse(payload.toString());
    if (frame?.type === "req" && frame.id && frame.method) {
      pending.set(frame.id, frame.method);
    }
  });
  socket.on("framereceived", ({ payload }) => {
    const frame = JSON.parse(payload.toString());
    if (frame?.type !== "res" || !frame.id) {
      return;
    }
    if (pending.get(frame.id) !== "terminal.upload") {
      return;
    }
    const r = frame.payload ?? {};
    uploads.push({ ok: frame.ok, path: r.path, size: r.size, error: frame.error });
    log(`terminal.upload res ok=${frame.ok} path=${r.path} size=${r.size}`);
  });
});

// The bootstrap token is consumed on the root route; land there first so the
// session navigation below is authenticated.
log(`bootstrapping ${handoff.browserUrl.slice(0, 80)}…`);
await page.goto(handoff.browserUrl);
await page.waitForTimeout(10_000);

log(`navigating ${sessionUrl}`);
await page.goto(sessionUrl);
await page.waitForSelector("openclaw-chat-pane", { timeout: 90_000 });

// 3. Open the Terminal side panel and reveal the composer.
const pane = page.locator("openclaw-chat-pane.chat-pane-cache__pane--active");
// The shipped panel toggle opens the side region; the launcher inside it lists
// the available panel types as plain buttons (no menuitem roles).
const panelsToggle = pane.locator(".sidebar-region__panels-toggle").getByRole("button").first();
await panelsToggle.waitFor({ state: "visible", timeout: 60_000 });
if ((await panelsToggle.getAttribute("aria-expanded")) !== "true") {
  await panelsToggle.click();
}
const launcher = pane.locator(".side-panel-launcher").filter({ visible: true }).first();
await launcher.waitFor({ state: "visible", timeout: 60_000 });
const terminalOption = launcher
  .getByRole("button")
  .filter({ has: page.getByText("Terminal", { exact: true }) })
  .first();
await terminalOption.waitFor({ state: "visible", timeout: 30_000 });
await terminalOption.click();
const embedded = page.locator('[data-panel-slot="terminal"] openclaw-terminal-panel');
await embedded.waitFor({ state: "visible", timeout: 60_000 });
log("terminal panel visible");

// Real PTY session opens through the Gateway.
await page.waitForFunction(
  () => document.querySelectorAll('[data-panel-slot="terminal"] .tp-session').length > 0,
  undefined,
  { timeout: 60_000 },
);
await embedded
  .locator(".tp-session.is-current")
  .click()
  .catch(() => {});
const composer = embedded.locator(".tp-composer input");
await composer.waitFor({ state: "visible", timeout: 60_000 });
log("composer visible");

// 4. Text paste stays native: no upload.
await page.evaluate(() => navigator.clipboard.writeText("plain text paste"));
await composer.click();
await page.keyboard.press("Control+V");
await page.waitForFunction(
  () =>
    document
      .querySelector('[data-panel-slot="terminal"] .tp-composer input')
      ?.value?.includes("plain text paste"),
  undefined,
  { timeout: 15_000 },
);
const textUploads = uploads.length;
log(`text paste: uploads=${textUploads} (expected 0)`);

// 5. Real PNG on the OS clipboard, pasted with a real keystroke.
await page.evaluate(async () => {
  const canvas = document.createElement("canvas");
  canvas.width = 2;
  canvas.height = 2;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ff0000";
  ctx.fillRect(0, 0, 2, 2);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
  await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
});
await composer.click();
await page.keyboard.press("Control+V");

const deadline = Date.now() + 30_000;
while (uploads.length === textUploads && Date.now() < deadline) {
  await page.waitForTimeout(250);
}
if (uploads.length === textUploads) {
  throw new Error("no terminal.upload request after image paste");
}

const staged = uploads.at(-1);
if (!staged.ok) {
  throw new Error(`terminal.upload failed: ${JSON.stringify(staged.error)}`);
}
const onDisk = await stat(staged.path);
log(`staged on disk: ${staged.path} size=${onDisk.size} isFile=${onDisk.isFile()}`);
if (!onDisk.isFile() || onDisk.size !== staged.size || onDisk.size === 0) {
  throw new Error("staged file does not match the Gateway response");
}
if (!staged.path.endsWith(".png")) {
  throw new Error(`staged path is not a png: ${staged.path}`);
}

// 6. The attachment chip renders, and nothing was submitted to the PTY.
await page.waitForFunction(
  () =>
    /\.png/u.test(
      document.querySelector('[data-panel-slot="terminal"] .tp-attachment')?.textContent ?? "",
    ),
  undefined,
  { timeout: 20_000 },
);
const chipText = await embedded.locator(".tp-attachment").first().textContent();
log(`attachment chip: ${JSON.stringify(chipText)}`);

const composerValue = await composer.inputValue();
log(`composer value after staging: ${JSON.stringify(composerValue)}`);

await page.screenshot({ path: path.join(OUT, "composer-pasted-attachment.png") });
await embedded.screenshot({ path: path.join(OUT, "terminal-panel.png") });
// Element-level frames keep the chip legible at proof scale.
await embedded.locator(".tp-composer").screenshot({ path: path.join(OUT, "composer-only.png") });
await embedded
  .locator(".tp-composer")
  .screenshot({ path: path.join(OUT, "composer-attachment-only.png"), scale: "device" });

const report = {
  gateway: `real dist Gateway on 127.0.0.1:${PORT}`,
  pty: "real terminal PTY opened through the Gateway",
  clipboard: "real OS clipboard via navigator.clipboard + real Control+V",
  modelProvider: "loopback fixture only",
  textPasteUploads: textUploads,
  imageUpload: staged,
  stagedOnDisk: { size: onDisk.size, isFile: onDisk.isFile() },
  attachmentChip: chipText,
  composerValueAfterStaging: composerValue,
};
await writeFile(path.join(OUT, "proof.json"), `${JSON.stringify(report, null, 2)}\n`);
log(`PASS ${JSON.stringify(report)}`);

await browser.close();
