import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * 版式译 custom-system-prompt（写入 BabelDOC 的 role_block）。
 * 只写文风/术语，不要写输出格式：
 * - 批量路径自带「返回 JSON 数组」；role_block 若写「只输出纯译文」会冲掉该格式，整批失败后回退逐段、极慢。
 * - 回退逐段路径要求纯文本；role_block 若写「必须输出 JSON」会把 ```json[{"id":1,"output":"..."}]``` 原样画进 PDF。
 * 输出格式交给 BabelDOC 模板；围栏/泄漏由 sanitizeTranslationModelOutput 与本地 LLM 代理剥离。
 */
export const ACADEMIC_ZH_SYSTEM_PROMPT = [
  "You are a professional native Chinese academic translator for scientific papers.",
  "Translate into fluent Simplified Chinese that reads like a Chinese journal article.",
  "Style: natural sentence structure; accurate meaning; consistent terminology",
  "(noninvasive→非侵入性, recruit→募集, stimulation→刺激); keep common acronyms (DBS, TI, c-fos, EEG).",
  "Keep placeholders, tags, pure numbers/units/math tokens unchanged when they are not prose.",
  "Never translate URLs, DOIs, or web links (http/https/www/doi.org): copy them exactly as in the input.",
  "Follow the Output Format and Structure Rules in the user message for this request.",
  "Never wrap the answer in markdown fences or extra commentary."
].join(" ");

/** 匹配需原样保留的网址 / DOI 链接 */
export const URL_PRESERVE_RE =
  /(?:https?:\/\/|www\.)[^\s<>"'）】\]}>，。；、！？]+|doi:\s*10\.\S+/gi;

const URL_TRAILING_PUNCT_RE = /[.,;:!?，。；：！？）】\]}>]+$/;

/** 侧栏文字翻译的 system 提示（可附带占位符保护说明） */
export function buildTextTranslateSystemPrompt({ preserveTokens = false } = {}) {
  const parts = [
    "你是专业的学术文献翻译，把用户给出的文献内容翻译成简体中文。",
    "要求：",
    "1) 术语准确统一：同一概念全文用同一译法（如 noninvasive 一律译「非侵入性」，不要混用「无创」；recruit 用「募集」；stimulation 用「刺激」）。",
    "2) 译文自然通顺，像中文论文，避免机翻腔与电报式断句。",
    "3) 专有名词、基因/蛋白名、常见缩写（DBS、TI、c-fos、EEG 等）按学界习惯保留英文或中英并用。",
    "4) 保持段落与标点结构；不要增删论点或数据。",
    "5) 纯数字、单位、公式、变量名、图注编号（Fig. 1 / (A)）尽量原样保留。",
    "6) 网址、DOI、网页链接（http/https/www/doi.org 等）一律不翻译，原样保留。",
    "7) 只输出译文，不要解释或补充。"
  ];
  if (preserveTokens) {
    parts.push("8) 原样保留所有形如 __SCHOLARLOOP_KEEP_数字__ 与 __SCHOLARLOOP_URL_数字__ 的占位符，不要翻译、删除、改写或添加空格。");
  }
  return parts.join("");
}

/** 把 URL 换成占位符，译后再还原，避免模型改写链接 */
export function protectUrls(text) {
  const urls = [];
  const protectedText = String(text || "").replace(URL_PRESERVE_RE, (match) => {
    const trailingMatch = match.match(URL_TRAILING_PUNCT_RE);
    const trailing = trailingMatch ? trailingMatch[0] : "";
    const url = trailing ? match.slice(0, -trailing.length) : match;
    if (!url || url.length < 4) return match;
    const index = urls.length;
    urls.push(url);
    return `__SCHOLARLOOP_URL_${index}__${trailing}`;
  });
  return { text: protectedText, urls };
}

export function restoreUrls(text, urls = []) {
  if (!urls?.length) return String(text || "");
  return String(text || "").replace(/__SCHOLARLOOP_URL_(\d+)__/g, (full, idx) => {
    const i = Number(idx);
    return Number.isInteger(i) && urls[i] != null ? urls[i] : full;
  });
}

export function getAcademicGlossaryPath() {
  return path.join(__dirname, "assets", "academic-zh-glossary.csv");
}

