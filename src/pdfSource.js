/**
 * Classify errors encountered while opening a remote PDF.  Keeping this
 * small and renderer-safe makes the error UI useful without exposing the
 * implementation details of Electron, the proxy, or PDF.js.
 */
export const PDF_ERROR_KINDS = Object.freeze({
  auth: "auth",
  landingPage: "landing-page",
  antiBot: "anti-bot",
  redirect: "redirect",
  nonPdf: "non-pdf",
  pdfParse: "pdf-parse",
  network: "network"
});

export const PDF_ERROR_LABELS = Object.freeze({
  [PDF_ERROR_KINDS.auth]: "登录或权限问题",
  [PDF_ERROR_KINDS.landingPage]: "网页落地页",
  [PDF_ERROR_KINDS.antiBot]: "站点反爬拦截",
  [PDF_ERROR_KINDS.redirect]: "重定向异常",
  [PDF_ERROR_KINDS.nonPdf]: "返回内容不是 PDF",
  [PDF_ERROR_KINDS.pdfParse]: "PDF 解析失败",
  [PDF_ERROR_KINDS.network]: "网络或下载失败"
});

function textOf(error) {
  if (typeof error === "string") return error;
  return String(error?.message || error?.error || error || "").trim();
}

/**
 * Return a stable kind and safe UI hints for an opening error.  The original
 * message is retained for diagnostics, but callers should render `label` and
 * `hint` as the user-facing explanation.
 */
export function classifyPdfError(error, context = {}) {
  const message = textOf(error);
  const lower = message.toLowerCase();
  const status = Number(context.status || error?.status || 0);
  const explicitKind = String(context.kind || error?.kind || "").trim();
  let kind = Object.values(PDF_ERROR_KINDS).includes(explicitKind) ? explicitKind : PDF_ERROR_KINDS.network;

  if (context.pdfParse || /invalidpdf|invalid pdf|pdf\.js|pdfjs|failed to parse|解析 pdf|pdf 解析|损坏的 pdf|无法解析/i.test(message)) {
    kind = PDF_ERROR_KINDS.pdfParse;
  } else if (/captcha|验证码|cloudflare|challenge|robot|反爬|人机验证|access denied|blocked by|被拦截/i.test(message)) {
    kind = PDF_ERROR_KINDS.antiBot;
  } else if (status === 401 || status === 403 || /\b401\b|\b403\b|unauthori[sz]ed|forbidden|需要登录|请登录|登录后|权限不足|无权访问/i.test(message)) {
    kind = PDF_ERROR_KINDS.auth;
  } else if (/redirect|重定向|redirect loop|循环|too many redirects|跳转目标/i.test(message)) {
    kind = PDF_ERROR_KINDS.redirect;
  } else if (/html|<!doctype|<html|网页|落地页|登录页面|登录页|text\/html/i.test(message)) {
    kind = PDF_ERROR_KINDS.landingPage;
  } else if (/not.*pdf|不是.*pdf|非 pdf|非pdf|pdf 文件|content-type.{0,20}(?:text\/html|application\/json)/i.test(message)) {
    kind = PDF_ERROR_KINDS.nonPdf;
  } else if (lower.includes("404") || lower.includes("network") || lower.includes("fetch") || lower.includes("timeout") || status >= 400) {
    kind = PDF_ERROR_KINDS.network;
  }

  // Server-side resolution can provide an authoritative kind; keep it even
  // when the human-readable message also contains words such as "not PDF".
  if (Object.values(PDF_ERROR_KINDS).includes(explicitKind)) kind = explicitKind;

  const canUsePortal = Boolean(context.url || context.canUsePortal);
  const hints = {
    [PDF_ERROR_KINDS.auth]: "该站点可能要求登录或机构权限。可在内嵌门户完成登录后，再读取当前 PDF。",
    [PDF_ERROR_KINDS.landingPage]: "链接返回的是网页落地页，不是 PDF 文件。可在内嵌门户中继续访问并登录。",
    [PDF_ERROR_KINDS.antiBot]: "站点要求人机验证或拦截了自动下载。请在内嵌门户中按站点提示操作。",
    [PDF_ERROR_KINDS.redirect]: "下载跳转未能完成，通常需要先在站点页面建立登录或权限会话。",
    [PDF_ERROR_KINDS.nonPdf]: "服务器返回的内容不是 PDF，可能是登录页、错误页或下载落地页。",
    [PDF_ERROR_KINDS.pdfParse]: "文件已返回，但 PDF.js 无法解析它；可重新下载或选择本地 PDF 文件。",
    [PDF_ERROR_KINDS.network]: "请检查链接、网络或站点状态，也可以选择本地 PDF 文件。"
  };

  return {
    kind,
    label: PDF_ERROR_LABELS[kind],
    hint: hints[kind],
    message: message || PDF_ERROR_LABELS[kind],
    canUsePortal
  };
}

