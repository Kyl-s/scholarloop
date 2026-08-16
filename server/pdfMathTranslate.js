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
import { restorePreservedPageOutputs } from "./pdfPreserveRegions.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const JOBS_DIR = path.join(ROOT, "data", "pdf-translations");
const PAPER_INDEX_DIR = path.join(JOBS_DIR, "by-paper");
const WINDOWS_COMMAND_NAMES = ["pdf2zh.exe", "pdf2zh.cmd", "pdf2zh"];
const POSIX_COMMAND_NAMES = ["pdf2zh"];
const PDF_MATH_JOBS = new Map();
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

function jobSnapshotPath(jobId) {
  return path.join(JOBS_DIR, String(jobId || ""), "job.json");
}

function sha256Buffer(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
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
    priorityPage: job.priorityPage || 1,
    activePage: job.activePage || 0,
    translateMode: job.translateMode === "all-remaining" ? "all-remaining" : "reading-window",
    pages: Array.isArray(job.pages) ? job.pages.map((page) => ({ ...page })) : [],
    sourceLang: job.sourceLang || "en",
    targetLang: job.targetLang || "zh",
    sourceSha256: job.sourceSha256 || ""
  };
}

function jobHasUsablePages(job) {
  if (!job) return false;
  if (job.result?.monoFile || job.result?.dualFile) return true;
  return (job.pages || []).some((page) => page?.status === "completed" && (page.monoFile || page.dualFile));
}

function hydratePagesFromOutputDir(job) {
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
  for (const name of files) {
    const match = String(name).match(/^page-(\d+)\.zh\.(mono|dual)\.pdf$/i);
    if (!match) continue;
    const page = Number(match[1]);
    const kind = match[2].toLowerCase();
    const current = pageMap.get(page) || {
      page,
      status: "completed",
      progress: "本页排版译文已生成",
      error: "",
      monoFile: "",
      dualFile: ""
    };
    if (kind === "mono") current.monoFile = name;
    if (kind === "dual") current.dualFile = name;
    current.status = "completed";
    current.progress = current.progress || "本页排版译文已生成";
    current.error = "";
    pageMap.set(page, current);
  }
  if (!pageMap.size && (job.result?.monoFile || job.result?.dualFile)) return job;
  if (pageMap.size) {
    job.pages = [...pageMap.values()].sort((a, b) => a.page - b.page);
    job.completedPages = job.pages.filter((page) => page.status === "completed").length;
    if (!job.pageCount) job.pageCount = job.pages.length;
  }
  return job;
}

