import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
const storeFile = new URL("../data/store.json", import.meta.url);
const digest = () => createHash("sha256").update(fs.readFileSync(storeFile)).digest("hex");
const before = digest();
const child = spawn(process.execPath, ["server/index.js"], { cwd: root, env: { ...process.env, PORT: "0" }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
let timeout;
try {
  const port = await new Promise((resolve, reject) => {
    timeout = setTimeout(() => reject(new Error("Server startup timed out")), 20000);
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`Server exited ${code}`)));
    child.stdout.on("data", (chunk) => { const match = String(chunk).match(/SCHOLARLOOP_PORT=(\d+)/); if (match) { clearTimeout(timeout); resolve(match[1]); } });
    child.stderr.resume();
  });
  const base = `http://127.0.0.1:${port}`;
  const status = await fetch(`${base}/api/zotero/status`);
  assert.equal(status.status, 200); assert.equal(status.headers.get("cache-control"), "no-store");
  const body = await status.json(); assert.equal(typeof body.configured, "boolean"); assert.equal(body.apiKey, undefined);
  const foreign = await fetch(`${base}/api/zotero/status`, { headers: { Origin: "https://unrelated.example" } }); assert.equal(foreign.status, 403);
  const forwarded = await fetch(`${base}/api/zotero/status`, { headers: { "x-forwarded-for": "192.0.2.1" } }); assert.equal(forwarded.status, 403);
  if (!body.configured) {
    const noConfig = await fetch(`${base}/api/zotero/sync`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }); assert.equal(noConfig.status, 400);
    const invalid = await fetch(`${base}/api/zotero/config`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ apiKey: "invalid" }) }); assert.equal(invalid.status, 400);
  }
  assert.equal(digest(), before, "real document library must remain unchanged");
  console.log("Zotero live local HTTP smoke passed: status, origin guard, forwarded guard, unconfigured sync/config, unchanged library");
} finally {
  clearTimeout(timeout);
  child.kill();
  await new Promise((resolve) => child.exitCode !== null ? resolve() : child.once("exit", resolve));
}
