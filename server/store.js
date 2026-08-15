import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import {
  addPathTask as addPathTaskToPath,
  appendPathLog as appendPathLogEntry,
  findPathTask,
  pathProgress,
  setTaskStatus as setPathTaskStatus,
  splitPathTask as splitPathTaskInPath
} from "./path.js";
import { clearPdfCache, deletePdfSource } from "./pdfCache.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "data");
const DATA_FILE = path.join(DATA_DIR, "store.json");

const defaultData = () => ({
  library: [],
  memories: [],
  path: {
    goal: null,
    level: "beginner",
    stages: []
  },
  drafts: [],
  journals: [],
  settings: {
    openLinksInNewTab: true,
    defaultSources: ["arxiv", "openalex", "semanticscholar", "pubmed", "crossref", "cnki"],
    defaultSort: "authority",
    proxy: "",
    pdfMathTranslateBin: "",
    // 版式翻译：单页内 qps/workers 全力；页间默认串行 1（最多 2=当前+下一页）
    pdfMathQps: 12,
    pdfMathWorkers: 8,
    pdfMathPageWorkers: 1,
    pdfMathNoDual: false,
    institutionAccess: {
      enabled: false,
      name: "",
      type: "webvpn",
      portalUrl: ""
    }
  },
  searchCache: {}
});

let data = null;

function ensureFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(defaultData(), null, 2), "utf8");
  }
}

export function loadData() {
  ensureFile();
  try {
    const raw = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    data = {
      ...defaultData(),
      ...raw,
      memories: normalizeMemoryList(raw.memories),
      path: { ...defaultData().path, ...(raw.path || {}) },
      settings: {
        ...defaultData().settings,
        ...(raw.settings || {}),
        institutionAccess: {
          ...defaultData().settings.institutionAccess,
          ...(raw.settings?.institutionAccess || {})
        }
      }
    };
  } catch (err) {
    console.warn("数据文件损坏，已重建：", err.message);
    data = defaultData();
  }
  return data;
}

export function getData() {
  if (!data) loadData();
  return data;
}

export function save() {
  const tmp = DATA_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  fs.renameSync(tmp, DATA_FILE);
}

export function resetData(next = null) {
  data = next || defaultData();
  save();
  return data;
}

export function upsertPaper(paper) {
  const existing = data.library.find((p) => p.id === paper.id);
  if (existing) {
    Object.assign(existing, paper, { id: existing.id, savedAt: existing.savedAt, updatedAt: new Date().toISOString() });
    save();
    return existing;
  }
  const record = {
    ...paper,
    status: paper.status || "todo",
    understanding: paper.understanding ?? 1,
    tags: paper.tags || [],
    notes: paper.notes || "",
    reviewDue: paper.reviewDue || addDays(3),
    savedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  data.library.unshift(record);
  save();
  return record;
}

export function updatePaper(id, patch) {
  const paper = data.library.find((p) => p.id === id);
  if (!paper) return null;
  Object.assign(paper, patch, { id, updatedAt: new Date().toISOString() });
  if (patch.understanding !== undefined) {
    const days = [3, 7, 14, 30, 60][Math.max(0, Math.min(4, Number(patch.understanding) - 1))];
    paper.reviewDue = addDays(days);
  }
  save();
  return paper;
}

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
    .slice(0, 12);
}

/**
 * 只保存 AI 解读本身，明确排除前端传入的 API 配置等敏感信息。
 */
export function normalizeSavedInterpretation(value) {
  if (!value || typeof value !== "object" || !value.result || typeof value.result !== "object") return null;
  let result;
  try {
    result = JSON.parse(JSON.stringify(value.result));
  } catch {
    return null;
  }
  if (result.evidence) result.evidence = normalizeEvidenceItems(result.evidence);
  const followups = Array.isArray(value.followups)
    ? value.followups
        .map((item) => ({
          id: String(item?.id || "").trim(),
          q: String(item?.q || "").trim(),
          a: String(item?.a || ""),
          status: item?.status === "error" ? "error" : "done",
          evidence: normalizeEvidenceItems(item?.evidence)
        }))
        .filter((item) => item.q)
    : [];
  return {
    version: 1,
    mode: value.mode === "full" ? "full" : "quick",
    usedChars: Number(value.usedChars) || 0,
    pageCoverage: String(value.pageCoverage || ""),
    result,
    followups,
    savedAt: String(value.savedAt || new Date().toISOString())
  };
}