function finalizeInterruptedJob(job) {
  if (!job) return null;
  hydratePagesFromOutputDir(job);
  if (["queued", "running", "canceling"].includes(job.status)) {
    if (jobHasUsablePages(job)) {
      for (const page of job.pages || []) {
        if (page.status !== "completed") {
          page.status = "canceled";
          page.progress = "未完成（服务重启后中断）";
        }
      }
      job.status = "completed";
      job.progress = `已从本地恢复 ${job.completedPages || 0} 页版式译文`;
      job.error = "";
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
  }
  job.child = null;
  job.children = new Set();
  job.cancelRequested = false;
  return job;
}

function persistJob(job) {
  if (!job?.jobId) return;
  try {
    ensureDirectory(path.join(JOBS_DIR, job.jobId));
    writeJsonAtomic(jobSnapshotPath(job.jobId), serializableJob(job));
    const paperId = cleanPaperId(job.paperId);
    if (paperId) {
      writeJsonAtomic(paperIndexFile(paperId), {
        paperId,
        jobId: job.jobId,
        status: job.status,
        sourceLang: job.sourceLang || "en",
        targetLang: job.targetLang || "zh",
        sourceSha256: job.sourceSha256 || "",
        updatedAt: job.updatedAt || Date.now()
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

export function getPdfMathTranslationForPaper(paperId, { sourceLang = "", targetLang = "" } = {}) {
  const id = cleanPaperId(paperId);
  if (!id) return null;
  const indexPath = paperIndexFile(id);
  if (!existsFile(indexPath)) return null;
  try {
    const index = JSON.parse(fs.readFileSync(indexPath, "utf8"));
    const job = resolveJob(index?.jobId);
    if (!job) return null;
    if (sourceLang && job.sourceLang && job.sourceLang !== normalizeLanguage(sourceLang, job.sourceLang)) return null;
    if (targetLang && job.targetLang && job.targetLang !== normalizeLanguage(targetLang, job.targetLang)) return null;
    return publicPdfMathJob(job);
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

function boundedPositiveInt(value, fallback, maximum = 16) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(maximum, Math.max(1, Math.round(parsed)));
}

// 单页内全力：提高 qps / pool workers；页与页之间默认串行（阅读顺序）
const DEFAULT_PDFMATH_QPS = 12;
const DEFAULT_PDFMATH_WORKERS = 8;
// 阅读策略：同一时刻只全力做 1 页（下一页通过串行队列预取，不并行抢资源）
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
 * 全书阅读顺序（仅用于展示/兼容）：当前页 → 向后 → 再补前面
 * 实际调度见 buildPdfMathWorkWindow：只做当前页 + 下一页预取
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
 * 阅读窗口：只全力做当前阅读页，并最多预取下一页。
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
    pageState.error = "";
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
 * reading-window：只认领当前页+下一页
 * all-remaining：按阅读顺序认领所有未完成页（跳过已完成，绝不重译）
 */
export function pickNextPdfMathPage(job) {
  if (!job?.pages?.length) return null;
  const total = job.pageCount || job.pages.length;
  const priority = job.priorityPage || 1;
  const order = job.translateMode === "all-remaining"
    ? buildPdfMathPageOrder(total, priority)
    : buildPdfMathWorkWindow(total, priority);
  for (const pageNumber of order) {
    const pageState = job.pages[pageNumber - 1];
    if (pageNeedsWork(pageState)) {
      pageState.status = "running";
      pageState.progress = pageNumber === Number(job.priorityPage)
        ? `准备全力翻译第 ${pageNumber} 页`
        : job.translateMode === "all-remaining"
          ? `准备翻译第 ${pageNumber} 页（续译未完成页）`
          : `准备预取第 ${pageNumber} 页`;
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
    if (page.status !== "running") markPageCompletedIfHasFiles(page);
  }
  job.completedPages = job.pages.filter((page) => pageIsDone(page)).length;
  return job.completedPages;
}

function describePageWork(job, page) {
  const reading = Number(job?.priorityPage) || page;
  if (Number(page) === reading) {
    return {
      short: `正在全力翻译第 ${page} 页`,
      detail: `正在全力翻译第 ${page} / ${job.pageCount || "?"} 页（当前阅读页）`
    };
  }
  return {
    short: `正在预取第 ${page} 页`,
    detail: `正在预取第 ${page} 页（你当前在第 ${reading} 页，第 ${page} 页尚未就绪）`
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jobAllPagesCompleted(job) {
  if (!job) return false;
  if (job.status === "completed" && (!job.pages?.length || job.pages.every((page) => page.status === "completed"))) {
    return true;
  }
  return Array.isArray(job.pages)
    && job.pages.length > 0
    && job.pages.every((page) => page.status === "completed" && (page.monoFile || page.dualFile));
}

function jobIncompletePages(job) {
  return (job?.pages || []).filter((page) => page.status !== "completed" || !(page.monoFile || page.dualFile));
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

function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const stdout = [];
    const stderr = [];
    let settled = false;
    let idleTimer;
    let idleWarningTimer;
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      windowsHide: true,
      shell: process.platform === "win32" && /\.(cmd|bat)$/i.test(command)
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
    priorityPage: job.priorityPage || 1,
    activePage: job.activePage || 0,
    translateMode: job.translateMode === "all-remaining" ? "all-remaining" : "reading-window",
    pages: Array.isArray(job.pages) ? job.pages.map((page) => ({ ...page })) : [],
    sourceLang: job.sourceLang || "en",
    targetLang: job.targetLang || "zh",
    sourceSha256: job.sourceSha256 || "",
    persisted: true
  };
}

function preparePdfMathTranslation({ data, config = {}, sourceLang = "en", targetLang = "zh", binary = "", paperId = "" } = {}) {
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

function createPageStates(pageCount) {
  return Array.from({ length: pageCount }, (_, index) => ({
    page: index + 1,
    status: "queued",
    progress: "等待处理",
    error: "",
    monoFile: "",
    dualFile: ""
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
  try {
    if (!existsFile(filePath)) return false;
    const stat = fs.statSync(filePath);
    // 空文件/目录不算产物；未写完的 0 字节残留不能当「已就绪」
    if (!stat.isFile() || stat.size < 1) return false;
    return true;
  } catch {
    return false;
  }
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
  recountCompletedPages(job);
  return true;
}

async function executePdfMathTranslationPage(job, prepared, pageState) {
  const page = pageState.page;
  // 开始前：仅当非 running 且磁盘已有合法 PDF 才跳过
  if (pageState.status !== "running") {
    pageState.status = "queued";
  }
  // 认领后先进入 running，再检查磁盘；检查时允许用合法成品跳过
  pageState.status = "running";
  pageState.monoFile = "";
  pageState.dualFile = "";
  pageState.error = "";
  if (promoteExistingPageOutput(job, prepared, pageState, { allowWhileRunning: true })) {
    recountCompletedPages(job);
    touchJob(job, {
      progress: `第 ${page} 页译文已存在，跳过重译（${job.completedPages} / ${job.pageCount} 页）`
    });
    return "completed";
  }

  const pageDir = path.join(prepared.jobDir, "pages", pageFilePrefix(page));
  const pageOutputDir = path.join(pageDir, "output");
  fs.mkdirSync(pageOutputDir, { recursive: true });
  const invocation = buildPdfMathTranslateInvocation({
    inputPath: prepared.inputPath,
    outputDir: pageOutputDir,
    config: prepared.config,
    sourceLang: prepared.sourceLang,
    targetLang: prepared.targetLang,
    page
  });
  const work = describePageWork(job, page);
  pageState.progress = work.short;
  job.activePage = page;
  job.pagePreemptRequested = false;
  touchJob(job, { progress: work.detail });
  let currentChild = null;
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
      pageState.status = "canceled";
      pageState.progress = "已取消";
      persistJob(job);
      return "canceled";
    }
    if (wasPagePreempted(job)) {
      // 抢占后仅当磁盘上已有合法成品才算完成；否则回队列，绝不假装就绪
      if (promoteExistingPageOutput(job, prepared, pageState, { allowWhileRunning: true })) {
        job.pagePreemptRequested = false;
        touchJob(job, { progress: `第 ${page} 页已完成，切换到新的阅读页` });
        return "completed";
      }
      requeuePageState(pageState, "已让出给当前阅读页");
      pageState.monoFile = "";
      pageState.dualFile = "";
      job.pagePreemptRequested = false;
      persistJob(job);
      return "preempted";
    }
    if (result.code !== 0) {
      if (promoteExistingPageOutput(job, prepared, pageState, { allowWhileRunning: true })) {
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
      if (promoteExistingPageOutput(job, prepared, pageState, { allowWhileRunning: true })) {
        touchJob(job, { progress: `第 ${page} 页译文已生成（${job.completedPages} / ${job.pageCount}）` });
        return "completed";
      }
      throw new Error(`PDFMathTranslate 第 ${page} 页没有生成译文 PDF`);
    }
    const monoFile = translatedPageFileName(page, "mono");
    const dualFile = translatedPageFileName(page, "dual");
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
    pageState.status = "completed";
    pageState.progress = "本页排版译文已生成";
    pageState.monoFile = finalMono;
    pageState.dualFile = finalDual;
    restorePreservedPageOutputs(
      prepared.inputPath,
      finalMono ? destMono : "",
      finalDual ? destDual : "",
      page
    );
    recountCompletedPages(job);
    const reading = Number(job.priorityPage) || page;
    touchJob(job, {
      progress: Number(page) === reading
        ? `第 ${page} 页已完成，可阅读`
        : `第 ${page} 页预取完成（你当前在第 ${reading} 页）`
    });
    return "completed";
  } catch (error) {
    if (job.cancelRequested) {
      pageState.status = "canceled";
      pageState.progress = "已取消";
      pageState.monoFile = "";
      pageState.dualFile = "";
      persistJob(job);
      return "canceled";
    }
    if (wasPagePreempted(job)) {
      if (promoteExistingPageOutput(job, prepared, pageState, { allowWhileRunning: true })) {
        job.pagePreemptRequested = false;
        return "completed";
      }
      requeuePageState(pageState, "已让出给当前阅读页");
      pageState.monoFile = "";
      pageState.dualFile = "";
      job.pagePreemptRequested = false;
      persistJob(job);
      return "preempted";
    }
    if (promoteExistingPageOutput(job, prepared, pageState, { allowWhileRunning: true })) {
      return "completed";
    }
    pageState.status = "failed";
    pageState.error = error.message || `第 ${page} 页排版翻译失败`;
    pageState.progress = "本页排版翻译失败";
    pageState.monoFile = "";
    pageState.dualFile = "";
    persistJob(job);
    return "failed";
  } finally {
    if (job.activePage === page) job.activePage = 0;
    if (currentChild) job.children.delete(currentChild);
    job.child = [...job.children][0] || null;
    persistJob(job);
  }
}

function finishProgressiveJobSuccess(job, prepared) {
  recountCompletedPages(job);
  job.result = {
    jobId: job.jobId,
    pages: job.pages,
    sourceLang: prepared.sourceLang,
    targetLang: prepared.targetLang
  };
  touchJob(job, {
    status: "completed",
    progress: `全部版式译文已完成（${job.completedPages} / ${job.pageCount} 页）`
  });
}

function waitingProgressMessage(job) {
  const priority = clampPageNumber(job.priorityPage || 1, job.pageCount || 1);
  const next = priority + 1;
  const priorityDone = pageIsDone(job.pages?.[priority - 1]);
  const nextDone = next > (job.pageCount || 0) || pageIsDone(job.pages?.[next - 1]);
  const active = Number(job.activePage) || 0;
  if (active) {
    return describePageWork(job, active).detail;
  }
  if (priorityDone && nextDone && next <= (job.pageCount || 0)) {
    return `第 ${priority}、${next} 页均已完成，翻到新页后继续（已完成 ${job.completedPages}/${job.pageCount}）`;
  }
  if (priorityDone) {
    return `第 ${priority} 页已完成，可阅读；翻页后自动翻译新页（已完成 ${job.completedPages}/${job.pageCount}）`;
  }
  return `第 ${priority} 页尚未完成（已完成 ${job.completedPages}/${job.pageCount}）`;
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
      if (markPageCompletedIfHasFiles(pageState)) continue;
      if (pageState.status === "failed" || pageState.status === "canceled" || pageState.status === "running") {
        // 残留 running（进程已死）回收为 queued
        requeuePageState(pageState);
      }
      // 磁盘上已有 output 时直接恢复
      promoteExistingPageOutput(job, prepared, pageState);
    }
    if (prepared.continueAll || prepared.translateMode === "all-remaining") {
      job.translateMode = "all-remaining";
    } else if (!job.translateMode) {
      job.translateMode = "reading-window";
    }
    recountCompletedPages(job);
    const modeLabel = job.translateMode === "all-remaining"
      ? `续译未完成页（从第 ${priorityPage} 页起，已完成页自动跳过）`
      : `阅读模式：只译当前页并预取下一页（第 ${priorityPage} 页）`;
    touchJob(job, {
      status: "running",
      startedAt: job.startedAt || Date.now(),
      progress: modeLabel
    });

    while (!job.cancelRequested) {
      recountCompletedPages(job);
      if ((job.pageCount || 0) > 0 && (job.pages || []).every((p) => pageIsDone(p))) {
        finishProgressiveJobSuccess(job, prepared);
        return;
      }

      const pageState = pickNextPdfMathPage(job);
      if (!pageState) {
        if ((job.pages || []).every((p) => pageIsDone(p))) {
          finishProgressiveJobSuccess(job, prepared);
          return;
        }
        // 续译模式：没有可做的页就结束（已完成的不会重来）
        if (job.translateMode === "all-remaining") {
          finishProgressiveJobSuccess(job, prepared);
          return;
        }
        // 阅读窗口模式：本页+下一页做完后停住，等翻页或用户点「继续翻译剩余」
        const epoch = Number(job.priorityEpoch) || 0;
        const modeEpoch = String(job.translateMode || "reading-window");
        touchJob(job, {
          status: "running",
          progress: waitingProgressMessage(job)
        });
        while (
          !job.cancelRequested
          && (Number(job.priorityEpoch) || 0) === epoch
          && String(job.translateMode || "reading-window") === modeEpoch
        ) {
          recountCompletedPages(job);
          if ((job.pages || []).every((p) => pageIsDone(p))) {
            finishProgressiveJobSuccess(job, prepared);
            return;
          }
          await sleep(250);
        }
        continue;
      }

      const outcome = await executePdfMathTranslationPage(job, prepared, pageState);
      if (outcome === "canceled") {
        touchJob(job, { status: "canceled", progress: "已取消排版翻译" });
        return;
      }
      if (outcome === "failed") {
        touchJob(job, {
          status: "failed",
          error: pageState.error,
          progress: `第 ${pageState.page} 页排版翻译失败，已保留此前已完成页面`
        });
        return;
      }
    }

    if (job.cancelRequested) {
      touchJob(job, { status: "canceled", progress: "已取消排版翻译" });
    }
  } finally {
    job.progressiveLoopActive = false;
  }
}

/**
 * 阅读翻页 / 续译模式切换。
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
  // 仅当「当前阅读页还没真正完成」且后台在做别的页时才抢占
  if (!priorityDone && active && active !== next) {
    job.pagePreemptRequested = true;
    if (job.children?.size) {
      for (const child of job.children) killProcessTree(child);
    } else if (job.child) {
      killProcessTree(job.child);
    }
    touchJob(job, {
      progress: `已翻到第 ${next} 页，正在优先全力翻译该页（尚未完成）`
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
          : `已翻到第 ${next} 页，准备翻译`
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
    if (!existsFile(monoPath) && !existsFile(dualPath)) {
      throw new Error(`PDFMathTranslate 没有生成译文 PDF${tail(result.stderr || result.stdout) ? `：${tail(result.stderr || result.stdout)}` : ""}`);
    }
    job.result = {
      jobId: job.jobId,
      monoFile: existsFile(monoPath) ? outputs.mono : "",
      dualFile: existsFile(dualPath) ? outputs.dual : "",
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

function findReusableJob({ paperId, sourceSha256, sourceLang, targetLang, force = false } = {}) {
  if (force || !paperId) return null;
  const indexPath = paperIndexFile(paperId);
  if (!existsFile(indexPath)) return null;
  try {
    const index = JSON.parse(fs.readFileSync(indexPath, "utf8"));
    const job = resolveJob(index?.jobId);
    if (!job) return null;
    if (job.sourceLang && job.sourceLang !== sourceLang) return null;
    if (job.targetLang && job.targetLang !== targetLang) return null;
    if (sourceSha256 && job.sourceSha256 && job.sourceSha256 !== sourceSha256) return null;
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
  const prepared = {
    jobId: job.jobId,
    jobDir: path.join(JOBS_DIR, job.jobId),
    outputDir: path.join(JOBS_DIR, job.jobId, "output"),
    inputPath: path.join(JOBS_DIR, job.jobId, "source.pdf"),
    resolved: resolvePdfMathTranslateCommand(args.binary || ""),
    config: args.config || {},
    sourceLang: job.sourceLang || normalizeLanguage(args.sourceLang, "en"),
    targetLang: job.targetLang || normalizeLanguage(args.targetLang, "zh"),
    paperId: job.paperId || "",
    sourceSha256: job.sourceSha256 || "",
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
  job.pagePreemptRequested = false;
  job.error = "";
  job.child = null;
  job.children = new Set();
  job.priorityPage = clampPageNumber(args.priorityPage || job.priorityPage || 1, job.pageCount || Number(args.pageCount) || 1);
  job.activePage = job.activePage || 0;
  if (args.continueAll || args.translateMode === "all-remaining") {
    job.translateMode = "all-remaining";
  } else if (!job.translateMode) {
    job.translateMode = "reading-window";
  }
  prepared.continueAll = job.translateMode === "all-remaining";
  prepared.translateMode = job.translateMode;
  if (!Array.isArray(job.pages) || !job.pages.length) {
    const pageCount = Number(args.pageCount) || job.pageCount || 0;
    job.pageCount = pageCount;
    job.pages = createPageStates(pageCount);
  }
  hydratePagesFromOutputDir(job);
  PDF_MATH_JOBS.set(job.jobId, job);
  persistJob(job);
  void executePdfMathTranslationProgressive(job, prepared);
  return publicPdfMathJob(job);
}

export function startPdfMathTranslation(args = {}) {
  const paperId = cleanPaperId(args.paperId);
  const from = normalizeLanguage(args.sourceLang, "en");
  const to = normalizeLanguage(args.targetLang, "zh");
  const continueAll = Boolean(args.continueAll || args.translateMode === "all-remaining");

  // 前端带着已有 jobId 续译：不依赖 paperId，已完成页直接跳过
  if (!args.force && args.jobId) {
    const existing = resolveJob(args.jobId);
    if (existing) {
      hydratePagesFromOutputDir(existing);
      recountCompletedPages(existing);
      if (["queued", "running", "canceling"].includes(existing.status)) {
        return setPdfMathTranslationPriority(
          existing.jobId,
          args.priorityPage || existing.priorityPage || 1,
          { continueAll }
        ) || publicPdfMathJob(existing);
      }
      if (jobAllPagesCompleted(existing)) {
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
          force: false
        });
        if (reusable?.mode === "active") {
          // 活跃任务：更新优先页；若点了「续译剩余」则切换模式并唤醒等待循环
          return setPdfMathTranslationPriority(
            reusable.job.jobId,
            args.priorityPage || reusable.job.priorityPage || 1,
            { continueAll }
          ) || publicPdfMathJob(reusable.job);
        }
        if (reusable?.mode === "complete") {
          return publicPdfMathJob(reusable.job);
        }
        if (reusable?.mode === "resume" && Array.isArray(reusable.job.pages) && reusable.job.pages.length) {
          return resumePdfMathTranslation(reusable.job, { ...args, continueAll });
        }
      }
    } catch {
      /* 继续新建任务 */
    }
  }

  const prepared = preparePdfMathTranslation({ ...args, paperId });
  prepared.priorityPage = Number(args.priorityPage) || 1;
  prepared.continueAll = continueAll;
  prepared.translateMode = continueAll ? "all-remaining" : "reading-window";
  const requestedPageCount = Number(args.pageCount);
  const progressive = args.progressive !== false && Number.isInteger(requestedPageCount) && requestedPageCount > 1;
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
    translateMode: continueAll ? "all-remaining" : "reading-window",
    updatedAt: now,
    startedAt: null,
    pageCount: progressive ? requestedPageCount : 0,
    completedPages: 0,
    pages: progressive ? createPageStates(requestedPageCount) : [],
    sourceLang: prepared.sourceLang,
    targetLang: prepared.targetLang,
    sourceSha256: prepared.sourceSha256
  };
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

export function cancelPdfMathTranslation(jobId) {
  const job = resolveJob(jobId);
  if (!job) return null;
  if (["completed", "failed", "canceled"].includes(job.status)) return publicPdfMathJob(job);
  job.cancelRequested = true;
  touchJob(job, { status: "canceling", progress: "正在停止排版翻译" });
  if (job.children?.size) {
    for (const child of job.children) killProcessTree(child);
  } else if (job.child) {
    killProcessTree(job.child);
  }
  return publicPdfMathJob(job);
}

export function buildPdfMathTranslateInvocation({ inputPath, outputDir, config = {}, sourceLang = "en", targetLang = "zh", page = 0 } = {}) {
  ensurePdf2zhListMarkerPatch();
  const from = normalizeLanguage(sourceLang, "en");
  const to = normalizeLanguage(targetLang, "zh");
  const baseUrl = String(config.baseUrl || "").trim().replace(/\/+$/, "");
  const apiKey = String(config.apiKey || "").trim();
  const model = String(config.model || "").trim();
  const speed = getPdfMathSpeedOptions(config);
  const glossaryPath = getAcademicGlossaryPath();
  const systemPrompt = String(config.pdfMathSystemPrompt || ACADEMIC_ZH_SYSTEM_PROMPT).trim();
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
      "45",
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
  return candidates.find((file) => file.startsWith(`${jobDir}${path.sep}`) && existsFile(file)) || null;
}

export async function translatePdfWithMath({ data, config = {}, sourceLang = "en", targetLang = "zh", binary = "" } = {}) {
  const started = startPdfMathTranslation({ data, config, sourceLang, targetLang, binary });
  for (;;) {
    const job = getPdfMathTranslationJob(started.jobId);
    if (!job || job.status === "failed") throw new Error(job?.error || "PDF 排版翻译任务不存在");
    if (job.status === "completed") return job.result;
    if (job.status === "canceled") throw new Error("PDF 排版翻译已取消");
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}
