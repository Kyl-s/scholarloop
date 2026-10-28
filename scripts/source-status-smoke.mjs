import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";

// Serves only the built frontend. Every API request is intercepted; no personal
// store or live provider is involved in this regression check.
const root = fileURLToPath(new URL("../", import.meta.url));
const server = spawn(process.execPath, [fileURLToPath(new URL("../node_modules/vite/bin/vite.js", import.meta.url)), "preview", "--host", "127.0.0.1", "--port", "4189", "--strictPort"], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
let browser;
try {
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("preview startup timed out")), 15000);
    server.on("error", reject);
    server.on("exit", (code) => reject(new Error(`preview exited ${code}`)));
    server.stdout.on("data", (data) => { if (String(data).includes("4189")) { clearTimeout(timeout); resolve(); } });
  });
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  let mode = "mixed";
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    let body = [];
    let status = 200;
    if (path === "/api/settings") body = { learningPathEnabled: false, paperSources: {} };
    else if (path === "/api/path") body = null;
    else if (path === "/api/sources") body = { sources: [{ id: "openalex", label: "OpenAlex", authRequired: false }, { id: "ieee", label: "IEEE Xplore", authRequired: true, configured: false }] };
    else if (path === "/api/search") {
      if (mode === "request-error") { status = 500; body = { error: "fixture search failure" }; }
      else body = { papers: [], total: 0, queries: ["world models"], completedAt: "2026-10-11T12:00:00Z", sourceStatus: mode === "mixed"
        ? [{ id: "openalex", state: "empty", ok: true, attemptedQueries: 1, successfulQueries: 1, count: 0, uniqueCount: 0, filteredCount: 0, displayedCount: 0 }, { id: "cnki", state: "partial", ok: true, attemptedQueries: 2, successfulQueries: 1, error: "fixture rate limit" }]
        : [{ id: "openalex", state: "failed", ok: false, attemptedQueries: 1, successfulQueries: 0, error: "fixture upstream failure" }] };
    } else if (["/api/stats", "/api/health"].includes(path)) body = {};
    await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  });
  await page.goto("http://127.0.0.1:4189");
  const navigate = async (name) => page.locator(".nav-list .nav-item").filter({ hasText: name }).click();
  await navigate("论文搜索");
  const run = async () => {
    await page.locator(".search-page .search-input-wrap input").fill("world models");
    await page.locator(".search-page form").first().locator('button[type="submit"]').click();
  };
  await run();
  await page.getByText("本次检索的数据源执行状态", { exact: true }).waitFor();
  await page.getByText("OpenAlex：成功 · 无展示结果", { exact: true }).waitFor();
  await page.getByText("知网 CNKI：部分成功", { exact: true }).waitFor();
  await navigate("设置");
  await page.getByText("无需授权", { exact: true }).waitFor();
  await page.getByText("未配置授权", { exact: true }).waitFor();
  await navigate("论文搜索");
  await page.getByText("上次检索的数据源执行状态", { exact: true }).waitFor();
  mode = "failed";
  await run();
  await page.getByText("数据源未能完成检索", { exact: true }).waitFor();
  mode = "request-error";
  await run();
  await page.getByText("fixture search failure", { exact: true }).waitFor();
  assert.equal(await page.getByText("数据源未能完成检索", { exact: true }).count(), 0);
  await navigate("设置");
  await navigate("论文搜索");
  await page.getByText("fixture search failure", { exact: true }).waitFor();
  assert.deepEqual(errors, []);
  console.log("source status browser smoke passed: empty, partial, configuration, history, all failed, request failure");
} finally {
  await browser?.close();
  server.kill();
}
