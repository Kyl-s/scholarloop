import { loadAgentConfig } from "./agentConfig.js";

async function request(url, options = {}) {
  const res = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    ...options
  });
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const body = await res.json();
      if (body.error) message = body.error;
    } catch {
      /* keep status message */
    }
    throw new Error(message);
  }
  return res.json();
}

function agentConfig() {
  return loadAgentConfig();
}

export const api = {
  get: (url) => request(url),
  post: (url, body) => request(url, { method: "POST", body: JSON.stringify(body || {}) }),
  put: (url, body) => request(url, { method: "PUT", body: JSON.stringify(body || {}) }),
  del: (url) => request(url, { method: "DELETE" }),
  getMemories: () => request("/api/memories"),
  createMemory: (body) => request("/api/memories", { method: "POST", body: JSON.stringify(body || {}) }),
  updateMemory: (id, body) => request(`/api/memories/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify(body || {}) }),
  deleteMemory: (id) => request(`/api/memories/${encodeURIComponent(id)}`, { method: "DELETE" }),
  search: (params) => {
    return request("/api/search", {
      method: "POST",
      body: JSON.stringify({ ...params, config: agentConfig() })
    });
  },
  searchPlan: (body) => request("/api/search/plan", {
    method: "POST",
    body: JSON.stringify({ ...body, config: agentConfig() })
  }),
  translate: (body) => request("/api/translate", {
    method: "POST",
    body: JSON.stringify(body)
  }),
  interpretPdf: (body) => request("/api/pdf/interpret", {
    method: "POST",
    body: JSON.stringify(body)
  }),
  getPaperInterpretation: (id) => request(`/api/library/${encodeURIComponent(id)}/interpretation`),
  savePaperInterpretation: (id, body) => request(`/api/library/${encodeURIComponent(id)}/interpretation`, {
    method: "PUT",
    body: JSON.stringify(body)
  }),
  getPdfCache: (id) => request(`/api/library/${encodeURIComponent(id)}/pdf-cache`),
  savePdfCache: (id, body) => request(`/api/library/${encodeURIComponent(id)}/pdf-cache`, {
    method: "PUT",
    body: JSON.stringify(body)
  }),
  clearPdfCache: (id) => request(`/api/library/${encodeURIComponent(id)}/pdf-cache`, { method: "DELETE" }),
  savePaperPdf: (id, body) => request(`/api/library/${encodeURIComponent(id)}/pdf-source`, {
    method: "POST",
    body: JSON.stringify(body)
  }),
  getPdfLocalPath: (id) => request(`/api/library/${encodeURIComponent(id)}/pdf-local-path`),
  materializePdf: (body) => request("/api/pdf/materialize", {
    method: "POST",
    body: JSON.stringify(body || {})
  }),
  pdfMathTranslateStatus: () => request("/api/pdf/translate-layout/status"),
  installPdfMathTranslate: () => request("/api/pdf/translate-layout/install", { method: "POST", body: JSON.stringify({}) }),
  pdfMathTranslate: (body) => request("/api/pdf/translate-layout", {
    method: "POST",
    body: JSON.stringify(body)
  }),
  pdfMathTranslateJob: (jobId) => request(`/api/pdf/translate-layout/${encodeURIComponent(jobId)}`),
  getPdfLayoutTranslation: (id) => request(`/api/library/${encodeURIComponent(id)}/pdf-layout-translation`),
  cancelPdfMathTranslate: (jobId) => request(`/api/pdf/translate-layout/${encodeURIComponent(jobId)}/cancel`, {
    method: "POST"
  }),
  prioritizePdfMathTranslate: (jobId, page, options = {}) => request(`/api/pdf/translate-layout/${encodeURIComponent(jobId)}/priority`, {
    method: "POST",
    body: JSON.stringify({ page, continueAll: Boolean(options.continueAll) })
  }),
  importPdf: (body) => request("/api/import/pdf", {
    method: "POST",
    body: JSON.stringify(body)
  }),
  pdfUrl: (url, proxy, doi) => `/api/pdf?url=${encodeURIComponent(url || "")}${proxy ? `&proxy=${encodeURIComponent(proxy)}` : ""}${doi ? `&doi=${encodeURIComponent(doi)}` : ""}`,
  analyze: (body) => request("/api/analyze", { method: "POST", body: JSON.stringify(body) }),
  deepAnalyze: (body) => request("/api/analyze/deep", { method: "POST", body: JSON.stringify(body) }),
  models: (body) => request("/api/agent/models", { method: "POST", body: JSON.stringify(body || {}) }),
  exportData: () => request("/api/data/export", { method: "POST" }),
  exportDraft: (id) => request(`/api/drafts/${id}/export`, { method: "POST" })
};
