import { PDFParse } from "pdf-parse";
import { fetchWithFallback } from "./proxy.js";

const PDF_MAGIC = "%PDF-";
const ID_CONVERTER_URL = "https://pmc.ncbi.nlm.nih.gov/tools/idconv/api/v1/articles/";
const EUROPE_PMC_PDF_URL = "https://europepmc.org/api/getPdf";

export class PdfResolveError extends Error {
  constructor(message, { kind = "network", status = 0, url = "" } = {}) {
    super(String(message || "PDF 下载失败"));
    this.name = "PdfResolveError";
    this.kind = kind;
    this.status = Number(status) || 0;
    this.url = String(url || "");
  }
}

const PDF_HEADERS = {
  Accept: "application/pdf,application/octet-stream;q=0.9,*/*;q=0.1",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36 ScholarLoop/0.1"
};

export function isPdfBuffer(buffer) {
  const value = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  return value.length >= PDF_MAGIC.length && value.subarray(0, PDF_MAGIC.length).toString("latin1") === PDF_MAGIC;
}

/** pdf-parse 2.4.5 的 `first` 参数只解析前 N 页。 */
export function pdfTextParseOptions(maxPages = 15) {
  return { first: Math.max(1, Math.floor(Number(maxPages) || 15)) };
}

export async function extractPdfText(buffer, maxPages = 15, { PDFParseClass = PDFParse } = {}) {
  const parser = new PDFParseClass({ data: buffer });
  try {
    const parsed = await parser.getText(pdfTextParseOptions(maxPages));
    return String(parsed?.text || "").replace(/[ \t]+/g, " ").trim().slice(0, 30000);
  } finally {
    await parser.destroy?.();
  }
}

export function normalizeDoi(value) {
  return String(value || "")
    .trim()
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "")
    .replace(/^doi:\s*/i, "")
    .trim();
}

async function responseBuffer(response, label) {
  const status = Number(response?.status) || 0;
  if (!response.ok) {
    const kind = status === 401 || status === 403 ? "auth" : status >= 300 && status < 400 ? "redirect" : "network";
    throw new PdfResolveError(`${label}返回 ${response.status} ${response.statusText}`.trim(), { kind, status, url: response.url });
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (!isPdfBuffer(buffer)) {
    const contentType = String(response.headers?.get?.("content-type") || "").toLowerCase();
    const kind = /text\/html|application\/xhtml|application\/json/.test(contentType) ? "landing-page" : "non-pdf";
    const suffix = contentType ? `（Content-Type: ${contentType}）` : "";
    throw new PdfResolveError(`${label}返回的不是 PDF 文件${suffix}`, { kind, status, url: response.url });
  }
  return buffer;
}

export async function resolvePmcid(doi, { fetcher = fetchWithFallback, proxy = null } = {}) {
  const normalized = normalizeDoi(doi);
  if (!/^10\.\d{4,9}\/.+/i.test(normalized)) return null;

  const params = new URLSearchParams({
    ids: normalized,
    format: "json",
    tool: "ScholarLoop",
    email: "local@scholarloop.app"
  });
  const response = await fetcher(`${ID_CONVERTER_URL}?${params}`, {
    headers: { Accept: "application/json", "User-Agent": PDF_HEADERS["User-Agent"] },
    redirect: "follow",
    signal: AbortSignal.timeout(20000)
  }, proxy);
  if (!response.ok) throw new Error(`PMC 标识查询返回 ${response.status} ${response.statusText}`.trim());
  const payload = await response.json();
  const record = Array.isArray(payload?.records) ? payload.records[0] : null;
  const pmcid = String(record?.pmcid || "").trim().toUpperCase();
  return /^PMC\d+$/.test(pmcid) && record?.live !== false ? pmcid : null;
}

export async function fetchPdfWithOpenAccessFallback({
  url,
  doi,
  proxy = null,
  fetcher = fetchWithFallback
}) {
  const sourceUrl = String(url || "").trim();
  const normalizedDoi = normalizeDoi(doi);
  const failures = [];
  const rememberFailure = (error, prefix = "") => {
    const message = String(error?.message || error || "PDF 下载失败");
    const status = Number(error?.status) || Number(message.match(/\b(401|403)\b/)?.[1]) || 0;
    const kind = error?.kind || (status === 401 || status === 403 ? "auth" : /redirect|重定向/i.test(message) ? "redirect" : "network");
    const item = error instanceof PdfResolveError ? error : new PdfResolveError(message, { kind, status });
    failures.push({ ...item, message: prefix ? `${prefix}${item.message}` : item.message });
  };

  if (/^https?:\/\//i.test(sourceUrl)) {
    try {
      const response = await fetcher(sourceUrl, {
        headers: PDF_HEADERS,
        redirect: "follow",
        signal: AbortSignal.timeout(60000)
      }, proxy);
      const buffer = await responseBuffer(response, "原始链接");
      return { buffer, source: "publisher", resolvedUrl: response.url || sourceUrl, pmcid: null };
    } catch (error) {
      rememberFailure(error);
    }
  } else if (sourceUrl) {
    rememberFailure(new PdfResolveError("PDF 链接不合法", { kind: "network" }));
  }

  if (normalizedDoi) {
    try {
      const pmcid = await resolvePmcid(normalizedDoi, { fetcher, proxy });
      if (!pmcid) {
        rememberFailure(new PdfResolveError("未找到可公开获取的 PMC 全文", { kind: "network" }));
      } else {
        const resolvedUrl = `${EUROPE_PMC_PDF_URL}?pmcid=${encodeURIComponent(pmcid)}`;
        const response = await fetcher(resolvedUrl, {
          headers: PDF_HEADERS,
          redirect: "follow",
          signal: AbortSignal.timeout(120000)
        }, proxy);
        const buffer = await responseBuffer(response, "Europe PMC");
        return { buffer, source: "europe-pmc", resolvedUrl, pmcid };
      }
    } catch (error) {
      rememberFailure(error, "开放全文回退失败：");
    }
  } else {
    rememberFailure(new PdfResolveError("缺少 DOI，无法查找开放全文", { kind: "network" }));
  }

  const priority = ["auth", "anti-bot", "redirect", "landing-page", "non-pdf", "pdf-parse", "network"];
  const representative = failures.sort((a, b) => priority.indexOf(a.kind) - priority.indexOf(b.kind))[0];
  throw new PdfResolveError(failures.map((item) => item.message).filter(Boolean).join("；") || "没有可用的 PDF 来源", {
    kind: representative?.kind || "network",
    status: representative?.status || 0,
    url: sourceUrl
  });
}
