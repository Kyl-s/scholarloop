import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  cancelPdfMathTranslation,
  buildAssistLineTexts,
  collectVisionEquationGroups,
  createPdfMathTranslationIdentity,
  getPdfMathTranslationJob,
  getPdfMathTranslateStatus,
  planPdfMathPageAutoRetry,
  settlePdfMathJobCompletion,
  startPdfMathTranslation,
  unloadPdfMathTranslationJob
} from "./pdfMathTranslate.js";

const JOBS_DIR = path.join(process.cwd(), "data", "pdf-translations");
const FAKE_PDF = "%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n";
const SOURCE = Buffer.from("%PDF-1.7\nsource\n%%EOF\n");
const CONFIG = { baseUrl: "http://127.0.0.1:1", apiKey: "test-secret", model: "test-model" };

function sourceSha256(buffer = SOURCE) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function createJobDir(jobId) {
  const dir = path.join(JOBS_DIR, jobId);
  fs.mkdirSync(path.join(dir, "output"), { recursive: true });
  return dir;
}

function writeJobSnapshot(jobId, job) {
  const dir = createJobDir(jobId);
  fs.writeFileSync(path.join(dir, "job.json"), JSON.stringify(job, null, 2));
  return dir;
}

function writeSleepCommand(dir) {
  const command = path.join(dir, process.platform === "win32" ? "slow-pdfmath.cmd" : "slow-pdfmath");
  fs.writeFileSync(
    command,
    process.platform === "win32" ? "@echo off\r\nping 127.0.0.1 -n 8 >nul\r\n" : "#!/bin/sh\nsleep 5\n",
    { mode: 0o755 }
  );
  return command;
}

async function waitForTerminal(jobId, attempts = 120) {
  let job = getPdfMathTranslationJob(jobId);
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (!job || ["completed", "failed", "canceled", "partial"].includes(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 25));
    job = getPdfMathTranslationJob(jobId);
  }
  return job;
}

function cleanup(jobIds) {
  for (const jobId of jobIds) {
    if (!jobId) continue;
    try {
      unloadPdfMathTranslationJob(jobId);
      fs.rmSync(path.join(JOBS_DIR, jobId), { recursive: true, force: true });
    } catch {
      /* 清理失败不影响断言结果 */
    }
  }
}

test("视觉 equation 回贴行文本可从 rendered.lines 重建（重启后 assistLineTexts 为空也能恢复）", () => {
  const context = {
    version: "page-context-v1",
    page: 1,
    textLayer: true,
    columns: 1,
    readingOrder: [0, 1],
    regions: [
      { kind: "text", order: 0, lineIndexes: [0], confidence: 0.98 },
      { kind: "equation", order: 1, lineIndexes: [1], confidence: 0.96 }
    ],
    notes: ""
  };
  const rendered = { lines: [{ text: "where the gain is" }, { text: "" }, { text: "E = mc^2" }] };
  // 重启后只恢复了 context，assistLineTexts 不在 job.json 里：必须先重建再取分组。
  assert.deepEqual(collectVisionEquationGroups({ assist: { context } }), []);
  assert.deepEqual(
    collectVisionEquationGroups({ assist: { context }, assistLineTexts: buildAssistLineTexts(rendered) }),
    [["E = mc^2"]]
  );
});

test("历史 completed job 仍有 queued 页时恢复为 partial 并列出缺口", () => {
  const jobId = crypto.randomUUID();
  const dir = createJobDir(jobId);
  try {
    fs.writeFileSync(path.join(dir, "source.pdf"), SOURCE);
    fs.writeFileSync(path.join(dir, "output", "page-001.zh.mono.pdf"), FAKE_PDF);
    fs.writeFileSync(path.join(dir, "output", "page-002.zh.mono.pdf"), FAKE_PDF);
    fs.writeFileSync(path.join(dir, "job.json"), JSON.stringify({
      jobId,
      paperId: "",
      status: "completed",
      progress: "全部版式译文已完成",
      pageCount: 4,
      completedPages: 4,
      layoutAssist: { enabled: false },
      sourceLang: "en",
      targetLang: "zh",
      pages: [
        { page: 1, status: "completed", monoFile: "page-001.zh.mono.pdf", dualFile: "" },
        { page: 2, status: "completed", monoFile: "page-002.zh.mono.pdf", dualFile: "" },
        { page: 3, status: "queued", progress: "等待处理", monoFile: "", dualFile: "" },
        { page: 4, status: "queued", progress: "等待处理", monoFile: "", dualFile: "" }
      ]
    }, null, 2));

    const restored = getPdfMathTranslationJob(jobId);
    assert.equal(restored.status, "partial");
    assert.equal(restored.completedPages, 2);
    assert.deepEqual(restored.incompletePages.map((page) => page.page), [3, 4]);
    assert.match(restored.progress, /2 \/ 4/);
    assert.match(restored.progress, /第 3、4 页/);

    // 纠正后的状态必须回写 job.json，不能只在内存里正确。
    const snapshot = JSON.parse(fs.readFileSync(path.join(dir, "job.json"), "utf8"));
    assert.equal(snapshot.status, "partial");
    assert.equal(snapshot.completedPages, 2);
  } finally {
    cleanup([jobId]);
  }
});