export function getPaperInterpretation(id) {
  const paper = getData().library.find((p) => p.id === id);
  return paper?.aiInterpretation || null;
}

export function savePaperInterpretation(id, value) {
  const paper = getData().library.find((p) => p.id === id);
  if (!paper) return null;
  const normalized = normalizeSavedInterpretation(value);
  if (!normalized) throw new Error("AI 解读内容为空或格式不正确");
  paper.aiInterpretation = normalized;
  paper.updatedAt = new Date().toISOString();
  save();
  return paper;
}

export function removePaper(id) {
  const removed = data.library.find((paper) => paper.id === id);
  data.library = data.library.filter((p) => p.id !== id);
  if (removed) {
    clearPdfCache(id);
    if (removed.localPdf) deletePdfSource(removed.pdfUrl);
  }
  save();
}

const SENSITIVE_MEMORY_PATTERNS = [
  [/sk-[A-Za-z0-9_-]{12,}/g, "[已隐藏 API Key]"],
  [/(Bearer\s+)[^\s,;]+/gi, "$1[已隐藏]"],
  [/((?:api[_ -]?key|password|passwd|token|cookie|secret|密钥|密码)\s*[:=：]\s*)[^\r\n]+/gi, "$1[已隐藏]"]
];

function redactMemoryText(value, maxLength = 10000) {
  let text = String(value || "").trim();
  for (const [pattern, replacement] of SENSITIVE_MEMORY_PATTERNS) text = text.replace(pattern, replacement);
  return text.slice(0, maxLength).trim();
}

function normalizeMemoryTags(value) {
  const raw = Array.isArray(value) ? value : String(value || "").split(/[,，]/);
  return [...new Set(raw.map((tag) => redactMemoryText(tag, 40)).filter(Boolean))].slice(0, 20);
}

export function normalizeMemoryInput(value, base = {}) {
  const source = { ...base, ...(value || {}) };
  const title = redactMemoryText(source.title, 120) || "未命名记忆";
  const content = redactMemoryText(source.content, 10000);
  if (!content) return null;
  return {
    title,
    content,
    tags: normalizeMemoryTags(source.tags),
    enabled: source.enabled !== false
  };
}

function normalizeStoredMemory(value) {
  const normalized = normalizeMemoryInput(value);
  if (!normalized) return null;
  const now = new Date().toISOString();
  return {
    id: String(value?.id || randomUUID()),
    ...normalized,
    createdAt: String(value?.createdAt || now),
    updatedAt: String(value?.updatedAt || now)
  };
}

function normalizeMemoryList(value) {
  return Array.isArray(value) ? value.map(normalizeStoredMemory).filter(Boolean) : [];
}

export function getMemories() {
  return getData().memories;
}

export function upsertMemory(value = {}) {
  const existing = value.id ? data.memories.find((memory) => memory.id === value.id) : null;
  const normalized = normalizeMemoryInput(value, existing || {});
  if (!normalized) throw new Error("记忆内容不能为空");
  const now = new Date().toISOString();
  if (existing) {
    Object.assign(existing, normalized, { id: existing.id, updatedAt: now });
    save();
    return existing;
  }
  const record = { id: randomUUID(), ...normalized, createdAt: now, updatedAt: now };
  data.memories.unshift(record);
  save();
  return record;
}

export function updateMemory(id, patch = {}) {
  const memory = data.memories.find((item) => item.id === id);
  if (!memory) return null;
  const normalized = normalizeMemoryInput(patch, memory);
  if (!normalized) throw new Error("记忆内容不能为空");
  Object.assign(memory, normalized, { id, updatedAt: new Date().toISOString() });
  save();
  return memory;
}

