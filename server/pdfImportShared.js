/**
 * PDF 导入共享逻辑：/api/import/pdf 与 /api/import/pdf-from-url 共用同一条
 * 「元数据提取 → 显式参数合并 → DOI 反查补全 → 建记录」流水线。
 * 全部依赖（提取器、DOI 反查、下载器）均可注入，便于单元测试 mock。
 */
import { makeManualPaper } from "./sources.js";
import { isPdfBuffer, normalizeDoi } from "./pdfResolve.js";

/** PDF 下载大小上限：100MB */
export const MAX_PDF_BYTES = 100 * 1024 * 1024;

/** 浏览器 UA：部分站点会拒绝非浏览器请求 */
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/** 带分类的导入错误：kind 用于路由决定 HTTP 状态码 */
export class PdfImportError extends Error {
  constructor(message, { kind = "network", status = 0, url = "" } = {}) {
    super(String(message || "PDF 导入失败"));
    this.name = "PdfImportError";
    this.kind = kind; // "not-pdf" | "too-large" | "network" | "internal"
    this.status = Number(status) || 0;
    this.url = String(url || "");
  }
}

/**
 * 归一化 authors 入参：接受数组或逗号/分号分隔字符串（含中文标点），容错处理。
 * 返回字符串数组（最多 20 个）。
 */
export function normalizeAuthorsInput(value) {
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === "string") return item.trim();
        if (item && typeof item === "object") {
          return String(item.name ?? item.given ?? item.value ?? "").trim();
        }
        return String(item ?? "").trim();
      })
      .filter(Boolean)
      .slice(0, 20);
  }
  return String(value || "")
    .split(/[,;，；]/)
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 20);
}

/** 判断字段值是否"非空"（数组看长度，字符串看 trim） */
function filled(value) {
  if (Array.isArray(value)) return value.filter(Boolean).length > 0;
  return String(value ?? "").trim().length > 0;
}

/**
 * 按字段优先级合并元数据：显式传入 > Crossref 反查 > PDF 提取（含 AI）。
 * crossref 是 toPaper 形状；显式字段不覆盖原则同样适用于 crossref（显式永远赢）。
 */
export function mergeImportMetadata({ extracted = {}, explicit = {}, crossref = null } = {}) {
  const fields = ["title", "authors", "year", "venue", "abstract", "keywords"];
  const merged = {};
  for (const field of fields) {
    if (filled(explicit[field])) merged[field] = explicit[field];
    else if (crossref && filled(crossref[field])) merged[field] = crossref[field];
    else merged[field] = extracted[field];
  }
  // doi：显式传入优先，其次 Crossref 返回的规范 DOI，再次 PDF 正文中提取到的
  merged.doi = filled(explicit.doi)
    ? normalizeDoi(explicit.doi)
    : normalizeDoi((crossref && crossref.doi) || extracted.doi || "");
  // pdfUrl 一律以本地落盘结果为准，不从 crossref/提取值合并
  merged.pdfUrl = extracted.pdfUrl || "";
  return merged;
}

/**
 * 从 buffer 构建导入的 paper 记录（不负责落盘，pdfUrl 由调用方传入）。
 * 依赖注入：
 *   - extractText(buffer) → 文本（失败容错为空串，损坏 PDF 也能导入）
 *   - guessMetadata(text) → 提取的基础元数据
 *   - extractAi(text, config) → AI 元数据（可为 null）
 *   - resolveByDoi(doi) → Crossref 反查（显式 doi 或 PDF 文本提取到的 doi 存在时才调用，失败不阻断导入）
 */
export async function buildImportedPdfPaper(buffer, {
  pdfName = "",
  config = {},
  explicit = {},
  pdfUrl = "",
  url = "",
  resolveByDoi = null,
  extractText = null,
  guessMetadata = null,
  extractAi = null
} = {}) {
  // 1. 提取文本（容错：解析失败按空文本继续，元数据交给显式参数/DOI 反查兜底）
  let text = "";
  if (extractText) {
    try {
      text = await extractText(buffer);
    } catch {
      text = "";
    }
  }
  // 2. 规则提取 + 可选 AI 提取
  const base = guessMetadata ? guessMetadata(text) : {};
  let ai = null;
  if (extractAi) {
    try {
      ai = await extractAi(text, config);
    } catch {
      ai = null;
    }
  }
  const extracted = { ...base, ...(ai || {}), pdfUrl };
  // 3. DOI 反查触发条件：显式传入的 doi 或 PDF 首页文本提取到的 doi 均可
  //    （PDF 首页几乎都印有 DOI，提取到即可反查补全元数据；失败不阻断导入）
  const explicitDoi = normalizeDoi(explicit.doi);
  const extractedDoi = normalizeDoi(extracted.doi);
  let crossref = null;
  if ((explicitDoi || extractedDoi) && typeof resolveByDoi === "function") {
    try {
      crossref = await resolveByDoi(explicitDoi || extractedDoi);
    } catch {
      crossref = null;
    }
  }
  // 4. 合并：显式 > Crossref > 提取值
  const merged = mergeImportMetadata({
    extracted,
    explicit: { ...explicit, doi: explicitDoi },
    crossref
  });
  // 5. 标题兜底：显式 > 提取 > 文件名 > 未命名
  let title = String(merged.title || "").trim();
  if (!title && pdfName) title = String(pdfName).replace(/\.pdf$/i, "").trim().slice(0, 300);
  if (!title) title = `未命名文献（${new Date().toISOString().slice(0, 10)}）`;
  // 6. 走 makeManualPaper 统一记录形状（id/doi 规范化等）
  const paper = makeManualPaper({
    ...merged,
    title,
    source: "manual",
    url: String(url || "").trim(),
    pdfUrl
  });
  paper.aiExtracted = Boolean(ai);
  paper.localPdf = true;
  return paper;
}

