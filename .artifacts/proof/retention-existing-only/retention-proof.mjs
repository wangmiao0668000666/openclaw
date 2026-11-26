// Real shipped-workflow proof for issue #205927.
// Phase 1: seed an isolated state dir, start a real `openclaw gateway` process, wait for
//          the shipped startup+130s maintenance retention timer, then check the removed
//          store stays absent, live-store pruning continues, and the registry survives.
// Phase 2: run the real `openclaw doctor --non-interactive` CLI against the same state
//          dir and confirm Doctor does not recreate the removed store either.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const ROOT = process.argv[2]; // dist root containing openclaw.mjs
const MODE = process.argv[3] ?? "head"; // head | base (label only)
if (!ROOT) {
  console.error("usage: node retention-proof.mjs <distRoot> [label]");
  process.exit(2);
}
const CLI = path.join(ROOT, "openclaw.mjs");
const NODE = process.execPath;

const DAY = 86_400_000;
const now = Date.now();
const LIVE = "main";
const MISSING = "stale";
const FRESH_TOOL = "openclaw:synthetic:lookup";
const EXPIRED_TOOL = "openclaw:synthetic:stale-lookup";
const EXPIRED_AT = now - 91 * DAY;

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), `oc-ret-proof-${MODE}-`));
fs.chmodSync(stateDir, 0o700);
const env = {
  ...process.env,
  OPENCLAW_STATE_DIR: stateDir,
  OPENCLAW_TEST_MINIMAL_GATEWAY: "0", // allow real side runtimes / maintenance timers
  PROC_SAFE_NATIVE: "off", // host glibc < 2.33
};

const agentDb = (agentId) =>
  path.join(stateDir, "agents", agentId, "agent", "openclaw-agent.sqlite");
const livePath = agentDb(LIVE);
const missingPath = agentDb(MISSING);

