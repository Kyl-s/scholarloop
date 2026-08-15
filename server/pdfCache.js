import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "data");
const PDF_DIR = path.join(DATA_DIR, "pdfs");
const CACHE_DIR = path.join(DATA_DIR, "pdf-cache");

const MAP_FIELDS = [
  "textByPage",
  "ocrPageTexts",
  "pageTranslations",
  "pageTranslationLayouts",
  "paragraphTranslations",
  "selectionTranslations",
  "ocrSelectionCache"
];

function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function cleanText(value, maxLength = 120000) {
  return String(value || "").slice(0, maxLength);
}

function cleanMap(value, maxEntries = 5000) {
  const source = asRecord(value);
  return Object.fromEntries(
    Object.entries(source)
      .slice(0, maxEntries)
      .map(([key, item]) => [cleanText(key, 300), item])
  );
}

function cleanNestedMap(value) {
  const source = asRecord(value);
  return Object.fromEntries(
    Object.entries(source)
      .slice(0, 5000)
      .map(([key, item]) => [cleanText(key, 300), item])
  );
}

export function normalizePdfCache(value, paperId = "") {
  const source = asRecord(value);
  const normalized = {
    version: 1,
    paperId: cleanText(paperId || source.paperId, 300),
    sourceUrl: cleanText(source.sourceUrl, 2000),
    pdfUrl: cleanText(source.pdfUrl, 500),
    sourceSha256: cleanText(source.sourceSha256, 128),
    bytes: Number(source.bytes) || 0,
    numPages: Math.max(0, Number(source.numPages) || 0),
    textLayoutVersion: Math.max(0, Number(source.textLayoutVersion) || 0),
    textByPage: cleanMap(source.textByPage),
    ocrPageTexts: cleanMap(source.ocrPageTexts),
    pageTranslations: cleanMap(source.pageTranslations),
    pageTranslationLayouts: cleanNestedMap(source.pageTranslationLayouts),
    paragraphTranslations: cleanMap(source.paragraphTranslations),
    selectionTranslations: cleanNestedMap(source.selectionTranslations),
    ocrSelectionCache: cleanNestedMap(source.ocrSelectionCache),
    // 版式翻译任务 ID：重启后通过 job.json 恢复，避免每次重新翻译
    layoutTranslationJobId: cleanText(source.layoutTranslationJobId, 80),
    // 阅读随记：想到什么写什么，随 PDF 缓存持久化
    readingNotes: cleanText(source.readingNotes, 200000),
    savedAt: cleanText(source.savedAt, 80) || new Date().toISOString()
  };

  // Selection and OCR entries contain small objects/arrays. Clone through JSON so
  // request bodies cannot leave functions, prototypes, or other non-persistable data.
  try {
    normalized.selectionTranslations = JSON.parse(JSON.stringify(normalized.selectionTranslations));
    normalized.ocrSelectionCache = JSON.parse(JSON.stringify(normalized.ocrSelectionCache));
    normalized.pageTranslationLayouts = JSON.parse(JSON.stringify(normalized.pageTranslationLayouts));
  } catch {
    normalized.selectionTranslations = {};
    normalized.ocrSelectionCache = {};
    normalized.pageTranslationLayouts = {};
  }
  return normalized;
}

function cacheFile(paperId) {
  const safeId = encodeURIComponent(String(paperId || "").trim());
  return safeId ? path.join(CACHE_DIR, `${safeId}.json`) : "";
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

function mergeMap(current, patch) {
  if (patch === undefined) return current;
  return { ...asRecord(current), ...asRecord(patch) };
}

export function mergePdfCache(current, patch, paperId = "") {
  const base = normalizePdfCache(current, paperId);
  const next = asRecord(patch);
  const merged = {
    ...base,
    ...next,
    paperId: paperId || base.paperId,
    savedAt: new Date().toISOString()
  };
  for (const field of MAP_FIELDS) merged[field] = mergeMap(base[field], next[field]);
  return normalizePdfCache(merged, paperId || base.paperId);
}

export function getPdfCache(paperId) {
  const file = cacheFile(paperId);
  if (!file || !fs.existsSync(file)) return null;
  try {
    return normalizePdfCache(JSON.parse(fs.readFileSync(file, "utf8")), paperId);
  } catch {
    return null;
  }
}

export function savePdfCache(paperId, patch = {}) {
  const file = cacheFile(paperId);
  if (!file) throw new Error("文献 ID 不能为空");
  const cache = mergePdfCache(getPdfCache(paperId), patch, paperId);
  writeJsonAtomic(file, cache);
  return cache;
}

export function clearPdfCache(paperId) {
  const file = cacheFile(paperId);
  if (file && fs.existsSync(file)) fs.unlinkSync(file);
}

export function savePdfSource(buffer, sourceUrl = "") {
  if (!Buffer.isBuffer(buffer) || buffer.length < 5 || buffer.subarray(0, 5).toString("latin1") !== "%PDF-") {
    throw new Error("上传内容不是有效的 PDF 文件");
  }
  ensureDirectory(PDF_DIR);
  const fileName = `${randomUUID()}.pdf`;
  const file = path.join(PDF_DIR, fileName);
  fs.writeFileSync(file, buffer);
  return {
    fileName,
    pdfUrl: `/api/pdf/file/${fileName}`,
    sourceUrl: cleanText(sourceUrl, 2000),
    sourceSha256: crypto.createHash("sha256").update(buffer).digest("hex"),
    bytes: buffer.length
  };
}

export function deletePdfSource(pdfUrl) {
  const match = String(pdfUrl || "").match(/^\/api\/pdf\/file\/([a-f0-9-]+\.pdf)$/i);
  if (!match) return false;
  const file = path.join(PDF_DIR, match[1]);
  if (!fs.existsSync(file)) return false;
  fs.unlinkSync(file);
  return true;
}

/** 将 /api/pdf/file/<uuid>.pdf 解析为 data/pdfs 下的绝对路径 */
export function resolveLocalPdfPath(pdfUrl) {
  const match = String(pdfUrl || "").match(/^\/api\/pdf\/file\/([a-f0-9-]+\.pdf)$/i);
  if (!match) return null;
  const root = path.resolve(PDF_DIR);
  const file = path.resolve(PDF_DIR, match[1]);
  const rel = path.relative(root, file);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  if (!fs.existsSync(file)) return null;
  return file;
}

/** 按文献 ID 解析本地 PDF 绝对路径 */
export function resolvePaperPdfPath(paper) {
  if (!paper) return null;
  return resolveLocalPdfPath(paper.pdfUrl);
}
