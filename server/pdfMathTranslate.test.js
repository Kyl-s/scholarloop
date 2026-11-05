import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  pickPdfMathWindowsAsset,
  buildPdfMathPageOrder,
  buildPdfMathWorkWindow,
  buildPdfMathTranslateInvocation,
  cancelPdfMathTranslation,
  clearPdfMathTranslationsForPaper,
  findPdfMathTranslateOutputs,
  hasUsablePdfMathOutput,
  getPdfMathTranslationForPaper,
  getPdfMathTranslationJob,
  getPdfMathTranslateStatus,
  getPdfMathTranslateFile,
  isPdfBuffer,
  pageIsDone,
  pickNextPdfMathPage,
  setPdfMathTranslationPriority,
  startPdfMathTranslation,
  unloadPdfMathTranslationJob
} from "./pdfMathTranslate.js";
import { pdfOutputCopyLines, testSourcePdf, writeMinimalPdf } from "./pdfTestFixtures.js";

const FAKE_PDF = "%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n";
// 真实可解析的最小 PDF：严格回贴校验会调用 PyMuPDF 抽文本，假 PDF 会被判为产物无效。
const SOURCE_PDF_BASE64 = testSourcePdf(4).toString("base64");

test("从发行版资源里挑出 Windows zip", () => {
  const asset = pickPdfMathWindowsAsset([
    { name: "PDFMathTranslate-v2.8.0-src.tar.gz" },
    { name: "PDFMathTranslate-v2.8.0-win64.zip", browser_download_url: "https://example.com/win64.zip" },
    { name: "PDFMathTranslate-v2.8.0-mac.zip" }
  ]);
  assert.equal(asset.name, "PDFMathTranslate-v2.8.0-win64.zip");
});

test("recognizes PDF buffers and rejects non-PDF buffers", () => {
  assert.equal(isPdfBuffer(Buffer.from("%PDF-1.7\n")), true);
  assert.equal(isPdfBuffer(Buffer.from("<html>")), false);
  assert.equal(isPdfBuffer(Buffer.from("")), false);
});

