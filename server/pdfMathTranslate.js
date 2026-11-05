import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto, { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  ACADEMIC_ZH_SYSTEM_PROMPT,
  getAcademicGlossaryPath
} from "./translationQuality.js";
import { fetchWithFallback, getProxyUrl } from "./proxy.js";
import { applyPdfMathLlmProxyEnv } from "./pdfMathLlmProxy.js";
import { applyPdf2zhListMarkerPatch } from "./pdfListMarkers.js";
import {
  countUntranslatedClusters,
  restorePreservedPageOutputs
} from "./pdfPreserveRegions.js";
import {
  LAYOUT_QA_KINDS,
  LAYOUT_QA_LABELS,
  detectLayoutIssues,
  mergeLayoutIssues,
  summarizeLayoutIssues
} from "./pdfLayoutQa.js";
import { renderPdfPage, getPdfPageCount } from "./pdfPageRender.js";
import { reviewTranslatedLayout } from "./pdfLayoutReview.js";
import { trySafeLayoutRepair } from "./pdfSafeLayoutRepair.js";
import {
  compileLayoutAssistPrompt,
  createPageAssistState,
  layoutAssistIdentity,
  normalizeLayoutAssist,
  requestPdfVisualContext,
  validatePdfVisualContext
} from "./pdfVisualContext.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const JOBS_DIR = path.join(ROOT, "data", "pdf-translations");
const PAPER_INDEX_DIR = path.join(JOBS_DIR, "by-paper");
const WINDOWS_COMMAND_NAMES = ["pdf2zh.exe", "pdf2zh.cmd", "pdf2zh"];
const POSIX_COMMAND_NAMES = ["pdf2zh"];
const PDF_MATH_JOBS = new Map();
// 单页失败不再直接终止整本翻译；连续失败达到该阈值才视为文档级故障并停止本轮。
const PDF_MATH_MAX_CONSECUTIVE_FAILURES = 3;
const CLEARED_PAPERS = new Set();
const PAPER_GENERATIONS = new Map();
const DELETING_PAPERS = new Set();
const PDF_MATH_RELEASES_API = "https://api.github.com/repos/PDFMathTranslate/PDFMathTranslate-next/releases/latest";
const PDF_MATH_INSTALL_DIR = path.join(ROOT, "tools", "pdf2zh");
const PDF_MATH_INSTALL_TMP = path.join(ROOT, "tmp", "pdf2zh-install");
const pdfMathInstallState = {
  status: "idle",
  progress: "",
  percent: 0,
  error: "",
  version: ""
};
/** 识别公式/符号字符，尽量不译，减少 E1(x,y) 被拆坏 */
const FORMULAR_CHAR_PATTERN = String.raw`^[α-ωΑ-Ωµ∂∇∆∑∏∫≈≠≤≥±×÷√∞°′″∈∉⊂⊃∪∩∧∨¬∀∃∝∼≡≪≫†‡]`;
const PDF2ZH_PARAGRAPH_FINDER = path.join(
  PDF_MATH_INSTALL_DIR,
  "site-packages",
  "babeldoc",
  "format",
  "pdf",
  "document_il",
  "midend",
  "paragraph_finder.py"
);

function ensurePdf2zhListMarkerPatch() {
  try {
    applyPdf2zhListMarkerPatch(PDF2ZH_PARAGRAPH_FINDER);
  } catch {
    /* 本地 pdf2zh 未安装时忽略，翻译启动时会再报安装提示 */
  }
}

function existsFile(value) {
  try {
    return Boolean(value) && fs.statSync(value).isFile();
  } catch {
    return false;
  }
}

function ensureDirectory(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function writeJsonAtomic(file, value) {
  ensureDirectory(path.dirname(file));
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), "utf8");
  fs.renameSync(tmp, file);
}

function cleanPaperId(value) {
  return String(value || "").trim().slice(0, 300);
}

function paperIndexFile(paperId) {
  const safe = encodeURIComponent(cleanPaperId(paperId));
  return safe ? path.join(PAPER_INDEX_DIR, `${safe}.json`) : "";
}

function readPaperIndex(paperId) {
  const file = paperIndexFile(paperId);
  if (!file || !existsFile(file)) return null;
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

function paperIndexJobIds(index) {
  const ids = [];
  if (index?.jobId) ids.push(String(index.jobId));
  for (const item of Array.isArray(index?.jobs) ? index.jobs : []) {
    if (item?.jobId) ids.push(String(item.jobId));
  }
  return [...new Set(ids)];
}

function discoverPaperJobIds(paperId) {
  if (!fs.existsSync(JOBS_DIR)) return [];
  try {
    return fs.readdirSync(JOBS_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name !== "by-paper")
      .map((entry) => {
        const id = entry.name;
        const file = jobSnapshotPath(id);
        if (!existsFile(file)) return "";
        try {
          const raw = JSON.parse(fs.readFileSync(file, "utf8"));
          return raw?.paperId === paperId && raw?.jobId === id ? id : "";
        } catch {
          return "";
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function paperJobIds(paperId, index) {
  return [...new Set([...paperIndexJobIds(index), ...discoverPaperJobIds(paperId)])];
}

function currentPaperGeneration(paperId, index = readPaperIndex(paperId)) {
  const id = cleanPaperId(paperId);
  if (!id) return 0;
  let generation = Number(PAPER_GENERATIONS.get(id) || 0);
  for (const jobId of paperJobIds(id, index)) {
    try {
      const raw = JSON.parse(fs.readFileSync(jobSnapshotPath(jobId), "utf8"));
      if (cleanPaperId(raw?.paperId) === id) generation = Math.max(generation, Number(raw.paperGeneration) || 0);
    } catch {
      // 忽略损坏或已删除的任务快照
    }
  }
  PAPER_GENERATIONS.set(id, generation);
  return generation;
}

function jobSnapshotPath(jobId) {
  return path.join(JOBS_DIR, String(jobId || ""), "job.json");
}

function sha256Buffer(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

/**
 * 术语表内容指纹。术语表更新（例如 52 条扩到 160 条）后必须让旧任务身份失效，
 * 否则续译会一直复用按旧术语表生成的页面。文件很小，按需读取不做缓存，
 * 避免同一进程内替换术语表后仍拿到旧指纹。
 */
function academicGlossarySha256() {
  try {
    const file = getAcademicGlossaryPath();
    if (!existsFile(file)) return "";
    return sha256Buffer(fs.readFileSync(file));
  } catch {
    return "";
  }
}

/** 实际参与翻译时的术语表指纹；显式关闭术语表时为空，表示内容不影响产物 */
function glossaryIdentityHash(config = {}) {
  if (config.pdfMathNoGlossary === true) return "";
  return academicGlossarySha256();
}

function serializableJob(job) {
  return {
    jobId: job.jobId,
    paperId: job.paperId || "",
    status: job.status,
    progress: job.progress || "",
    startedAt: job.startedAt || null,
    updatedAt: job.updatedAt || Date.now(),
    error: job.error || "",
    result: job.result || null,
    pageCount: job.pageCount || 0,
    completedPages: job.completedPages || 0,
    incompletePages: Array.isArray(job.incompletePages) ? job.incompletePages : [],
    priorityPage: job.priorityPage || 1,
    activePage: job.activePage || 0,
    translateMode: job.translateMode === "all-remaining" ? "all-remaining" : "reading-window",
    pages: Array.isArray(job.pages) ? job.pages.map((page) => serializePageState(page, job.layoutAssist)) : [],
    sourceLang: job.sourceLang || "en",
    targetLang: job.targetLang || "zh",
    sourceSha256: job.sourceSha256 || "",
    paperGeneration: Number(job.paperGeneration) || 0,
    layoutAssist: serializeLayoutAssist(job),
    identity: job.identity || null,
    identityHash: job.identityHash || ""
  };
}

function serializePageState(page, layoutAssist) {
  const assist = page?.assist || createPageAssistState(layoutAssist);
  return {
    page: Number(page?.page) || 0,
    status: String(page?.status || "queued"),
    progress: String(page?.progress || ""),
    error: String(page?.error || ""),
    retriedOnce: page?.retriedOnce === true,
    monoFile: String(page?.monoFile || ""),
    dualFile: String(page?.dualFile || ""),
    qualityReview: page?.qualityReview || null,
    layoutQa: page?.layoutQa || null,
    translationIdentity: page?.translationIdentity || null,
    assist: {
      status: String(assist.status || "queued"),
      mode: "page-context-v1",
      error: String(assist.error || ""),
      errorCode: String(assist.errorCode || ""),
      stage: String(assist.stage || ""),
      retryable: assist.retryable === true,
      context: assist.context && typeof assist.context === "object" ? assist.context : null
    }
  };
}

function jobHasUsablePages(job) {
  if (!job) return false;
  if (jobOutputLooksLikePdf(job, job.result?.monoFile) || jobOutputLooksLikePdf(job, job.result?.dualFile)) return true;
  return (job.pages || []).some((page) => page?.status === "completed" && pageHasValidOutput(job, page));
}

export function hasUsablePdfMathOutput(job) {
  return jobHasUsablePages(job);
}
export function getPdfMathCompletedOutputCount(job) {
  if (!job) return 0;
  const completed = (job.pages || []).filter((page) => page.status === "completed" && pageHasValidOutput(job, page)).length;
  if (jobOutputLooksLikePdf(job, job.result?.monoFile) || jobOutputLooksLikePdf(job, job.result?.dualFile)) {
    return Math.max(completed, Number(job.pageCount) || 0);
  }
  return completed;
}

function reusedPageQualityReview() {
  // 复用磁盘产物时没有跑过译后视觉检查，显式标出来，避免和前一次的真实结果混淆。
  return { status: "not-run", issues: [], error: "此页复用已有产物，未做译后视觉检查" };
}

function markReusedPageQualityReview(page) {
  if (!page || page.qualityReview) return;
  page.qualityReview = reusedPageQualityReview();
}

function settleReusedPageState(page) {
  // 磁盘上有合法产物也可能来自「重译失败后保留旧译文」：必须保留失败原因，
  // 不能把它重新包装成「复用产物、未做译后检查」。
  const reason = String(page?.error || "").trim();
  if (reason) {
    if (!page.qualityReview || page.qualityReview.status === "not-run") {
      page.qualityReview = { status: "failed", issues: [], error: reason };
    }
    return;
  }
  markReusedPageQualityReview(page);
}

function tailTextLines(value, maxLines = 200, maxChars = 20000) {
  const text = String(value || "").replace(/\r\n?/g, "\n").trim();
  if (!text) return "";
  const slice = text.split("\n").slice(-maxLines).join("\n");
  return slice.length > maxChars ? slice.slice(-maxChars) : slice;
}

function writePageRunLog(pageDir, attemptId, result) {
  // 诊断日志只是旁路信息：写失败绝不影响翻译主流程。
  try {
    if (!pageDir || !result) return;
    const targetDir = attemptId ? path.join(pageDir, `attempt-${attemptId}`) : pageDir;
    const body = [
      `exitCode=${result.code ?? "unknown"}`,
      `time=${new Date().toISOString()}`,
      "----- stdout (tail 200 lines) -----",
      tailTextLines(result.stdout),
      "----- stderr (tail 200 lines) -----",
      tailTextLines(result.stderr)
    ].join("\n");
    fs.writeFileSync(path.join(targetDir, "run.log"), `${body}\n`, "utf8");
  } catch {
    // 忽略：run.log 仅用于失败诊断
  }
}

function hydratePagesFromOutputDir(job, { skipPage = 0 } = {}) {
  if (!job?.jobId) return job;
  const outputDir = path.join(JOBS_DIR, job.jobId, "output");
  if (!fs.existsSync(outputDir)) return job;
  let files = [];
  try {
    files = fs.readdirSync(outputDir);
  } catch {
    return job;
  }
  const pageMap = new Map((job.pages || []).map((page) => [Number(page.page), { ...page }]));
  for (const page of pageMap.values()) {
    if (page.monoFile && !fileLooksLikePdf(outputFilePath(outputDir, page.monoFile))) page.monoFile = "";
    if (page.dualFile && !fileLooksLikePdf(outputFilePath(outputDir, page.dualFile))) page.dualFile = "";
  }
  if (job.result) {
    if (job.result.monoFile && !fileLooksLikePdf(outputFilePath(outputDir, job.result.monoFile))) job.result.monoFile = "";
    if (job.result.dualFile && !fileLooksLikePdf(outputFilePath(outputDir, job.result.dualFile))) job.result.dualFile = "";
  }
  for (const name of files) {
    const match = String(name).match(/^page-(\d+)\.zh\.(mono|dual)\.pdf$/i);
    if (!match) continue;
    if (!fileLooksLikePdf(outputFilePath(outputDir, name))) continue;
    const page = Number(match[1]);
    if (page === Number(skipPage)) continue;
    const kind = match[2].toLowerCase();
    const current = pageMap.get(page) || {
      page,
      status: "completed",
      progress: "本页排版译文已生成",
      error: "",
      monoFile: "",
      dualFile: ""
    };
    // A page may refer to a newer versioned output. A legacy filename must
    // never silently replace that selected version during restoration.
    const hasSelectedVersion = [current.monoFile, current.dualFile].some((file) => String(file || "").includes(".v-"));
    if (kind === "mono" && !current.monoFile && !hasSelectedVersion) current.monoFile = name;
    if (kind === "dual" && !current.dualFile && !hasSelectedVersion) current.dualFile = name;
    current.status = "completed";
    current.progress = current.progress || "本页排版译文已生成";
    // 保留失败原因（例如重译失败后沿用旧译文），不能因为磁盘上有旧产物就清掉。
    settleReusedPageState(current);
    pageMap.set(page, current);
  }
  for (const page of pageMap.values()) {
    if (Number(page.page) !== Number(skipPage) && pageHasValidOutput(job, page)) {
      page.status = "completed";
      settleReusedPageState(page);
    }
  }
  if (!pageMap.size && (job.result?.monoFile || job.result?.dualFile)) return job;
  if (pageMap.size) {
    job.pages = [...pageMap.values()].sort((a, b) => a.page - b.page);
    job.completedPages = job.pages.filter((page) => page.status === "completed" && pageHasValidOutput(job, page)).length;
    if (!job.pageCount) job.pageCount = job.pages.length;
  }
  return job;
}

function finalizeInterruptedJob(job) {
  if (!job) return null;
  hydratePagesFromOutputDir(job);
  recountCompletedPages(job);
  if (job.status === "completed" && !jobHasUsablePages(job) && (job.result || job.pages?.length)) {
    job.status = "failed";
    job.error = "本地版式译文产物校验失败，请重新开始翻译";
    job.progress = "版式译文产物无效";
  }
  if (["queued", "running", "canceling"].includes(job.status)) {
    if (jobHasUsablePages(job)) {
      for (const page of job.pages || []) {
        if (page.status === "completed" && pageHasValidOutput(job, page)) continue;
        if (pageHasValidOutput(job, page)) {
          page.status = "completed";
          settleReusedPageState(page);
          continue;
        }
        // 服务重启后未完成的页：保留为可续译的 canceled，而不是静默当成已完成。
        page.status = "canceled";
        page.progress = "未完成（服务重启后中断，可继续翻译）";
      }
      recountCompletedPages(job);
      if (jobAllPagesCompleted(job)) {
        job.status = "completed";
        job.progress = `已从本地恢复 ${job.completedPages || 0} 页版式译文`;
        job.error = "";
      } else {
        // 有完成页但仍有缺口：partial + 明确提示，前端可直接继续翻译。
        job.status = "partial";
        markPdfMathJobIncomplete(job, "服务重启后中断，已恢复部分译文");
      }
      job.result = {
        jobId: job.jobId,
        pages: job.pages,
        monoFile: job.result?.monoFile || "",
        dualFile: job.result?.dualFile || "",
        sourceLang: job.sourceLang || "en",
        targetLang: job.targetLang || "zh"
      };
    } else {
      job.status = "failed";
      job.error = "服务重启后任务已中断，请重新开始版式翻译";
      job.progress = "版式翻译已中断";
    }
  } else if (jobHasUsablePages(job) && job.status === "failed") {
    // 保留失败信息，但若已有完成页仍可恢复展示
    job.progress = job.progress || `已从本地恢复 ${job.completedPages || 0} 页版式译文`;
    settlePdfMathJobCompletion(job);
  } else {
    // 历史 job.json 可能把“还有 queued 页”的任务写成 completed：恢复时纠正，绝不静默当完成。
    settlePdfMathJobCompletion(job);
  }
  job.child = null;
  job.children = new Set();
  job.cancelRequested = false;
  return job;
}

function persistJob(job) {
  if (!job?.jobId) return;
  const paperId = cleanPaperId(job.paperId);
  if (paperId && CLEARED_PAPERS.has(paperId)) return;
  if (paperId && Number(job.paperGeneration || 0) !== currentPaperGeneration(paperId)) return;
  try {
    ensureDirectory(path.join(JOBS_DIR, job.jobId));
    writeJsonAtomic(jobSnapshotPath(job.jobId), serializableJob(job));
    if (paperId) {
      const previous = readPaperIndex(paperId);
      const current = {
        paperId,
        jobId: job.jobId,
        status: job.status,
        sourceLang: job.sourceLang || "en",
        targetLang: job.targetLang || "zh",
        sourceSha256: job.sourceSha256 || "",
        paperGeneration: Number(job.paperGeneration) || 0,
        identity: job.identity || null,
        identityHash: job.identityHash || "",
        layoutAssist: job.layoutAssist || { enabled: false },
        updatedAt: job.updatedAt || Date.now()
      };
      const entries = new Map();
      for (const id of paperIndexJobIds(previous)) {
        const entry = (previous?.jobs || []).find((item) => item?.jobId === id)
          || (previous?.jobId === id ? previous : null);
        if (entry?.jobId) entries.set(entry.jobId, entry);
      }
      entries.set(job.jobId, current);
      const jobs = [...entries.values()]
        .sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0))
        .slice(0, 32);
      writeJsonAtomic(paperIndexFile(paperId), {
        paperId,
        // 保留 jobId 作为旧客户端的最新任务兼容字段
        jobId: job.jobId,
        jobs
      });
    }
  } catch {
    // 持久化失败不应中断翻译主流程
  }
}

function touchJob(job, patch = {}, { persist = true, throttleMs = 0 } = {}) {
  if (!job) return job;
  Object.assign(job, patch);
  job.updatedAt = Date.now();
  if (!persist) return job;
  if (throttleMs > 0) {
    const last = Number(job._lastPersistAt) || 0;
    if (job.updatedAt - last < throttleMs) return job;
  }
  job._lastPersistAt = job.updatedAt;
  persistJob(job);
  return job;
}

function loadJobFromDisk(jobId) {
  const id = String(jobId || "").trim();
  if (!/^[a-f0-9-]{20,}$/i.test(id)) return null;
  const file = jobSnapshotPath(id);
  if (!existsFile(file)) {
    // 兼容旧任务：仅有 output 文件时也能提供文件服务，但不恢复任务状态
    return null;
  }
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!raw || typeof raw !== "object" || raw.jobId !== id) return null;
    const job = finalizeInterruptedJob({
      ...raw,
      jobId: id,
      pages: Array.isArray(raw.pages) ? raw.pages.map((page) => ({ ...page })) : [],
      result: raw.result || null
    });
    if (!job) return null;
    PDF_MATH_JOBS.set(id, job);
    persistJob(job);
    return job;
  } catch {
    return null;
  }
}

function resolveJob(jobId) {
  const id = String(jobId || "").trim();
  if (!id) return null;
  return PDF_MATH_JOBS.get(id) || loadJobFromDisk(id);
}

export function getPdfMathTranslationForPaper(paperId, {
  sourceLang = "",
  targetLang = "",
  sourceSha256 = "",
  layoutAssist,
  identityHash = "",
  configFingerprint = "",
  model = "",
  baseUrl = "",
  requireOutput = false
} = {}) {
  const id = cleanPaperId(paperId);
  if (!id) return null;
  const indexPath = paperIndexFile(id);
  if (!existsFile(indexPath) && !discoverPaperJobIds(id).length) return null;
  try {
    const index = readPaperIndex(id);
    const requestedSource = sourceSha256 ? String(sourceSha256).trim() : "";
    const requestedIdentity = identityHash ? String(identityHash).trim() : "";
    const requestedModel = String(model || "").trim();
    const requestedBaseUrl = String(baseUrl || "").trim();
    const jobs = paperJobIds(id, index)
      .map((jobId) => resolveJob(jobId))
      .filter(Boolean)
      .filter((job) => cleanPaperId(job.paperId) === id)
      .filter((job) => Number(job.paperGeneration || 0) === currentPaperGeneration(id, index))
      .filter((job) => !sourceLang || !job.sourceLang || job.sourceLang === normalizeLanguage(sourceLang, job.sourceLang))
      .filter((job) => !targetLang || !job.targetLang || job.targetLang === normalizeLanguage(targetLang, job.targetLang))
      .filter((job) => !requestedSource || job.sourceSha256 === requestedSource)
      .filter((job) => layoutAssist === undefined || (requireOutput
        ? (job.layoutAssist?.enabled === true) === Boolean(layoutAssist)
        : job.layoutAssist?.enabled === Boolean(layoutAssist)))
      .filter((job) => !requestedIdentity || job.identityHash === requestedIdentity)
      .filter((job) => !configFingerprint || job.identity?.configFingerprint === configFingerprint)
      .filter((job) => !requestedModel || String(job.identity?.model || "").trim() === requestedModel)
      .filter((job) => !requestedBaseUrl || normalizeBaseUrl(job.identity?.baseUrl) === normalizeBaseUrl(requestedBaseUrl))
      .filter((job) => !requireOutput || jobHasUsablePages(job))
      .sort((a, b) => (requireOutput ? getPdfMathCompletedOutputCount(b) - getPdfMathCompletedOutputCount(a) : 0)
        || (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0));
    const candidate = jobs[0];
    if (!candidate) return null;
    if (candidate.status === "completed" && !jobHasUsablePages(candidate)) return null;
    return publicPdfMathJob(candidate);
  } catch {
    return null;
  }
}

function expandCandidate(value) {
  const candidate = String(value || "").trim();
  if (!candidate) return [];
  const expanded = candidate.replace(/^~(?=$|[\\/])/, os.homedir());
  return [expanded, path.resolve(ROOT, expanded)];
}

function commandFromPath(candidate, source = "configured") {
  const values = expandCandidate(candidate);
  const file = values.find(existsFile);
  if (!file) return null;
  return {
    command: file,
    argsPrefix: [],
    label: file,
    source
  };
}

function findOnPath() {
  const names = process.platform === "win32" ? WINDOWS_COMMAND_NAMES : POSIX_COMMAND_NAMES;
  const pathEntries = String(process.env.PATH || "").split(path.delimiter).filter(Boolean);
  for (const entry of pathEntries) {
    for (const name of names) {
      const candidate = path.join(entry, name);
      if (existsFile(candidate)) return commandFromPath(candidate, "PATH");
    }
  }
  return null;
}

export function resolvePdfMathTranslateCommand(binary = "") {
  const configured = String(binary || process.env.PDFMATH_TRANSLATE_BIN || "").trim();
  if (configured) {
    return commandFromPath(configured, "configured");
  }

  const bundledCandidates = [
    path.join(ROOT, "tools", "pdf2zh", "pdf2zh.exe"),
    path.join(ROOT, "tools", "pdfmathtranslate", "pdf2zh.exe"),
    path.join(ROOT, "pdf2zh.exe")
  ];
  for (const candidate of bundledCandidates) {
    const bundled = commandFromPath(candidate, "bundled");
    if (bundled) return bundled;
  }
  return findOnPath();
}

export function getPdfMathTranslateStatus(binary = "") {
  const resolved = resolvePdfMathTranslateCommand(binary);
  return {
    available: Boolean(resolved),
    command: resolved?.label || "",
    source: resolved?.source || "",
    // 前端把它并入版式翻译配置指纹：术语表更新后自动与旧任务配置失配。
    glossaryHash: academicGlossarySha256(),
    installHint: "请安装 PDFMathTranslate：可在设置中一键安装官方 Windows 包，或手动指定 pdf2zh.exe。"
  };
}

export function getPdfMathInstallState() {
  return { ...pdfMathInstallState };
}

export function pickPdfMathWindowsAsset(assets = []) {
  const list = Array.isArray(assets) ? assets : [];
  return list.find((asset) => /win64\.zip$/i.test(asset?.name || ""))
    || list.find((asset) => /win.*\.zip$/i.test(asset?.name || ""))
    || null;
}

function setPdfMathInstallState(patch) {
  Object.assign(pdfMathInstallState, patch);
}

function findNamedFile(dir, name) {
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && entry.name.toLowerCase() === name.toLowerCase()) return full;
    }
  }
  return "";
}

