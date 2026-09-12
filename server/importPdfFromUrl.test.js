import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = path.join(ROOT, "data");
const STORE_FILE = path.join(DATA_DIR, "store.json");
const PDF_DIR = path.join(DATA_DIR, "pdfs");

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

async function waitForHealth(url) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(500) });
      if (response.ok) return;
    } catch {
      // 子进程可能还没启动完
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("ScholarLoop server did not become ready");
}

/** 备份真实 store.json，测试结束后恢复，避免污染用户数据 */
function backupStore() {
  const exists = fs.existsSync(STORE_FILE);
  const original = exists ? fs.readFileSync(STORE_FILE) : null;
  return function restore() {
    if (original) fs.writeFileSync(STORE_FILE, original);
    else if (fs.existsSync(STORE_FILE)) fs.unlinkSync(STORE_FILE);
  };
}

/** 测试产生的 PDF 落盘文件清理（/api/pdf/file/<uuid>.pdf → data/pdfs/<uuid>.pdf） */
function trackPdf(pdfUrl) {
  const match = String(pdfUrl || "").match(/^\/api\/pdf\/file\/([a-f0-9-]+\.pdf)$/i);
  return match ? path.join(PDF_DIR, match[1]) : null;
}

// 假 PDF：只要 %PDF- 文件头合法即可通过路由校验；正文无法被 pdf-parse 解析时走容错分支
const fakePdf = Buffer.from("%PDF-1.4\n1 0 obj\n<</Type/Catalog>>\nendobj\ntrailer\n%%EOF\n");
const fakeHtml = Buffer.from("<html><body><h1>请登录后下载全文</h1></body></html>");

let pdfMode = "pdf";
let pdfServerSeenHeaders = null;

function startMockPdfServer() {
  return http.createServer((req, res) => {
    pdfServerSeenHeaders = req.headers;
    const body = pdfMode === "pdf" ? fakePdf : fakeHtml;
    res.writeHead(200, { "content-type": pdfMode === "pdf" ? "application/pdf" : "text/html" });
    res.end(body);
  });
}

async function startApp() {
  const portServer = http.createServer();
  const appPort = await listen(portServer);
  await close(portServer);
  const appServer = spawn(process.execPath, ["server/index.js"], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(appPort) },
    stdio: "ignore"
  });
  await waitForHealth(`http://127.0.0.1:${appPort}/api/health`);
  return { appServer, base: `http://127.0.0.1:${appPort}` };
}

test("pdf-from-url downloads PDF bytes, saves to data/pdfs and creates a record", async () => {
  const restore = backupStore();
  const createdFiles = [];
  const mockServer = startMockPdfServer();
  pdfMode = "pdf";
  const mockPort = await listen(mockServer);
  const { appServer, base } = await startApp();
  try {
    const response = await fetch(`${base}/api/import/pdf-from-url`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        url: `http://127.0.0.1:${mockPort}/papers/demo-paper.pdf`,
        cookie: "sid=test-cookie",
        sourceUrl: "https://example.com/article"
      })
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.attached, false);
    // 记录形状：与 /api/import/pdf 一致（localPdf:true + /api/pdf/file/ 落盘路径）
    assert.equal(body.paper.localPdf, true);
    assert.match(body.paper.pdfUrl, /^\/api\/pdf\/file\/[a-f0-9-]+\.pdf$/);
    // 服务端确实发了 Cookie 头
    assert.equal(pdfServerSeenHeaders.cookie, "sid=test-cookie");
    // PDF 落盘到 data/pdfs
    const file = trackPdf(body.paper.pdfUrl);
    assert.ok(file, "pdfUrl 应指向 data/pdfs 下的落盘文件");
    assert.ok(fs.existsSync(file), "PDF 文件应已写入 data/pdfs");
    createdFiles.push(file);
  } finally {
    appServer.kill();
    await close(mockServer);
    for (const file of createdFiles) {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    }
    restore();
  }
});