function readRawUpdatedAt(dbPath, toolId) {
  using db = new DatabaseSync(dbPath, { readOnly: true });
  const row = db
    .prepare("SELECT updated_at AS updatedAt FROM agent_tool_usage WHERE tool_id = ?")
    .get(toolId);
  return row?.updatedAt ?? null;
}
function registryHas(targetPath) {
  // registry lives in the shared state sqlite (agent_databases table); paths are stored
  // relative to the state dir, so match by suffix.
  const candidates = [
    path.join(stateDir, "state", "openclaw.sqlite"),
    path.join(stateDir, "openclaw.sqlite"),
  ];
  const suffix = targetPath.split(`${path.sep}agents${path.sep}`)[1];
  const needle = suffix ? `agents${path.sep}${suffix}` : targetPath;
  for (const c of candidates) {
    if (!fs.existsSync(c)) continue;
    try {
      using db = new DatabaseSync(c, { readOnly: true });
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all()
        .map((r) => r.name);
      if (!tables.includes("agent_databases")) continue;
      const rows = db.prepare("SELECT agent_id, path FROM agent_databases").all();
      const found = rows.some(
        (r) => typeof r.path === "string" && (r.path === targetPath || r.path.endsWith(needle)),
      );
      return { agents: rows.map((r) => r.agent_id), found };
    } catch {
      /* try next */
    }
  }
  return { agents: null, found: null };
}
const redact = (s) =>
  s
    .replace(/token\S*/gi, "token<redacted>")
    .replace(/\/tmp\/oc-ret-proof-\S+?\//g, "<state>/")
    .replace(/\/retention-(head|base)/g, "<dist>");

console.log(`[proof:${MODE}] stateDir=${stateDir}`);
console.log(`[proof:${MODE}] cli=${CLI}`);

// A minimal config so the shipped Gateway starts in local mode.
fs.writeFileSync(
  path.join(stateDir, "openclaw.json"),
  `${JSON.stringify({ gateway: { mode: "local" } })}\n`,
  { mode: 0o600 },
);

// --- Seed phase: register the missing store's registry row WITHOUT creating its file,
//     and seed the live store with a fresh row + a directly-inserted expired row. ---
const seedScript = `
const reg = await import(${JSON.stringify(path.join(ROOT, "src/state/openclaw-agent-db-registry.ts"))});
const paths = await import(${JSON.stringify(path.join(ROOT, "src/state/openclaw-agent-db.paths.ts"))});
const tu = await import(${JSON.stringify(path.join(ROOT, "src/config/sessions/tool-usage.ts"))});
const ts = await import(${JSON.stringify(path.join(ROOT, "src/config/sessions/tool-usage.test-support.ts"))});
const env = process.env;
const now = ${now};
const missingPath = paths.resolveOpenClawAgentSqlitePath({ agentId: ${JSON.stringify(MISSING)}, env });
reg.registerOpenClawAgentDatabase({ agentId: ${JSON.stringify(MISSING)}, path: missingPath, env });
const live = { agentId: ${JSON.stringify(LIVE)}, env };
const seeded = await ts.seedAgentToolUsageRunForTest({ ...live, now });
await tu.flushAgentToolUsage({ ...live, generation: seeded.generation, startedAt: now, now, rows: [{ toolId: ${JSON.stringify(FRESH_TOOL)}, score: 1, updatedAt: now }] });
const { DatabaseSync } = await import("node:sqlite");
const livePath = paths.resolveOpenClawAgentSqlitePath(live);
{ using db = new DatabaseSync(livePath); db.prepare("INSERT INTO agent_tool_usage (tool_id, score, updated_at) VALUES (?, ?, ?)").run(${JSON.stringify(EXPIRED_TOOL)}, 1, ${EXPIRED_AT}); }
console.log("SEED_OK");
`;
const seed = spawnSync(NODE, ["--import", path.join(ROOT, "scripts/tsx.mjs"), "-e", seedScript], {
  env,
  encoding: "utf8",
});
if (seed.status !== 0 || !`${seed.stdout}`.includes("SEED_OK")) {
  console.error(`[proof:${MODE}] SEED_FAILED\n${redact(`${seed.stdout}\n${seed.stderr}`)}`);
  process.exit(3);
}

console.log(`[proof:${MODE}] before gateway: missing store absent=${!fs.existsSync(missingPath)}`);
console.log(`[proof:${MODE}] before gateway: expired row present=${readRawUpdatedAt(livePath, EXPIRED_TOOL) !== null}`);
console.log(`[proof:${MODE}] before gateway: registry=${JSON.stringify(registryHas(missingPath))}`);

// --- Phase 1: start the real Gateway process and wait for the shipped retention timer ---
const port = 18789 + Math.floor(Math.random() * 1000);
const gw = spawn(
  NODE,
  [CLI, "gateway", "--port", String(port), "--bind", "loopback", "--auth", "token", "--token", "retention-proof-token"],
  { env, stdio: ["ignore", "pipe", "pipe"] },
);
let gwLog = "";
gw.stdout.on("data", (d) => (gwLog += d));
gw.stderr.on("data", (d) => (gwLog += d));
let gwExited = null;
gw.on("close", (c) => (gwExited = c));

const WAIT_MS = 160_000;
console.log(`[proof:${MODE}] gateway pid=${gw.pid} port=${port}; waiting ${WAIT_MS / 1000}s for the shipped retention timer...`);
await new Promise((r) => setTimeout(r, WAIT_MS));

const expiredAfter = readRawUpdatedAt(livePath, EXPIRED_TOOL);
const freshAfter = readRawUpdatedAt(livePath, FRESH_TOOL);
const missingAfterGateway = fs.existsSync(missingPath);
const regAfterGateway = registryHas(missingPath);

console.log(`[proof:${MODE}] after gateway retention cycle:`);
console.log(`[proof:${MODE}]   expired row pruned=${expiredAfter === null}`);
console.log(`[proof:${MODE}]   fresh row preserved=${freshAfter !== null}`);
console.log(`[proof:${MODE}]   removed store recreated=${missingAfterGateway} (false = stays absent)`);
console.log(`[proof:${MODE}]   registry row survives=${regAfterGateway.found}`);

gw.kill("SIGTERM");
await new Promise((r) => setTimeout(r, 3000));
if (gwExited === null) gw.kill("SIGKILL");
console.log(`[proof:${MODE}] gateway shutdown; retention log lines:`);
for (const l of gwLog.split("\n").filter((l) => /retention|tool.?usage|ready|listening/i.test(l)).slice(0, 8)) {
  console.log(`  ${redact(l)}`);
}

// --- Phase 2: run the real Doctor CLI against the same state dir ---
console.log(`[proof:${MODE}] running real doctor CLI (openclaw doctor --non-interactive)...`);
const doctor = spawnSync(
  NODE,
  [CLI, "doctor", "--non-interactive"],
  { env, encoding: "utf8", timeout: 240_000 },
);
const doctorOut = `${doctor.stdout}\n${doctor.stderr}`;
const missingAfterDoctor = fs.existsSync(missingPath);
const regAfterDoctor = registryHas(missingPath);
console.log(`[proof:${MODE}] doctor exit=${doctor.status}`);
console.log(`[proof:${MODE}] after doctor:`);
console.log(`[proof:${MODE}]   removed store recreated=${missingAfterDoctor} (false = stays absent)`);
console.log(`[proof:${MODE}]   registry row survives=${regAfterDoctor.found}`);
// Show doctor's agent/state-integrity lines if any.
for (const l of doctorOut.split("\n").filter((l) => /agent|state|integrity|sqlite|database|orphan/i.test(l)).slice(0, 10)) {
  console.log(`  doctor| ${redact(l.trim())}`);
}

// --- Verdict ---
const gatewayOk = expiredAfter === null && freshAfter !== null && !missingAfterGateway && regAfterGateway.found === true;
const doctorOk = !missingAfterDoctor && regAfterDoctor.found === true;
console.log(`[proof:${MODE}] gatewayOk=${gatewayOk} doctorOk=${doctorOk}`);
console.log(`[proof:${MODE}] ${gatewayOk && doctorOk ? "PASS" : "FAIL"}`);
process.exit(gatewayOk && doctorOk ? 0 : 1);