function extractZipArchive(zipPath, destDir) {
  if (process.platform === "win32") {
    const script = `Expand-Archive -LiteralPath '${String(zipPath).replace(/'/g, "''")}' -DestinationPath '${String(destDir).replace(/'/g, "''")}' -Force`;
    const result = spawnSync("powershell", ["-NoProfile", "-Command", script], { windowsHide: true, encoding: "utf8" });
    if (result.status !== 0) throw new Error(String(result.stderr || result.stdout || "解压失败").trim());
    return;
  }
  const result = spawnSync("tar", ["-xf", zipPath, "-C", destDir], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(String(result.stderr || result.stdout || "解压失败").trim());
}

export async function installPdfMathTranslate({ proxy } = {}) {
  if (pdfMathInstallState.status === "resolving" || pdfMathInstallState.status === "downloading" || pdfMathInstallState.status === "extracting") {
    return getPdfMathInstallState();
  }

  setPdfMathInstallState({ status: "resolving", progress: "正在查找官方 Windows 包…", percent: 2, error: "", version: "" });
  const proxyUrl = getProxyUrl(proxy);
  const headers = { "User-Agent": "ScholarLoop", Accept: "application/vnd.github+json" };

  try {
    const metaRes = await fetchWithFallback(PDF_MATH_RELEASES_API, { headers }, proxyUrl);
    if (!metaRes.ok) throw new Error(`无法读取 GitHub 发行版（${metaRes.status}）`);
    const release = await metaRes.json();
    const asset = pickPdfMathWindowsAsset(release.assets);
    if (!asset?.browser_download_url) throw new Error("官方发行版里没有 Windows zip");

    fs.rmSync(PDF_MATH_INSTALL_TMP, { recursive: true, force: true });
    fs.mkdirSync(PDF_MATH_INSTALL_TMP, { recursive: true });
    const zipPath = path.join(PDF_MATH_INSTALL_TMP, asset.name || "pdf2zh-win64.zip");
    setPdfMathInstallState({
      status: "downloading",
      progress: `正在下载 ${asset.name}…`,
      percent: 5,
      version: release.tag_name || ""
    });

    const fileRes = await fetchWithFallback(asset.browser_download_url, { headers: { "User-Agent": "ScholarLoop" } }, proxyUrl);
    if (!fileRes.ok || !fileRes.body) throw new Error(`下载失败（${fileRes.status}）`);
    const total = Number(fileRes.headers.get("content-length")) || 0;
    const writer = fs.createWriteStream(zipPath);
    const reader = fileRes.body.getReader();
    let received = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (!writer.write(Buffer.from(value))) {
        await new Promise((resolve) => writer.once("drain", resolve));
      }
      if (total > 0) {
        const downloadedMb = Math.round(received / 1024 / 1024);
        const totalMb = Math.max(1, Math.round(total / 1024 / 1024));
        setPdfMathInstallState({
          percent: Math.min(88, 5 + Math.round((received / total) * 80)),
          progress: `正在下载 ${downloadedMb} / ${totalMb} MB`
        });
      }
    }
    await new Promise((resolve, reject) => {
      writer.end(() => resolve());
      writer.on("error", reject);
    });

    setPdfMathInstallState({ status: "extracting", progress: "正在解压到 tools/pdf2zh…", percent: 90 });
    const extractDir = path.join(PDF_MATH_INSTALL_TMP, "extracted");
    fs.mkdirSync(extractDir, { recursive: true });
    extractZipArchive(zipPath, extractDir);
    const exe = findNamedFile(extractDir, process.platform === "win32" ? "pdf2zh.exe" : "pdf2zh");
    if (!exe) throw new Error("压缩包里没有 pdf2zh 可执行文件");

    const sourceRoot = path.dirname(exe);
    const backupDir = `${PDF_MATH_INSTALL_DIR}.bak`;
    if (fs.existsSync(backupDir)) fs.rmSync(backupDir, { recursive: true, force: true });
    if (fs.existsSync(PDF_MATH_INSTALL_DIR)) fs.renameSync(PDF_MATH_INSTALL_DIR, backupDir);
    fs.mkdirSync(path.dirname(PDF_MATH_INSTALL_DIR), { recursive: true });
    fs.cpSync(sourceRoot, PDF_MATH_INSTALL_DIR, { recursive: true });
    fs.rmSync(backupDir, { recursive: true, force: true });
    fs.rmSync(PDF_MATH_INSTALL_TMP, { recursive: true, force: true });

    const status = getPdfMathTranslateStatus();
    if (!status.available) throw new Error("文件已解压，但未能识别 pdf2zh");
    setPdfMathInstallState({ status: "done", progress: "安装完成", percent: 100, error: "" });
    return { ...getPdfMathInstallState(), ...status };
  } catch (err) {
    setPdfMathInstallState({
      status: "error",
      error: err.message || "安装失败",
      progress: "安装失败"
    });
    throw err;
  }
}