const LANDING_PATH_RE = /\/stamp\/stamp\.jsp(?:$|[?#])|\/document\/\d+(?:$|[?#])|\/abs\/|\/abstract|\/full\/html|\/fulltext\.html|\/html\/|\/doi\/full|\/doi\/abs/i;

function pathnameOf(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    return new URL(raw).pathname || "";
  } catch {
    return raw.split(/[?#]/)[0];
  }
}

/** True when the URL is a local cached PDF served by this app. */
export function isLocalPdfUrl(value) {
  return /^\/api\/pdf\/file\/[a-f0-9-]+\.pdf$/i.test(String(value || "").trim());
}

/**
 * Rank how likely a URL is a byte-stream PDF the built-in reader can open.
 * Higher is better. 0 means "do not treat as pdfUrl".
 */
export function pdfUrlQuality(value) {
  const raw = String(value || "").trim();
  if (!raw) return 0;
  if (isLocalPdfUrl(raw)) return 100;
  const lower = raw.toLowerCase();
  const path = pathnameOf(raw).toLowerCase();
  if (LANDING_PATH_RE.test(raw) || LANDING_PATH_RE.test(path)) return 0;
  if (path.endsWith(".pdf") || /[?&](?:type|format|download)=pdf(?:&|$)/i.test(raw)) return 80;
  if (/arxiv\.org\/pdf\//i.test(raw) || /export\.arxiv\.org\/pdf\//i.test(raw)) return 80;
  if (/pmc\.ncbi\.nlm\.nih\.gov\/articles\/[^/]+\/pdf\b/i.test(raw)) return 75;
  if (/europepmc\.org\/articles\/.*pdf/i.test(raw)) return 70;
  if (lower.includes("openaccesspdf") || lower.includes("/oa/pdf")) return 60;
  if (/^https?:\/\//i.test(raw) && (lower.includes(".pdf") || lower.includes("/pdf"))) return 40;
  return 0;
}

export function isDirectPdfUrl(value) {
  return pdfUrlQuality(value) > 0;
}

/** Keep the stronger direct PDF link; never let a landing page replace a real one. */
export function preferPdfUrl(current, incoming) {
  const a = String(current || "").trim();
  const b = String(incoming || "").trim();
  const qa = pdfUrlQuality(a);
  const qb = pdfUrlQuality(b);
  if (qb > qa) return b;
  if (qa > 0) return a;
  return a || b;
}

export function asDirectPdfUrl(value) {
  const raw = String(value || "").trim();
  return pdfUrlQuality(raw) > 0 ? raw : "";
}

export const PDF_OPEN_FAILURE_STORAGE_KEY = "scholarloop.pdf.open-failure";
export const PDF_OPEN_FAILURE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const PDF_OPEN_FAILURE_MESSAGE_MAX = 2000;

function defaultFailureStorage() {
  try {
    if (typeof localStorage === "undefined") return null;
    return localStorage;
  } catch {
    return null;
  }
}

function normalizeFailureDoi(value) {
  return String(value || "")
    .trim()
    .replace(/^https?:\/\/doi\.org\//i, "")
    .toLowerCase();
}

export function pdfOpenFailureKeys(source = {}) {
  const keys = [];
  const paperId = String(source.paperId || "").trim();
  const doi = normalizeFailureDoi(source.doi);
  const url = String(source.url || "").trim();
  if (paperId) keys.push(`paper:${paperId}`);
  if (doi) keys.push(`doi:${doi}`);
  if (url) keys.push(`url:${url}`);
  return keys;
}

function readFailureMap(storage) {
  try {
    const parsed = JSON.parse(storage.getItem(PDF_OPEN_FAILURE_STORAGE_KEY) || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeFailureMap(storage, map) {
  storage.setItem(PDF_OPEN_FAILURE_STORAGE_KEY, JSON.stringify(map));
}

function asFailureRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const kind = Object.values(PDF_ERROR_KINDS).includes(value.kind) ? value.kind : PDF_ERROR_KINDS.network;
  return {
    kind,
    label: String(value.label || PDF_ERROR_LABELS[kind] || "").slice(0, 80),
    hint: String(value.hint || "").slice(0, 500),
    message: String(value.message || "").slice(0, PDF_OPEN_FAILURE_MESSAGE_MAX),
    url: String(value.url || "").trim(),
    doi: String(value.doi || "").trim(),
    paperId: String(value.paperId || "").trim(),
    canUsePortal: value.canUsePortal !== false,
    at: String(value.at || "")
  };
}

export function readPdfOpenFailure(source = {}, storage = defaultFailureStorage()) {
  if (!storage) return null;
  const keys = pdfOpenFailureKeys(source);
  if (!keys.length) return null;
  const map = readFailureMap(storage);
  const now = Date.now();
  let found = null;
  let dirty = false;
  for (const key of keys) {
    const entry = asFailureRecord(map[key]);
    if (!entry) continue;
    const at = Date.parse(entry.at) || 0;
    if (!at || now - at > PDF_OPEN_FAILURE_TTL_MS) {
      delete map[key];
      dirty = true;
      continue;
    }
    found = entry;
    break;
  }
  if (dirty) writeFailureMap(storage, map);
  return found;
}

export function writePdfOpenFailure(source = {}, info = {}, storage = defaultFailureStorage()) {
  if (!storage) return null;
  const keys = pdfOpenFailureKeys(source);
  if (!keys.length) return null;
  const classified = info?.kind ? info : classifyPdfError(info, source);
  const record = asFailureRecord({
    ...classified,
    url: source.url || info.url || "",
    doi: source.doi || info.doi || "",
    paperId: source.paperId || info.paperId || "",
    canUsePortal: classified.canUsePortal,
    at: new Date().toISOString()
  });
  const map = readFailureMap(storage);
  for (const key of keys) map[key] = record;
  writeFailureMap(storage, map);
  return record;
}

export function clearPdfOpenFailure(source = {}, storage = defaultFailureStorage()) {
  if (!storage) return;
  const keys = pdfOpenFailureKeys(source);
  if (!keys.length) return;
  const map = readFailureMap(storage);
  let dirty = false;
  for (const key of keys) {
    if (map[key]) {
      delete map[key];
      dirty = true;
    }
  }
  if (dirty) writeFailureMap(storage, map);
}
