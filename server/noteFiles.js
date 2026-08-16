import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const NOTE_FILES_DIR = path.join(__dirname, "..", "data", "note-files");
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_BYTES = 12 * 1024 * 1024;

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp"]);
const FILE_EXTS = new Set([
  ...IMAGE_EXTS,
  "pdf", "txt", "md", "csv", "tsv", "json", "bib", "ris",
  "xlsx", "xls", "docx", "doc", "pptx", "ppt",
  "zip", "7z"
]);

const MIME_BY_EXT = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  json: "application/json",
  bib: "application/x-bibtex",
  ris: "application/x-research-info-systems",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xls: "application/vnd.ms-excel",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  doc: "application/msword",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ppt: "application/vnd.ms-powerpoint",
  zip: "application/zip",
  "7z": "application/x-7z-compressed"
};

function ensureDir() {
  if (!fs.existsSync(NOTE_FILES_DIR)) fs.mkdirSync(NOTE_FILES_DIR, { recursive: true });
}

export function extensionOf(name = "", mime = "") {
  const fromName = String(name || "").split(".").pop()?.toLowerCase() || "";
  if (FILE_EXTS.has(fromName)) return fromName;
  const fromMime = String(mime || "").toLowerCase();
  if (fromMime === "image/jpeg") return "jpg";
  if (fromMime === "image/png") return "png";
  if (fromMime === "image/gif") return "gif";
  if (fromMime === "image/webp") return "webp";
  if (fromMime === "application/pdf") return "pdf";
  return "";
}

export function sanitizeFileName(name) {
  const base = String(name || "未命名文件").replace(/\\/g, "/").split("/").pop();
  const raw = String(base || "").replace(/[\[\]()]/g, "").replace(/[:*?"<>|]/g, " ").replace(/\s+/g, " ").trim();
  return raw.slice(0, 120) || "未命名文件";
}

export function noteFileKind(ext) {
  return IMAGE_EXTS.has(ext) ? "image" : "file";
}

export function attachmentToken({ id, name, kind }) {
  const label = sanitizeFileName(name);
  const url = `/api/note-files/${id}`;
  return kind === "image" ? `![${label}](${url})` : `[${label}](${url})`;
}

function decodeBase64(data) {
  const raw = String(data || "").replace(/^data:[^;]+;base64,/, "").replace(/\s+/g, "");
  if (!raw) throw new Error("文件内容为空");
  return Buffer.from(raw, "base64");
}

export function saveNoteFile({ name, mime, data } = {}) {
  const ext = extensionOf(name, mime);
  if (!FILE_EXTS.has(ext)) throw new Error("不支持这种文件类型");
  const buffer = decodeBase64(data);
  if (!buffer.length) throw new Error("文件内容为空");
  if (buffer.length > MAX_BYTES) throw new Error("文件不能超过 12MB");
  ensureDir();
  const id = randomUUID();
  const record = {
    id,
    name: sanitizeFileName(name),
    mime: MIME_BY_EXT[ext] || "application/octet-stream",
    ext,
    size: buffer.length,
    kind: noteFileKind(ext),
    createdAt: new Date().toISOString()
  };
  fs.writeFileSync(path.join(NOTE_FILES_DIR, `${id}.bin`), buffer);
  fs.writeFileSync(path.join(NOTE_FILES_DIR, `${id}.json`), JSON.stringify(record, null, 2), "utf8");
  return {
    ...record,
    url: `/api/note-files/${id}`,
    token: attachmentToken(record)
  };
}

export function getNoteFile(id) {
  if (!ID_RE.test(String(id || ""))) return null;
  const metaPath = path.join(NOTE_FILES_DIR, `${id}.json`);
  const binPath = path.join(NOTE_FILES_DIR, `${id}.bin`);
  if (!fs.existsSync(metaPath) || !fs.existsSync(binPath)) return null;
  try {
    const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
    return {
      ...meta,
      url: `/api/note-files/${id}`,
      token: attachmentToken(meta),
      path: binPath
    };
  } catch {
    return null;
  }
}

export function removeNoteFile(id) {
  if (!ID_RE.test(String(id || ""))) return false;
  const metaPath = path.join(NOTE_FILES_DIR, `${id}.json`);
  const binPath = path.join(NOTE_FILES_DIR, `${id}.bin`);
  let removed = false;
  for (const file of [metaPath, binPath]) {
    if (!fs.existsSync(file)) continue;
    fs.unlinkSync(file);
    removed = true;
  }
  return removed;
}