export function isPdfBuffer(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length >= 5 && buffer.subarray(0, 5).toString("latin1") === "%PDF-";
}

export function findPdfMathTranslateOutputs(outputDir) {
  const files = fs.readdirSync(outputDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.pdf$/i.test(entry.name))
    .filter((entry) => fileLooksLikePdf(outputFilePath(outputDir, entry.name)))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
  const source = files.find((name) => /^source\.pdf$/i.test(name));
  const translated = files.filter((name) => name !== source);
  const byName = (pattern) => translated.find((name) => pattern.test(name));
  const mono = byName(/(?:-|_)mono\.pdf$/i) || translated.find((name) => /mono/i.test(name));
  const dual = byName(/(?:-|_)dual\.pdf$/i) || translated.find((name) => /dual|bilingual/i.test(name));
  return {
    mono: mono || translated[0] || "",
    dual: dual || translated.find((name) => name !== mono) || translated[0] || "",
    files
  };
}

function normalizeLanguage(value, fallback) {
  const normalized = String(value || fallback).trim().toLowerCase();
  return /^[a-z]{2,8}(?:-[a-z]{2,8})?$/.test(normalized) ? normalized : fallback;
}

function normalizeBaseUrl(value) {
  const input = String(value || "").trim().replace(/\/+$/, "");
  if (!input) return "";
  try {
    const url = new URL(input);
    url.protocol = url.protocol.toLowerCase();
    url.hostname = url.hostname.toLowerCase();
    if ((url.protocol === "https:" && url.port === "443") || (url.protocol === "http:" && url.port === "80")) {
      url.port = "";
    }
    url.pathname = url.pathname.replace(/\/+$/, "");
    return url.toString().replace(/\/+$/, "");
  } catch {
    return input.toLowerCase();
  }
}

function normalizeProvider(config = {}) {
  return String(config.provider || config.providerName || config.name || "").trim().toLowerCase();
}

function pdfMathConfigFingerprint(config = {}) {
  const value = {
    provider: normalizeProvider(config),
    baseUrl: normalizeBaseUrl(config.baseUrl),
    model: String(config.model || "").trim(),
    systemPrompt: String(config.pdfMathSystemPrompt || "").trim(),
    fontFamily: String(config.pdfMathFontFamily || "").trim(),
    noDual: config.pdfMathNoDual === true,
    noGlossary: config.pdfMathNoGlossary === true,
    disableRichText: config.pdfMathDisableRichText === true,
    sendTemperature: config.pdfMathSendTemperature === true,
    qps: config.pdfMathQps ?? "",
    workers: config.pdfMathWorkers ?? "",
    pageWorkers: config.pdfMathPageWorkers ?? "",
    binary: String(config.pdfMathBinary || "").trim(),
    termGlossaryHash: glossaryIdentityHash(config)
  };
  return sha256Buffer(Buffer.from(JSON.stringify(value), "utf8"));
}

function executableIdentity(resolved) {
  const command = String(resolved?.command || "").trim();
  let stat = null;
  try {
    const info = fs.statSync(command);
    stat = { size: Number(info.size) || 0, mtimeMs: Math.round(Number(info.mtimeMs) || 0) };
  } catch {
    stat = null;
  }
  return {
    source: String(resolved?.source || ""),
    commandHash: command
      ? sha256Buffer(Buffer.from(process.platform === "win32" ? path.resolve(command).toLowerCase() : path.resolve(command), "utf8"))
      : "",
    stat,
    argsPrefix: Array.isArray(resolved?.argsPrefix) ? resolved.argsPrefix.map((arg) => String(arg)) : []
  };
}

export function createPdfMathTranslationIdentity({ config = {}, sourceLang = "en", targetLang = "zh", sourceSha256 = "", layoutAssist, binary = "", resolved, configFingerprint = "" } = {}) {
  const actualResolved = resolved === undefined ? resolvePdfMathTranslateCommand(binary) : resolved;
  const baseSystemPrompt = String(config.pdfMathSystemPrompt || ACADEMIC_ZH_SYSTEM_PROMPT).trim();
  const speed = getPdfMathSpeedOptions(config);
  const identity = {
    version: "pdf-math-job-identity-v1",
    pipelineVersion: "pdf-preserve-safe-v2",
    provider: normalizeProvider(config),
    baseUrl: normalizeBaseUrl(config.baseUrl),
    model: String(config.model || "").trim(),
    sourceLang: normalizeLanguage(sourceLang, "en"),
    targetLang: normalizeLanguage(targetLang, "zh"),
    sourceSha256: String(sourceSha256 || "").trim(),
    termGlossaryHash: glossaryIdentityHash(config),
    pdfMathSystemPromptHash: sha256Buffer(Buffer.from(baseSystemPrompt, "utf8")),
    layoutAssist: layoutAssistIdentity(layoutAssist),
    output: {
      fontFamily: String(config.pdfMathFontFamily || "").trim(),
      noDual: config.pdfMathNoDual === true || process.env.PDFMATH_TRANSLATE_NO_DUAL === "1",
      noGlossary: config.pdfMathNoGlossary === true,
      disableRichText: config.pdfMathDisableRichText === true || process.env.PDFMATH_DISABLE_RICH_TEXT === "1",
      sendTemperature: config.pdfMathSendTemperature === true || process.env.PDFMATH_SEND_TEMPERATURE === "1",
      qps: speed.qps,
      workers: speed.workers,
      pageWorkers: getPdfMathPageWorkers(config)
    },
    engine: executableIdentity(actualResolved)
  };
  identity.configFingerprint = String(configFingerprint || pdfMathConfigFingerprint(config)).trim();
  return {
    identity,
    identityHash: sha256Buffer(Buffer.from(JSON.stringify(identity), "utf8"))
  };
}

function jobIdentityMatches(job, requested) {
  return Boolean(
    job?.identityHash
    && job?.identity
    && requested?.identityHash
    && job.identityHash === requested.identityHash
    && JSON.stringify(job.identity) === JSON.stringify(requested.identity)
  );
}

/** 旧任务快照可能没有 termGlossaryHash：无法证明它用的是当前术语表，按不一致处理 */
function jobTermGlossaryHash(job) {
  const value = job?.identity?.termGlossaryHash;
  return typeof value === "string" ? value.trim() : "";
}

/**
 * 带 jobId 续译时，术语表变化必须让旧任务失效。
 * 返回空字符串表示可以复用；否则返回给前端的明确原因。
 */
function jobGlossaryStaleReason(job, requestedIdentity) {
  const expected = String(requestedIdentity?.identity?.termGlossaryHash || "").trim();
  if (!expected) return "";
  return jobTermGlossaryHash(job) === expected ? "" : "terminology-updated";
}

function boundedPositiveInt(value, fallback, maximum = 16) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(maximum, Math.max(1, Math.round(parsed)));
}

// 单页内全力：提高 qps / pool workers；页与页之间默认串行（阅读顺序）
const DEFAULT_PDFMATH_QPS = 12;
const DEFAULT_PDFMATH_WORKERS = 8;
// 翻译策略：同一时刻只做 1 页，按固定起始页顺序推进，不跟随阅读翻页。
const DEFAULT_PDFMATH_PAGE_WORKERS = 1;
const MAX_PDFMATH_PAGE_WORKERS = 1;

function getPdfMathSpeedOptions(config = {}) {
  return {
    qps: boundedPositiveInt(config.pdfMathQps || process.env.PDFMATH_TRANSLATE_QPS, DEFAULT_PDFMATH_QPS),
    workers: boundedPositiveInt(config.pdfMathWorkers || process.env.PDFMATH_TRANSLATE_WORKERS, DEFAULT_PDFMATH_WORKERS)
  };
}

function getPdfMathPageWorkers(config = {}) {
  return boundedPositiveInt(
    config.pdfMathPageWorkers || process.env.PDFMATH_TRANSLATE_PAGE_WORKERS,
    DEFAULT_PDFMATH_PAGE_WORKERS,
    MAX_PDFMATH_PAGE_WORKERS
  );
}

function clampPageNumber(page, pageCount) {
  const total = Math.max(0, Number(pageCount) || 0);
  if (total <= 0) return 1;
  return Math.min(Math.max(1, Number(page) || 1), total);
}

/**
 * 固定翻译顺序：默认从第 1 页开始；显式起始页 → 向后 → 再补前面。
 */
export function buildPdfMathPageOrder(pageCount, priorityPage = 1) {
  const total = Math.max(0, Number(pageCount) || 0);
  if (total <= 0) return [];
  const priority = clampPageNumber(priorityPage, total);
  const ordered = [];
  for (let page = priority; page <= total; page += 1) ordered.push(page);
  for (let page = 1; page < priority; page += 1) ordered.push(page);
  return ordered;
}

/**
 * 旧阅读窗口辅助函数，仅保留兼容；翻译队列不再受此窗口限制。
 * 只全力做当前阅读页，并最多预取下一页。
 * 例：priority=2, pageCount=10 → [2, 3]
 * 绝不会在第 2 页已完成后继续「全力」扫第 4、5… 页。
 */
export function buildPdfMathWorkWindow(pageCount, priorityPage = 1) {
  const total = Math.max(0, Number(pageCount) || 0);
  if (total <= 0) return [];
  const priority = clampPageNumber(priorityPage, total);
  const window = [priority];
  if (priority + 1 <= total) window.push(priority + 1);
  return window;
}

function pageHasOutputFiles(pageState) {
  return Boolean(pageState?.monoFile || pageState?.dualFile);
}

/** 真正完成：必须 completed 且有产物。running 绝不算就绪 */
export function pageIsDone(pageState) {
  return Boolean(pageState)
    && pageState.status === "completed"
    && pageHasOutputFiles(pageState);
}

/** 已完成页：有产物即视为完成，绝不重译（不会把 running 改成 completed） */
function markPageCompletedIfHasFiles(pageState) {
  if (!pageState || !pageHasOutputFiles(pageState)) return false;
  // 正在跑的页即使残留旧文件名，也不能标完成（避免「还在译却显示就绪」）
  if (pageState.status === "running") return false;
  if (pageState.status !== "completed") {
    pageState.status = "completed";
    pageState.progress = pageState.progress || "本页排版译文已生成";
    // 有产物不等于本次翻译成功：重译失败保留旧译文时仍要暴露失败原因。
    settleReusedPageState(pageState);
  }
  return pageState.status === "completed";
}

function pageNeedsWork(pageState) {
  if (!pageState) return false;
  if (pageIsDone(pageState)) return false;
  // 已有产物且非 running → 治愈为 completed 并跳过
  if (pageState.status !== "running" && markPageCompletedIfHasFiles(pageState)) return false;
  if (pageState.status === "running") return false;
  return true;
}

/**
 * 按固定起始页认领所有未完成页（含旧 reading-window 任务，跳过已完成，绝不重译）。
 */
export function pickNextPdfMathPage(job, { skipPages } = {}) {
  if (!job?.pages?.length) return null;
  const forced = Number(job.forcedPage) || 0;
  const selected = forced ? job.pages.find((page) => Number(page.page) === forced) : null;
  if (selected && selected.status !== "running" && selected.status !== "completed") {
    selected.status = "running";
    selected.progress = `准备重新翻译第 ${forced} 页`;
    selected.error = "";
    return selected;
  }
  const total = job.pageCount || job.pages.length;
  const priority = job.priorityPage || 1;
  const order = buildPdfMathPageOrder(total, priority);
  const skip = skipPages instanceof Set ? skipPages : null;
  for (const pageNumber of order) {
    // 本轮已经失败的页不再重复认领，避免同一页无限重试；下一轮「继续翻译」会重新入队。
    if (skip?.has(pageNumber)) continue;
    const pageState = job.pages[pageNumber - 1];
    if (pageNeedsWork(pageState)) {
      pageState.status = "running";
      pageState.progress = `准备翻译第 ${pageNumber} 页（已完成页自动跳过）`;
      pageState.error = "";
      // 认领时清掉可能残留的旧文件引用，完成前不得显示就绪
      pageState.monoFile = "";
      pageState.dualFile = "";
      return pageState;
    }
  }
  return null;
}

function recountCompletedPages(job) {
  if (!job?.pages) return 0;
  for (const page of job.pages) {
    if (page.status !== "running" && Number(page.page) !== Number(job.forcedPage || 0)) markPageCompletedIfHasFiles(page);
  }
  job.completedPages = job.pages.filter((page) => pageIsDone(page)).length;
  return job.completedPages;
}

function describePageWork(job, page) {
  return {
    short: `正在翻译第 ${page} 页`,
    detail: `正在按顺序翻译第 ${page} / ${job.pageCount || "?"} 页`
  };
}

function jobAllPagesCompleted(job) {
  if (!job) return false;
  if (job.status === "completed" && !job.pages?.length) {
    return jobOutputLooksLikePdf(job, job.result?.monoFile) || jobOutputLooksLikePdf(job, job.result?.dualFile);
  }
  if (job.status === "completed" && job.pages.every((page) => page.status === "completed" && pageHasValidOutput(job, page))) {
    return true;
  }
  return Array.isArray(job.pages)
    && job.pages.length > 0
    && job.pages.every((page) => page.status === "completed" && pageHasValidOutput(job, page));
}

function jobIncompletePages(job) {
  return (job?.pages || []).filter((page) => page.status !== "completed" || !pageHasValidOutput(job, page));
}

/** 任务级终态：partial 表示“有完成页但仍有未完成页”，可继续翻译，绝不能冒充 completed */
const PDF_MATH_TERMINAL_JOB_STATUSES = new Set(["completed", "failed", "canceled", "partial"]);

function pdfMathIncompletePagesPayload(job) {
  return jobIncompletePages(job).map((page) => ({
    page: Number(page.page) || 0,
    status: String(page.status || ""),
    progress: String(page.progress || ""),
    error: String(page.error || "")
  }));
}

function pdfMathIncompleteHint(job, pages = jobIncompletePages(job)) {
  const total = Number(job?.pageCount) || (job?.pages || []).length || 0;
  const numbers = pages.map((page) => Number(page.page)).filter((page) => page > 0);
  const shown = numbers.slice(0, 8).join("、");
  const suffix = numbers.length > 8 ? " 等" : "";
  return `已完成 ${Number(job?.completedPages) || 0} / ${total} 页，仍有 ${pages.length} 页未完成（第 ${shown}${suffix} 页），可继续翻译`;
}

/**
 * 把“有未完成页”的任务标成 partial（而不是 completed），并给出可操作提示。
 * 只用于任务已停止推进的终态收尾，不打断 running 中的进度文案。
 * 返回 true 表示确实存在未完成页。
 */
