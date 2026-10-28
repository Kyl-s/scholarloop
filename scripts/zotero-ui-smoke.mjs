import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { preview } from "vite";
import { chromium } from "playwright";

// All API traffic is intercepted. No backend, real credentials or uploads are used.
const root = fileURLToPath(new URL("../", import.meta.url));
const artifactDir = resolve(root, "tmp/zotero-ui-smoke");
await mkdir(artifactDir, { recursive: true });
const portProbe = createNetServer();
await new Promise((ready, reject) => portProbe.once("error", reject).listen(0, "127.0.0.1", ready));
const port = portProbe.address().port;
await new Promise((ready) => portProbe.close(ready));
let vite;
let browser;
const pageErrors = [];
const requests = [];
let configCount = 0;
let testCount = 0;
let syncCount = 0;
let syncStarted = 0;
let status = { configured: false, collectionName: "ScholarLoop", autoSync: false, busy: false, lastRun: null, error: "本机授权暂不可用，请重新保存 Key" };
const finished = () => ({ running: false, total: 3, processed: 3, synced: 1, metadataOnly: 1, failed: 1, results: [
  { id: "p1", title: "Smoke PDF paper", status: "synced", pdfStatus: "uploaded" },
  { id: "p2", title: "Smoke metadata paper", status: "metadata-only", pdfStatus: "missing" },
  { id: "p3", title: "Smoke failed paper", status: "failed", error: "Zotero 空间不足（模拟）", pdfStatus: "failed" }
] });
try {
  vite = await preview({ root, preview: { host: "127.0.0.1", port, strictPort: true, open: false }, logLevel: "error" });
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  page.setDefaultTimeout(30000);
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    requests.push({ path, method: request.method() });
    const reply = (body, code = 200) => route.fulfill({ status: code, contentType: "application/json", body: JSON.stringify(body) });
    if (path === "/api/zotero/status") {
      if (status.busy && Date.now() - syncStarted > 2200) status = { ...status, busy: false, lastRun: finished() };
      return reply(status);
    }
    if (path === "/api/zotero/config") {
      const body = request.postDataJSON();
      configCount += 1;
      assert.equal(body.apiKey, "smoke-only-not-a-real-key");
      if (configCount === 1) return reply({ error: "缺少个人库写入或文件访问权限（模拟）" }, 403);
      assert.equal(body.collectionName, "Phone Papers");
      assert.equal(body.autoSync, true);
      status = { configured: true, collectionName: body.collectionName, autoSync: body.autoSync, username: "Smoke Account", userID: 42, busy: false, lastRun: null };
      return reply(status);
    }
    if (path === "/api/zotero/test") { testCount += 1; return reply(status); }
    if (path === "/api/zotero/sync") {
      syncCount += 1;
      assert.deepEqual(request.postDataJSON(), {});
      syncStarted = Date.now();
      status = { ...status, busy: true, lastRun: { running: true, total: 3, processed: 0, synced: 0, metadataOnly: 0, failed: 0, results: [] } };
      return reply({ started: true });
    }
    const fixtures = {
      "/api/library": [{ id: "p1", title: "Smoke PDF paper", authors: ["Smoke Author"], year: 2026, status: "todo", source: "manual", tags: [] }],
      "/api/memories": [], "/api/path": { stages: [] }, "/api/drafts": [], "/api/journals": [], "/api/notes": [],
      "/api/settings": { learningPathEnabled: false }, "/api/stats": { libraryCount: 1 }, "/api/sources": { sources: [] }
    };
    assert.equal(request.method(), "GET", `Unexpected mutation outside mocked Zotero routes: ${path}`);
    return reply(fixtures[path] || {});
  });
  await page.goto(`http://127.0.0.1:${port}`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.locator(".nav-list .nav-item").filter({ hasText: "设置" }).click();
  const panel = page.locator(".zotero-settings-panel");
  await panel.waitFor({ state: "visible" });
  await panel.getByRole("alert").filter({ hasText: "本机授权暂不可用" }).waitFor();
  const key = panel.locator('input[type="password"]');
  assert.equal(await key.getAttribute("autocomplete"), "new-password");
  await key.fill("smoke-only-not-a-real-key");
  await panel.locator('input[placeholder="ScholarLoop"]').fill("Phone Papers");
  await panel.locator(".settings-toggle-row").click();
  const save = panel.getByRole("button", { name: "保存配置", exact: true });
  assert.equal(await save.getAttribute("type"), "submit");
  await save.click();
  await panel.getByRole("alert").filter({ hasText: "缺少个人库写入或文件访问权限" }).waitFor();
  assert.equal(await key.inputValue(), "smoke-only-not-a-real-key", "failed save retains the draft for retry");
  await save.click();
  await panel.getByRole("status").filter({ hasText: "配置已保存" }).waitFor();
  assert.equal(await key.inputValue(), "", "successful save clears key input");
  assert.equal(await page.evaluate(() => JSON.stringify(localStorage).includes("smoke-only-not-a-real-key")), false);
  await panel.getByRole("button", { name: "验证已保存的连接", exact: true }).click();
  await panel.getByRole("status").filter({ hasText: "连接验证成功" }).waitFor();
  assert.equal(testCount, 1);
  await panel.getByRole("button", { name: "同步全部文献", exact: true }).click();
  await panel.getByRole("progressbar", { name: "Zotero 同步进度" }).waitFor();
  assert.equal(await panel.getByRole("button", { name: "同步中…", exact: true }).isDisabled(), true);
  await panel.getByText("查看 3 篇同步结果").waitFor();
  await panel.locator(".zotero-results summary").click();
  await panel.getByText("Zotero 空间不足（模拟）", { exact: false }).waitFor();
  assert.match(await panel.locator("li").nth(1).innerText(), /仅条目/);
  const settingsScreenshot = resolve(artifactDir, "settings.png");
  await panel.screenshot({ path: settingsScreenshot });
  await page.locator(".nav-list .nav-item").filter({ hasText: "文献库" }).click();
  const libraryPanel = page.locator(".zotero-library-sync");
  await libraryPanel.getByRole("button", { name: "同步全部文献到 Zotero", exact: true }).click();
  await libraryPanel.getByRole("progressbar").waitFor();
  await libraryPanel.getByText("查看 3 篇同步结果").waitFor();
  const libraryScreenshot = resolve(artifactDir, "library.png");
  await libraryPanel.screenshot({ path: libraryScreenshot });
  assert.equal(syncCount, 2);
  assert.deepEqual(pageErrors, []);
  console.log(JSON.stringify({ passed: true, configCount, testCount, syncCount, apiRequests: requests.length, settingsScreenshot, libraryScreenshot }, null, 2));
} finally {
  await browser?.close();
  if (vite) await new Promise((done) => vite.httpServer.close(done));
}