test("pdf-from-url returns 422 with readable error when the link serves HTML instead of PDF", async () => {
  const restore = backupStore();
  const mockServer = startMockPdfServer();
  pdfMode = "html";
  const mockPort = await listen(mockServer);
  const { appServer, base } = await startApp();
  try {
    const response = await fetch(`${base}/api/import/pdf-from-url`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: `http://127.0.0.1:${mockPort}/articles/123` })
    });
    assert.equal(response.status, 422);
    const body = await response.json();
    assert.equal(body.ok, false);
    assert.ok(body.error.includes("PDF"), `错误信息应提示不是 PDF，实际：${body.error}`);
  } finally {
    appServer.kill();
    await close(mockServer);
    restore();
  }
});

test("pdf-from-url attaches to an existing paper by paperId and only fills empty fields", async () => {
  const restore = backupStore();
  const createdFiles = [];
  const mockServer = startMockPdfServer();
  pdfMode = "pdf";
  const mockPort = await listen(mockServer);
  const { appServer, base } = await startApp();
  try {
    // 先建一条已有完整标题的记录（upsertPaper 保留传入的 id，不自动生成）
    const testId = `attach-test-${Date.now()}`;
    const created = await fetch(`${base}/api/library`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: testId, title: "附加目标文献" })
    });
    const existing = await created.json();
    assert.equal(existing.id, testId);

    const response = await fetch(`${base}/api/import/pdf-from-url`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        url: `http://127.0.0.1:${mockPort}/papers/attach.pdf`,
        paperId: existing.id,
        title: "显式标题不应覆盖已有标题"
      })
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.attached, true);
    // 仅填空缺字段：已有标题保持不变，PDF 信息写入
    assert.equal(body.paper.title, "附加目标文献");
    assert.equal(body.paper.localPdf, true);
    assert.match(body.paper.pdfUrl, /^\/api\/pdf\/file\/[a-f0-9-]+\.pdf$/);
    const file = trackPdf(body.paper.pdfUrl);
    if (file) createdFiles.push(file);
  } finally {
    appServer.kill();
    await close(mockServer);
    for (const file of createdFiles) {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    }
    restore();
  }
});

test("pdf-from-url attaches to an existing same-DOI record instead of creating a duplicate", async () => {
  const restore = backupStore();
  const createdFiles = [];
  const mockServer = startMockPdfServer();
  pdfMode = "pdf";
  const mockPort = await listen(mockServer);
  const { appServer, base } = await startApp();
  try {
    // 先建一条带 DOI 的已有记录（模拟「原来的搜索记录」）
    const testId = `dedupe-test-${Date.now()}`;
    const created = await fetch(`${base}/api/library`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: testId, title: "已有同 DOI 记录", doi: "10.9999/dedupe-test", year: 2020 })
    });
    const existing = await created.json();
    assert.equal(existing.id, testId);

    // 再通过 pdf-from-url 导入同 DOI 的 PDF（显式 doi 带 doi.org 前缀，验证规范化口径一致）
    const response = await fetch(`${base}/api/import/pdf-from-url`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        url: `http://127.0.0.1:${mockPort}/papers/dedupe.pdf`,
        doi: "https://doi.org/10.9999/dedupe-test",
        title: "查重附加不应覆盖已有标题"
      })
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
    // 命中查重：attached:true 且返回的是已有记录（同 id），不是新建记录
    assert.equal(body.attached, true);
    assert.equal(body.paper.id, testId);
    // 仅填空缺字段：已有标题保持不变，PDF 信息写入
    assert.equal(body.paper.title, "已有同 DOI 记录");
    assert.equal(body.paper.localPdf, true);
    assert.match(body.paper.pdfUrl, /^\/api\/pdf\/file\/[a-f0-9-]+\.pdf$/);
    const file = trackPdf(body.paper.pdfUrl);
    assert.ok(file, "pdfUrl 应指向 data/pdfs 下的落盘文件");
    assert.ok(fs.existsSync(file), "PDF 文件应已写入 data/pdfs");
    createdFiles.push(file);

    // 记录总数不变：同 DOI 只有一条记录，且新落盘的 pdfUrl 已写回该记录
    const library = await (await fetch(`${base}/api/library`)).json();
    const sameDoi = library.filter((p) => String(p.doi || "").toLowerCase() === "10.9999/dedupe-test");
    assert.equal(sameDoi.length, 1, "同 DOI 记录应只有一条");
    assert.equal(sameDoi[0].pdfUrl, body.paper.pdfUrl);
  } finally {
    appServer.kill();
    await close(mockServer);
    for (const file of createdFiles) {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    }
    restore();
  }
});