function markPdfMathJobIncomplete(job, detail = "") {
  if (!job?.pages?.length) return false;
  recountCompletedPages(job);
  // 任务已停止推进：queued 页改成明确的“等待续译”，避免前端看起来像仍在排队转圈。
  for (const page of job.pages || []) {
    if (page.status === "queued" && page.page !== Number(job.forcedPage || 0)) {
      page.progress = "等待续译";
    }
  }
  const incomplete = jobIncompletePages(job);
  job.incompletePages = pdfMathIncompletePagesPayload(job);
  if (!incomplete.length) return false;
  job.status = "partial";
  job.error = "";
  const hint = pdfMathIncompleteHint(job, incomplete);
  job.progress = detail ? `${detail}；${hint}` : hint;
  return true;
}

/**
 * 完成态不变量：只有所有页都完成且有合法产物时才算 completed。
 * 用于重启恢复 / 单页重译收尾等“任务已停止推进”的路径，纠正历史误标。
 */
export function settlePdfMathJobCompletion(job, { detail = "" } = {}) {
  if (!job?.pages?.length) return job;
  const wasCompleted = job.status === "completed";
  const wasPartial = job.status === "partial";
  const active = ["queued", "running", "canceling"].includes(job.status);
  recountCompletedPages(job);
  const incomplete = jobIncompletePages(job);
  job.incompletePages = pdfMathIncompletePagesPayload(job);
  if (!incomplete.length) {
    job.incompletePages = [];
    if (!active && wasPartial) {
      job.status = "completed";
      job.error = "";
      job.progress = `全部版式译文已完成（${Number(job.completedPages) || 0} / ${Number(job.pageCount) || job.pages.length} 页）`;
    }
    return job;
  }
  if (wasCompleted || wasPartial) {
    // active 任务保持自身状态，避免把进行中的队列误标成 partial
    if (active) return job;
    markPdfMathJobIncomplete(job, detail);
  }
  return job;
}

/** 自动重试只针对“真实漏译”；latex/overlap/outOfBounds 是确定性输出，重跑同页不会改善 */
export function planPdfMathPageAutoRetry({ layoutIssues = {}, untranslatedClusters = 0, retriedOnce = false } = {}) {
  if (retriedOnce) return { retry: false, reasons: [] };
  const untranslatedCount = Array.isArray(layoutIssues?.untranslated) ? layoutIssues.untranslated.length : 0;
  // 只按 layout QA 的 issue.kind 判断；参考文献误报由 QA 自身排除，这里不复制正则。
  if (untranslatedCount < 1) return { retry: false, reasons: [] };
  const reasons = [`${untranslatedCount} 处疑似未翻译英文`];
  if (Number(untranslatedClusters) >= 2) reasons.push(`连续 ${Number(untranslatedClusters)} 处未翻译段`);
  return { retry: true, reasons };
}

function tail(value, max = 1600) {
  const clean = String(value || "").trim();
  return clean.length > max ? clean.slice(-max) : clean;
}

function cleanProgress(value) {
  const lines = String(value || "")
    .replace(/\u001b\[[0-?]*[ -\/]*[@-~]/g, "")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  if (!lines.length) return "正在处理 PDF";
  // 从后往前找「像进度」的行；纯 WARNING/traceback 转成可读状态，避免界面像卡住
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (/traceback|exception|error\s+\S+\s+during translation|try fallback/i.test(line)) {
      return "批量译失败，正在逐段回退翻译（较慢）";
    }
    if (/^WARNING\b/i.test(line) || /il_translator/i.test(line)) {
      if (/fallback|same as input|too long or too short|edit distance/i.test(line)) {
        return "部分段落回退逐段翻译中";
      }
      continue;
    }
    if (/^\s*File\s+\"|^\s*at\s+/i.test(line)) continue;
    return line.slice(0, 180);
  }
  return lines[lines.length - 1].slice(0, 180);
}

function killProcessTree(child) {
  if (!child?.pid) return;
  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore"
    });
    killer.once("error", () => {});
    return;
  }
  child.kill("SIGTERM");
}

/**
 * spawn 的 shell:true（Windows 上 .cmd/.bat 必须走 shell）不转义参数、原样拼接（DEP0190）。
 * 批处理按引号切分 %1..%9，参数含空格或引号（视觉语境 JSON、用户自定义 prompt）时
 * 必须整体加引号、内部引号翻倍，否则批处理解析崩坏会让翻译进程死挂到空闲超时。
 * 参数里不能出现裸 %（会被批处理当变量展开）；当前 argv（路径/flag/prompt）不含 %。
 */
function escapeCmdBatchArg(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const stdout = [];
    const stderr = [];
    let settled = false;
    let idleTimer;
    let idleWarningTimer;
    const useShell = process.platform === "win32" && /\.(cmd|bat)$/i.test(command);
    const child = spawn(command, useShell ? args.map(escapeCmdBatchArg) : args, {
      cwd: options.cwd,
      env: options.env,
      windowsHide: true,
      shell: useShell
    });
    options.onSpawn?.(child);
    const totalTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      killProcessTree(child);
      clearIdleTimers();
      reject(new Error("PDFMathTranslate 翻译超时，请缩小页数或检查模型服务"));
    }, options.timeoutMs || 45 * 60 * 1000);
    const clearIdleTimers = () => {
      clearTimeout(idleTimer);
      clearTimeout(idleWarningTimer);
    };
    const resetIdleTimer = () => {
      clearIdleTimers();
      if (options.idleWarningMs) {
        idleWarningTimer = setTimeout(() => {
          if (!settled) options.onIdleWarning?.();
        }, options.idleWarningMs);
      }
      if (options.idleTimeoutMs) {
        idleTimer = setTimeout(() => {
          if (settled) return;
          settled = true;
          killProcessTree(child);
          reject(new Error("PDFMathTranslate 长时间没有进展，已停止本次任务；请检查模型地址、代理和 API 超时设置"));
        }, options.idleTimeoutMs);
      }
    };
    resetIdleTimer();

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      stdout.push(text);
      options.onOutput?.(text, "stdout");
      resetIdleTimer();
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr.push(text);
      options.onOutput?.(text, "stderr");
      resetIdleTimer();
    });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(totalTimer);
      clearIdleTimers();
      reject(error);
    });
    child.once("exit", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(totalTimer);
      clearIdleTimers();
      resolve({ code, signal, stdout: stdout.join(""), stderr: stderr.join("") });
    });
  });
}


function serializeLayoutAssist(job) {
  const assist = normalizeLayoutAssist(job?.layoutAssist);
  const runtime = job?.layoutAssist && typeof job.layoutAssist === "object" ? job.layoutAssist : {};
  return {
    ...assist,
    status: String(runtime.status || (assist.enabled ? "active" : "disabled")),
    stage: String(runtime.stage || ""),
    errorCode: String(runtime.errorCode || ""),
    error: String(runtime.error || "")
  };
}

function isPermanentVisionError(code) {
  return ["VISION_AUTH", "VISION_MODEL_UNAVAILABLE", "VISION_UNSUPPORTED"].includes(String(code || ""));
}

function publicPdfMathJob(job) {
  if (!job) return null;
  return {
    jobId: job.jobId,
    paperId: job.paperId || "",
    status: job.status,
    progress: job.progress,
    startedAt: job.startedAt || null,
    updatedAt: job.updatedAt,
    error: job.error || "",
    result: job.result || null,
    pageCount: job.pageCount || 0,
    completedPages: job.completedPages || 0,
    incompletePages: Array.isArray(job.incompletePages) ? job.incompletePages : [],
    priorityPage: job.priorityPage || 1,
    activePage: job.activePage || 0,
    translateMode: job.translateMode === "all-remaining" ? "all-remaining" : "reading-window",
    pages: Array.isArray(job.pages) ? job.pages.map((page) => serializePageState(page, job.layoutAssist)) : [],
    sourceLang: job.sourceLang || "en",
    targetLang: job.targetLang || "zh",
    sourceSha256: job.sourceSha256 || "",
    layoutAssist: serializeLayoutAssist(job),
    identity: job.identity || null,
    identityHash: job.identityHash || "",
    staleReason: String(job.staleReason || ""),
    supersededJobId: String(job.supersededJobId || ""),
    persisted: true
  };
}

function preparePdfMathTranslation({ data, config = {}, sourceLang = "en", targetLang = "zh", binary = "", paperId = "", layoutAssist, layoutAssistDeps = {}, configFingerprint = "" } = {}) {
  const buffer = Buffer.from(String(data || ""), "base64");
  if (!isPdfBuffer(buffer)) throw new Error("只能对 PDF 文件使用排版翻译");

  const baseUrl = String(config.baseUrl || "").trim().replace(/\/+$/, "");
  const apiKey = String(config.apiKey || "").trim();
  const model = String(config.model || "").trim();
  if (!baseUrl || !apiKey || !model) throw new Error("请先在设置中配置 API Key、地址和模型");

  const resolved = resolvePdfMathTranslateCommand(binary);
  if (!resolved) throw new Error(getPdfMathTranslateStatus(binary).installHint);

  const jobId = randomUUID();
  const jobDir = path.join(JOBS_DIR, jobId);
  const outputDir = path.join(jobDir, "output");
  const inputPath = path.join(jobDir, "source.pdf");
  const from = normalizeLanguage(sourceLang, "en");
  const to = normalizeLanguage(targetLang, "zh");
  const sourceSha256 = sha256Buffer(buffer);
  const normalizedLayoutAssist = normalizeLayoutAssist(layoutAssist);
  const identityInfo = createPdfMathTranslationIdentity({
    config,
    sourceLang: from,
    targetLang: to,
    sourceSha256,
    layoutAssist: normalizedLayoutAssist,
    resolved,
    configFingerprint
  });
  const pageRenderer = layoutAssistDeps.renderer || layoutAssistDeps.renderPage || renderPdfPage;
  const pageCounter = layoutAssistDeps.getPageCount || getPdfPageCount;
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(inputPath, buffer);
  const invocation = buildPdfMathTranslateInvocation({ inputPath, outputDir, config, sourceLang: from, targetLang: to });
  const env = { ...process.env };
  delete env.OPENAI_API_KEY;
  delete env.OPENAI_BASE_URL;
  delete env.OPENAI_MODEL;
  // Keep credentials out of argv and ScholarLoop files; PDFMathTranslate reads them from its child env.
  Object.assign(env, invocation.env);
  applyPdfMathLlmProxyEnv(env);
  return {
    jobId,
    jobDir,
    outputDir,
    inputPath,
    resolved,
    invocation,
    env,
    sourceLang: from,
    targetLang: to,
    config,
    layoutAssist: normalizedLayoutAssist,
    identity: identityInfo.identity,
    identityHash: identityInfo.identityHash,
    pageRenderer,
    pageCounter,
    visionAnalyzer: layoutAssistDeps.vision || layoutAssistDeps.analyzePage || requestPdfVisualContext,
    layoutReviewer: layoutAssistDeps.review || reviewTranslatedLayout,
    layoutAssistDeps,
    paperId: cleanPaperId(paperId),
    sourceSha256
  };
}

function pageFilePrefix(pageNumber) {
  return `page-${String(pageNumber).padStart(3, "0")}`;
}

function translatedPageFileName(pageNumber, kind) {
  return `${pageFilePrefix(pageNumber)}.zh.${kind}.pdf`;
}

function createPageStates(pageCount, layoutAssist) {
  return Array.from({ length: pageCount }, (_, index) => ({
    page: index + 1,
    status: "queued",
    progress: "等待处理",
    error: "",
    monoFile: "",
    dualFile: "",
    assist: createPageAssistState(layoutAssist)
  }));
}

function requeuePageState(pageState, progress = "等待处理") {
  if (!pageState || pageState.status === "completed") return;
  pageState.status = "queued";
  pageState.progress = progress;
  pageState.error = "";
}

function wasPagePreempted(job) {
  // 仅认显式抢占标志，避免串行译「当前页之后」时被误判打断
  return Boolean(job?.pagePreemptRequested);
}

function fileLooksLikePdf(filePath) {
  let descriptor;
  try {
    if (!existsFile(filePath)) return false;
    const stat = fs.statSync(filePath);
    // 空文件/目录不算产物；未写完的 0 字节残留不能当「已就绪」
    if (!stat.isFile() || stat.size < 5) return false;
    const header = Buffer.alloc(5);
    descriptor = fs.openSync(filePath, "r");
    const bytesRead = fs.readSync(descriptor, header, 0, header.length, 0);
    return bytesRead === header.length && header.toString("latin1") === "%PDF-";
  } catch {
    return false;
  } finally {
    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor);
      } catch {
        // 读取失败时忽略关闭文件描述符的错误
      }
    }
  }
}

function outputFilePath(outputDir, fileName) {
  const name = String(fileName || "");
  if (!/^[A-Za-z0-9._-]+\.pdf$/i.test(name)) return "";
  const root = path.resolve(outputDir);
  const file = path.resolve(root, name);
  return file.startsWith(`${root}${path.sep}`) ? file : "";
}

function jobOutputLooksLikePdf(job, fileName) {
  const outputDir = job?.jobId ? path.join(JOBS_DIR, String(job.jobId), "output") : "";
  const file = outputFilePath(outputDir, fileName);
  return Boolean(file) && fileLooksLikePdf(file);
}

function pageHasValidOutput(job, pageState) {
  return jobOutputLooksLikePdf(job, pageState?.monoFile) || jobOutputLooksLikePdf(job, pageState?.dualFile);
}

function resolveExistingPageOutputs(prepared, page) {
  const monoFile = translatedPageFileName(page, "mono");
  const dualFile = translatedPageFileName(page, "dual");
  const monoPath = path.join(prepared.outputDir, monoFile);
  const dualPath = path.join(prepared.outputDir, dualFile);
  return {
    monoFile: fileLooksLikePdf(monoPath) ? monoFile : "",
    dualFile: fileLooksLikePdf(dualPath) ? dualFile : ""
  };
}

function promoteExistingPageOutput(job, prepared, pageState, { allowWhileRunning = false } = {}) {
  const page = pageState.page;
  // 正在翻译中禁止用旧文件冒充完成
  if (pageState.status === "running" && !allowWhileRunning) return false;
  const existing = resolveExistingPageOutputs(prepared, page);
  if (!existing.monoFile && !existing.dualFile) return false;
  pageState.status = "completed";
  pageState.progress = "本页排版译文已生成";
  pageState.error = "";
  pageState.monoFile = existing.monoFile;
  pageState.dualFile = existing.dualFile;
  markReusedPageQualityReview(pageState);
  recountCompletedPages(job);
  return true;
}

function pageInterruptionOutcome(job) {
  if (job?.cancelRequested) return "canceled";
  if (job?.pagePreemptRequested) return "preempted";
  return "";
}

