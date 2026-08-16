import { hasUsage, normalizeUsage } from "./llmUsage.js";

export function interpretationStorageKey({ paperId, doi, url, title } = {}) {
  const identity = String(paperId || doi || url || title || "unknown").trim();
  return `scholarloop.pdf.interpretation.${encodeURIComponent(identity)}`;
}

function cloneJson(value) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return null;
  }
}

export function createSavedInterpretation({ result, meta, followups = [], savedAt } = {}) {
  const clonedResult = cloneJson(result);
  if (!clonedResult || typeof clonedResult !== "object") return null;
  return {
    version: 1,
    mode: meta?.mode === "full" ? "full" : "quick",
    usedChars: Number(meta?.usedChars) || 0,
    pageCoverage: String(meta?.pageCoverage || ""),
    usage: hasUsage(meta?.usage) ? normalizeUsage(meta.usage) : undefined,
    model: String(meta?.model || "").trim(),
    result: clonedResult,
    followups: cloneJson(Array.isArray(followups) ? followups : []) || [],
    savedAt: String(savedAt || new Date().toISOString())
  };
}

export function normalizeSavedInterpretation(value) {
  if (!value || typeof value !== "object" || !value.result || typeof value.result !== "object") return null;
  const result = cloneJson(value.result);
  if (!result || typeof result !== "object") return null;
  return {
    version: 1,
    mode: value.mode === "full" ? "full" : "quick",
    usedChars: Number(value.usedChars) || 0,
    pageCoverage: String(value.pageCoverage || ""),
    usage: hasUsage(value.usage) ? normalizeUsage(value.usage) : undefined,
    model: String(value.model || "").trim(),
    result,
    followups: Array.isArray(value.followups) ? value.followups : [],
    savedAt: String(value.savedAt || "")
  };
}