test("settlePdfMathJobCompletion 不会把含未完成页的任务标成 completed", () => {
  const jobId = crypto.randomUUID();
  const dir = createJobDir(jobId);
  try {
    fs.writeFileSync(path.join(dir, "output", "page-001.zh.mono.pdf"), FAKE_PDF);
    const job = {
      jobId,
      status: "completed",
      pageCount: 2,
      completedPages: 2,
      pages: [
        { page: 1, status: "completed", monoFile: "page-001.zh.mono.pdf", dualFile: "" },
        { page: 2, status: "queued", progress: "等待处理", monoFile: "", dualFile: "" }
      ]
    };
    settlePdfMathJobCompletion(job);
    assert.equal(job.status, "partial");
    assert.equal(job.completedPages, 1);
    assert.deepEqual(job.incompletePages.map((page) => page.page), [2]);
  } finally {
    cleanup([jobId]);
  }
});

test("自动重试只针对真实漏译，latex/overlap/outOfBounds 不重排队", () => {
  const latexOnly = planPdfMathPageAutoRetry({
    layoutIssues: { latex: [{ kind: "latex" }], overlap: [{ kind: "overlap" }], outOfBounds: [{ kind: "outOfBounds" }] },
    untranslatedClusters: 3
  });
  assert.equal(latexOnly.retry, false);

  const untranslated = planPdfMathPageAutoRetry({
    layoutIssues: { untranslated: [{ kind: "untranslated" }] },
    untranslatedClusters: 2
  });
  assert.equal(untranslated.retry, true);
  assert.match(untranslated.reasons.join("、"), /未翻译/);

  const alreadyRetried = planPdfMathPageAutoRetry({
    layoutIssues: { untranslated: [{ kind: "untranslated" }] },
    untranslatedClusters: 2,
    retriedOnce: true
  });
  assert.equal(alreadyRetried.retry, false);
  assert.deepEqual(alreadyRetried.reasons, []);
});