/** 从术语表中挑出在原文里出现过的条目，拼进文字译提示（轻量上下文一致） */
export function buildGlossaryHintForText(text, { maxEntries = 24 } = {}) {
  const file = getAcademicGlossaryPath();
  if (!text || !fs.existsSync(file)) return "";
  let raw = "";
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
  const lines = raw.split(/\r?\n/).slice(1);
  const lower = String(text).toLowerCase();
  const hits = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    // CSV: source,target,tgt_lng — source/target 不含逗号
    const [source, target] = line.split(",");
    if (!source || !target) continue;
    if (lower.includes(source.toLowerCase())) {
      hits.push(`${source} → ${target}`);
      if (hits.length >= maxEntries) break;
    }
  }
  if (!hits.length) return "";
  return `\n本段可用术语对照（出现时请优先采用）：${hits.join("；")}。`;
}

/** 去掉模型爱加的 ```json 围栏和 <think> */
export function stripLlmCodeFences(text) {
  let s = String(text || "").trim();
  s = s.replace(/^<think>[\s\S]*?<\/think>/i, "").trim();
  s = s.replace(/^<json>\s*/i, "").replace(/\s*<\/json>\s*$/i, "").trim();
  const wrapped = s.match(/^```(?:json|JSON)?\s*([\s\S]*?)\s*```$/);
  if (wrapped) return wrapped[1].trim();
  if (/^```(?:json|JSON)?/.test(s)) {
    s = s.replace(/^```(?:json|JSON)?\s*/, "");
    s = s.replace(/\s*```$/, "");
  }
  return s.trim();
}

function tryParseJson(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function firstJsonValue(text) {
  const s = String(text || "").trim();
  const direct = tryParseJson(s);
  if (direct != null) return direct;
  const arrayMatch = s.match(/\[[\s\S]*\]/);
  if (arrayMatch) {
    const parsed = tryParseJson(arrayMatch[0]);
    if (parsed != null) return parsed;
  }
  const objectMatch = s.match(/\{[\s\S]*\}/);
  if (objectMatch) {
    const parsed = tryParseJson(objectMatch[0]);
    if (parsed != null) return parsed;
  }
  return null;
}

function isTranslationRecord(item) {
  return Boolean(item && typeof item === "object" && ("output" in item || ("id" in item && "input" in item)));
}

function collectTranslationOutputs(parsed) {
  if (Array.isArray(parsed)) {
    if (!parsed.length || !parsed.every(isTranslationRecord)) return null;
    return parsed.map((item) => String(item.output ?? item.input ?? ""));
  }
  if (!parsed || typeof parsed !== "object") return null;
  if (typeof parsed.output === "string") return [parsed.output];
  if (Array.isArray(parsed.translations)) return collectTranslationOutputs(parsed.translations);
  if (Array.isArray(parsed.results)) return collectTranslationOutputs(parsed.results);
  return null;
}

function compactTranslationJson(parsed) {
  if (Array.isArray(parsed)) {
    return JSON.stringify(parsed.map((item) => ({
      id: item.id,
      output: String(item.output ?? item.input ?? "")
    })));
  }
  if (parsed && typeof parsed === "object" && (parsed.id != null || typeof parsed.output === "string")) {
    return JSON.stringify([{
      id: parsed.id ?? 0,
      output: String(parsed.output ?? parsed.input ?? "")
    }]);
  }
  return "";
}

/** 批量路径的用户消息会带 JSON 数组说明 / id+input */
export function looksLikeBatchJsonRequest(prompt) {
  const s = String(prompt || "");
  return /Return a JSON array/i.test(s)
    || /## Output Format/.test(s)
    || /"id"\s*:\s*\d+\s*,\s*"input"\s*:/.test(s);
}

/**
 * 清洗模型译文：
 * - expectJson=true（BabelDOC 批量）：剥围栏，只留合法 [{id,output}]
 * - expectJson=false（侧栏 / 逐段回退）：若整段是 JSON，抽出 output，避免把 JSON 画进 PDF/面板
 */
export function sanitizeTranslationModelOutput(text, { expectJson = false } = {}) {
  const cleaned = stripLlmCodeFences(text);
  if (!cleaned) return "";
  const parsed = firstJsonValue(cleaned);
  const outputs = parsed ? collectTranslationOutputs(parsed) : null;
  if (expectJson) {
    if (outputs) return compactTranslationJson(parsed) || cleaned;
    return cleaned;
  }
  if (outputs) return outputs.filter(Boolean).join("\n\n");
  return cleaned;
}