function safeLayoutAssistError(error) {
  const code = String(error?.code || "").trim();
  const messages = {
    VISION_UNSUPPORTED: "当前模型或接口不支持图片输入，请更换视觉模型或关闭页面图片辅助翻译",
    VISION_AUTH: "视觉模型鉴权失败，请检查 API Key、模型权限和接口地址",
    VISION_MODEL_UNAVAILABLE: "当前模型不存在或已失效，请在设置中刷新并选择可用模型",
    VISION_TOO_LARGE: "页面图片被上游拒绝（请求过大），请降低图片分辨率或关闭页面图片辅助翻译",
    VISION_OUTPUT_TRUNCATED: "视觉模型输出被截断，已重试一次；仍未返回完整结果，已回退普通翻译",
    VISION_TIMEOUT: "视觉模型请求超时，已回退普通翻译",
    VISION_NETWORK: "视觉模型网络请求失败，已回退普通翻译",
    VISION_STREAM_INTERRUPTED: "视觉响应流中断，重试后仍未收到完整结果；本页已使用普通翻译",
    VISION_INCOMPLETE: "视觉模型未完成本页分析；本页已使用普通翻译",
    VISION_REQUEST: "视觉请求未能完成，错误类型未明确；本页已使用普通翻译",
    VISION_EMPTY: "视觉模型返回为空，已回退普通翻译",
    VISION_REASONING_ONLY: "视觉模型只返回了思考过程，已回退普通翻译",
    VISION_INVALID_JSON: "视觉模型返回格式无效，已回退普通翻译",
    VISION_INVALID_SCHEMA: "视觉模型页面语境结构无效，已回退普通翻译",
    VISION_UPSTREAM: "视觉模型请求失败，已回退普通翻译",
    VISION_RENDER: "页面视觉准备失败，已回退普通翻译"
  };
  return messages[code] || "页面视觉辅助不可用，已回退普通翻译";
}

function finishPageInterruption(job, pageState, outcome) {
  const assist = pageState.assist || createPageAssistState(job.layoutAssist);
  if (outcome === "canceled") {
    pageState.status = "canceled";
    pageState.progress = "已取消";
    pageState.monoFile = "";
    pageState.dualFile = "";
    pageState.assist = { ...assist, status: "canceled", error: "", errorCode: "", context: null };
    persistJob(job);
    return;
  }
  requeuePageState(pageState, "已让出给当前阅读页");
  pageState.monoFile = "";
  pageState.dualFile = "";
  pageState.assist = { ...assist, status: "queued", error: "", errorCode: "", context: null };
  // 只有已经处理完本次抢占时才消费标志，不能在视觉准备期间提前清除。
  job.pagePreemptRequested = false;
  persistJob(job);
}

/**
 * 与 requestPdfVisualContext 的行提取保持一致（截断 160 行、每行 1200 字、去空行），
 * region 行号按这个数组索引。仅存内存供译后 equation 区域回贴匹配，不写入 job.json。
 */
export function buildAssistLineTexts(rendered) {
  return (Array.isArray(rendered?.lines) ? rendered.lines : [])
    .slice(0, 160)
    .map((line) => String(line?.text || "").slice(0, 1200))
    .filter((text) => String(text).trim());
}

async function preparePageVisualContext(job, prepared, pageState, { signal } = {}) {
  const layoutAssist = normalizeLayoutAssist(prepared.layoutAssist || job.layoutAssist);
  if (!layoutAssist.enabled) {
    pageState.assist = createPageAssistState(layoutAssist);
    return null;
  }
  if (job.layoutAssist?.status === "degraded" && job.layoutAssist?.scope === "job") {
    pageState.assist = {
      ...(pageState.assist || createPageAssistState(layoutAssist)),
      status: "fallback",
      stage: String(job.layoutAssist.stage || "request"),
      errorCode: String(job.layoutAssist.errorCode || "VISION_UPSTREAM"),
      error: String(job.layoutAssist.error || "视觉辅助已降级，已回退普通翻译"),
      retryable: false,
      context: null
    };
    return null;
  }
  const interrupted = pageInterruptionOutcome(job);
  if (interrupted) return { outcome: interrupted };
  const existing = pageState.assist?.context;
  if (pageState.assist?.status === "ready" && existing) {
    try {
      const validated = validatePdfVisualContext(existing, { page: pageState.page, lineCount: 240 });
      // 重启/续译后内存里的 assistLineTexts 会丢失（它不写 job.json）：
      // 这里从当前页文本层重建，否则 collectVisionEquationGroups 永远是空数组，equation 回贴静默失效。
      if (!Array.isArray(pageState.assistLineTexts) || !pageState.assistLineTexts.length) {
        try {
          const rendered = await Promise.resolve(prepared.pageRenderer(prepared.inputPath, pageState.page, { signal }));
          const afterRebuild = pageInterruptionOutcome(job);
          if (afterRebuild) return { outcome: afterRebuild };
          const texts = buildAssistLineTexts(rendered);
          if (texts.length) pageState.assistLineTexts = texts;
        } catch {
          const afterRebuildError = pageInterruptionOutcome(job);
          if (afterRebuildError) return { outcome: afterRebuildError };
          // 语境本身仍可用，只是本次无法做 equation 回贴；不能因此清空已有语境。
          if (!pageState.assistLineTexts) pageState.assistLineTexts = [];
        }
      }
      const afterValidation = pageInterruptionOutcome(job);
      return afterValidation ? { outcome: afterValidation } : validated;
    } catch {
      pageState.assist.context = null;
    }
  }
  pageState.assist = {
    ...(pageState.assist || createPageAssistState(layoutAssist)),
    status: "rendering",
    mode: layoutAssist.mode,
    error: "",
    errorCode: ""
  };
  touchJob(job, { progress: `正在准备第 ${pageState.page} 页视觉语境` });
  try {
    const rendered = await Promise.resolve(prepared.pageRenderer(prepared.inputPath, pageState.page, { signal }));
    const afterRender = pageInterruptionOutcome(job);
    if (afterRender) return { outcome: afterRender };
    if (!rendered?.textLayer || !Array.isArray(rendered.lines) || !rendered.lines.length) {
      throw new Error("本页没有文本层，已回退普通翻译");
    }
    if (!rendered.image) throw new Error("页面图像不可用，已回退普通翻译");
    pageState.assist.status = "analyzing";
    touchJob(job, { progress: `正在分析第 ${pageState.page} 页视觉语境` });
    const context = await prepared.visionAnalyzer({
      rendered,
      page: pageState.page,
      config: prepared.config,
      fetchImpl: prepared.layoutAssistDeps.fetchImpl,
      signal
    });
    const afterVision = pageInterruptionOutcome(job);
    if (afterVision) return { outcome: afterVision };
    const validated = validatePdfVisualContext(context, {
      page: pageState.page,
      lineCount: Math.min(240, rendered.lines.filter((line) => String(line?.text || "").trim()).length)
    });
    pageState.assist.status = "ready";
    pageState.assist.context = validated;
    pageState.assist.error = "";
    pageState.assist.errorCode = "";
    pageState.assist.stage = "";
    pageState.assist.retryable = false;
    pageState.assist.retryCount = 0;
    // 与 requestPdfVisualContext 的行提取保持一致（截断+去空行），region 行号按此数组索引；
    // 仅存内存供译后 equation 区域回贴匹配，不写入 job.json。
    pageState.assistLineTexts = buildAssistLineTexts(rendered);
    persistJob(job);
    return validated;
  } catch (error) {
    const interruptedAfterError = pageInterruptionOutcome(job);
    if (interruptedAfterError) return { outcome: interruptedAfterError };
    const code = String(error?.code || "VISION_RENDER").slice(0, 80);
    const retryable = error?.retryable === true && Number(pageState.assist?.retryCount || 0) < 1;
    if (retryable) {
      pageState.assist.retryCount = Number(pageState.assist.retryCount || 0) + 1;
      pageState.assist.status = "queued";
      pageState.assist.stage = String(error?.stage || "request");
      persistJob(job);
      return preparePageVisualContext(job, prepared, pageState, { signal });
    }
    // 视觉能力是辅助能力，失败只影响语境分析，不阻塞普通翻译。
    pageState.assist.status = "fallback";
    pageState.assist.context = null;
    pageState.assist.stage = String(error?.stage || (code === "VISION_RENDER" ? "render" : "request"));
    pageState.assist.retryable = error?.retryable === true;
    pageState.assist.errorCode = code;
    pageState.assist.error = safeLayoutAssistError(error);
    if (isPermanentVisionError(code)) {
      job.layoutAssist = {
        ...job.layoutAssist,
        status: "degraded",
        scope: "job",
        stage: pageState.assist.stage,
        errorCode: code,
        error: pageState.assist.error
      };
    }
    persistJob(job);
    return null;
  }
}

/** 从视觉语境里取 equation 区域的行文本组（行号 → assistLineTexts），供译后整块回贴 */
export function collectVisionEquationGroups(pageState) {
  const context = pageState?.assist?.context;
  const texts = Array.isArray(pageState?.assistLineTexts) ? pageState.assistLineTexts : [];
  if (!context || !Array.isArray(context.regions) || !texts.length) return [];
  const groups = [];
  for (const region of context.regions) {
    if (String(region?.kind) !== "equation") continue;
    if (Number(region?.confidence) < 0.7) continue;
    const group = (Array.isArray(region?.lineIndexes) ? region.lineIndexes : [])
      .map((index) => (Number.isInteger(index) && index >= 0 && index < texts.length ? texts[index] : ""))
      .filter(Boolean);
    if (group.length) groups.push(group);
  }
  return groups;
}

