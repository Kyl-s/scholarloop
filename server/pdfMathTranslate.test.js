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
  findPdfMathTranslateOutputs,
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
    fs.writeFileSync(path.join(dir, "source.pdf"), "%PDF-1.7");
    fs.writeFileSync(path.join(dir, "source-mono.pdf"), "%PDF-1.7");
    fs.writeFileSync(path.join(dir, "source-dual.pdf"), "%PDF-1.7");
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
    fs.writeFileSync(expected, "%PDF-1.7");
    const resolved = getPdfMathTranslateFile(jobId, fileName);
    assert.ok(resolved);
    // junction / 真实路径可能不同，比较解析后的真实路径
    assert.equal(fs.realpathSync(resolved), fs.realpathSync(expected));
  } finally {
    fs.rmSync(path.dirname(jobDir), { recursive: true, force: true });
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
  assert.equal(args[args.indexOf("--openai-timeout") + 1], "45");
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

test("orders progressive pages in reading order from the current page", () => {
  // 当前页 → 向后 → 再补前面（兼容/展示用）
  assert.deepEqual(buildPdfMathPageOrder(5, 3), [3, 4, 5, 1, 2]);
  assert.deepEqual(buildPdfMathPageOrder(3, 1), [1, 2, 3]);
  assert.deepEqual(buildPdfMathPageOrder(1, 9), [1]);
  assert.deepEqual(buildPdfMathPageOrder(4, 4), [4, 1, 2, 3]);
});

test("work window is only current page plus next-page prefetch", () => {
  assert.deepEqual(buildPdfMathWorkWindow(10, 2), [2, 3]);
  assert.deepEqual(buildPdfMathWorkWindow(3, 3), [3]);
  assert.deepEqual(buildPdfMathWorkWindow(5, 1), [1, 2]);
});

test("picks only within the reading window and never redoes completed pages", () => {
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

  // 当前页+下一页都完成后，不应再去抢第 4 页
  job.pages[1] = { page: 2, status: "completed", monoFile: "page-002.zh.mono.pdf", dualFile: "" };
  job.pages[2] = { page: 3, status: "completed", monoFile: "page-003.zh.mono.pdf", dualFile: "" };
  assert.equal(pickNextPdfMathPage(job), null);

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
      "> \"%OUT%\\source.zh.mono.pdf\" echo fake-pdf",
      "exit /b 0",
      ""
    ].join("\r\n")
    : "#!/bin/sh\nexit 0\n";
  fs.writeFileSync(command, script, { mode: 0o755 });
  const started = startPdfMathTranslation({
    data: Buffer.from("%PDF-1.7\n").toString("base64"),
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

test("cancels a running layout translation job", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scholarloop-pdfmath-cancel-"));
  const command = path.join(dir, process.platform === "win32" ? "slow-pdfmath.cmd" : "slow-pdfmath");
  const script = process.platform === "win32"
    ? "@echo off\r\nping 127.0.0.1 -n 30 >nul\r\n"
    : "#!/bin/sh\nsleep 30\n";
  fs.writeFileSync(command, script, { mode: 0o755 });
  const started = startPdfMathTranslation({
    data: Buffer.from("%PDF-1.7\n").toString("base64"),
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
  const script = process.platform === "win32"
    ? [
      "@echo off",
      "set \"OUT=%~3\"",
      "echo %~3 | findstr /i \"page-002\" >nul && ping 127.0.0.1 -n 16 >nul",
      "if not exist \"%OUT%\" mkdir \"%OUT%\"",
      "> \"%OUT%\\source.zh.mono.pdf\" echo fake-pdf",
      "exit /b 0",
      ""
    ].join("\r\n")
    : "#!/bin/sh\nmkdir -p \"$3\"\nprintf 'fake-pdf\\n' > \"$3/source.zh.mono.pdf\"\n";
  fs.writeFileSync(command, script, { mode: 0o755 });
  const started = startPdfMathTranslation({
    data: Buffer.from("%PDF-1.7\n").toString("base64"),
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

test("translates progressive PDF pages serially by default", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scholarloop-pdfmath-serial-"));
  const command = path.join(dir, process.platform === "win32" ? "fake-serial-pdfmath.cmd" : "fake-serial-pdfmath");
  const script = process.platform === "win32"
    ? [
      "@echo off",
      "set \"OUT=%~3\"",
      "echo %~3 | findstr /i \"page-002\" >nul && ping 127.0.0.1 -n 8 >nul",
      "if not exist \"%OUT%\" mkdir \"%OUT%\"",
      "> \"%OUT%\\source.zh.mono.pdf\" echo fake-pdf",
      "exit /b 0",
      ""
    ].join("\r\n")
    : "#!/bin/sh\ncase \"$3\" in *page-002*) sleep 10;; esac\nmkdir -p \"$3\"\nprintf 'fake-pdf\\n' > \"$3/source.zh.mono.pdf\"\n";
  fs.writeFileSync(command, script, { mode: 0o755 });
  const started = startPdfMathTranslation({
    data: Buffer.from("%PDF-1.7\n").toString("base64"),
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
  const script = process.platform === "win32"
    ? [
      "@echo off",
      "set \"OUT=%~3\"",
      "echo %~3 | findstr /i \"page-001\" >nul && ping 127.0.0.1 -n 20 >nul",
      "if not exist \"%OUT%\" mkdir \"%OUT%\"",
      "> \"%OUT%\\source.zh.mono.pdf\" echo fake-pdf",
      "exit /b 0",
      ""
    ].join("\r\n")
    : "#!/bin/sh\ncase \"$3\" in *page-001*) sleep 20;; esac\nmkdir -p \"$3\"\nprintf 'fake-pdf\\n' > \"$3/source.zh.mono.pdf\"\n";
  fs.writeFileSync(command, script, { mode: 0o755 });
  const started = startPdfMathTranslation({
    data: Buffer.from("%PDF-1.7\n").toString("base64"),
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
  const script = process.platform === "win32"
    ? [
      "@echo off",
      "set \"OUT=%~3\"",
      "if not exist \"%OUT%\" mkdir \"%OUT%\"",
      "> \"%OUT%\\source.zh.mono.pdf\" echo fake-pdf",
      "exit /b 0",
      ""
    ].join("\r\n")
    : "#!/bin/sh\nmkdir -p \"$3\"\nprintf 'fake-pdf\\n' > \"$3/source.zh.mono.pdf\"\n";
  fs.writeFileSync(command, script, { mode: 0o755 });
  const paperId = "manual:persist-layout-test";
  const started = startPdfMathTranslation({
    data: Buffer.from("%PDF-1.7\n").toString("base64"),
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
      data: Buffer.from("%PDF-1.7\n").toString("base64"),
      binary: command,
      pageCount: 1,
      progressive: false,
      paperId,
      config: { baseUrl: "http://127.0.0.1:1", apiKey: "test-secret", model: "test-model" }
    });
    assert.equal(reused.jobId, started.jobId);
    assert.equal(reused.status, "completed");
  } finally {
    fs.rmSync(path.join(process.cwd(), "data", "pdf-translations", started.jobId), { recursive: true, force: true });
    fs.rmSync(path.join(process.cwd(), "data", "pdf-translations", "by-paper", `${encodeURIComponent(paperId)}.json`), { force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