test("finds mono and dual PDFMathTranslate outputs", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scholarloop-pdfmath-"));
  try {
    fs.writeFileSync(path.join(dir, "source.pdf"), FAKE_PDF);
    fs.writeFileSync(path.join(dir, "source-mono.pdf"), FAKE_PDF);
    fs.writeFileSync(path.join(dir, "source-dual.pdf"), FAKE_PDF);
    fs.writeFileSync(path.join(dir, "broken-mono.pdf"), "not a PDF");
    assert.deepEqual(findPdfMathTranslateOutputs(dir), {
      mono: "source-mono.pdf",
      dual: "source-dual.pdf",
      files: ["source-dual.pdf", "source-mono.pdf", "source.pdf"]
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("serves PDFMathTranslate files from the output directory", () => {
  const jobId = "12345678-1234-4234-8234-123456789abc";
  const jobDir = path.join(process.cwd(), "data", "pdf-translations", jobId, "output");
  fs.mkdirSync(jobDir, { recursive: true });
  try {
    const fileName = "source.zh.mono.pdf";
    const expected = path.join(jobDir, fileName);
    fs.writeFileSync(expected, FAKE_PDF);
    const resolved = getPdfMathTranslateFile(jobId, fileName);
    assert.ok(resolved);
    // junction / 真实路径可能不同，比较解析后的真实路径
    assert.equal(fs.realpathSync(resolved), fs.realpathSync(expected));
    fs.writeFileSync(expected, "not a PDF");
    assert.equal(getPdfMathTranslateFile(jobId, fileName), null);
  } finally {
    fs.rmSync(path.dirname(jobDir), { recursive: true, force: true });
  }
});

test("accepts completed page-scoped outputs without whole-document URLs", () => {
  const jobId = "22345678-1234-4234-8234-123456789abc";
  const outputDir = path.join(process.cwd(), "data", "pdf-translations", jobId, "output");
  fs.mkdirSync(outputDir, { recursive: true });
  try {
    fs.writeFileSync(path.join(outputDir, "page-001.zh.mono.pdf"), FAKE_PDF);
    assert.equal(hasUsablePdfMathOutput({
      jobId,
      status: "completed",
      result: { jobId, pages: [] },
      pages: [{ page: 1, status: "completed", monoFile: "page-001.zh.mono.pdf", dualFile: "" }]
    }), true);
    assert.equal(hasUsablePdfMathOutput({
      jobId,
      status: "completed",
      result: null,
      pages: []
    }), false);
  } finally {
    fs.rmSync(path.dirname(outputDir), { recursive: true, force: true });
  }
});
test("builds PDFMathTranslate-next args without legacy flags or API keys", () => {
  const invocation = buildPdfMathTranslateInvocation({
    inputPath: "C:\\job\\source.pdf",
    outputDir: "C:\\job\\output",
    sourceLang: "en",
    targetLang: "zh",
    config: {
      baseUrl: "https://model.example/v1/",
      apiKey: "test-secret",
      model: "test-model"
    }
  });
  const args = invocation.args;
  assert.equal(args[0], "C:\\job\\source.pdf");
  assert.equal(args[args.indexOf("--output") + 1], "C:\\job\\output");
  assert.equal(args[args.indexOf("--lang-in") + 1], "en");
  assert.equal(args[args.indexOf("--lang-out") + 1], "zh");
  assert.ok(args.includes("--openai"));
  assert.equal(args[args.indexOf("--openai-timeout") + 1], "90");
  assert.equal(args[args.indexOf("--qps") + 1], "12");
  assert.equal(args[args.indexOf("--pool-max-workers") + 1], "8");
  assert.ok(args.includes("--no-auto-extract-glossary"));
  assert.ok(args.includes("--skip-scanned-detection"));
  assert.equal(args.includes("--disable-rich-text-translate"), false);
  // 通顺 + 对齐观感
  assert.ok(args.includes("--custom-system-prompt"));
  assert.match(args[args.indexOf("--custom-system-prompt") + 1], /academic translator|学术|Simplified Chinese|简体中文/i);
  assert.equal(args.includes("--primary-font-family"), false);
  assert.equal(args[args.indexOf("--watermark-output-mode") + 1], "no_watermark");
  assert.ok(args.includes("--glossaries"));
  assert.match(args[args.indexOf("--glossaries") + 1], /academic-zh-glossary\.csv$/i);
  assert.ok(args.includes("--formular-char-pattern"));
  assert.equal(args[args.indexOf("--openai-temperature") + 1], "0.1");
  // 默认不发送 temperature，避免兼容接口拒参
  assert.equal(args.includes("--openai-send-temprature"), false);
  assert.match(args[args.indexOf("--custom-system-prompt") + 1], /Output Format|user message/i);
  assert.match(args[args.indexOf("--custom-system-prompt") + 1], /author names|affiliations|laboratory/i);
  assert.match(args[args.indexOf("--custom-system-prompt") + 1], /formulae|equations/i);
  assert.doesNotMatch(args[args.indexOf("--custom-system-prompt") + 1], /JSON array/i);
  assert.doesNotMatch(args[args.indexOf("--custom-system-prompt") + 1], /Output only the translation/i);
  assert.equal(args.some((arg) => ["-o", "-li", "-lo", "-s", "-t", "--config", "--config-file"].includes(arg)), false);
  assert.doesNotMatch(args.join(" "), /test-secret/);
  assert.deepEqual(invocation.env, {
    PDF2ZH_OPENAI_BASE_URL: "https://model.example/v1",
    PDF2ZH_OPENAI_API_KEY: "test-secret",
    PDF2ZH_OPENAI_MODEL: "test-model"
  });
});

test("adds a page selector and only-include-translated-page for progressive page translation", () => {
  const invocation = buildPdfMathTranslateInvocation({
    inputPath: "C:\\job\\source.pdf",
    outputDir: "C:\\job\\page-001\\output",
    sourceLang: "en",
    targetLang: "zh",
    page: 1
  });
  const pagesIdx = invocation.args.indexOf("--pages");
  assert.equal(invocation.args[pagesIdx + 1], "1");
  assert.ok(invocation.args.includes("--only-include-translated-page"));
});

test("merges page context into the custom prompt without changing argv protocol", () => {
  const pageContext = {
    version: "page-context-v1",
    page: 1,
    textLayer: true,
    columns: 2,
    readingOrder: [0],
    regions: [{ kind: "text", order: 0, lineIndexes: [0], confidence: 1 }],
    notes: ""
  };
  const plain = buildPdfMathTranslateInvocation({ inputPath: "source.pdf", outputDir: "out", page: 1 });
  const assisted = buildPdfMathTranslateInvocation({ inputPath: "source.pdf", outputDir: "out", page: 1, pageContext });
  assert.equal(assisted.args.slice(0, 10).join("|"), plain.args.slice(0, 10).join("|"));
  assert.match(assisted.args[assisted.args.indexOf("--custom-system-prompt") + 1], /SCHOLARLOOP PAGE CONTEXT v1/);
  assert.match(assisted.args[assisted.args.indexOf("--custom-system-prompt") + 1], /never output JSON/);
});

test("allows a provider-specific PDFMathTranslate speed profile", () => {
  const invocation = buildPdfMathTranslateInvocation({
    inputPath: "C:\\job\\source.pdf",
    outputDir: "C:\\job\\output",
    config: { baseUrl: "http://model.example", apiKey: "test-secret", model: "test-model", pdfMathQps: 8, pdfMathWorkers: 6 }
  });
  const qpsIndex = invocation.args.indexOf("--qps");
  const workersIndex = invocation.args.indexOf("--pool-max-workers");
  assert.equal(invocation.args[qpsIndex + 1], "8");
  assert.equal(invocation.args[workersIndex + 1], "6");
});

test("orders progressive pages from page one by default or an explicit starting page", () => {
  assert.deepEqual(buildPdfMathPageOrder(5), [1, 2, 3, 4, 5]);
  assert.deepEqual(buildPdfMathPageOrder(0), []);
  // 显式起始页 → 向后 → 再补前面
  assert.deepEqual(buildPdfMathPageOrder(5, 3), [3, 4, 5, 1, 2]);
  assert.deepEqual(buildPdfMathPageOrder(3, 1), [1, 2, 3]);
  assert.deepEqual(buildPdfMathPageOrder(1, 9), [1]);
  assert.deepEqual(buildPdfMathPageOrder(4, 4), [4, 1, 2, 3]);
});

test("retains the legacy work-window helper without limiting the translation queue", () => {
  assert.deepEqual(buildPdfMathWorkWindow(10, 2), [2, 3]);
  assert.deepEqual(buildPdfMathWorkWindow(3, 3), [3]);
  assert.deepEqual(buildPdfMathWorkWindow(5, 1), [1, 2]);
});

test("legacy reading-window jobs now continue sequentially and never redo completed pages", () => {
  const job = {
    pageCount: 4,
    priorityPage: 2,
    translateMode: "reading-window",
    pages: [
      { page: 1, status: "queued", monoFile: "", dualFile: "" },
      { page: 2, status: "queued", monoFile: "", dualFile: "" },
      { page: 3, status: "completed", monoFile: "page-003.zh.mono.pdf", dualFile: "" },
      { page: 4, status: "queued", monoFile: "", dualFile: "" }
    ]
  };
  const next = pickNextPdfMathPage(job);
  assert.equal(next.page, 2);
  assert.equal(next.status, "running");
  assert.equal(job.pages[1].status, "running");

  // 旧窗口完成后继续第 4 页，再回到第 1 页，不等待浏览翻页。
  job.pages[1] = { page: 2, status: "completed", monoFile: "page-002.zh.mono.pdf", dualFile: "" };
  job.pages[2] = { page: 3, status: "completed", monoFile: "page-003.zh.mono.pdf", dualFile: "" };
  assert.equal(pickNextPdfMathPage(job).page, 4);
  job.pages[3] = { page: 4, status: "completed", monoFile: "page-004.zh.mono.pdf", dualFile: "" };
  assert.equal(pickNextPdfMathPage(job).page, 1);
  job.pages[0] = { page: 1, status: "completed", monoFile: "page-001.zh.mono.pdf", dualFile: "" };

  // 已有产物的页即使 status 被弄脏也绝不重译
  job.priorityPage = 2;
  job.pages[1] = { page: 2, status: "queued", monoFile: "page-002.zh.mono.pdf", dualFile: "" };
  assert.equal(pickNextPdfMathPage(job), null);
  assert.equal(job.pages[1].status, "completed");

  // running 页即使残留文件名也不算就绪
  job.pages[1] = { page: 2, status: "running", monoFile: "page-002.zh.mono.pdf", dualFile: "" };
  assert.equal(pageIsDone(job.pages[1]), false);
  assert.equal(pickNextPdfMathPage(job), null);
});

test("default queue starts at page one and resumes in order while skipping existing output", () => {
  const job = {
    pageCount: 5,
    pages: Array.from({ length: 5 }, (_, index) => ({ page: index + 1, status: "queued", monoFile: "", dualFile: "" }))
  };
  const first = pickNextPdfMathPage(job);
  assert.equal(first.page, 1);
  Object.assign(first, { status: "completed", monoFile: "page-001.zh.mono.pdf" });
  // 模拟续译：中间一页已完成，另一页已有产物但状态残留。
  Object.assign(job.pages[2], { status: "completed", monoFile: "page-003.zh.mono.pdf" });
  Object.assign(job.pages[3], { status: "queued", monoFile: "page-004.zh.mono.pdf" });
  const resumed = [];
  for (let page = pickNextPdfMathPage(job); page; page = pickNextPdfMathPage(job)) {
    resumed.push(page.page);
    Object.assign(page, { status: "completed", monoFile: `page-${page.page}.zh.mono.pdf` });
  }
  assert.deepEqual(resumed, [2, 5]);
  assert.equal(job.pages[3].status, "completed");
});

test("all-remaining mode continues incomplete pages and skips completed ones", () => {
  const job = {
    pageCount: 4,
    priorityPage: 2,
    translateMode: "all-remaining",
    pages: [
      { page: 1, status: "queued", monoFile: "", dualFile: "" },
      { page: 2, status: "completed", monoFile: "page-002.zh.mono.pdf", dualFile: "" },
      { page: 3, status: "queued", monoFile: "", dualFile: "" },
      { page: 4, status: "queued", monoFile: "", dualFile: "" }
    ]
  };
  // 从第 2 页起：2 已完成 → 先 3，再 4，再回 1
  const first = pickNextPdfMathPage(job);
  assert.equal(first.page, 3);
  job.pages[2] = { page: 3, status: "completed", monoFile: "page-003.zh.mono.pdf", dualFile: "" };
  const second = pickNextPdfMathPage(job);
  assert.equal(second.page, 4);
  job.pages[3] = { page: 4, status: "completed", monoFile: "page-004.zh.mono.pdf", dualFile: "" };
  const third = pickNextPdfMathPage(job);
  assert.equal(third.page, 1);
  Object.assign(third, { status: "completed", monoFile: "page-001.zh.mono.pdf" });
  assert.equal(pickNextPdfMathPage(job), null);
});

test("can skip dual PDF generation for faster mono-only output", () => {
  const invocation = buildPdfMathTranslateInvocation({
    inputPath: "C:\\job\\source.pdf",
    outputDir: "C:\\job\\output",
    config: { baseUrl: "http://model.example", apiKey: "test-secret", model: "test-model", pdfMathNoDual: true }
  });
  assert.equal(invocation.args.includes("--no-dual"), true);
});

test("reports a missing optional engine without exposing credentials", () => {
  const status = getPdfMathTranslateStatus("C:\\missing\\pdf2zh.exe");
  assert.equal(status.available, false);
  assert.equal(status.command, "");
  assert.match(status.installHint, /PDFMathTranslate/);
  assert.doesNotMatch(JSON.stringify(status), /api[_-]?key|secret/i);
});

test("runs a layout translation as a pollable job and exposes its result", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scholarloop-pdfmath-command-"));
  const command = path.join(dir, process.platform === "win32" ? "fake-pdfmath.cmd" : "fake-pdfmath");
  const script = process.platform === "win32"
    ? [
      "@echo off",
      "set \"OUT=%~3\"",
      "if not exist \"%OUT%\" mkdir \"%OUT%\"",
      "> \"%OUT%\\source.zh.mono.pdf\" echo %%PDF-1.4",
      ">> \"%OUT%\\source.zh.mono.pdf\" echo %%EOF",
      "exit /b 0",
      ""
    ].join("\r\n")
    : "#!/bin/sh\nmkdir -p \"$3\"\nprintf '%s\\n' '%PDF-1.4' '%%EOF' > \"$3/source.zh.mono.pdf\"\n";
  fs.writeFileSync(command, script, { mode: 0o755 });
  const started = startPdfMathTranslation({
    data: SOURCE_PDF_BASE64,
    binary: command,
    config: { baseUrl: "http://127.0.0.1:1", apiKey: "test-secret", model: "test-model" }
  });
  let job = started;
  for (let attempt = 0; attempt < 40 && !["completed", "failed", "canceled"].includes(job.status); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    job = getPdfMathTranslationJob(started.jobId);
  }
  try {
    assert.equal(job.status, "completed", job.error || job.progress);
    assert.equal(job.result.monoFile, "source.zh.mono.pdf");
    const outputFile = getPdfMathTranslateFile(started.jobId, "source.zh.mono.pdf");
    assert.ok(outputFile && fs.existsSync(outputFile));
  } finally {
    fs.rmSync(path.join(process.cwd(), "data", "pdf-translations", started.jobId), { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("marks a page failed when the translated PDF cannot be text-extracted", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scholarloop-pdfmath-invalid-output-"));
  const command = path.join(dir, process.platform === "win32" ? "invalid-pdfmath.cmd" : "invalid-pdfmath");
  fs.writeFileSync(command, process.platform === "win32"
    ? [
      "@echo off",
      "set \"OUT=%~3\"",
      "if not exist \"%OUT%\" mkdir \"%OUT%\"",
      "> \"%OUT%\\source.zh.mono.pdf\" echo %%PDF-1.4",
      ">> \"%OUT%\\source.zh.mono.pdf\" echo %%EOF",
      "exit /b 0",
      ""
    ].join("\r\n")
    : "#!/bin/sh\nmkdir -p \"$3\"\nprintf '%s\\n' '%PDF-1.4' '%%EOF' > \"$3/source.zh.mono.pdf\"\n",
  { mode: 0o755 });
  const started = startPdfMathTranslation({
    data: SOURCE_PDF_BASE64,
    binary: command,
    pageCount: 2,
    progressive: true,
    priorityPage: 1,
    config: { baseUrl: "http://127.0.0.1:1", apiKey: "test-secret", model: "test-model" }
  });
  let job = started;
  for (let attempt = 0; attempt < 80 && !["completed", "failed", "canceled", "partial"].includes(job.status); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    job = getPdfMathTranslationJob(started.jobId);
  }
  try {
    // 单页失败不再拖垮整本：任务停在 partial，失败原因保留在页级状态，用户可继续重试。
    assert.equal(job.status, "partial", job.progress);
    assert.equal(job.pages[0].status, "failed");
    assert.match(job.pages[0].error, /回贴\/最终文本抽取失败/);
    assert.equal(job.incompletePages.length, 2);
  } finally {
    fs.rmSync(path.join(process.cwd(), "data", "pdf-translations", started.jobId), { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("continues with later pages after a single page fails", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scholarloop-pdfmath-skip-failed-"));
  const command = path.join(dir, process.platform === "win32" ? "skip-failed.cmd" : "skip-failed");
  const outputPdf = writeMinimalPdf(path.join(dir, "translated.pdf"), { pages: 1, text: "Hello" });
  const script = process.platform === "win32"
    ? [
      "@echo off",
      "set \"OUT=%~3\"",
      "echo %~3 | findstr /i \"page-001\" >nul && exit /b 1",
      "if not exist \"%OUT%\" mkdir \"%OUT%\"",
      ...pdfOutputCopyLines(outputPdf),
      "exit /b 0",
      ""
    ].join("\r\n")
    : `#!/bin/sh\ncase "$3" in *page-001*) exit 1;; esac\nmkdir -p "$3"\n${pdfOutputCopyLines(outputPdf).join("\n")}\n`;
  fs.writeFileSync(command, script, { mode: 0o755 });
  const started = startPdfMathTranslation({
    data: SOURCE_PDF_BASE64,
    binary: command,
    pageCount: 3,
    progressive: true,
    config: { baseUrl: "http://127.0.0.1:1", apiKey: "test-secret", model: "test-model" }
  });
  let job = started;
  for (let attempt = 0; attempt < 120 && !["completed", "failed", "canceled", "partial"].includes(job.status); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    job = getPdfMathTranslationJob(started.jobId);
  }
  try {
    assert.equal(job.status, "partial", job.progress);
    assert.equal(job.pages[0].status, "failed");
    assert.equal(job.pages[1].status, "completed");
    assert.equal(job.pages[2].status, "completed");
    assert.equal(job.completedPages, 2);
    assert.deepEqual(job.incompletePages.map((page) => page.page), [1]);
    assert.match(job.pages[0].error, /退出码 1/);
  } finally {
    fs.rmSync(path.join(process.cwd(), "data", "pdf-translations", started.jobId), { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("stops after three consecutive page failures instead of burning the rest of the document", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scholarloop-pdfmath-consecutive-failures-"));
  const command = path.join(dir, process.platform === "win32" ? "consecutive-failed.cmd" : "consecutive-failed");
  const outputPdf = writeMinimalPdf(path.join(dir, "translated.pdf"), { pages: 1, text: "Hello" });
  const script = process.platform === "win32"
    ? [
      "@echo off",
      "set \"OUT=%~3\"",
      "echo %~3 | findstr /i \"page-001 page-002 page-003\" >nul && exit /b 1",
      "if not exist \"%OUT%\" mkdir \"%OUT%\"",
      ...pdfOutputCopyLines(outputPdf),
      "exit /b 0",
      ""
    ].join("\r\n")
    : `#!/bin/sh\ncase "$3" in *page-001*|*page-002*|*page-003*) exit 1;; esac\nmkdir -p "$3"\n${pdfOutputCopyLines(outputPdf).join("\n")}\n`;
  fs.writeFileSync(command, script, { mode: 0o755 });
  const started = startPdfMathTranslation({
    data: SOURCE_PDF_BASE64,
    binary: command,
    pageCount: 4,
    progressive: true,
    config: { baseUrl: "http://127.0.0.1:1", apiKey: "test-secret", model: "test-model" }
  });
  let job = started;
  for (let attempt = 0; attempt < 120 && !["completed", "failed", "canceled", "partial"].includes(job.status); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    job = getPdfMathTranslationJob(started.jobId);
  }
  try {
    assert.equal(job.status, "partial", job.progress);
    assert.deepEqual(job.pages.slice(0, 3).map((page) => page.status), ["failed", "failed", "failed"]);
    // 第 4 页不应在连续 3 页失败后再被认领。
    assert.equal(job.pages[3].status, "queued");
    assert.equal(job.pages[3].monoFile, "");
    assert.match(job.progress, /连续 3 页翻译失败/);
  } finally {
    fs.rmSync(path.join(process.cwd(), "data", "pdf-translations", started.jobId), { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("cancels a running layout translation job", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scholarloop-pdfmath-cancel-"));
  const command = path.join(dir, process.platform === "win32" ? "slow-pdfmath.cmd" : "slow-pdfmath");
  const script = process.platform === "win32"
    ? "@echo off\r\nping 127.0.0.1 -n 30 >nul\r\n"
    : "#!/bin/sh\nsleep 30\n";
  fs.writeFileSync(command, script, { mode: 0o755 });
  const started = startPdfMathTranslation({
    data: SOURCE_PDF_BASE64,
    binary: command,
    config: { baseUrl: "http://127.0.0.1:1", apiKey: "test-secret", model: "test-model" }
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  cancelPdfMathTranslation(started.jobId);
  let job = getPdfMathTranslationJob(started.jobId);
  for (let attempt = 0; attempt < 60 && !["completed", "failed", "canceled"].includes(job.status); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    job = getPdfMathTranslationJob(started.jobId);
  }
  try {
    assert.equal(job.status, "canceled");
  } finally {
    fs.rmSync(path.join(process.cwd(), "data", "pdf-translations", started.jobId), { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("publishes the first completed page while later pages are still running", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scholarloop-pdfmath-progressive-"));
  const command = path.join(dir, process.platform === "win32" ? "fake-progressive-pdfmath.cmd" : "fake-progressive-pdfmath");
  const outputPdf = writeMinimalPdf(path.join(dir, "translated.pdf"), { pages: 1, text: "Hello" });
  const script = process.platform === "win32"
    ? [
      "@echo off",
      "set \"OUT=%~3\"",
      "echo %~3 | findstr /i \"page-002\" >nul && ping 127.0.0.1 -n 16 >nul",
      ...pdfOutputCopyLines(outputPdf),
      "exit /b 0",
      ""
    ].join("\r\n")
    : `#!/bin/sh\ncase "$3" in *page-002*) sleep 8;; esac\n${pdfOutputCopyLines(outputPdf).join("\n")}\n`;
  fs.writeFileSync(command, script, { mode: 0o755 });
  const started = startPdfMathTranslation({
    data: SOURCE_PDF_BASE64,
    binary: command,
    pageCount: 2,
    progressive: true,
    config: { baseUrl: "http://127.0.0.1:1", apiKey: "test-secret", model: "test-model" }
  });
  let job = started;
  for (let attempt = 0; attempt < 80 && job.completedPages < 1; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    job = getPdfMathTranslationJob(started.jobId);
  }
  try {
    assert.equal(job.completedPages, 1, job.error || job.progress);
    assert.equal(job.status, "running");
    assert.equal(job.pages[0].status, "completed");
    assert.equal(job.pages[1].status, "running");
    assert.match(job.pages[0].monoFile, /^page-001\.zh\.mono\.pdf$/);
    assert.ok(getPdfMathTranslateFile(started.jobId, job.pages[0].monoFile));
  } finally {
    cancelPdfMathTranslation(started.jobId);
    for (let attempt = 0; attempt < 40; attempt += 1) {
      job = getPdfMathTranslationJob(started.jobId);
      if (job.status === "canceled") break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    fs.rmSync(path.join(process.cwd(), "data", "pdf-translations", started.jobId), { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("progressive jobs finish the whole queue in default or explicit starting-page order", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scholarloop-pdfmath-order-"));
  try {
    for (const priorityPage of [undefined, 3]) {
      const orderFile = path.join(dir, `order-${priorityPage || "default"}.txt`);
      const command = path.join(dir, process.platform === "win32" ? "ordered.cmd" : "ordered");
      const outputPdf = writeMinimalPdf(path.join(dir, `translated-${priorityPage || "default"}.pdf`), { pages: 1, text: "Hello" });
      fs.writeFileSync(command, process.platform === "win32"
        ? [
          "@echo off",
          `>> "${orderFile}" echo %~3`,
          "set \"OUT=%~3\"",
          ...pdfOutputCopyLines(outputPdf),
          "exit /b 0", ""
        ].join("\r\n")
        : `#!/bin/sh\nprintf '%s\\n' "$3" >> '${orderFile}'\n${pdfOutputCopyLines(outputPdf).join("\n")}\n`,
      { mode: 0o755 });
      const started = startPdfMathTranslation({
        data: SOURCE_PDF_BASE64,
        binary: command,
        pageCount: 4,
        ...(priorityPage === undefined ? {} : { priorityPage }),
        config: { baseUrl: "http://127.0.0.1:1", apiKey: "test-secret", model: "test-model" }
      });
      let job = started;
      try {
        for (let attempt = 0; attempt < 200 && !["completed", "failed", "canceled"].includes(job.status); attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 50));
          job = getPdfMathTranslationJob(started.jobId);
        }
        assert.equal(job.status, "completed", job.error || job.progress);
        assert.equal(job.completedPages, 4);
        assert.equal(job.priorityPage, priorityPage || 1);
        assert.equal(job.translateMode, "all-remaining");
        const order = [...fs.readFileSync(orderFile, "utf8").matchAll(/page-(\d+)/g)].map((match) => Number(match[1]));
        assert.deepEqual(order, priorityPage ? [3, 4, 1, 2] : [1, 2, 3, 4]);
      } finally {
        if (!["completed", "failed", "canceled"].includes(job.status)) cancelPdfMathTranslation(started.jobId);
        fs.rmSync(path.join(process.cwd(), "data", "pdf-translations", started.jobId), { recursive: true, force: true });
      }
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("translates progressive PDF pages serially by default", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scholarloop-pdfmath-serial-"));
  const command = path.join(dir, process.platform === "win32" ? "fake-serial-pdfmath.cmd" : "fake-serial-pdfmath");
  const outputPdf = writeMinimalPdf(path.join(dir, "translated.pdf"), { pages: 1, text: "Hello" });
  const script = process.platform === "win32"
    ? [
      "@echo off",
      "set \"OUT=%~3\"",
      "echo %~3 | findstr /i \"page-002\" >nul && ping 127.0.0.1 -n 8 >nul",
      ...pdfOutputCopyLines(outputPdf),
      "exit /b 0",
      ""
    ].join("\r\n")
    : `#!/bin/sh\ncase "$3" in *page-002*) sleep 5;; esac\n${pdfOutputCopyLines(outputPdf).join("\n")}\n`;
  fs.writeFileSync(command, script, { mode: 0o755 });
  const started = startPdfMathTranslation({
    data: SOURCE_PDF_BASE64,
    binary: command,
    pageCount: 3,
    progressive: true,
    // 默认串行：即使显式写 1 也只做当前页
    config: { baseUrl: "http://127.0.0.1:1", apiKey: "test-secret", model: "test-model", pdfMathPageWorkers: 1 }
  });
  let job = started;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    job = getPdfMathTranslationJob(started.jobId);
    if (job.pages[0].status === "completed" && job.pages[1].status === "running") break;
  }
  try {
    assert.equal(job.pages[0].status, "completed", job.error || job.progress);
    assert.equal(job.pages[1].status, "running", job.error || job.progress);
    assert.equal(job.pages[2].status, "queued", "串行时第 3 页应等待第 2 页完成");
  } finally {
    cancelPdfMathTranslation(started.jobId);
    for (let attempt = 0; attempt < 80; attempt += 1) {
      job = getPdfMathTranslationJob(started.jobId);
      if (["completed", "failed", "canceled"].includes(job.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    fs.rmSync(path.join(process.cwd(), "data", "pdf-translations", started.jobId), { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("reprioritizes a running progressive job to the current reading page", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scholarloop-pdfmath-priority-"));
  const command = path.join(dir, process.platform === "win32" ? "fake-priority-pdfmath.cmd" : "fake-priority-pdfmath");
  const outputPdf = writeMinimalPdf(path.join(dir, "translated.pdf"), { pages: 1, text: "Hello" });
  const script = process.platform === "win32"
    ? [
      "@echo off",
      "set \"OUT=%~3\"",
      "echo %~3 | findstr /i \"page-001\" >nul && ping 127.0.0.1 -n 20 >nul",
      ...pdfOutputCopyLines(outputPdf),
      "exit /b 0",
      ""
    ].join("\r\n")
    : `#!/bin/sh\ncase "$3" in *page-001*) sleep 20;; esac\n${pdfOutputCopyLines(outputPdf).join("\n")}\n`;
  fs.writeFileSync(command, script, { mode: 0o755 });
  const started = startPdfMathTranslation({
    data: SOURCE_PDF_BASE64,
    binary: command,
    pageCount: 3,
    progressive: true,
    priorityPage: 1,
    config: { baseUrl: "http://127.0.0.1:1", apiKey: "test-secret", model: "test-model", pdfMathPageWorkers: 1 }
  });
  let job = started;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    job = getPdfMathTranslationJob(started.jobId);
    if (job.pages[0].status === "running") break;
  }
  try {
    assert.equal(job.pages[0].status, "running", job.error || job.progress);
    setPdfMathTranslationPriority(started.jobId, 3);
    for (let attempt = 0; attempt < 120; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      job = getPdfMathTranslationJob(started.jobId);
      if (job.pages[2].status === "completed" || job.pages[2].status === "running") break;
    }
    assert.equal(job.priorityPage, 3);
    // 抢占后应优先处理第 3 页；第 1 页被让出后回到排队
    assert.ok(
      job.pages[2].status === "running" || job.pages[2].status === "completed",
      `expected page 3 active, got ${job.pages.map((p) => p.status).join(",")}: ${job.progress}`
    );
    assert.notEqual(job.pages[0].status, "running", "第 1 页应被抢占让出");
  } finally {
    cancelPdfMathTranslation(started.jobId);
    for (let attempt = 0; attempt < 120; attempt += 1) {
      job = getPdfMathTranslationJob(started.jobId);
      if (["completed", "failed", "canceled"].includes(job?.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    // Windows 下子进程句柄可能短暂占用目录，重试删除
    const jobDir = path.join(process.cwd(), "data", "pdf-translations", started.jobId);
    for (let attempt = 0; attempt < 10; attempt += 1) {
      try {
        fs.rmSync(jobDir, { recursive: true, force: true });
        fs.rmSync(dir, { recursive: true, force: true });
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  }
});

test("persists layout translation job and restores after memory clear", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scholarloop-pdfmath-persist-"));
  const command = path.join(dir, process.platform === "win32" ? "fake-persist-pdfmath.cmd" : "fake-persist-pdfmath");
  const outputPdf = writeMinimalPdf(path.join(dir, "translated.pdf"), { pages: 1, text: "Hello" });
  const script = process.platform === "win32"
    ? [
      "@echo off",
      "set \"OUT=%~3\"",
      ...pdfOutputCopyLines(outputPdf),
      "exit /b 0",
      ""
    ].join("\r\n")
    : `#!/bin/sh\n${pdfOutputCopyLines(outputPdf).join("\n")}\n`;
  fs.writeFileSync(command, script, { mode: 0o755 });
  const paperId = "manual:persist-layout-test";
  let differentModelJob = null;
  let assistedJob = null;
  const started = startPdfMathTranslation({
    data: SOURCE_PDF_BASE64,
    binary: command,
    pageCount: 1,
    progressive: false,
    paperId,
    config: { baseUrl: "http://127.0.0.1:1", apiKey: "test-secret", model: "test-model" }
  });
  let job = started;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    job = getPdfMathTranslationJob(started.jobId);
    if (job?.status === "completed" || job?.status === "failed") break;
  }
  try {
    assert.equal(job.status, "completed", job.error || job.progress);
    const snapshot = path.join(process.cwd(), "data", "pdf-translations", started.jobId, "job.json");
    assert.equal(fs.existsSync(snapshot), true);
    const index = path.join(process.cwd(), "data", "pdf-translations", "by-paper", `${encodeURIComponent(paperId)}.json`);
    assert.equal(fs.existsSync(index), true);

    // 模拟服务重启：清空内存 Map 后仍可从 job.json 恢复
    unloadPdfMathTranslationJob(started.jobId);
    const restored = getPdfMathTranslationJob(started.jobId);
    assert.equal(restored?.jobId, started.jobId);
    assert.equal(restored?.status, "completed");
    assert.equal(restored?.paperId, paperId);
    assert.ok(restored?.result?.monoFile || restored?.result?.dualFile);

    const byPaper = getPdfMathTranslationForPaper(paperId);
    assert.equal(byPaper?.jobId, started.jobId);

    // 相同 paper + 相同 PDF 再次提交应复用，不新建 job
    const reused = startPdfMathTranslation({
      data: SOURCE_PDF_BASE64,
      binary: command,
      pageCount: 1,
      progressive: false,
      paperId,
      config: { baseUrl: "http://127.0.0.1:1", apiKey: "test-secret", model: "test-model" }
    });
    assert.equal(reused.jobId, started.jobId);
    assert.equal(reused.status, "completed");

    // 普通与页面图片辅助模式必须各自复用自己的任务，不能互相覆盖索引。
    assistedJob = startPdfMathTranslation({
      data: SOURCE_PDF_BASE64,
      binary: command,
      pageCount: 1,
      progressive: true,
      paperId,
      layoutAssist: { enabled: true },
      layoutAssistDeps: {
        renderer: async (_input, page) => ({
          page,
          textLayer: true,
          image: "data:image/png;base64,AA==",
          lines: [{ text: "Title", left: 1, top: 2 }]
        }),
        vision: async () => ({
          version: "page-context-v1",
          page: 1,
          textLayer: true,
          columns: 1,
          readingOrder: [0],
          regions: [{ kind: "text", order: 0, lineIndexes: [0], confidence: 1 }],
          notes: ""
        })
      },
      config: { baseUrl: "http://127.0.0.1:1", apiKey: "test-secret", model: "test-model" }
    });
    let assistedStatus = getPdfMathTranslationJob(assistedJob.jobId);
    for (let attempt = 0; attempt < 100 && !["completed", "failed", "canceled"].includes(assistedStatus.status); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      assistedStatus = getPdfMathTranslationJob(assistedJob.jobId);
    }
    assert.equal(assistedStatus.status, "completed", assistedStatus.error || assistedStatus.progress);
    assert.notEqual(assistedJob.jobId, started.jobId);

    const normalAfterAssisted = startPdfMathTranslation({
      data: SOURCE_PDF_BASE64,
      binary: command,
      pageCount: 1,
      progressive: false,
      paperId,
      config: { baseUrl: "http://127.0.0.1:1", apiKey: "test-secret", model: "test-model" }
    });
    assert.equal(normalAfterAssisted.jobId, started.jobId);
    assert.equal(normalAfterAssisted.layoutAssist.enabled, false);
    const assistedByPaper = getPdfMathTranslationForPaper(paperId, {
      sourceSha256: started.sourceSha256,
      layoutAssist: true,
      model: "test-model",
      baseUrl: "http://127.0.0.1:1"
    });
    assert.equal(assistedByPaper?.jobId, assistedJob.jobId);
    assert.equal(getPdfMathTranslationForPaper(paperId, {
      sourceSha256: "different-source",
      layoutAssist: true,
      model: "test-model",
      baseUrl: "http://127.0.0.1:1"
    }), null);

    // 兼容旧版只保存最新 jobId 的索引：扫描同 paper 的 job.json 后仍能找回辅助任务。
    const paperIndex = path.join(process.cwd(), "data", "pdf-translations", "by-paper", `${encodeURIComponent(paperId)}.json`);
    fs.writeFileSync(paperIndex, JSON.stringify({ paperId, jobId: assistedJob.jobId }));
    unloadPdfMathTranslationJob(started.jobId);
    unloadPdfMathTranslationJob(assistedJob.jobId);
    const restoredLegacyAssisted = getPdfMathTranslationForPaper(paperId, {
      sourceSha256: started.sourceSha256,
      layoutAssist: true,
      model: "test-model",
      baseUrl: "http://127.0.0.1:1"
    });
    assert.equal(restoredLegacyAssisted?.jobId, assistedJob.jobId);

    // 同一 paper / PDF 但模型变化时必须创建新的任务身份，不能复用旧产物。
    differentModelJob = startPdfMathTranslation({
      data: SOURCE_PDF_BASE64,
      binary: command,
      pageCount: 1,
      progressive: false,
      paperId,
      config: { baseUrl: "http://127.0.0.1:1", apiKey: "test-secret", model: "different-model" }
    });
    assert.notEqual(differentModelJob.jobId, started.jobId);
    assert.notEqual(differentModelJob.identityHash, started.identityHash);
    assert.equal(differentModelJob.identity.model, "different-model");
    let differentStatus = getPdfMathTranslationJob(differentModelJob.jobId);
    for (let attempt = 0; attempt < 80 && !["completed", "failed", "canceled"].includes(differentStatus.status); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      differentStatus = getPdfMathTranslationJob(differentModelJob.jobId);
    }
    assert.equal(differentStatus.status, "completed", differentStatus.error || differentStatus.progress);
    await clearPdfMathTranslationsForPaper(paperId);
    assert.equal(getPdfMathTranslationForPaper(paperId), null);
  } finally {
    fs.rmSync(path.join(process.cwd(), "data", "pdf-translations", started.jobId), { recursive: true, force: true });
    if (assistedJob) fs.rmSync(path.join(process.cwd(), "data", "pdf-translations", assistedJob.jobId), { recursive: true, force: true });
    if (differentModelJob) fs.rmSync(path.join(process.cwd(), "data", "pdf-translations", differentModelJob.jobId), { recursive: true, force: true });
    fs.rmSync(path.join(process.cwd(), "data", "pdf-translations", "by-paper", `${encodeURIComponent(paperId)}.json`), { force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("成功视觉辅助会把页面语境送入 PDFMathTranslate 调用", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scholarloop-pdfmath-visual-success-"));
  const command = path.join(dir, process.platform === "win32" ? "fake-visual-success.cmd" : "fake-visual-success");
  const capture = path.join(dir, "argv.txt");
  const captureForBatch = capture.replace(/%/g, "%%");
  const outputPdf = writeMinimalPdf(path.join(dir, "translated.pdf"), { pages: 1, text: "Hello" });
  const script = process.platform === "win32"
    ? [
      "@echo off",
      "set \"OUT=%~3\"",
      "set \"HAS_PROMPT=0\"",
      "set \"HAS_CONTEXT=0\"",
      "echo %* | findstr /c:\"SCHOLARLOOP\" >nul && set \"HAS_CONTEXT=1\"",
      ":scan",
      "if \"%~1\"==\"\" goto done",
      "if \"%~1\"==\"--custom-system-prompt\" set \"HAS_PROMPT=1\"",
      "echo %~1 | findstr /c:\"SCHOLARLOOP\" >nul && set \"HAS_CONTEXT=1\"",
      "shift",
      "goto scan",
      ":done",
      `> \"${captureForBatch}\" echo prompt=%HAS_PROMPT%;context=%HAS_CONTEXT%`,
      ...pdfOutputCopyLines(outputPdf),
      "exit /b 0",
      ""
    ].join("\r\n")
    : `#!/bin/sh\nprintf '%s\\n' "$@" > '${capture.replace(/'/g, "'\\''")}'\n${pdfOutputCopyLines(outputPdf).join("\n")}\n`;
  fs.writeFileSync(command, script, { mode: 0o755 });
  const pageContext = {
    version: "page-context-v1",
    page: 1,
    textLayer: true,
    columns: 1,
    readingOrder: [0],
    regions: [{ kind: "text", order: 0, lineIndexes: [0], confidence: 1 }],
    notes: ""
  };
  const started = startPdfMathTranslation({
    data: SOURCE_PDF_BASE64,
    binary: command,
    pageCount: 1,
    progressive: true,
    layoutAssist: { enabled: true },
    layoutAssistDeps: {
      renderer: async (_input, page, { signal } = {}) => ({
        page,
        textLayer: true,
        image: "data:image/png;base64,AA==",
        lines: [{ text: "Title", left: 1, top: 2 }],
        signal
      }),
      vision: async ({ signal }) => {
        assert.ok(signal, "视觉请求应携带 AbortSignal");
        return pageContext;
      }
    },
    config: { baseUrl: "http://127.0.0.1:1", apiKey: "test-secret", model: "vision-translation-test" }
  });
  let job = started;
  for (let attempt = 0; attempt < 80 && !["completed", "failed", "canceled"].includes(job.status); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    job = getPdfMathTranslationJob(started.jobId);
  }
  try {
    assert.equal(job.status, "completed", job.error || job.progress);
    assert.equal(job.pages[0].assist.status, "ready");
    const captured = fs.readFileSync(capture, "utf8");
    if (process.platform === "win32") {
      assert.match(captured, /prompt=1/);
    } else {
      assert.match(captured, /--custom-system-prompt/);
      assert.match(captured, /SCHOLARLOOP PAGE CONTEXT v1/);
    }
  } finally {
    fs.rmSync(path.join(process.cwd(), "data", "pdf-translations", started.jobId), { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("视觉准备阶段取消时不启动 PDFMathTranslate", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scholarloop-pdfmath-visual-cancel-"));
  const command = path.join(dir, process.platform === "win32" ? "fake-visual-cancel.cmd" : "fake-visual-cancel");
  const script = process.platform === "win32"
    ? "@echo off\r\nexit /b 17\r\n"
    : "#!/bin/sh\nexit 17\n";
  fs.writeFileSync(command, script, { mode: 0o755 });
  let visionStarted;
  const startedPromise = new Promise((resolve) => { visionStarted = resolve; });
  const started = startPdfMathTranslation({
    data: SOURCE_PDF_BASE64,
    binary: command,
    pageCount: 1,
    progressive: true,
    layoutAssist: { enabled: true },
    layoutAssistDeps: {
      renderer: () => ({ textLayer: true, image: "data:image/png;base64,AA==", lines: [{ text: "Title" }] }),
      vision: ({ signal }) => new Promise((_resolve, reject) => {
        visionStarted();
        signal.addEventListener("abort", () => reject(new Error("vision aborted")), { once: true });
      })
    },
    config: { baseUrl: "http://127.0.0.1:1", apiKey: "test-secret", model: "cancel-vision-test" }
  });
  try {
    await startedPromise;
    assert.equal(getPdfMathTranslationJob(started.jobId).activePage, 1);
    cancelPdfMathTranslation(started.jobId);
    let job = getPdfMathTranslationJob(started.jobId);
    for (let attempt = 0; attempt < 60 && job.status !== "canceled"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      job = getPdfMathTranslationJob(started.jobId);
    }
    assert.equal(job.status, "canceled", job.error || job.progress);
    assert.equal(job.pages[0].status, "canceled");
    assert.equal(job.pages[0].assist.status, "canceled");
    assert.equal(job.pages[0].assist.context, null);
    assert.equal(job.activePage, 0);
  } finally {
    fs.rmSync(path.join(process.cwd(), "data", "pdf-translations", started.jobId), { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("视觉准备阶段显式抢占后优先翻译指定页并续译被让出的页面", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scholarloop-pdfmath-visual-preempt-"));
  const command = path.join(dir, process.platform === "win32" ? "fake-visual-preempt.cmd" : "fake-visual-preempt");
  const outputPdf = writeMinimalPdf(path.join(dir, "translated.pdf"), { pages: 1, text: "Hello" });
  const script = process.platform === "win32"
    ? ["@echo off", "set \"OUT=%~3\"", ...pdfOutputCopyLines(outputPdf), "exit /b 0", ""].join("\r\n")
    : `#!/bin/sh\n${pdfOutputCopyLines(outputPdf).join("\n")}\n`;
  fs.writeFileSync(command, script, { mode: 0o755 });
  let firstVisionStarted;
  let visionCalls = 0;
  const visionPages = [];
  const firstStarted = new Promise((resolve) => { firstVisionStarted = resolve; });
  const makeContext = (page) => ({ version: "page-context-v1", page, textLayer: true, columns: 1, readingOrder: [0], regions: [{ kind: "text", order: 0, lineIndexes: [0], confidence: 1 }], notes: "" });
  const started = startPdfMathTranslation({
    data: SOURCE_PDF_BASE64,
    binary: command,
    pageCount: 2,
    progressive: true,
    priorityPage: 1,
    layoutAssist: { enabled: true },
    layoutAssistDeps: {
      renderer: () => ({ textLayer: true, image: "data:image/png;base64,AA==", lines: [{ text: "Title" }] }),
      vision: ({ page, signal }) => {
        visionCalls += 1;
        visionPages.push(page);
        if (visionCalls === 1) {
          firstVisionStarted();
          return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("vision preempted")), { once: true }));
        }
        return Promise.resolve(makeContext(page));
      }
    },
    config: { baseUrl: "http://127.0.0.1:1", apiKey: "test-secret", model: "preempt-vision-test" }
  });
  try {
    await firstStarted;
    setPdfMathTranslationPriority(started.jobId, 2);
    let job = getPdfMathTranslationJob(started.jobId);
    for (let attempt = 0; attempt < 100 && !["completed", "failed", "canceled"].includes(job.status); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      job = getPdfMathTranslationJob(started.jobId);
    }
    assert.equal(job.status, "completed", job.error || job.progress);
    assert.deepEqual(visionPages, [1, 2, 1]);
    assert.equal(job.pages[0].status, "completed");
    assert.equal(job.pages[1].status, "completed", job.error || job.progress);
  } finally {
    cancelPdfMathTranslation(started.jobId);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (["completed", "failed", "canceled"].includes(getPdfMathTranslationJob(started.jobId)?.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    fs.rmSync(path.join(process.cwd(), "data", "pdf-translations", started.jobId), { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("视觉辅助失败时标记本页 fallback 且不阻塞普通翻译", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scholarloop-pdfmath-visual-fallback-"));
  const command = path.join(dir, process.platform === "win32" ? "fake-visual-fallback.cmd" : "fake-visual-fallback");
  const outputPdf = writeMinimalPdf(path.join(dir, "translated.pdf"), { pages: 1, text: "Hello" });
  const script = process.platform === "win32"
    ? [
      "@echo off",
      "set \"OUT=%~3\"",
      ...pdfOutputCopyLines(outputPdf),
      "exit /b 0",
      ""
    ].join("\r\n")
    : `#!/bin/sh\n${pdfOutputCopyLines(outputPdf).join("\n")}\n`;
  fs.writeFileSync(command, script, { mode: 0o755 });
  const started = startPdfMathTranslation({
    data: SOURCE_PDF_BASE64,
    binary: command,
    pageCount: 1,
    progressive: true,
    layoutAssist: { enabled: true, mode: "page-context-v1", failurePolicy: "fallback" },
    layoutAssistDeps: {
      renderer: () => ({ textLayer: true, image: "data:image/png;base64,AA==", lines: [{ text: "Title" }] }),
      vision: () => {
        const error = new Error("provider secret-detail must not be persisted");
        error.code = "VISION_UNSUPPORTED";
        throw error;
      }
    },
    config: { baseUrl: "http://127.0.0.1:1", apiKey: "test-secret", model: "test-model" }
  });
  let job = started;
  for (let attempt = 0; attempt < 80 && !["completed", "failed", "canceled"].includes(job.status); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    job = getPdfMathTranslationJob(started.jobId);
  }
  try {
    assert.equal(job.status, "completed", job.error || job.progress);
    assert.equal(job.layoutAssist.enabled, true);
    assert.equal(job.layoutAssist.status, "degraded");
    assert.equal(job.pages[0].assist.status, "fallback");
    assert.equal(job.pages[0].assist.errorCode, "VISION_UNSUPPORTED");
    assert.match(job.pages[0].assist.error, /不支持图片输入/);
    assert.ok(job.pages[0].monoFile);
    const snapshot = fs.readFileSync(path.join(process.cwd(), "data", "pdf-translations", started.jobId, "job.json"), "utf8");
    assert.doesNotMatch(snapshot, /test-secret|data:image|provider secret-detail/i);
  } finally {
    fs.rmSync(path.join(process.cwd(), "data", "pdf-translations", started.jobId), { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