test("任务身份包含术语表内容指纹，关闭术语表时为空", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scholarloop-pdfmath-glossary-"));
  const executable = path.join(dir, process.platform === "win32" ? "pdf2zh.exe" : "pdf2zh");
  fs.writeFileSync(executable, "fixture", { mode: 0o755 });
  try {
    const identity = createPdfMathTranslationIdentity({
      config: CONFIG,
      sourceSha256: "source",
      layoutAssist: { enabled: false },
      binary: executable
    });
    assert.match(identity.identity.termGlossaryHash, /^[0-9a-f]{64}$/);
    assert.equal(identity.identity.termGlossaryHash, getPdfMathTranslateStatus(executable).glossaryHash);

    const withoutGlossary = createPdfMathTranslationIdentity({
      config: { ...CONFIG, pdfMathNoGlossary: true },
      sourceSha256: "source",
      layoutAssist: { enabled: false },
      binary: executable
    });
    assert.equal(withoutGlossary.identity.termGlossaryHash, "");
    assert.notEqual(withoutGlossary.identityHash, identity.identityHash);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("旧 job 缺少 termGlossaryHash 时不再续译旧页，自动开新任务并给出原因", async () => {
  const oldJobId = crypto.randomUUID();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scholarloop-pdfmath-stale-"));
  const command = writeSleepCommand(dir);
  let newJobId = "";
  try {
    const jobDir = createJobDir(oldJobId);
    fs.writeFileSync(path.join(jobDir, "source.pdf"), SOURCE);
    fs.writeFileSync(path.join(jobDir, "output", "page-001.zh.mono.pdf"), FAKE_PDF);
    fs.writeFileSync(path.join(jobDir, "job.json"), JSON.stringify({
      jobId: oldJobId,
      paperId: "",
      status: "completed",
      pageCount: 2,
      completedPages: 2,
      sourceSha256: sourceSha256(),
      sourceLang: "en",
      targetLang: "zh",
      layoutAssist: { enabled: false },
      identity: { model: "test-model", baseUrl: CONFIG.baseUrl },
      identityHash: "legacy-without-glossary",
      pages: [
        { page: 1, status: "completed", monoFile: "page-001.zh.mono.pdf", dualFile: "" },
        { page: 2, status: "queued", progress: "等待处理", monoFile: "", dualFile: "" }
      ]
    }, null, 2));

    const started = startPdfMathTranslation({
      data: SOURCE.toString("base64"),
      binary: command,
      pageCount: 2,
      progressive: true,
      jobId: oldJobId,
      config: CONFIG,
      layoutAssist: { enabled: false }
    });
    newJobId = started.jobId;
    assert.notEqual(started.jobId, oldJobId);
    assert.equal(started.staleReason, "terminology-updated");
    assert.equal(started.supersededJobId, oldJobId);
    assert.equal(started.identity.termGlossaryHash, getPdfMathTranslateStatus(command).glossaryHash);

    // 旧任务保持可读，但被纠正为 partial（1 页完成 / 2 页），不会被新任务覆盖。
    const oldJob = getPdfMathTranslationJob(oldJobId);
    assert.equal(oldJob.status, "partial");
    assert.equal(oldJob.completedPages, 1);
    assert.deepEqual(oldJob.incompletePages.map((page) => page.page), [2]);
    assert.equal(fs.existsSync(path.join(JOBS_DIR, oldJobId, "output", "page-001.zh.mono.pdf")), true);
  } finally {
    if (newJobId) cancelPdfMathTranslation(newJobId);
    if (newJobId) await waitForTerminal(newJobId);
    cleanup([newJobId, oldJobId]);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("partial 旧 job 在身份匹配时继续原任务而不是新建", async () => {
  const jobId = crypto.randomUUID();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scholarloop-pdfmath-resume-"));
  const command = writeSleepCommand(dir);
  try {
    const jobDir = createJobDir(jobId);
    fs.writeFileSync(path.join(jobDir, "source.pdf"), SOURCE);
    fs.writeFileSync(path.join(jobDir, "output", "page-001.zh.mono.pdf"), FAKE_PDF);
    const identity = createPdfMathTranslationIdentity({
      config: CONFIG,
      sourceSha256: sourceSha256(),
      layoutAssist: { enabled: false },
      binary: command
    });
    fs.writeFileSync(path.join(jobDir, "job.json"), JSON.stringify({
      jobId,
      paperId: "",
      status: "partial",
      progress: "已完成 1 / 2 页，仍有 1 页未完成",
      pageCount: 2,
      completedPages: 1,
      sourceSha256: sourceSha256(),
      sourceLang: "en",
      targetLang: "zh",
      layoutAssist: { enabled: false },
      ...identity,
      pages: [
        { page: 1, status: "completed", monoFile: "page-001.zh.mono.pdf", dualFile: "" },
        { page: 2, status: "queued", progress: "等待处理", monoFile: "", dualFile: "" }
      ]
    }, null, 2));

    const resumed = startPdfMathTranslation({
      data: SOURCE.toString("base64"),
      binary: command,
      pageCount: 2,
      progressive: true,
      priorityPage: 1,
      jobId,
      config: CONFIG,
      layoutAssist: { enabled: false }
    });
    assert.equal(resumed.jobId, jobId);
    assert.equal(resumed.staleReason, "");
    assert.ok(["queued", "running"].includes(resumed.status), resumed.status);
    assert.equal(resumed.pages.find((page) => page.page === 2).status !== "completed", true);
  } finally {
    cancelPdfMathTranslation(jobId);
    await waitForTerminal(jobId);
    cleanup([jobId]);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
