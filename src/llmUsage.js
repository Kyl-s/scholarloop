export const LLM_USAGE_KEY = "scholarloop.llm.usage";
export const LLM_USAGE_EVENT = "scholarloop-llm-usage";

export const USAGE_KIND_LABELS = {
  interpret: "PDF 解读",
  followup: "解读追问",
  translate: "翻译",
  agent: "Agent"
};

export function emptyUsage() {
  return { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0 };
}

export function emptyUsageBucket() {
  return { ...emptyUsage(), calls: 0 };
}

export function parseChatUsage(data) {
  const usage = data?.usage && typeof data.usage === "object" ? data.usage : {};
  const details = usage.prompt_tokens_details || usage.input_tokens_details || {};
  const promptTokens = positiveInt(usage.prompt_tokens ?? usage.input_tokens);
  const completionTokens = positiveInt(usage.completion_tokens ?? usage.output_tokens);
  const cachedTokens = positiveInt(
    usage.prompt_cache_hit_tokens
    ?? details.cached_tokens
    ?? details.cache_read_tokens
    ?? usage.cached_tokens
  );
  const totalTokens = positiveInt(usage.total_tokens) || (promptTokens + completionTokens);
  return { promptTokens, completionTokens, totalTokens, cachedTokens };
}

export function mergeUsages(list) {
  return (Array.isArray(list) ? list : []).reduce((acc, item) => {
    const usage = normalizeUsage(item);
    return {
      promptTokens: acc.promptTokens + usage.promptTokens,
      completionTokens: acc.completionTokens + usage.completionTokens,
      totalTokens: acc.totalTokens + usage.totalTokens,
      cachedTokens: acc.cachedTokens + usage.cachedTokens
    };
  }, emptyUsage());
}

export function normalizeUsage(value) {
  if (!value || typeof value !== "object") return emptyUsage();
  if (value.prompt_tokens != null || value.input_tokens != null) return parseChatUsage({ usage: value });
  const promptTokens = positiveInt(value.promptTokens);
  const completionTokens = positiveInt(value.completionTokens);
  const cachedTokens = positiveInt(value.cachedTokens);
  const totalTokens = positiveInt(value.totalTokens) || (promptTokens + completionTokens);
  return { promptTokens, completionTokens, totalTokens, cachedTokens };
}

export function hasUsage(usage) {
  const next = normalizeUsage(usage);
  return next.promptTokens > 0 || next.completionTokens > 0 || next.totalTokens > 0;
}

export function cacheHitRate(usage) {
  const next = normalizeUsage(usage);
  if (next.promptTokens <= 0) return 0;
  return Math.min(1, next.cachedTokens / next.promptTokens);
}

export function contextWindowForModel(model) {
  const name = String(model || "").toLowerCase();
  if (/gpt-4\.1/.test(name)) return 1047576;
  if (/qwen-long|glm-4-long/.test(name)) return 1000000;
  if (/moonshot-v1-8k/.test(name)) return 8000;
  if (/moonshot-v1-32k/.test(name)) return 32000;
  if (/deepseek-(chat|reasoner)/.test(name)) return 65536;
  if (/kimi|moonshot|qwen|glm-4|gpt-4o|o3|o4|deepseek/.test(name)) return 128000;
  return 128000;
}

/** 中英混排粗估：汉字约 1.2 token，其余约 4 字 1 token */
export function estimateTokensFromText(text) {
  const source = String(text || "");
  if (!source) return 0;
  const cjk = (source.match(/[\u4e00-\u9fff]/g) || []).length;
  const other = Math.max(0, source.length - cjk);
  return Math.max(0, Math.round(cjk * 1.2 + other / 4));
}

export function formatTokenCount(value) {
  const n = Math.max(0, Math.round(Number(value) || 0));
  return n.toLocaleString("zh-CN");
}

export function formatPercent(rate) {
  const n = Number(rate);
  if (!Number.isFinite(n) || n <= 0) return "0%";
  const pct = n * 100;
  return `${pct >= 10 ? pct.toFixed(0) : pct.toFixed(1)}%`;
}

export function emptyUsageStore() {
  return {
    version: 1,
    updatedAt: "",
    totals: emptyUsageBucket(),
    byKind: {},
    byModel: {},
    recent: []
  };
}

export function addUsageEvent(store, event) {
  const usage = normalizeUsage(event);
  if (!hasUsage(usage)) return store || emptyUsageStore();
  const current = store && typeof store === "object" ? store : emptyUsageStore();
  const kind = USAGE_KIND_LABELS[event?.kind] ? event.kind : "interpret";
  const model = String(event?.model || "").trim() || "未知模型";
  const at = String(event?.at || new Date().toISOString());
  const nextEvent = {
    at,
    kind,
    model,
    providerName: String(event?.providerName || "").trim(),
    ...usage
  };
  return {
    version: 1,
    updatedAt: at,
    totals: addToBucket(current.totals, usage),
    byKind: {
      ...(current.byKind || {}),
      [kind]: addToBucket(current.byKind?.[kind], usage)
    },
    byModel: {
      ...(current.byModel || {}),
      [model]: addToBucket(current.byModel?.[model], usage)
    },
    recent: [nextEvent, ...(Array.isArray(current.recent) ? current.recent : [])].slice(0, 40)
  };
}

export function normalizeUsageBucket(bucket) {
  const current = bucket && typeof bucket === "object" ? bucket : emptyUsageBucket();
  return {
    ...normalizeUsage(current),
    calls: positiveInt(current.calls)
  };
}

function addToBucket(bucket, usage) {
  const current = normalizeUsageBucket(bucket);
  return {
    promptTokens: current.promptTokens + usage.promptTokens,
    completionTokens: current.completionTokens + usage.completionTokens,
    totalTokens: current.totalTokens + usage.totalTokens,
    cachedTokens: current.cachedTokens + usage.cachedTokens,
    calls: current.calls + 1
  };
}

function positiveInt(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

function readRawUsageStore() {
  try {
    if (typeof localStorage === "undefined") return null;
    const raw = localStorage.getItem(LLM_USAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function loadLlmUsageStore() {
  const raw = readRawUsageStore();
  if (!raw || typeof raw !== "object") return emptyUsageStore();
  return {
    version: 1,
    updatedAt: String(raw.updatedAt || ""),
    totals: normalizeUsageBucket(raw.totals),
    byKind: raw.byKind && typeof raw.byKind === "object" ? raw.byKind : {},
    byModel: raw.byModel && typeof raw.byModel === "object" ? raw.byModel : {},
    recent: Array.isArray(raw.recent) ? raw.recent : []
  };
}

export function recordLlmUsage(event) {
  const next = addUsageEvent(loadLlmUsageStore(), event);
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(LLM_USAGE_KEY, JSON.stringify(next));
    }
  } catch {
    /* 本机配额满时忽略 */
  }
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(LLM_USAGE_EVENT, { detail: next }));
  }
  return next;
}

export function clearLlmUsageStore() {
  const next = emptyUsageStore();
  try {
    if (typeof localStorage !== "undefined") localStorage.removeItem(LLM_USAGE_KEY);
  } catch {
    /* ignore */
  }
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(LLM_USAGE_EVENT, { detail: next }));
  }
  return next;
}