async function executePdfMathTranslationPage(job, prepared, pageState) {
  const page = pageState.page;
  // 开始前：仅当非 running 且磁盘已有合法 PDF 才跳过
  if (pageState.status !== "running") {
    pageState.status = "queued";
  }
  // 认领后先进入 running，再检查磁盘；检查时允许用合法成品跳过
  pageState.status = "running";
  const priorPage = job.forcedPage === page && pageHasValidOutput(job, pageState)
    ? { ...structuredClone(pageState), status: "completed" } : null;
  if (!priorPage) { pageState.monoFile = ""; pageState.dualFile = ""; }
  pageState.error = "";
  if (job.forcedPage !== page && promoteExistingPageOutput(job, prepared, pageState, { allowWhileRunning: true })) {
    recountCompletedPages(job);
    touchJob(job, {
      progress: `第 ${page} 页译文已存在，跳过重译（${job.completedPages} / ${job.pageCount} 页）`
    });
    return "completed";
  }

  const pageDir = path.join(prepared.jobDir, "pages", pageFilePrefix(page));
  // A forced retranslation uses a fresh output directory: a failed attempt
  // must never promote an earlier engine artifact as a new result.
  const attemptId = job.forcedPage === page ? randomUUID() : "";
  const pageOutputDir = attemptId ? path.join(pageDir, `attempt-${attemptId}`, "output") : path.join(pageDir, "output");
  fs.mkdirSync(pageOutputDir, { recursive: true });
  const work = describePageWork(job, page);
  pageState.progress = work.short;
  job.activePage = page;
  // 视觉阶段也属于本页的 active 工作，取消/翻页可以在此阶段被观测并抢占。
  const visualAbortController = new AbortController();
  job.visualAbortController = visualAbortController;
  touchJob(job, { progress: work.detail });
  const pageContext = await preparePageVisualContext(job, prepared, pageState, {
    signal: visualAbortController.signal
  });
  const visualOutcome = pageContext?.outcome;
  if (visualOutcome) {
    finishPageInterruption(job, pageState, visualOutcome);
    if (priorPage) Object.assign(pageState, priorPage);
    if (job.activePage === page) job.activePage = 0;
    if (job.visualAbortController === visualAbortController) job.visualAbortController = null;
    persistJob(job);
    return visualOutcome;
  }
  const beforeInvocation = pageInterruptionOutcome(job);
  if (beforeInvocation) {
    finishPageInterruption(job, pageState, beforeInvocation);
    if (priorPage) Object.assign(pageState, priorPage);
    if (job.activePage === page) job.activePage = 0;
    if (job.visualAbortController === visualAbortController) job.visualAbortController = null;
    persistJob(job);
    return beforeInvocation;
  }
  const invocation = buildPdfMathTranslateInvocation({
    inputPath: prepared.inputPath,
    outputDir: pageOutputDir,
    config: prepared.config,
    sourceLang: prepared.sourceLang,
    targetLang: prepared.targetLang,
    page,
    pageContext
  });
  pageState.progress = work.short;
  touchJob(job, { progress: work.detail });
  let currentChild = null;
  let postprocessFailed = false;
  try {
    const result = await runProcess(
      prepared.resolved.command,
      [...prepared.resolved.argsPrefix, ...invocation.args],
      {
        cwd: pageDir,
        env: prepared.env,
        timeoutMs: 45 * 60 * 1000,
        idleWarningMs: 3 * 60 * 1000,
        idleTimeoutMs: 12 * 60 * 1000,
        onSpawn: (child) => {
          currentChild = child;
          job.children.add(child);
          job.child = child;
          if (job.cancelRequested || job.pagePreemptRequested) killProcessTree(child);
        },
        onOutput: (text) => {
          if (job.pagePreemptRequested && currentChild) {
            killProcessTree(currentChild);
            return;
          }
          const progress = cleanProgress(text);
          const live = describePageWork(job, page);
          pageState.progress = `${live.short}：${progress}`;
          touchJob(job, {
            progress: `${live.detail} · ${progress}`
          }, { throttleMs: 2000 });
        },
        onIdleWarning: () => {
          const warning = "等待模型响应已超过 5 分钟，任务仍在运行；可继续等待或手动取消";
          pageState.progress = warning;
          touchJob(job, { progress: `第 ${page} 页：${warning}` });
        }
      }
    );
    if (job.cancelRequested) {
      if (priorPage) Object.assign(pageState, priorPage);
      else { pageState.status = "canceled"; pageState.progress = "已取消"; }
      persistJob(job);
      return "canceled";
    }
    if (wasPagePreempted(job)) {
      // 抢占后仅当磁盘上已有合法成品才算完成；否则回队列，绝不假装就绪
      if (job.forcedPage !== page && promoteExistingPageOutput(job, prepared, pageState, { allowWhileRunning: true })) {
        job.pagePreemptRequested = false;
        touchJob(job, { progress: `第 ${page} 页已完成，切换到新的阅读页` });
        return "completed";
      }
      if (priorPage) Object.assign(pageState, priorPage);
      else { requeuePageState(pageState, "已让出给当前阅读页"); pageState.monoFile = ""; pageState.dualFile = ""; }
      job.pagePreemptRequested = false;
      persistJob(job);
      return "preempted";
    }
    if (result.code !== 0) {
      writePageRunLog(pageDir, attemptId, result);
      if (job.forcedPage !== page && promoteExistingPageOutput(job, prepared, pageState, { allowWhileRunning: true })) {
        touchJob(job, { progress: `第 ${page} 页译文已生成（${job.completedPages} / ${job.pageCount}）` });
        return "completed";
      }
      const detail = tail(result.stderr || result.stdout);
      throw new Error(`PDFMathTranslate 第 ${page} 页退出码 ${result.code ?? "未知"}${detail ? `：${detail}` : ""}`);
    }
    const outputs = findPdfMathTranslateOutputs(pageOutputDir);
    const monoPath = outputs.mono ? path.join(pageOutputDir, outputs.mono) : "";
    const dualPath = outputs.dual ? path.join(pageOutputDir, outputs.dual) : "";
    if (!fileLooksLikePdf(monoPath) && !fileLooksLikePdf(dualPath)) {
      writePageRunLog(pageDir, attemptId, result);
      if (job.forcedPage !== page && promoteExistingPageOutput(job, prepared, pageState, { allowWhileRunning: true })) {
        touchJob(job, { progress: `第 ${page} 页译文已生成（${job.completedPages} / ${job.pageCount}）` });
        return "completed";
      }
      const detail = tail(result.stderr || result.stdout);
      throw new Error(`第 ${page} 页没有生成译文 PDF${detail ? `：${detail}` : ""}`);
    }
    const monoFile = attemptId ? `${pageFilePrefix(page)}.v-${attemptId}.zh.mono.pdf` : translatedPageFileName(page, "mono");
    const dualFile = attemptId ? `${pageFilePrefix(page)}.v-${attemptId}.zh.dual.pdf` : translatedPageFileName(page, "dual");
    const destMono = path.join(prepared.outputDir, monoFile);
    const destDual = path.join(prepared.outputDir, dualFile);
    // 目标已存在则覆盖写入，避免 Windows rename 到已有文件失败后被标 failed 再重译
    if (fileLooksLikePdf(monoPath)) {
      if (existsFile(destMono)) fs.rmSync(destMono, { force: true });
      fs.renameSync(monoPath, destMono);
    }
    if (fileLooksLikePdf(dualPath) && dualPath !== monoPath) {
      if (existsFile(destDual)) fs.rmSync(destDual, { force: true });
      fs.renameSync(dualPath, destDual);
    }
    // 最终校验：目标文件必须是合法 PDF 才标 completed
    const finalMono = fileLooksLikePdf(destMono) ? monoFile : "";
    const finalDual = fileLooksLikePdf(destDual) ? dualFile : "";
    if (!finalMono && !finalDual) {
      throw new Error(`PDFMathTranslate 第 ${page} 页产物校验失败`);
    }
    // 漏译检测必须使用回贴后的最终文本，不能把抽取失败/零行当作无漏译。
    const restoreResults = restorePreservedPageOutputs(
      prepared.inputPath,
      finalMono ? destMono : "",
      finalDual ? destDual : "",
      page,
      {
        equationTextGroups: collectVisionEquationGroups(pageState),
        // 首页标题/作者区整块回贴英文原文，避免 BabelDOC 重排把标题/作者拆成碎片。
        preserveFrontMatter: page === 1 || page === Number(job.pages?.[0]?.page)
      }
    );
    const invalidRestore = restoreResults.find((result) => result.ok !== true || !result.destLines?.length);
    if (!restoreResults.length || invalidRestore) {
      postprocessFailed = true;
      // 不留下能被 promoteExistingPageOutput 冒充成功的未校验产物。
      if (finalMono) fs.rmSync(destMono, { force: true });
      if (finalDual) fs.rmSync(destDual, { force: true });
      throw new Error(`第 ${page} 页回贴/最终文本抽取失败：${invalidRestore?.ok === false ? invalidRestore.reason : "译文文本为零行"}`);
    }
    const scanResult = restoreResults.find((result) => result.kind === "mono") || restoreResults[0];
    const untranslatedClusters = countUntranslatedClusters(scanResult.destLines);
    const skippedOverlays = restoreResults.reduce((sum, result) => sum + (result.skipped?.length || 0), 0);
    // 确定性版式 QA：公式标记被排版、中文行内整句英文、译文行框重叠/越界。
    // 页面尺寸来自本页文本抽取结果；dual 产物宽度是双栏拼接值，不参与越界判定。
    const layoutIssues = detectLayoutIssues(scanResult.destLines, {
      pageWidth: scanResult.kind === "mono" ? Number(scanResult.pageWidth) || 0 : 0,
      pageHeight: scanResult.kind === "mono" ? Number(scanResult.pageHeight) || 0 : 0,
      // 源页行用于保守识别参考文献版面区域；识别失败时 QA 内部回退到正则。
      sourceLines: scanResult.sourceLines || [],
      // 首页整块回贴的英文标题/作者区不再是漏译或行框重叠。
      ignoreBoxes: scanResult.ignoreBoxes || []
    });
    const layoutSummary = summarizeLayoutIssues(layoutIssues);
    const layoutCounts = layoutSummary.counts;
    const layoutHitKinds = LAYOUT_QA_KINDS.filter((kind) => layoutCounts[kind] > 0);
    const autoRetry = planPdfMathPageAutoRetry({
      layoutIssues,
      untranslatedClusters,
      retriedOnce: pageState.retriedOnce === true
    });
    if (autoRetry.retry && !job.cancelRequested && !job.pagePreemptRequested) {
      // 只有“真实漏译”才值得自动重译；latex/overlap/outOfBounds 命中是确定性输出，重跑不会改善。
      // 先删掉本页旧产物，否则 promoteExistingPageOutput 会用旧文件短路。
      pageState.retriedOnce = true;
      pageState.layoutQa = null;
      pageState.status = "queued";
      pageState.progress = `检测到${autoRetry.reasons.length ? ` ${autoRetry.reasons.join("、")}` : ""}，自动重译本页`;
      if (!priorPage) { pageState.monoFile = ""; pageState.dualFile = ""; }
      if (finalMono) fs.rmSync(destMono, { force: true });
      if (finalDual) fs.rmSync(destDual, { force: true });
      recountCompletedPages(job);
      persistJob(job);
      return "requeued-untranslated";
    }
    // 重译机会用尽后固化本次 QA 结论（issues 合并各类、最多 8 条）。
    pageState.layoutQa = layoutSummary.total > 0
      ? { status: "issues", counts: layoutCounts, issues: mergeLayoutIssues(layoutIssues) }
      : { status: "clear", counts: layoutCounts, issues: [] };
    // Visual review is advisory: never trust model boxes as PDF deletion instructions.
    // Old jobs and failed checks remain distinguishable from a clean review.
    pageState.qualityReview = null;
    if (prepared.layoutAssist?.enabled && finalMono) {
      pageState.qualityReview = { status: "checking", issues: [] };
      touchJob(job, { progress: `正在对照原文检查第 ${page} 页译文` });
      try {
        const sourceImage = await prepared.pageRenderer(prepared.inputPath, page, { signal: visualAbortController.signal });
        const translatedImage = await prepared.pageRenderer(destMono, 1, { signal: visualAbortController.signal });
        const review = await prepared.layoutReviewer({ source: sourceImage, translated: translatedImage, page, config: prepared.config, fetchImpl: prepared.layoutAssistDeps.fetchImpl, signal: visualAbortController.signal });
        let finalReview = review;
        let repaired = false;
        if (review.issues.length) {
          try {
            const result = await trySafeLayoutRepair({ sourcePdf: prepared.inputPath, monoPdf: destMono, dualPdf: finalDual ? destDual : "", page, review, renderPage: prepared.pageRenderer, reviewer: prepared.layoutReviewer, config: prepared.config, fetchImpl: prepared.layoutAssistDeps.fetchImpl, signal: visualAbortController.signal });
            if (result.repaired) { repaired = true; finalReview = result.review; }
          } catch (error) {
            if (job.cancelRequested || wasPagePreempted(job)) throw error;
          }
        }
        pageState.qualityReview = { status: finalReview.issues.length ? "issues" : "clear", issues: finalReview.issues, repaired };
      } catch (error) {
        if (job.cancelRequested || wasPagePreempted(job)) throw error;
        pageState.qualityReview = { status: "unavailable", issues: [], error: "译后视觉检查未完成，请核对页面" };
      }
    } else if (prepared.layoutAssist?.enabled) {
      pageState.qualityReview = { status: "unavailable", issues: [], error: "缺少中文版译文页，未进行译后视觉检查" };
    }
    pageState.status = "completed";
    pageState.progress = "本页排版译文已生成";
    pageState.monoFile = finalMono;
    pageState.dualFile = finalDual;
    pageState.translationIdentity = { model: prepared.identity?.model || "", provider: prepared.identity?.provider || "", identityHash: prepared.identityHash || "" };
    if (untranslatedClusters >= 1) {
      pageState.progress = `本页排版译文已生成（${pageState.retriedOnce === true ? "重译后仍有 " : "检测到 "}${untranslatedClusters} 处疑似未翻译段落）`;
    }
    if (skippedOverlays) pageState.progress += `；为保护中文正文跳过 ${skippedOverlays} 个回贴框`;
    if (layoutHitKinds.length) {
      pageState.progress += `；版式检查：${layoutHitKinds.map((kind) => `${LAYOUT_QA_LABELS[kind]} ${layoutCounts[kind]} 处`).join("、")}`;
    }
    recountCompletedPages(job);
    touchJob(job, {
      progress: `第 ${page} 页已完成，可阅读`
    });
    return "completed";
  } catch (error) {
    if (pageState.qualityReview?.status === "checking") {
      pageState.qualityReview = { status: "unavailable", issues: [], error: "译后检查已中断，请核对页面" };
    }
    if (job.cancelRequested) {
      if (priorPage) Object.assign(pageState, priorPage);
      else { pageState.status = "canceled"; pageState.progress = "已取消"; pageState.monoFile = ""; pageState.dualFile = ""; }
      persistJob(job);
      return "canceled";
    }
    if (wasPagePreempted(job)) {
      if (!postprocessFailed && job.forcedPage !== page && promoteExistingPageOutput(job, prepared, pageState, { allowWhileRunning: true })) {
        job.pagePreemptRequested = false;
        return "completed";
      }
      if (priorPage) Object.assign(pageState, priorPage);
      else { requeuePageState(pageState, "已让出给当前阅读页"); pageState.monoFile = ""; pageState.dualFile = ""; }
      job.pagePreemptRequested = false;
      persistJob(job);
      return "preempted";
    }
    if (!postprocessFailed && job.forcedPage !== page && promoteExistingPageOutput(job, prepared, pageState, { allowWhileRunning: true })) {
      return "completed";
    }
    const failure = String(error?.message || `第 ${page} 页排版翻译失败`);
    // 服务端日志可能很长：保留前缀（含失败原因开头）后截断，避免污染 job.json 与前端卡片。
    const failureText = failure.length > 1200 ? `${failure.slice(0, 1200)}…` : failure;
    if (priorPage) Object.assign(pageState, priorPage);
    else { pageState.status = "failed"; pageState.monoFile = ""; pageState.dualFile = ""; }
    // 注意顺序：必须写在 Object.assign(priorPage) 之后，否则会被旧状态覆盖。
    pageState.error = priorPage ? `重译失败，已保留原有译文：${failureText}` : failureText;
    pageState.progress = priorPage ? "重译失败，已保留原有译文" : "本页排版翻译失败";
    // 失败页不能停留在 not-run，否则前端会误判成「复用产物、未做译后检查」。
    pageState.qualityReview = { status: "failed", issues: [], error: failureText };
    persistJob(job);
    return "failed";
  } finally {
    if (job.activePage === page) job.activePage = 0;
    if (job.visualAbortController === visualAbortController) job.visualAbortController = null;
    if (currentChild) job.children.delete(currentChild);
    job.child = [...job.children][0] || null;
    persistJob(job);
  }
}

function finishProgressiveJobSuccess(job, prepared) {
  recountCompletedPages(job);
  // 最后一道闸：任何未完成页都不能被整任务 completed 掩盖。
  if (markPdfMathJobIncomplete(job)) return false;
  job.result = {
    jobId: job.jobId,
    pages: job.pages,
    sourceLang: prepared.sourceLang,
    targetLang: prepared.targetLang
  };
  job.incompletePages = [];
  touchJob(job, {
    status: "completed",
    progress: `全部版式译文已完成（${job.completedPages} / ${job.pageCount} 页）`
  });
  return true;
}

async function executePdfMathTranslationProgressive(job, prepared) {
  if (job.cancelRequested) return;
  // 防止同一任务跑两套循环（否则已完成页会被第二套再次认领）
  if (job.progressiveLoopActive) return;
  job.progressiveLoopActive = true;

  try {
    const priorityPage = clampPageNumber(prepared.priorityPage || job.priorityPage || 1, job.pageCount || 1);
    job.priorityPage = priorityPage;
    job.priorityEpoch = Number(job.priorityEpoch) || 0;
    // 仅重试失败/取消；已有产物的页会被 mark 为 completed，不会重译
    for (const pageState of job.pages || []) {
      if (pageState.page !== job.forcedPage && markPageCompletedIfHasFiles(pageState)) continue;
      if (pageState.status === "failed" || pageState.status === "canceled" || pageState.status === "running") {
        // 残留 running（进程已死）回收为 queued
        requeuePageState(pageState);
      }
      // 磁盘上已有 output 时直接恢复
      if (pageState.page !== job.forcedPage) promoteExistingPageOutput(job, prepared, pageState);
    }
    job.translateMode = "all-remaining";
    recountCompletedPages(job);
    const modeLabel = `按顺序翻译（从第 ${priorityPage} 页起，已完成页自动跳过）`;
    touchJob(job, {
      status: "running",
      startedAt: job.startedAt || Date.now(),
      progress: modeLabel
    });

    // 本轮已失败页（跳过重复认领）与连续失败计数（文档级故障保护）。
    const failedThisRun = new Set();
    let consecutiveFailures = 0;

    while (!job.cancelRequested) {
      recountCompletedPages(job);
      if ((job.pageCount || 0) > 0 && (job.pages || []).every((p) => pageIsDone(p))) {
        finishProgressiveJobSuccess(job, prepared);
        return;
      }

      const pageState = pickNextPdfMathPage(job, { skipPages: failedThisRun });
      if (!pageState) {
        if ((job.pages || []).every((p) => pageIsDone(p))) {
          finishProgressiveJobSuccess(job, prepared);
          return;
        }
        // 剩余未完成页都在本轮失败过：收尾为 partial，保留每页错误，用户可点「继续翻译」重试。
        if (markPdfMathJobIncomplete(job, failedThisRun.size
          ? `已跳过 ${failedThisRun.size} 个翻译失败页`
          : "")) {
          persistJob(job);
          return;
        }
        touchJob(job, {
          status: "failed",
          error: "存在未完成页，但无法认领翻译任务",
          progress: "翻译队列异常，已保留此前已完成页面"
        });
        return;
      }

      const outcome = await executePdfMathTranslationPage(job, prepared, pageState);
      if (outcome === "completed" && job.forcedPage === pageState.page) {
        job.forcedPage = 0;
        recountCompletedPages(job);
        if (jobAllPagesCompleted(job) || !markPdfMathJobIncomplete(job, `第 ${pageState.page} 页已重新翻译`)) {
          job.incompletePages = [];
          touchJob(job, {
            status: "completed",
            progress: `第 ${pageState.page} 页已重新翻译`
          });
        } else {
          persistJob(job);
        }
        return;
      }
      if (outcome === "canceled") {
        touchJob(job, { status: "canceled", progress: "已取消排版翻译" });
        return;
      }
      if (outcome === "failed") {
        // 显式单页重译失败仍按单次操作收尾，不继续翻其他页。
        if (job.forcedPage === pageState.page) {
          touchJob(job, {
            status: "failed",
            error: pageState.error,
            progress: `第 ${pageState.page} 页重译失败，已保留原有译文`
          });
          return;
        }
        failedThisRun.add(pageState.page);
        consecutiveFailures += 1;
        persistJob(job);
        if (consecutiveFailures >= PDF_MATH_MAX_CONSECUTIVE_FAILURES) {
          // 连续多页失败通常意味着整份 PDF 不被引擎支持（如 BabelDOC 的 CID 限制），
          // 继续逐页空跑只会浪费模型调用；停在 partial，用户可修复后继续。
          markPdfMathJobIncomplete(job, `连续 ${consecutiveFailures} 页翻译失败，已停止本次翻译`);
          persistJob(job);
          return;
        }
        touchJob(job, {
          progress: `第 ${pageState.page} 页排版翻译失败，已跳过；连续失败 ${consecutiveFailures} / ${PDF_MATH_MAX_CONSECUTIVE_FAILURES} 页`
        });
        continue;
      }
      // 任意一页成功即打断连续失败计数。
      consecutiveFailures = 0;
    }

    if (job.cancelRequested) {
      touchJob(job, { status: "canceled", progress: "已取消排版翻译" });
    }
  } finally {
    job.progressiveLoopActive = false;
  }
}

