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

const GUIDE_VERDICTS = ["good", "partial", "off", "skipped"];

function normalizeEvidenceItems(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => ({
      page: Number(item?.page) || 0,
      label: String(item?.label || "").trim(),
      reason: String(item?.reason || "").trim(),
      quote: String(item?.quote || "").trim()
    }))
    .filter((item) => item.page > 0 && item.label)
    .slice(0, 6);
}

/**
 * 引导式精读计划：由解读结果里的 guidedSteps 生成稳定的步骤列表（带 id）
 */
export function normalizeGuidedPlan(steps) {
  if (!Array.isArray(steps)) return [];
  return steps
    .map((step, index) => {
      if (typeof step === "string") {
        return {
          id: `s${index + 1}`,
          stage: "",
          title: `第 ${index + 1} 步`,
          goal: "",
          question: step.trim(),
          hint: "",
          pages: []
        };
      }
      const pages = (Array.isArray(step?.pages) ? step.pages : [step?.page])
        .map((p) => Number(p) || 0)
        .filter((p) => p > 0)
        .slice(0, 6);
      return {
        id: String(step?.id || "").trim() || `s${index + 1}`,
        stage: String(step?.stage || "").trim(),
        title: String(step?.title || step?.name || "").trim() || `第 ${index + 1} 步`,
        goal: String(step?.goal || step?.aim || "").trim(),
        question: String(step?.question || step?.ask || "").trim(),
        hint: String(step?.hint || step?.tip || "").trim(),
        pages
      };
    })
    .filter((step) => step.question)
    .slice(0, 8);
}

export function createGuidedSession(result) {
  const plan = normalizeGuidedPlan(result?.guidedSteps);
  return plan.length ? { plan, index: 0, answers: {} } : null;
}

function normalizeDialogMessages(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((m) => ({
      role: m?.role === "assistant" ? "assistant" : "user",
      text: String(m?.text || "").slice(0, 6000),
      evidence: m?.role === "assistant" ? normalizeEvidenceItems(m?.evidence) : [],
      error: m?.role === "assistant" ? Boolean(m?.error) : false,
      at: String(m?.at || "")
    }))
    .filter((m) => m.text)
    .slice(-200);
}

function normalizeGuidedAnswer(value) {
  if (!value || typeof value !== "object") return null;
  const verdict = GUIDE_VERDICTS.includes(value.verdict) ? value.verdict : "partial";
  return {
    answer: String(value.answer || "").slice(0, 4000),
    verdict,
    feedback: String(value.feedback || "").slice(0, 6000),
    reference: String(value.reference || "").slice(0, 6000),
    strengths: (Array.isArray(value.strengths) ? value.strengths : [])
      .map((s) => String(s || "").trim().slice(0, 300))
      .filter(Boolean)
      .slice(0, 5),
    evidence: normalizeEvidenceItems(value.evidence),
    dialog: normalizeDialogMessages(value.dialog),
    answeredAt: String(value.answeredAt || "")
  };
}

/**
 * 恢复引导进度；旧数据没有 guided 时，回退用解读结果里的 guidedSteps 从头开始
 */
export function normalizeGuidedState(value, result = null) {
  if (value && typeof value === "object" && Array.isArray(value.plan) && value.plan.length) {
    const plan = normalizeGuidedPlan(value.plan);
    if (plan.length) {
      const source = value.answers && typeof value.answers === "object" && !Array.isArray(value.answers)
        ? value.answers
        : {};
      const answers = {};
      for (const step of plan) {
        const normalized = normalizeGuidedAnswer(source[step.id]);
        if (normalized) answers[step.id] = normalized;
      }
      return {
        plan,
        index: Math.max(0, Math.min(plan.length, Number(value.index) || 0)),
        answers
      };
    }
  }
  return createGuidedSession(result);
}

export function createSavedInterpretation({ result, meta, followups = [], guided = null, savedAt } = {}) {
  const clonedResult = cloneJson(result);
  if (!clonedResult || typeof clonedResult !== "object") return null;
  const normalizedGuided = guided && typeof guided === "object" ? normalizeGuidedState(guided, clonedResult) : null;
  return {
    version: 1,
    mode: meta?.mode === "full" ? "full" : "quick",
    usedChars: Number(meta?.usedChars) || 0,
    pageCoverage: String(meta?.pageCoverage || ""),
    usage: hasUsage(meta?.usage) ? normalizeUsage(meta.usage) : undefined,
    model: String(meta?.model || "").trim(),
    result: clonedResult,
    followups: cloneJson(Array.isArray(followups) ? followups : []) || [],
    guided: normalizedGuided || undefined,
    savedAt: String(savedAt || new Date().toISOString())
  };
}

export function normalizeSavedInterpretation(value) {
  if (!value || typeof value !== "object" || !value.result || typeof value.result !== "object") return null;
  const result = cloneJson(value.result);
  if (!result || typeof result !== "object") return null;
  const guided = normalizeGuidedState(value.guided, result);
  return {
    version: 1,
    mode: value.mode === "full" ? "full" : "quick",
    usedChars: Number(value.usedChars) || 0,
    pageCoverage: String(value.pageCoverage || ""),
    usage: hasUsage(value.usage) ? normalizeUsage(value.usage) : undefined,
    model: String(value.model || "").trim(),
    result,
    followups: Array.isArray(value.followups) ? value.followups : [],
    guided: guided || undefined,
    savedAt: String(value.savedAt || "")
  };
}
