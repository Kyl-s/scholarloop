import { fetchWithFallback } from "./proxy.js";

const PDF_MAGIC = "%PDF-";
const ID_CONVERTER_URL = "https://pmc.ncbi.nlm.nih.gov/tools/idconv/api/v1/articles/";
const EUROPE_PMC_PDF_URL = "https://europepmc.org/api/getPdf";

const PDF_HEADERS = {
  Accept: "application/pdf,application/octet-stream;q=0.9,*/*;q=0.1",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36 ScholarLoop/0.1"
};

export function isPdfBuffer(buffer) {
  const value = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  return value.length >= PDF_MAGIC.length && value.subarray(0, PDF_MAGIC.length).toString("latin1") === PDF_MAGIC;
}

export function normalizeDoi(value) {
  return String(value || "")
    .trim()
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "")
    .replace(/^doi:\s*/i, "")
    .trim();
}

async function responseBuffer(response, label) {
  if (!response.ok) throw new Error(`${label}返回 ${response.status} ${response.statusText}`.trim());
  const buffer = Buffer.from(await response.arrayBuffer());
  if (!isPdfBuffer(buffer)) throw new Error(`${label}返回的不是 PDF 文件`);
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
      failures.push(error.message);
    }
  } else if (sourceUrl) {
    failures.push("PDF 链接不合法");
  }

  if (normalizedDoi) {
    try {
      const pmcid = await resolvePmcid(normalizedDoi, { fetcher, proxy });
      if (!pmcid) {
        failures.push("未找到可公开获取的 PMC 全文");
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
      failures.push(`开放全文回退失败：${error.message}`);
    }
  } else {
    failures.push("缺少 DOI，无法查找开放全文");
  }

  throw new Error(failures.filter(Boolean).join("；") || "没有可用的 PDF 来源");
}