/**
 * 显式优先页操作（保留 /priority 兼容，不应由浏览翻页调用）。
 * 已完成页只会更新优先指针，绝不会触发重译。
 */
export function setPdfMathTranslationPriority(jobId, priorityPage, options = {}) {
  const job = resolveJob(jobId);
  if (!job) return null;
  if (!["queued", "running", "canceling"].includes(job.status)) {
    return publicPdfMathJob(job);
  }
  const next = clampPageNumber(priorityPage, job.pageCount || 1);
  const previous = clampPageNumber(job.priorityPage || 1, job.pageCount || 1);
  job.priorityPage = next;
  let woke = previous !== next;
  if (options.continueAll || options.translateMode === "all-remaining") {
    if (job.translateMode !== "all-remaining") {
      job.translateMode = "all-remaining";
      woke = true;
    }
  }
  if (woke) {
    job.priorityEpoch = (Number(job.priorityEpoch) || 0) + 1;
  }
  if (job.pages?.[next - 1]?.status !== "running") {
    markPageCompletedIfHasFiles(job.pages?.[next - 1]);
  }
  const priorityDone = pageIsDone(job.pages?.[next - 1]);
  const priorityRunning = job.pages?.[next - 1]?.status === "running" || Number(job.activePage) === next;
  const active = Number(job.activePage) || 0;
  // 仅当显式指定页尚未完成且后台在做别的页时才抢占。
  if (!priorityDone && active && active !== next) {
    job.pagePreemptRequested = true;
    job.visualAbortController?.abort(new Error("页面抢占"));
    if (job.children?.size) {
      for (const child of job.children) killProcessTree(child);
    } else if (job.child) {
      killProcessTree(job.child);
    }
    touchJob(job, {
      progress: `已指定第 ${next} 页，正在优先翻译该页（尚未完成）`
    });
  } else if (job.translateMode === "all-remaining" && options.continueAll) {
    touchJob(job, {
      progress: `继续翻译未完成页（从第 ${next} 页起，已完成页跳过）`
    });
  } else if (previous !== next) {
    touchJob(job, {
      progress: priorityDone
        ? `第 ${next} 页已完成，可直接阅读`
        : priorityRunning
          ? `第 ${next} 页仍在翻译中…`
          : `已指定第 ${next} 页，准备翻译`
    });
  } else {
    persistJob(job);
  }
  return publicPdfMathJob(job);
}

async function executePdfMathTranslation(job, prepared) {
  if (job.cancelRequested) return;
  touchJob(job, {
    status: "running",
    startedAt: Date.now(),
    progress: "正在启动 PDFMathTranslate"
  });
  let currentChild = null;
  try {
    const result = await runProcess(
      prepared.resolved.command,
      [...prepared.resolved.argsPrefix, ...prepared.invocation.args],
      {
        cwd: prepared.jobDir,
        env: prepared.env,
        timeoutMs: 45 * 60 * 1000,
        idleWarningMs: 3 * 60 * 1000,
        idleTimeoutMs: 12 * 60 * 1000,
        onSpawn: (child) => {
          currentChild = child;
          job.children.add(child);
          job.child = child;
          if (job.cancelRequested) killProcessTree(child);
        },
        onOutput: (text) => {
          touchJob(job, { progress: cleanProgress(text) }, { throttleMs: 2000 });
        },
        onIdleWarning: () => {
          touchJob(job, {
            progress: "等待模型响应已超过 5 分钟，任务仍在运行；可继续等待或手动取消"
          });
        }
      }
    );
    if (job.cancelRequested) {
      touchJob(job, { status: "canceled", progress: "已取消排版翻译" });
      return;
    }
    if (result.code !== 0) {
      const detail = tail(result.stderr || result.stdout);
      throw new Error(`PDFMathTranslate 退出码 ${result.code ?? "未知"}${detail ? `：${detail}` : ""}`);
    }
    const outputs = findPdfMathTranslateOutputs(prepared.outputDir);
    const monoPath = outputs.mono ? path.join(prepared.outputDir, outputs.mono) : "";
    const dualPath = outputs.dual ? path.join(prepared.outputDir, outputs.dual) : "";
    if (!fileLooksLikePdf(monoPath) && !fileLooksLikePdf(dualPath)) {
      throw new Error(`PDFMathTranslate 没有生成译文 PDF${tail(result.stderr || result.stdout) ? `：${tail(result.stderr || result.stdout)}` : ""}`);
    }
    job.result = {
      jobId: job.jobId,
      monoFile: fileLooksLikePdf(monoPath) ? outputs.mono : "",
      dualFile: fileLooksLikePdf(dualPath) ? outputs.dual : "",
      sourceLang: prepared.sourceLang,
      targetLang: prepared.targetLang
    };
    touchJob(job, { status: "completed", progress: "排版译文 PDF 已生成" });
  } catch (error) {
    if (job.cancelRequested) {
      touchJob(job, { status: "canceled", progress: "已取消排版翻译" });
    } else {
      touchJob(job, {
        status: "failed",
        error: error.message || "PDF 排版翻译失败",
        progress: "排版翻译失败"
      });
    }
  } finally {
    if (currentChild) job.children.delete(currentChild);
    job.child = [...job.children][0] || null;
    persistJob(job);
  }
}

function findReusableJob({ paperId, sourceSha256, sourceLang, targetLang, layoutAssist, identity, force = false } = {}) {
  if (force || !paperId) return null;
  const indexPath = paperIndexFile(paperId);
  if (!existsFile(indexPath) && !discoverPaperJobIds(paperId).length) return null;
  try {
    const index = readPaperIndex(paperId);
    const jobs = paperJobIds(paperId, index)
      .map((jobId) => resolveJob(jobId))
      .filter(Boolean)
      .filter((job) => cleanPaperId(job.paperId) === cleanPaperId(paperId))
      .filter((job) => Number(job.paperGeneration || 0) === currentPaperGeneration(cleanPaperId(paperId)))
      .filter((job) => !job.sourceLang || job.sourceLang === sourceLang)
      .filter((job) => !job.targetLang || job.targetLang === targetLang)
      // 可续译任务必须有并且匹配当前 PDF 指纹，旧无指纹快照只能查看。
      .filter((job) => !sourceSha256 || job.sourceSha256 === sourceSha256)
      .filter((job) => job.layoutAssist?.enabled === Boolean(layoutAssist?.enabled))
      .filter((job) => jobIdentityMatches(job, identity))
      .sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0));
    const job = jobs[0];
    if (!job) return null;
    if (["queued", "running", "canceling"].includes(job.status)) return { job, mode: "active" };
    if (jobAllPagesCompleted(job)) return { job, mode: "complete" };
    // 部分完成：复用已完成页，继续翻译剩余页
    if (jobHasUsablePages(job) || jobIncompletePages(job).length) return { job, mode: "resume" };
    return null;
  } catch {
    return null;
  }
}

function resumePdfMathTranslation(job, args = {}) {
  const layoutAssist = normalizeLayoutAssist(args.layoutAssist || job.layoutAssist);
  const layoutAssistDeps = args.layoutAssistDeps || {};
  const resolved = resolvePdfMathTranslateCommand(args.binary || "");
  const identityInfo = createPdfMathTranslationIdentity({
    config: args.config || {},
    sourceLang: job.sourceLang || normalizeLanguage(args.sourceLang, "en"),
    targetLang: job.targetLang || normalizeLanguage(args.targetLang, "zh"),
    sourceSha256: job.sourceSha256 || "",
    layoutAssist,
    resolved,
    configFingerprint: args.configFingerprint || ""
  });
  const prepared = {
    jobId: job.jobId,
    jobDir: path.join(JOBS_DIR, job.jobId),
    outputDir: path.join(JOBS_DIR, job.jobId, "output"),
    inputPath: path.join(JOBS_DIR, job.jobId, "source.pdf"),
    resolved,
    config: args.config || {},
    sourceLang: job.sourceLang || normalizeLanguage(args.sourceLang, "en"),
    targetLang: job.targetLang || normalizeLanguage(args.targetLang, "zh"),
    paperId: job.paperId || "",
    sourceSha256: job.sourceSha256 || "",
    layoutAssist,
    identity: identityInfo.identity,
    identityHash: identityInfo.identityHash,
    pageRenderer: layoutAssistDeps.renderer || layoutAssistDeps.renderPage || renderPdfPage,
    pageCounter: layoutAssistDeps.getPageCount || getPdfPageCount,
    visionAnalyzer: layoutAssistDeps.vision || layoutAssistDeps.analyzePage || requestPdfVisualContext,
    layoutReviewer: layoutAssistDeps.review || reviewTranslatedLayout,
    layoutAssistDeps,
    priorityPage: Number(args.priorityPage) || 1
  };
  if (!prepared.resolved) throw new Error(getPdfMathTranslateStatus(args.binary || "").installHint);
  if (!existsFile(prepared.inputPath)) throw new Error("本地版式翻译源文件已丢失，请重新开始翻译");
  ensureDirectory(prepared.outputDir);
  const invocation = buildPdfMathTranslateInvocation({
    inputPath: prepared.inputPath,
    outputDir: prepared.outputDir,
    config: prepared.config,
    sourceLang: prepared.sourceLang,
    targetLang: prepared.targetLang
  });
  const env = { ...process.env };
  delete env.OPENAI_API_KEY;
  delete env.OPENAI_BASE_URL;
  delete env.OPENAI_MODEL;
  Object.assign(env, invocation.env);
  applyPdfMathLlmProxyEnv(env);
  prepared.invocation = invocation;
  prepared.env = env;

  job.cancelRequested = false;
  job.layoutAssist = layoutAssist;
  job.pagePreemptRequested = false;
  job.error = "";
  job.child = null;
  job.children = new Set();
  job.priorityPage = clampPageNumber(args.priorityPage || 1, job.pageCount || Number(args.pageCount) || 1);
  job.activePage = job.activePage || 0;
  const retranslatePage = Number(args.retranslatePage) || 0;
  if (retranslatePage && (!Number.isInteger(retranslatePage) || retranslatePage < 1 || retranslatePage > (job.pageCount || 0))) {
    throw new Error("指定的页码无效");
  }
  if (retranslatePage) {
    const pageState = job.pages?.[retranslatePage - 1];
    if (!pageState) throw new Error("指定的页码无效");
    job.forcedPage = retranslatePage;
    pageState.status = "queued";
    pageState.progress = "准备重新翻译本页";
    pageState.error = "";
    // Keep previous output and provenance until the replacement is validated.
    pageState.retriedOnce = false;
    pageState.layoutQa = null;
  }
  job.translateMode = "all-remaining";
  prepared.continueAll = !retranslatePage;
  prepared.translateMode = job.translateMode;
  if (!Array.isArray(job.pages) || !job.pages.length) {
    const pageCount = Number(args.pageCount) || job.pageCount || 0;
    job.pageCount = pageCount;
    job.pages = createPageStates(pageCount, layoutAssist);
  }
  hydratePagesFromOutputDir(job, { skipPage: retranslatePage });
  PDF_MATH_JOBS.set(job.jobId, job);
  persistJob(job);
  void executePdfMathTranslationProgressive(job, prepared);
  return publicPdfMathJob(job);
}