/**
 * 服务端下载 PDF：
 *   - 带 cookie（作为 Cookie 头）、浏览器 UA、Referer=sourceUrl（若有）
 *   - 跟随重定向，100MB 大小上限
 *   - 校验 %PDF- 文件头，否则抛 kind="not-pdf" 的 PdfImportError（路由转 422）
 */
export async function downloadPdf(rawUrl, {
  cookie = "",
  sourceUrl = "",
  maxBytes = MAX_PDF_BYTES,
  fetcher = globalThis.fetch
} = {}) {
  const url = String(rawUrl || "").trim();
  if (!/^https?:\/\//i.test(url)) {
    throw new PdfImportError(`链接格式不正确，仅支持 http/https：${url || "(空)"}`, { kind: "network", url });
  }
  const headers = {
    Accept: "application/pdf,application/octet-stream;q=0.9,*/*;q=0.1",
    "User-Agent": BROWSER_UA
  };
  if (cookie) headers.Cookie = cookie;
  if (sourceUrl) headers.Referer = sourceUrl;
  let response;
  try {
    response = await fetcher(url, {
      headers,
      redirect: "follow",
      signal: AbortSignal.timeout(120000)
    });
  } catch (err) {
    throw new PdfImportError(`下载 PDF 失败：${err.message}`, { kind: "network", url });
  }
  if (!response.ok) {
    throw new PdfImportError(`下载 PDF 失败：目标服务器返回 ${response.status} ${response.statusText || ""}`.trim(), {
      kind: "network",
      status: response.status,
      url
    });
  }
  // 先看 Content-Length，超限直接拒绝，避免白白下载
  const declared = Number(response.headers?.get?.("content-length")) || 0;
  if (declared > maxBytes) {
    throw new PdfImportError(`文件过大（${(declared / 1024 / 1024).toFixed(1)}MB），超过 ${(maxBytes / 1024 / 1024).toFixed(0)}MB 上限`, {
      kind: "too-large",
      status: response.status,
      url
    });
  }
  let buffer;
  try {
    buffer = Buffer.from(await response.arrayBuffer());
  } catch (err) {
    throw new PdfImportError(`读取 PDF 内容失败：${err.message}`, { kind: "network", url });
  }
  if (buffer.length > maxBytes) {
    throw new PdfImportError(`文件过大（${(buffer.length / 1024 / 1024).toFixed(1)}MB），超过 ${(maxBytes / 1024 / 1024).toFixed(0)}MB 上限`, {
      kind: "too-large",
      status: response.status,
      url
    });
  }
  // 校验 %PDF- 文件头：很多期刊落地页会 200 返回 HTML，需要给出可读错误
  if (!isPdfBuffer(buffer)) {
    const contentType = String(response.headers?.get?.("content-type") || "").toLowerCase();
    const detail = /text\/html|application\/xhtml/.test(contentType) ? "（页面返回的是 HTML，可能需要登录或该站点不提供直链 PDF）" : "";
    throw new PdfImportError(`该链接不是可直接下载的 PDF 文件${detail}，请确认链接指向 PDF 全文，或先在浏览器中登录后重试。`, {
      kind: "not-pdf",
      status: response.status,
      url
    });
  }
  return { buffer, finalUrl: response.url || url, contentType: String(response.headers?.get?.("content-type") || "") };
}

/** 从 URL 推断文件名（用于标题兜底） */
export function guessPdfNameFromUrl(url) {
  try {
    const { pathname } = new URL(String(url || ""));
    const base = decodeURIComponent(pathname.split("/").filter(Boolean).pop() || "");
    return base.toLowerCase().endsWith(".pdf") ? base : "";
  } catch {
    return "";
  }
}