export function removeMemory(id) {
  data.memories = data.memories.filter((memory) => memory.id !== id);
  save();
}

export function setPath(patch) {
  data.path = { ...data.path, ...patch };
  save();
  return data.path;
}

export function getSettings() {
  return getData().settings;
}

export function getSearchCache() {
  const current = getData();
  if (!current.searchCache || typeof current.searchCache !== "object") current.searchCache = {};
  return current.searchCache;
}

export function setSearchCache(key, value) {
  getSearchCache()[key] = value;
  save();
  return value;
}

export function updateSettings(patch = {}) {
  const current = getData();
  current.settings = { ...current.settings, ...patch };
  save();
  return current.settings;
}

export function completePathTask(taskTitle = "") {
  const current = getData();
  const target = findPathTask(current.path, taskTitle);
  if (!target) return { ok: false, error: "未找到对应的学习任务，请确认任务标题或 id" };
  const stages = current.path.stages.map((s) => {
    if (s.id !== target.stageId) return s;
    return { ...s, tasks: s.tasks.map((t, i) => (i === target.index ? { ...t, done: true } : t)) };
  });
  current.path = { ...current.path, stages };
  save();
  return {
    ok: true,
    task: target,
    next: findPathTask(current.path, "") || null,
    progress: pathProgress(stages)
  };
}

export function addPathTask(stageId, title) {
  const current = getData();
  current.path = addPathTaskToPath(current.path, stageId, title);
  save();
  return current.path;
}

export function splitPathTask(stageId, index, titles) {
  const current = getData();
  current.path = splitPathTaskInPath(current.path, stageId, index, titles);
  save();
  return current.path;
}

export function updatePathTaskStatus(stageId, index, status) {
  const current = getData();
  current.path = setPathTaskStatus(current.path, stageId, index, status);
  save();
  return current.path;
}

export function appendPathLog(entry) {
  const current = getData();
  current.path = appendPathLogEntry(current.path, entry);
  save();
  return current.path;
}

export function getDrafts() {
  return data.drafts;
}

export function upsertDraft(draft) {
  const existing = data.drafts.find((d) => d.id === draft.id);
  if (existing) {
    Object.assign(existing, draft, { updatedAt: new Date().toISOString() });
    save();
    return existing;
  }
  const record = {
    id: randomUUID(),
    title: draft.title || "未命名论文",
    type: draft.type || "imrad",
    abstract: draft.abstract || "",
    sections: draft.sections || [],
    citations: draft.citations || [],
    updatedAt: new Date().toISOString(),
    createdAt: new Date().toISOString()
  };
  data.drafts.unshift(record);
  save();
  return record;
}

export function removeDraft(id) {
  data.drafts = data.drafts.filter((d) => d.id !== id);
  save();
}

export function getJournals() {
  return getData().journals;
}

export function upsertJournal(journal) {
  const current = getData();
  const existing = current.journals.find((j) => j.id === journal.id);
  if (existing) {
    Object.assign(existing, journal, { updatedAt: new Date().toISOString() });
    save();
    return existing;
  }
  const record = {
    id: journal.id || randomUUID(),
    title: journal.title || "未命名思考记录",
    core: journal.core || "",
    takeaways: journal.takeaways || [],
    summary: journal.summary || "",
    mindmap: journal.mindmap || null,
    messages: journal.messages || [],
    turnCount: journal.turnCount || 0,
    timeline: journal.timeline || [],
    corrections: journal.corrections || [],
    insights: journal.insights || [],
    nextSteps: journal.nextSteps || [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  current.journals.unshift(record);
  save();
  return record;
}

export function removeJournal(id) {
  const current = getData();
  current.journals = current.journals.filter((j) => j.id !== id);
  save();
}

export function importAll(payload) {
  if (!payload || typeof payload !== "object") throw new Error("导入数据格式不正确");
  data = { ...defaultData(), ...payload, memories: normalizeMemoryList(payload.memories) };
  save();
  return data;
}

function addDays(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}