export function startPdfMathTranslation(args = {}) {
  const paperId = cleanPaperId(args.paperId);
  if (paperId && DELETING_PAPERS.has(paperId)) throw new Error("文献正在删除，暂不能启动版式翻译");
  const paperGeneration = currentPaperGeneration(paperId) + (paperId && CLEARED_PAPERS.has(paperId) ? 1 : 0);
  if (paperId) PAPER_GENERATIONS.set(paperId, paperGeneration);
  if (paperId) CLEARED_PAPERS.delete(paperId);
  const from = normalizeLanguage(args.sourceLang, "en");
  const to = normalizeLanguage(args.targetLang, "zh");
  const layoutAssist = normalizeLayoutAssist(args.layoutAssist);
  const retranslatePage = Number(args.retranslatePage) || 0;
  const continueAll = !retranslatePage;
  let requestedSourceSha256 = "";
  try {
    const probe = Buffer.from(String(args.data || ""), "base64");
    if (isPdfBuffer(probe)) requestedSourceSha256 = sha256Buffer(probe);
  } catch {
    requestedSourceSha256 = "";
  }
  const requestedIdentity = createPdfMathTranslationIdentity({
    config: args.config || {},
    sourceLang: from,
    targetLang: to,
    sourceSha256: requestedSourceSha256,
    layoutAssist,
    binary: args.binary || "",
    configFingerprint: args.configFingerprint || ""
  });
  // 旧 job 因术语表更新而不宜续译时记录在这里，新任务会带上明确原因供前端提示。
  let replacedJob = null;

  // A single-page request must never fall through to a fresh whole-document
  // job. The selected job is the only safe source of its other pages.
  if (retranslatePage) {
    if (!Number.isInteger(retranslatePage) || retranslatePage < 1) throw new Error("指定的页码无效");
    if (!args.jobId) throw new Error("无法确认原翻译任务，已保留现有译文；请重新打开文献后再试");
    const selected = resolveJob(args.jobId);
    const samePaper = paperId ? cleanPaperId(selected?.paperId) === paperId : !cleanPaperId(selected?.paperId);
    const sameSource = Boolean(requestedSourceSha256) && selected?.sourceSha256 === requestedSourceSha256;
    const sameGeneration = Number(selected?.paperGeneration || 0) === paperGeneration;
    if (!selected || !samePaper || !sameSource || !sameGeneration) throw new Error("原翻译任务或 PDF 不匹配，已保留现有译文；请重新打开文献后再试");
    if ((selected.layoutAssist?.enabled === true) !== layoutAssist.enabled || selected.sourceLang !== from || selected.targetLang !== to) throw new Error("原任务的语言或辅助模式与当前设置不同，已保留现有译文");
    if (["queued", "running", "canceling"].includes(selected.status)) throw new Error("当前翻译任务仍在运行，请等待完成后再重译此页");
    if (retranslatePage > (selected.pageCount || 0)) throw new Error("指定的页码无效");
    return resumePdfMathTranslation(selected, { ...args, continueAll: false });
  }

  // 前端带着已有 jobId 续译：不依赖 paperId，已完成页直接跳过
  if (!args.force && args.jobId) {
    const existing = resolveJob(args.jobId);
    const samePaper = paperId
      ? cleanPaperId(existing?.paperId) === paperId
      : !cleanPaperId(existing?.paperId);
    const sameGeneration = Number(existing?.paperGeneration || 0) === paperGeneration;
    if (!existing || !samePaper || !sameGeneration) throw new Error("无法确认原翻译任务，已保留现有译文；请重新打开文献后再试");
    if (!requestedSourceSha256 || existing.sourceSha256 !== requestedSourceSha256 || existing.sourceLang !== from || existing.targetLang !== to || (existing.layoutAssist?.enabled === true) !== layoutAssist.enabled) throw new Error("原任务的 PDF、语言或辅助模式与当前设置不同，已保留现有译文");
    const staleReason = jobGlossaryStaleReason(existing, requestedIdentity);
    if (staleReason) {
      // 术语表变了：旧页不能复用，也不能假装续译成功。保留旧译文，自动开新任务重新翻译。
      replacedJob = { jobId: existing.jobId, reason: staleReason };
    } else if (existing && samePaper && sameGeneration) {
      hydratePagesFromOutputDir(existing);
      recountCompletedPages(existing);
      if (["queued", "running", "canceling"].includes(existing.status)) {
        if (retranslatePage) throw new Error("当前翻译任务仍在运行，请等待完成后再重译此页");
        return setPdfMathTranslationPriority(
          existing.jobId,
          args.priorityPage || 1,
          { continueAll }
        ) || publicPdfMathJob(existing);
      }
      if (jobAllPagesCompleted(existing) && !retranslatePage) {
        return publicPdfMathJob(existing);
      }
      if (jobHasUsablePages(existing) || jobIncompletePages(existing).length) {
        return resumePdfMathTranslation(existing, { ...args, continueAll });
      }
    }
  }

  // 仅当带 paperId 且未强制重跑时，可先用 sha 探测可复用任务；无 data 时不预判
  if (paperId && !args.force && args.data) {
    try {
      const probe = Buffer.from(String(args.data || ""), "base64");
      if (isPdfBuffer(probe)) {
        const reusable = findReusableJob({
          paperId,
          sourceSha256: sha256Buffer(probe),
          sourceLang: from,
          targetLang: to,
          layoutAssist,
          identity: requestedIdentity,
          force: false
        });
        if (reusable?.mode === "active") {
          if (retranslatePage) throw new Error("当前翻译任务仍在运行，请等待完成后再重译此页");
          // 活跃任务：仅显式启动/续译请求可更新起始页，不与浏览页绑定。
          return setPdfMathTranslationPriority(
            reusable.job.jobId,
            args.priorityPage || 1,
            { continueAll }
          ) || publicPdfMathJob(reusable.job);
        }
        if (reusable?.mode === "complete") {
          if (retranslatePage) return resumePdfMathTranslation(reusable.job, { ...args, continueAll: false });
          return publicPdfMathJob(reusable.job);
        }
        if (reusable?.mode === "resume" && Array.isArray(reusable.job.pages) && reusable.job.pages.length) {
          return resumePdfMathTranslation(reusable.job, { ...args, continueAll });
        }
      }
    } catch (error) {
      throw error;
    }
  }

  const prepared = preparePdfMathTranslation({ ...args, paperId, layoutAssist, configFingerprint: args.configFingerprint || "" });
  prepared.priorityPage = Number(args.priorityPage) || 1;
  prepared.continueAll = continueAll;
  prepared.translateMode = "all-remaining";
  let requestedPageCount = Number(args.pageCount);
  if (layoutAssist.enabled && (!Number.isInteger(requestedPageCount) || requestedPageCount < 1)) {
    try {
      requestedPageCount = Number(prepared.pageCounter(prepared.inputPath)) || 0;
    } catch {
      requestedPageCount = 0;
    }
  }
  const progressive = layoutAssist.enabled
    ? Number.isInteger(requestedPageCount) && requestedPageCount > 0
    : args.progressive !== false && Number.isInteger(requestedPageCount) && requestedPageCount > 1;
  const now = Date.now();
  const job = {
    jobId: prepared.jobId,
    paperId: prepared.paperId,
    status: "queued",
    progress: "任务已排队",
    error: "",
    result: null,
    child: null,
    children: new Set(),
    cancelRequested: false,
    pagePreemptRequested: false,
    priorityPage: clampPageNumber(prepared.priorityPage, progressive ? requestedPageCount : 1),
    activePage: 0,
    translateMode: "all-remaining",
    updatedAt: now,
    startedAt: null,
    pageCount: progressive ? requestedPageCount : 0,
    completedPages: 0,
    pages: progressive ? createPageStates(requestedPageCount, layoutAssist) : [],
    sourceLang: prepared.sourceLang,
    targetLang: prepared.targetLang,
    sourceSha256: prepared.sourceSha256,
    paperGeneration,
    layoutAssist,
    identity: prepared.identity,
    identityHash: prepared.identityHash,
    ...(replacedJob ? {
      staleReason: replacedJob.reason,
      supersededJobId: replacedJob.jobId
    } : {})
  };
  if (replacedJob) {
    job.progress = "术语表已更新，正在按新术语表重新翻译（旧译文已保留）";
  }
  PDF_MATH_JOBS.set(job.jobId, job);
  persistJob(job);
  void (progressive ? executePdfMathTranslationProgressive(job, prepared) : executePdfMathTranslation(job, prepared));
  return publicPdfMathJob(job);
}

export function getPdfMathTranslationJob(jobId) {
  return publicPdfMathJob(resolveJob(jobId));
}

/** 仅测试用：从内存卸下任务，验证重启后可从 job.json 恢复 */
export function unloadPdfMathTranslationJob(jobId) {
  PDF_MATH_JOBS.delete(String(jobId || ""));
}

export function setPdfMathPaperDeleting(paperId, deleting = true) {
  const id = cleanPaperId(paperId);
  if (!id) return;
  if (deleting) DELETING_PAPERS.add(id);
  else DELETING_PAPERS.delete(id);
}

export async function clearPdfMathTranslationsForPaper(paperId) {
  const id = cleanPaperId(paperId);
  if (!id) return;
  const clearGeneration = currentPaperGeneration(id) + 1;
  PAPER_GENERATIONS.set(id, clearGeneration);
  // 先立墓碑，避免被取消任务的 finally 再写回 job.json 或 paper 索引。
  CLEARED_PAPERS.add(id);
  const index = readPaperIndex(id);
  const jobIds = new Set(paperJobIds(id, index));
  for (const job of PDF_MATH_JOBS.values()) {
    if (cleanPaperId(job.paperId) !== id) continue;
    jobIds.add(job.jobId);
    if (!PDF_MATH_TERMINAL_JOB_STATUSES.has(job.status)) cancelPdfMathTranslation(job.jobId);
  }
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const active = [...jobIds].some((jobId) => {
      const job = resolveJob(jobId);
      return job && !PDF_MATH_TERMINAL_JOB_STATUSES.has(job.status);
    });
    if (!active) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  if ([...jobIds].some((jobId) => {
    const job = resolveJob(jobId);
    return job && !PDF_MATH_TERMINAL_JOB_STATUSES.has(job.status);
  })) {
    throw new Error("版式翻译任务仍在停止，暂未删除缓存");
  }
  const generationChanged = currentPaperGeneration(id) !== clearGeneration;
  for (const jobId of jobIds) {
    if (!/^[a-f0-9-]{20,}$/i.test(jobId)) continue;
    PDF_MATH_JOBS.delete(jobId);
    fs.rmSync(path.join(JOBS_DIR, jobId), { recursive: true, force: true });
  }
  // 新任务若在清理期间启动，只删除本轮旧任务，保留新任务索引。
  if (generationChanged) return;
  const indexFile = paperIndexFile(id);
  if (indexFile && fs.existsSync(indexFile)) fs.rmSync(indexFile, { force: true });
}

export function cancelPdfMathTranslation(jobId) {
  const job = resolveJob(jobId);
  if (!job) return null;
  if (PDF_MATH_TERMINAL_JOB_STATUSES.has(job.status)) return publicPdfMathJob(job);
  job.cancelRequested = true;
  job.visualAbortController?.abort(new Error("任务取消"));
  touchJob(job, { status: "canceling", progress: "正在停止排版翻译" });
  if (job.children?.size) {
    for (const child of job.children) killProcessTree(child);
  } else if (job.child) {
    killProcessTree(job.child);
  }
  return publicPdfMathJob(job);
}

export function buildPdfMathTranslateInvocation({ inputPath, outputDir, config = {}, sourceLang = "en", targetLang = "zh", page = 0, pageContext = null } = {}) {
  ensurePdf2zhListMarkerPatch();
  const from = normalizeLanguage(sourceLang, "en");
  const to = normalizeLanguage(targetLang, "zh");
  const baseUrl = String(config.baseUrl || "").trim().replace(/\/+$/, "");
  const apiKey = String(config.apiKey || "").trim();
  const model = String(config.model || "").trim();
  const speed = getPdfMathSpeedOptions(config);
  const glossaryPath = getAcademicGlossaryPath();
  const baseSystemPrompt = String(config.pdfMathSystemPrompt || ACADEMIC_ZH_SYSTEM_PROMPT).trim();
  const systemPrompt = pageContext ? compileLayoutAssistPrompt(baseSystemPrompt, pageContext) : baseSystemPrompt;
  const fontFamily = String(config.pdfMathFontFamily || "").trim();
  // 通顺 + 对齐观感：
  // - 学术中文 prompt + 静态术语表（术语一致）
  // - 默认不锁死 serif/关富文本：让 BabelDOC 按原文 span 保留颜色和粗细
  // - 公式字符模式（少拆公式）
  // - 去水印；按页时只输出已译页
  // 加速策略保留：更高 qps/workers、跳过扫描检测与自动抽术语
  const args = [
      inputPath,
      "--output",
      outputDir,
      "--lang-in",
      from,
      "--lang-out",
      to,
      "--openai",
      "--openai-timeout",
      // 推理型模型单批响应较慢，45s 会让批量请求超时回退、残留英文段落
      "90",
      "--openai-temperature",
      "0.1",
      // 部分兼容接口不认 temperature；仅在显式开启时发送，避免拒参/重试拖死
      ...(config.pdfMathSendTemperature === true || process.env.PDFMATH_SEND_TEMPERATURE === "1"
        ? ["--openai-send-temprature"]
        : []),
      "--qps",
      String(speed.qps),
      "--pool-max-workers",
      String(speed.workers),
      "--no-auto-extract-glossary",
      "--skip-scanned-detection",
      "--watermark-output-mode",
      "no_watermark",
      "--formular-char-pattern",
      FORMULAR_CHAR_PATTERN,
      "--min-text-length",
      "2"
    ];
  if (systemPrompt) {
    args.push("--custom-system-prompt", systemPrompt);
  }
  // 仅当显式指定时才锁字体族 / 关掉富文本（默认跟原文颜色和字重）
  if (fontFamily) {
    args.push("--primary-font-family", fontFamily);
  }
  if (config.pdfMathDisableRichText === true || process.env.PDFMATH_DISABLE_RICH_TEXT === "1") {
    args.push("--disable-rich-text-translate");
  }
  if (existsFile(glossaryPath) && config.pdfMathNoGlossary !== true) {
    args.push("--glossaries", glossaryPath);
  }
  // 可选：只出纯中文 mono，减少 dual 后处理（默认仍双出；config.pdfMathNoDual=true 时加速）
  if (config.pdfMathNoDual === true || process.env.PDFMATH_TRANSLATE_NO_DUAL === "1") {
    args.push("--no-dual");
  }
  if (Number.isInteger(page) && page > 0) {
    args.push("--pages", String(page), "--only-include-translated-page");
  }
  return {
    args,
    env: {
      PDF2ZH_OPENAI_BASE_URL: baseUrl,
      PDF2ZH_OPENAI_API_KEY: apiKey,
      PDF2ZH_OPENAI_MODEL: model
    }
  };
}

export function getPdfMathTranslateFile(jobId, fileName) {
  if (!/^[a-f0-9-]{20,}$/i.test(String(jobId || ""))) return null;
  if (!/^[A-Za-z0-9._-]+\.pdf$/i.test(String(fileName || ""))) return null;
  const jobDir = path.resolve(JOBS_DIR, String(jobId));
  const candidates = [
    path.resolve(jobDir, String(fileName)),
    path.resolve(jobDir, "output", String(fileName))
  ];
  return candidates.find((file) => file.startsWith(`${jobDir}${path.sep}`) && fileLooksLikePdf(file)) || null;
}

export async function translatePdfWithMath({ data, config = {}, sourceLang = "en", targetLang = "zh", binary = "" } = {}) {
  const started = startPdfMathTranslation({ data, config, sourceLang, targetLang, binary });
  for (;;) {
    const job = getPdfMathTranslationJob(started.jobId);
    if (!job || job.status === "failed") throw new Error(job?.error || "PDF 排版翻译任务不存在");
    if (job.status === "completed") return job.result;
    if (job.status === "canceled") throw new Error("PDF 排版翻译已取消");
    if (job.status === "partial") throw new Error(job.progress || "PDF 排版翻译仍有未完成页，请继续翻译");
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}
