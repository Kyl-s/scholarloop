import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { looksLikeLatexMarkup, looksLikeReferenceLine } from "./pdfLayoutQa.js";
import {
  collectFormulaSpanBoxes,
  matchFormulaRuns,
  shouldSuppressFormulaLeak
} from "./pdfFormulaSpans.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STAMP_SCRIPT = path.join(__dirname, "pdfPreserveRegions.py");

const BODY_STOP_RE = /^(graphical abstract|highlights|in brief|summary|abstract|introduction|keywords|significance|background|results?|discussion|methods?|materials and methods|references|acknowledgements?|acknowledgments?|funding|conflict of interest|author contributions?|supplementary|附录|摘要|引言|亮点|参考文献|结论)$/i;

// 首页标题块的正文起点：真实抽取常把摘要标题和正文并成一行（"Abstract: Large language..."），
// isBodyStopLine 只做整行匹配，这里放宽成前缀匹配（可选编号），避免把摘要正文吞进标题块。
const FRONT_MATTER_STOP_RE = /^(?:\d{1,2}(?:\.\d{1,2})*\.?\s+)?(?:abstract|summary|introduction|keywords|significance|background)\b|^(?:摘要|引言|关键词|关键字)/i;

const KEEP_HEADING_RE = /^(authors?|correspondence|affiliations?)$/i;

const ORG_RE = /\b(department|dept\.|institute|university|universit|laboratory|laboratories|\blabs?\b|college|school\b|center for|centre for|hospital|foundation|division of|faculty of|media lab|academy|inc\.|ltd\.|gmbh)\b/i;

const LOC_RE = /\b(USA|U\.S\.A\.|UK|U\.K\.|China|Germany|Japan|France|Switzerland|Canada|Australia|Italy|Spain|Sweden|Netherlands|Korea|Singapore|Israel|India|Austria|Belgium|Denmark|Norway|Finland|Ireland|Poland|Brazil|Mexico)\b|\b(MA|NY|CA|TX|PA|IL|WA|FL|NC|MD|VA|OH|MI|NJ|CT|GA|AZ|CO|OR)\s+\d{4,6}\b|\b\d{4,6}\b/;

const NAME_RE = /[A-Z][\p{L}'’-]+(?:\s+[A-Z]\.)?(?:\s+[A-Z][\p{L}'’-]+)+/gu;

const MATH_RE = /[=∑∫±≤≥×÷√∞∂∇∆∏≈≠∈∉⊂⊃∪∩∧∨¬∀∃∝∼≡≪≫†‡α-ωΑ-Ω^_{}\\]/g;

// 数学函数名不算「散文词」，否则 sin/cos/log 会把纯公式误判成含英文单词。
const MATH_FUNC_WORD_RE = /^(?:sin|cos|tan|log|exp|lim|min|max|arg|det|inf|sup)$/i;
// 连续 ≥3 个 ≥2 字母的英文词视为整句散文（变量/符号之间的单字母不算词）。
const PROSE_WORD_RUN_RE = /[A-Za-z]{2,}(?:\s*[,;:.)\]]?\s+[A-Za-z]{2,}){2,}/;

const CJK_RE = /[\u3400-\u9fff]/;

let cachedPython = undefined;

function normalizeLine(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

export function isBodyStopLine(text) {
  return BODY_STOP_RE.test(normalizeLine(text));
}

export function isKeepHeadingLine(text) {
  return KEEP_HEADING_RE.test(normalizeLine(text));
}

export function isMetaLine(text) {
  const t = normalizeLine(text);
  if (!t) return false;
  if (/license|open access|creative\s*commons/i.test(t)) return false;
  if (/correspondence|lead contact|contributed equally|equal contrib|\borcid\b/i.test(t)) return true;
  if (/@[\w.-]+\.[A-Za-z]{2,}/.test(t)) return true;
  return /^(https?:\/\/(?:dx\.)?doi\.org\/\S+|doi:\s*10\.\S+)$/i.test(t);
}

export function isAffiliationLine(text) {
  const t = normalizeLine(text);
  if (!t || t.length > 280) return false;
  const numbered = /^\d{1,3}(?=[A-Za-z(])/.test(t);
  if (ORG_RE.test(t) && (numbered || LOC_RE.test(t))) return true;
  return numbered && LOC_RE.test(t);
}

export function isAuthorLine(text) {
  const t = normalizeLine(text);
  if (!t || t.length > 400) return false;
  if (isSectionHeadingLine(t)) return false;
  if (isAffiliationLine(t) || isMetaLine(t) || isKeepHeadingLine(t) || isBodyStopLine(t)) return false;
  if (/published by|all rights reserved|open access|©|&copy;|copyright|received|accepted|available online/i.test(t)) return false;
  if (/^(cell|nature|science|lancet|pnas|elife)\s+\d/i.test(t)) return false;
  const names = t.match(NAME_RE) || [];
  const hasDigits = /\d/.test(t);
  const hasAnd = /\band\b/.test(t);
  const commaNames = (t.match(/,/g) || []).length >= 1 && names.length >= 2;
  if (names.length >= 2 && (hasDigits || hasAnd || commaNames)) return true;
  return names.length >= 1 && hasAnd && hasDigits;
}

function isAuthorContinuation(text) {
  const t = normalizeLine(text);
  if (!t || t.length > 90 || isBodyStopLine(t) || isAffiliationLine(t) || isMetaLine(t)) return false;
  const names = t.match(NAME_RE) || [];
  return names.length >= 1 && !/[.!?]["')\]]*$/.test(t.replace(/[,.…]+$/, ""));
}

function isAffiliationContinuation(text) {
  const t = normalizeLine(text);
  if (!t || isBodyStopLine(t) || isKeepHeadingLine(t)) return false;
  if (isAffiliationLine(t) || isMetaLine(t)) return true;
  return LOC_RE.test(t) && t.length < 160 && !/^[A-Z][a-z]+ing\b/.test(t);
}

export function isFormulaLikeLine(text) {
  const t = normalizeLine(text);
  if (!t || CJK_RE.test(t)) return false;
  if (isSectionHeadingLine(t)) return false;
  if (isAuthorLine(t) || isAffiliationLine(t) || isMetaLine(t) || isKeepHeadingLine(t) || isBodyStopLine(t)) return false;
  if (/^(fig(?:ure)?|table|eq(?:uation)?)\.?\s*\d/i.test(t)) return false;
  const math = (t.match(MATH_RE) || []).length;
  // 散文+公式混排行（如「…for learning L_TD(θ)=E[…]」）同样会把公式译坏：
  // 数学符号密集时把长度上限放宽到 240，否则只接受 160 以内的独立公式。
  const mathDense = math >= 6;
  if (t.length > (mathDense ? 240 : 160)) return false;
  if (/\\[a-zA-Z]+/.test(t) || /\$[^$]+\$/.test(t)) return true;
  if (/^[A-Za-z]\w{0,8}\s*[=≈]/.test(t) && math >= 1) return true;
  if (/\b[A-Za-z]\w?\d*\(\s*[A-Za-z](?:\s*,\s*[A-Za-z])+\s*\)/.test(t)) return true;
  // 数学符号密到 6 个以上且带上下标标记：即使夹着 where/and 等连词，也按公式整行回贴。
  if (mathDense && /[_^{}]/.test(t)) return true;
  // 非密集行仍要求基本是纯公式；正文行里的行内公式不能成为整行回贴的理由。
  const prose = t.replace(/\\[a-zA-Z]+/g, " ");
  if (/\b(the|this|that|where|which|with|for|from|and|using|given|we|is|are|of|to)\b/i.test(prose)) return false;
  const words = (prose.match(/[A-Za-z]{3,}/g) || [])
    .filter((word) => !/^(sin|cos|tan|log|exp|lim|min|max|arg|det|inf|sup)$/i.test(word));
  if (words.length) return false;
  return math >= 2 && t.length < 120;
}

/**
 * 源行是否是「纯公式行」：用于决定能否允许公式框覆盖它自己的中文译文。
 * 散文+公式混排行（如 "W = {w0,...}, a sequence of strings w"）整行回贴会
 * 把中文译文替换成英文，因此不算纯公式，仍按原有「相交即跳过」处理。
 */
export function isPureFormulaSourceLine(text) {
  const t = normalizeLine(text);
  if (!t || CJK_RE.test(t)) return false;
  if (PROSE_WORD_RUN_RE.test(t)) return false;
  const tokens = t.match(/[A-Za-z]+/g) || [];
  if (!tokens.length) return true;
  const totalLetters = tokens.reduce((sum, word) => sum + word.length, 0);
  const wordLetters = tokens
    .filter((word) => word.length >= 3 && !MATH_FUNC_WORD_RE.test(word))
    .reduce((sum, word) => sum + word.length, 0);
  // 行内字母以变量/符号为主：成词字母不超过 20%。
  return wordLetters <= totalLetters * 0.2;
}

/**
 * 章节标题（「3 SayCan: Do As I Can, Not As I Say」）判定。
 * 这类行同时满足「≥2 个大写词 + 含数字/逗号」，会被 isAuthorLine 误判成作者行；
 * 标题译文本来就是中文，误判成 author 会导致回贴时把英文标题盖回中文版本。
 * 无编号的标题只在含冒号且标题式大写时成立，避免把单行作者名（"Edward S. Boyden"）当标题。
 */
export function isSectionHeadingLine(text) {
  const t = normalizeLine(text);
  if (!t || CJK_RE.test(t) || t.length > 120) return false;
  const numbered = t.match(/^\d{1,2}(?:\.\d{1,2})*\.?\s+(\S.*)$/u);
  const rest = (numbered ? numbered[1] : t).trim();
  if (!rest) return false;
  // 句末标点说明是正文句子（如「3 orders of magnitude ... .」）。
  if (/[.,;!?]$/.test(rest)) return false;
  const words = rest.split(/\s+/);
  if (!words.length || words.length > 14) return false;
  const capitalized = words.filter((word) => /^[A-Z0-9“"'(]/.test(word)).length;
  const titleCased = capitalized >= Math.ceil(words.length * 0.5);
  if (!numbered) return titleCased && /:/.test(rest);
  return titleCased;
}

export function classifyPreserveLine(text) {
  const t = normalizeLine(text);
  if (!t) return "empty";
  if (isBodyStopLine(t)) return "body-stop";
  if (isKeepHeadingLine(t)) return "keep-heading";
  if (isMetaLine(t)) return "meta";
  if (isAffiliationLine(t)) return "affiliation";
  // 标题不参与原文回贴（KEEP_KINDS 不含 heading），避免盖掉中文标题。
  if (isSectionHeadingLine(t)) return "heading";
  if (isAuthorLine(t)) return "author";
  if (isFormulaLikeLine(t)) return "formula";
  return "other";
}

const KEEP_KINDS = new Set(["author", "affiliation", "meta", "keep-heading"]);

function unionBox(lines, pad = 2) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const line of lines) {
    x0 = Math.min(x0, Number(line.x0));
    y0 = Math.min(y0, Number(line.y0));
    x1 = Math.max(x1, Number(line.x1));
    y1 = Math.max(y1, Number(line.y1));
  }
  if (!Number.isFinite(x0)) return null;
  return {
    x0: x0 - pad,
    y0: y0 - pad,
    x1: x1 + pad,
    y1: y1 + pad
  };
}

function clusterIsAuthorBlock(kinds) {
  return kinds.includes("author")
    || kinds.includes("affiliation")
    || (kinds.includes("keep-heading") && (kinds.includes("meta") || kinds.includes("author")));
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** 标题式大写：多数英文词以大写/数字/引号开头（不要求冒号，供首页标题识别）。 */
function isTitleCaseLine(text) {
  const t = normalizeLine(text);
  if (!t || CJK_RE.test(t)) return false;
  const words = t.split(/\s+/).filter((word) => /[A-Za-z]{2,}/.test(word));
  if (words.length < 2) return false;
  const capitalized = words.filter((word) => /^[A-Z0-9“"'(]/.test(word)).length;
  return capitalized >= Math.ceil(words.length * 0.5);
}

/** 首页标题/作者块的正文起点（摘要/引言，含 "Abstract: ..." 这种并排行）。 */
function isFrontMatterStopLine(text) {
  const t = normalizeLine(text);
  return isBodyStopLine(t) || FRONT_MATTER_STOP_RE.test(t);
}

function lineCenterInsideBox(line, box) {
  const cx = (Number(line?.x0) + Number(line?.x1)) / 2;
  const cy = (Number(line?.y0) + Number(line?.y1)) / 2;
  if (!Number.isFinite(cx) || !Number.isFinite(cy)) return false;
  return cx >= Number(box.x0) && cx <= Number(box.x1)
    && cy >= Number(box.y0) && cy <= Number(box.y1);
}

/**
 * 首页标题 + 作者/机构/元信息整块识别（仅首页调用，由调用方保证）。
 *
 * BabelDOC 会重排首页标题与作者区，逐行回贴既盖不全又会留下碎片；这里把
 * 「标题首行 → body-stop（Abstract/摘要/Introduction…）」之间的顶部块 union 成一个框。
 * 左侧竖排 arXiv 水印（x0 < 页宽 12%）不参与，避免把水印框进来。
 * 识别不确定（没有标题起点 / 不足 2 行）时返回 null，保持旧的逐行行为。
 */
export function collectFrontMatterBox(lines = [], { pageHeight = 0, pageWidth = 0 } = {}) {
  const usable = [...lines]
    .filter((line) => line && normalizeLine(line.text))
    .sort((a, b) => Number(a.y0) - Number(b.y0) || Number(a.x0) - Number(b.x0));
  if (usable.length < 2) return null;
  const inferredWidth = Math.max(
    ...usable.map((line) => Number(line.x1)).filter((value) => Number.isFinite(value) && value > 0)
  );
  const width = Number(pageWidth) > 0 ? Number(pageWidth) : inferredWidth;
  const height = Number(pageHeight) > 0 ? Number(pageHeight) : 0;
  if (!(width > 0) || !(height > 0)) return null;
  // 水印/旋转行：贴左边距的竖排 arXiv 标记不参与标题块。
  const leftLimit = width * 0.12;
  const content = usable.filter((line) => Number(line.x0) >= leftLimit);
  if (content.length < 2) return null;
  const bodySize = median(
    content
      .map((line) => Number(line.size))
      .filter((size) => Number.isFinite(size) && size >= 5)
  );
  const titleLimitY = height * 0.30;
  const start = content.find((line) => {
    if (Number(line.y0) >= titleLimitY) return false;
    const text = normalizeLine(line.text);
    if (isFrontMatterStopLine(text) || isAffiliationLine(text) || isMetaLine(text)) return false;
    if (isSectionHeadingLine(text)) return true;
    const size = Number(line.size) || 0;
    return bodySize > 0 && size >= bodySize * 1.15 && isTitleCaseLine(text);
  });
  if (!start) return null;
  const bottomLimit = height * 0.45;
  const block = [start];
  const startIndex = content.indexOf(start);
  for (let i = startIndex + 1; i < content.length; i += 1) {
    const line = content[i];
    if (Number(line.y0) >= bottomLimit) break;
    const gap = Number(line.y0) - Number(block[block.length - 1].y1);
    if (gap > 40) break;
    // 摘要/引言首行不能进框：它们属于正文，必须继续被翻译。
    if (isFrontMatterStopLine(line.text)) break;
    block.push(line);
  }
  if (block.length < 2) return null;
  const box = unionBox(block, 2);
  if (!box) return null;
  return { ...box, reason: "front-matter", sourceText: start.text };
}

/**
 * 从带 bbox 的行里收出应保留原文的矩形：作者/单位块，以及疑似公式行。
 * frontMatter=true（仅首页）时，标题到机构/元信息整块合并为一个 front-matter 框，
 * 框内行不再逐行生成 author/affiliation/meta 框。
 */
export function collectPreserveBoxes(lines = [], { frontMatter = false, pageHeight = 0, pageWidth = 0 } = {}) {
  const ordered = [...lines]
    .filter((line) => line && normalizeLine(line.text))
    .sort((a, b) => Number(a.y0) - Number(b.y0) || Number(a.x0) - Number(b.x0));
  const frontBox = frontMatter ? collectFrontMatterBox(lines, { pageHeight, pageWidth }) : null;
  const boxes = [];
  let i = 0;
  while (i < ordered.length) {
    const kind = classifyPreserveLine(ordered[i].text);
    if (kind === "formula") {
      boxes.push({ ...unionBox([ordered[i]], 0.5), reason: "formula", sourceText: ordered[i].text });
      i += 1;
      continue;
    }
    // front-matter 框已整块覆盖标题/作者区：框内行不再逐行生成回贴框。
    if (frontBox && lineCenterInsideBox(ordered[i], frontBox)) {
      i += 1;
      continue;
    }
    if (!KEEP_KINDS.has(kind)) {
      i += 1;
      continue;
    }
    const cluster = [ordered[i]];
    const kinds = [kind];
    let j = i;
    while (j + 1 < ordered.length) {
      const next = ordered[j + 1];
      const nextKind = classifyPreserveLine(next.text);
      if (nextKind === "body-stop") break;
      if (frontBox && lineCenterInsideBox(next, frontBox)) break;
      const gap = Number(next.y0) - Number(ordered[j].y1);
      if (gap > 28) break;
      const lastKind = kinds[kinds.length - 1];
      if (KEEP_KINDS.has(nextKind)) {
        cluster.push(next);
        kinds.push(nextKind);
        j += 1;
        continue;
      }
      if (nextKind === "other" && gap <= 20) {
        if ((lastKind === "affiliation" || lastKind === "meta") && isAffiliationContinuation(next.text)) {
          cluster.push(next);
          kinds.push("affiliation");
          j += 1;
          continue;
        }
        if ((lastKind === "author" || lastKind === "keep-heading") && isAuthorContinuation(next.text)) {
          cluster.push(next);
          kinds.push("author");
          j += 1;
          continue;
        }
      }
      break;
    }
    if (clusterIsAuthorBlock(kinds)) {
      // 不 union 跨行/跨栏区域，避免把行间重排后的中文正文一起擦掉。
      for (const line of cluster) boxes.push({ ...unionBox([line], 0.5), reason: "author-block" });
    }
    i = j + 1;
  }
  return [...(frontBox ? [frontBox] : []), ...boxes].filter(Boolean);
}

/**
 * 原文是公式、译文同位置却出现了汉字或 LaTeX 标记时，把该框加入恢复列表。
 * BabelDOC 重排会把译文行推离原位：垂直重叠占比足够，或译文行中心落回源行 ±3pt 带内都算命中；
 * 水平无重叠（如另一栏同行）不算。
 */
export function collectFormulaLeakBoxes(sourceLines = [], destLines = []) {
  const leaks = [];
  let matches = null;
  const getMatches = () => {
    if (matches === null) matches = matchFormulaRuns(sourceLines, destLines);
    return matches;
  };
  for (const src of sourceLines) {
    if (!isFormulaLikeLine(src.text)) continue;
    // Stage 1 门控：该源行所有公式 run 都在译文精确匹配且译文 run 本身无 CJK/LaTeX
    // 时，公式没有损坏，不再生成整行 formula-leak 框（避免把中文正文整行盖回英文）。
    if (Array.isArray(src.spans) && src.spans.length && shouldSuppressFormulaLeak(src, getMatches())) {
      continue;
    }
    const srcH = Math.max(1, Number(src.y1) - Number(src.y0));
    const hit = destLines.some((dst) => {
      const dstText = String(dst.text || "");
      // 汉字说明公式位置被中文占了；LaTeX 标记说明公式被当正文排版了。
      if (!CJK_RE.test(dstText) && !looksLikeLatexMarkup(dstText)) return false;
      const dstH = Math.max(1, Number(dst.y1) - Number(dst.y0));
      const hOverlap = Math.min(Number(src.x1), Number(dst.x1)) - Math.max(Number(src.x0), Number(dst.x0));
      if (hOverlap <= 1) return false;
      const vOverlap = Math.min(Number(src.y1), Number(dst.y1)) - Math.max(Number(src.y0), Number(dst.y0));
      const dstCenter = (Number(dst.y0) + Number(dst.y1)) / 2;
      const centerInBand = dstCenter >= Number(src.y0) - 3 && dstCenter <= Number(src.y1) + 3;
      const ratio = vOverlap / Math.min(srcH, dstH);
      return centerInBand || ratio >= 0.4;
    });
    if (hit) leaks.push({ ...unionBox([src], 0.5), reason: "formula-leak", sourceText: src.text });
  }
  return leaks;
}

/**
 * 译文侧出现 LaTeX 标记时，按位置回贴对应的英文源行。
 * 不依赖 isFormulaLikeLine：像 "M = (S,A,P,R,γ), where S and A are ..." 这类带 prose 的公式行
 * 会被公式分类排除，但译成 LaTeX 乱码后仍需要回贴。只在源行是英文、非作者/单位/meta 行时生效，
 * 且 dest 行自身含中文时直接跳过，避免覆盖中文正文。
 */
export function collectLatexLeakBoxes(sourceLines = [], destLines = []) {
  const leaks = [];
  const sources = Array.isArray(sourceLines) ? sourceLines : [];
  const seen = new Set();
  for (const dst of Array.isArray(destLines) ? destLines : []) {
    if (leaks.length >= 5) break;
    const dstText = String(dst?.text || "");
    if (!looksLikeLatexMarkup(dstText)) continue;
    // 译文行已经承载中文正文，回贴会把它盖掉。
    if (CJK_RE.test(dstText)) continue;
    const dstH = Math.max(1, Number(dst.y1) - Number(dst.y0));
    const dstCenter = (Number(dst.y0) + Number(dst.y1)) / 2;
    const src = sources.find((line) => {
      const text = normalizeLine(line?.text);
      if (!text || CJK_RE.test(text)) return false;
      if (isAuthorLine(text) || isAffiliationLine(text) || isMetaLine(text)) return false;
      const hOverlap = Math.min(Number(dst.x1), Number(line.x1)) - Math.max(Number(dst.x0), Number(line.x0));
      if (hOverlap <= 1) return false;
      const srcH = Math.max(1, Number(line.y1) - Number(line.y0));
      const vOverlap = Math.min(Number(dst.y1), Number(line.y1)) - Math.max(Number(dst.y0), Number(line.y0));
      const centerInBand = dstCenter >= Number(line.y0) - 3 && dstCenter <= Number(line.y1) + 3;
      return centerInBand || vOverlap / Math.min(srcH, dstH) >= 0.4;
    });
    if (!src || seen.has(src)) continue;
    seen.add(src);
    const box = unionBox([src], 0.5);
    if (box) leaks.push({ ...box, reason: "latex-leak", sourceText: src.text });
  }
  return leaks;
}

function matchKey(text) {
  return String(text || "").toLowerCase().replace(/\s+/g, "");
}

/**
 * 把视觉辅助识别的 equation 区域行文本映射回源 PDF 的独立公式行，逐行生成回贴框。
 * region 只持久化行号，行文本由调用方在同进程内传入（assistLineTexts）。
 */
export function collectEquationRegionBoxes(sourceLines = [], equationTextGroups = []) {
  if (!Array.isArray(equationTextGroups) || !equationTextGroups.length) return [];
  const candidates = sourceLines
    .filter((line) => line && normalizeLine(line.text) && !CJK_RE.test(String(line.text)))
    .map((line) => ({ line, key: matchKey(line.text) }))
    .filter((item) => item.key);
  if (!candidates.length) return [];
  const boxes = [];
  const seen = new Set();
  for (const group of equationTextGroups) {
    const keys = (Array.isArray(group) ? group : [group]).map(matchKey).filter(Boolean);
    if (!keys.length) continue;
    const matched = [];
    for (const item of candidates) {
      const hit = keys.some((key) => {
        if (item.key === key) return true;
        const longer = key.length >= item.key.length ? key : item.key;
        const shorter = key.length >= item.key.length ? item.key : key;
        // 两套抽取器的 span 合并方式不同，用归一化文本的包含关系做模糊匹配
        return shorter.length >= 8 && longer.includes(shorter) && shorter.length / longer.length >= 0.8;
      });
      if (hit) matched.push(item.line);
    }
    for (const line of matched) {
      // 视觉模型已把该区域标为 equation：只要行本身不是作者/单位/meta/正文标题，
      // 即使文本抽取得不够「像公式」（字号混排、缺符号）也生成回贴框，避免漏保护。
      const text = normalizeLine(line.text);
      if (!text || CJK_RE.test(text)) continue;
      if (isAuthorLine(text) || isAffiliationLine(text) || isMetaLine(text) || isBodyStopLine(text)) continue;
      const key = `${line.x0},${line.y0},${line.x1},${line.y1}`;
      if (seen.has(key)) continue;
      seen.add(key);
      boxes.push({ ...unionBox([line], 0.5), reason: "vision-equation", sourceText: line.text });
    }
  }
  return boxes.filter(Boolean);
}

const UNTRANSLATED_REF_HINT_RE = /\bet\s+al\b|\bvol\.\s*\d|\bpp\.\s*\d|\bproc\.\b|\barxiv\b|doi\.org|https?:\/\/|^\s*[\[(]\d+[\])]/i;

// 只有「视觉 equation 区域」和「源行是纯公式」的框允许覆盖它自己的中文译文；
// 散文+公式混排行 / formula-leak / latex-leak 仍保持「与中文相交即跳过」，避免整句中文被英文替换。
const CHINESE_LINE_MAX_AREA_RATIO = 0.6;
const CHINESE_LINE_MAX_WIDTH_RATIO = 1.2;

export function boxAllowsChineseOverlap(box) {
  const reason = String(box?.reason || "");
  if (reason === "vision-equation" || reason === "formula-span") return true;
  // 首页标题/作者区整块回贴：允许盖掉这块区域自己的中文标题/作者译文。
  if (reason === "front-matter") return true;
  return reason === "formula" && isPureFormulaSourceLine(box?.sourceText);
}

/**
 * 判断与回贴框相交的中文行是否「本来就是框内内容的译文」。
 * 两个条件任一成立即视为属于该框：
 * - 中文行 ≥60% 的面积落在框内（公式被整体译成中文行）；
 * - 中文行宽度不超过框宽的 1.2 倍、水平中心落在框内（允许 2pt 抽取误差），
 *   且垂直方向确实落在公式行带内（防止只擦到下一行中文的边）。
 * 明显跨出框外/只是与框边缘相切的中文正文行返回 false，调用方继续跳过该框。
 */
export function chineseLineBelongsToBox(box, line) {
  if (!box || !line) return false;
  const bx0 = Number(box.x0);
  const by0 = Number(box.y0);
  const bx1 = Number(box.x1);
  const by1 = Number(box.y1);
  const lx0 = Number(line.x0);
  const ly0 = Number(line.y0);
  const lx1 = Number(line.x1);
  const ly1 = Number(line.y1);
  if (![bx0, by0, bx1, by1, lx0, ly0, lx1, ly1].every(Number.isFinite)) return false;
  const boxWidth = bx1 - bx0;
  const lineWidth = lx1 - lx0;
  const lineHeight = ly1 - ly0;
  if (boxWidth <= 0 || lineWidth <= 0 || lineHeight <= 0) return false;
  const overlapWidth = Math.min(bx1, lx1) - Math.max(bx0, lx0);
  const overlapHeight = Math.min(by1, ly1) - Math.max(by0, ly0);
  if (overlapWidth <= 0 || overlapHeight <= 0) return false;
  if ((overlapWidth * overlapHeight) / (lineWidth * lineHeight) >= CHINESE_LINE_MAX_AREA_RATIO) return true;
  const centerX = (lx0 + lx1) / 2;
  const verticalRatio = overlapHeight / Math.min(by1 - by0, lineHeight);
  return lineWidth <= boxWidth * CHINESE_LINE_MAX_WIDTH_RATIO
    && centerX >= bx0 - 2 && centerX <= bx1 + 2
    && verticalRatio >= CHINESE_LINE_MAX_AREA_RATIO;
}

/** 译文页里「整行仍是英文长句」的正文行：疑似漏译 */
export function isUntranslatedBodyLine(text) {
  const t = normalizeLine(text);
  if (!t || CJK_RE.test(t)) return false;
  if (t.length < 40) return false;
  if (isFormulaLikeLine(t)) return false;
  if (isAuthorLine(t) || isAffiliationLine(t) || isMetaLine(t) || isBodyStopLine(t)) return false;
  if (/^(fig(?:ure)?|table)\b[\s.:]/i.test(t)) return false;
  // 参考文献条目与 pdfLayoutQa 共用同一判定，避免整页文献列表触发无效重译。
  if (looksLikeReferenceLine(t)) return false;
  if (UNTRANSLATED_REF_HINT_RE.test(t)) return false;
  const words = t.split(/\s+/).filter(Boolean);
  if (words.length < 6) return false;
  const letters = (t.match(/[A-Za-z]/g) || []).length;
  return letters >= t.length * 0.6;
}

/**
 * 统计译文页里连续成段的未翻译正文行簇。
 * 单行不成簇（多为残留标题/碎片），参考文献页通常整页成簇（数量远超阈值），由调用方结合上限判断。
 */
export function countUntranslatedClusters(lines = []) {
  const rows = [...lines]
    .filter((line) => line && normalizeLine(line.text))
    .sort((a, b) => Number(a.y0) - Number(b.y0) || Number(a.x0) - Number(b.x0));
  let clusters = 0;
  let run = 0;
  let prev = null;
  const flush = () => {
    if (run >= 2) clusters += 1;
    run = 0;
  };
  for (const row of rows) {
    if (isUntranslatedBodyLine(row.text)) {
      const stacked = prev
        && Number(row.y0) - Number(prev.y1) <= Math.max(6, (Number(prev.y1) - Number(prev.y0)) * 0.9);
      if (run > 0 && !stacked) flush();
      run += 1;
    } else {
      flush();
    }
    prev = row;
  }
  flush();
  return clusters;
}

function pythonCandidates() {
  const runtime = path.join(__dirname, "..", "tools", "pdf2zh", "runtime", "python.exe");
  const site = path.join(__dirname, "..", "tools", "pdf2zh", "site-packages");
  return [
    { cmd: process.env.PYTHON, env: {} },
    { cmd: process.env.PDFMATH_PYTHON, env: {} },
    { cmd: "python", env: {} },
    { cmd: "py", env: { extra: ["-3"] } },
    { cmd: runtime, env: { PYTHONPATH: site } }
  ].filter((item) => item.cmd);
}

export function buildPreservePythonEnv(extra = {}) {
  // Python 在 Windows 控制台默认编码下无法把中文路径中的文本写入 JSON stdout。
  // 用户已指定的值优先，避免覆盖嵌入式 Python 或调用方的编码配置。
  return {
    ...process.env,
    ...extra,
    PYTHONIOENCODING: extra.PYTHONIOENCODING || process.env.PYTHONIOENCODING || "utf-8",
    PYTHONUTF8: extra.PYTHONUTF8 || process.env.PYTHONUTF8 || "1"
  };
}

export function resolvePreservePython() {
  if (cachedPython !== undefined) return cachedPython;
  for (const item of pythonCandidates()) {
    const args = [...(item.env.extra || []), "-c", "import fitz; print('ok')"];
    const env = buildPreservePythonEnv(item.env.PYTHONPATH ? { PYTHONPATH: item.env.PYTHONPATH } : {});
    const result = spawnSync(item.cmd, args, { encoding: "utf8", env, timeout: 15000, windowsHide: true });
    if (result.status === 0 && String(result.stdout || "").includes("ok")) {
      cachedPython = { cmd: item.cmd, extra: item.env.extra || [], env: item.env.PYTHONPATH ? { PYTHONPATH: item.env.PYTHONPATH } : {} };
      return cachedPython;
    }
  }
  cachedPython = null;
  return null;
}

function runPreservePython(argv, { input } = {}) {
  const py = resolvePreservePython();
  if (!py) throw new Error("未找到带 PyMuPDF 的 Python，无法回贴原文区域");
  const result = spawnSync(py.cmd, [...py.extra, STAMP_SCRIPT, ...argv], {
    encoding: "utf8",
    input,
    env: buildPreservePythonEnv(py.env),
    timeout: 60000,
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024
  });
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || "pdfPreserveRegions 失败").trim().slice(0, 500));
  }
  const text = String(result.stdout || "").trim();
  return text ? JSON.parse(text) : {};
}

export function extractPdfPageLines(pdfPath, page, { chars = false } = {}) {
  const argv = ["extract", pdfPath, String(page)];
  // chars=true 时 Python 用 rawdict 返回逐字符 bbox，供 formula-span 精确裁剪 srcClip。
  if (chars) argv.push("chars");
  return runPreservePython(argv);
}

export function stampPreserveBoxes({ sourcePdf, destPdf, page, kind = "mono", boxes = [] } = {}) {
  if (!boxes.length) return { ok: true, restored: 0 };
  const payload = JSON.stringify({
    source: sourcePdf,
    dest: destPdf,
    page,
    kind,
    boxes
  });
  const tmp = path.join(os.tmpdir(), `scholarloop-preserve-${process.pid}-${Date.now()}.json`);
  fs.writeFileSync(tmp, payload, "utf8");
  try {
    return runPreservePython(["stamp", tmp]);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/**
 * 译完后把作者/单位块、泄漏公式和视觉 equation 区域从原文盖回去，保住原排版。
 * 结果携带真正回贴后的译文页文本行；失败返回 ok:false，由调用方处理。
 */
export function restorePreservedRegions({ sourcePdf, destPdf, page, kind = "mono", equationTextGroups = [], preserveFrontMatter = false } = {}) {
  if (!sourcePdf || !destPdf || !page || !fs.existsSync(sourcePdf) || !fs.existsSync(destPdf)) {
    return { ok: false, restored: 0, reason: "missing" };
  }
  try {
    // 源页需要逐字符 bbox：formula-span 的 srcClip 要按匹配子串精确裁剪。
    const source = extractPdfPageLines(sourcePdf, page, { chars: true });
    // 每页产物只有一页；page 是原书页号，不能用于抽取目标产物。
    const dest = extractPdfPageLines(destPdf, 1);
    if (!source.width || !dest.width) throw new Error("preserve-page-missing");
    const destLines = kind === "dual"
      ? (dest.lines || []).filter((line) => Number(line.x0) >= (source.width || 0) * 0.85)
      : dest.lines || [];
    const mappedDest = destLines.map((line) => (
      kind === "dual"
        ? { ...line, x0: line.x0 - source.width, x1: line.x1 - source.width }
        : line
    ));
    const scannedLines = kind === "mono" ? destLines : mappedDest;
    const skipped = [];
    const formulaDiagnostics = [];
    const formulaSpanBoxes = collectFormulaSpanBoxes({
      sourceLines: source.lines || [],
      destLines: dest.lines || [],
      kind,
      sourceWidth: source.width,
      diagnostics: formulaDiagnostics
    });
    for (const diagnostic of formulaDiagnostics) skipped.push(diagnostic);
    // 首页标题/作者区整块回贴：一次 union 框覆盖标题 + 作者/机构/元信息，
    // 避免 BabelDOC 重排后逐行框盖不全、留下碎片。
    const preserveBoxes = collectPreserveBoxes(source.lines || [], {
      frontMatter: preserveFrontMatter && Number(page) === 1,
      pageHeight: Number(source.height) || 0,
      pageWidth: Number(source.width) || 0
    });
    const candidates = [
      ...preserveBoxes,
      ...collectFormulaLeakBoxes(source.lines || [], mappedDest),
      ...collectLatexLeakBoxes(source.lines || [], mappedDest),
      // 视觉 equation 区域框使用源 PDF 坐标；dual 由 Python 盖章时统一加 src_w 偏移，
      // 译文行也已减 src_w 映射回源坐标，因此 mono/dual 共用同一批框。
      ...collectEquationRegionBoxes(source.lines || [], equationTextGroups),
      ...formulaSpanBoxes
    ];
    // 同一矩形可能同时被多种检测命中（formula 与 formula-leak），去重避免重复盖章。
    const uniqueCandidates = [];
    const seenCandidates = new Set();
    for (const box of candidates) {
      const key = [box.x0, box.y0, box.x1, box.y1]
        .map((value) => Math.round(Number(value) * 10) / 10)
        .join(",");
      if (seenCandidates.has(key)) continue;
      seenCandidates.add(key);
      uniqueCandidates.push(box);
    }
    const allowedLegacyBoxes = [];
    const boxes = uniqueCandidates.filter((box) => {
      if (String(box.reason || "") === "formula-span") {
        // span 级公式框只 redaction 公式 run 的矩形，汉字安全交给 Python 逐字符守卫；
        // 这里不再用整行中文相交规则否决它。
        return true;
      }
      const relaxed = boxAllowsChineseOverlap(box);
      const blocker = mappedDest.find((line) => {
        if (!CJK_RE.test(String(line.text || ""))) return false;
        const intersects = Math.min(box.x1, Number(line.x1)) > Math.max(box.x0, Number(line.x0))
          && Math.min(box.y1, Number(line.y1)) > Math.max(box.y0, Number(line.y0));
        if (!intersects) return false;
        // 公式框允许覆盖它自己的中文译文；正文重排越出框外时仍然跳过。
        if (relaxed && chineseLineBelongsToBox(box, line)) return false;
        return true;
      });
      if (blocker) {
        skipped.push({ ...box, diagnostic: "overlaps-chinese-text" });
        return false;
      }
      // 只有被放行的旧整行公式/视觉 equation 框才需要参与「span 框去重」。
      if (relaxed) allowedLegacyBoxes.push(box);
      return true;
    });
    // 纯公式行走旧整行兜底：旧框已经被放行且完全覆盖 span 框时，丢掉 span 框，
    // 避免同一公式整行盖一次、span 再盖一次。
    const coversSource = (legacy, spanBox) => {
      const reason = String(legacy.reason || "");
      if (reason !== "formula" && reason !== "vision-equation") return false;
      return Number(legacy.x0) <= Number(spanBox.srcX0) + 0.5
        && Number(legacy.y0) <= Number(spanBox.srcY0) + 0.5
        && Number(legacy.x1) >= Number(spanBox.srcX1) - 0.5
        && Number(legacy.y1) >= Number(spanBox.srcY1) - 0.5;
    };
    const finalBoxes = boxes.filter((box) => {
      if (String(box.reason || "") !== "formula-span") return true;
      if (allowedLegacyBoxes.some((legacy) => coversSource(legacy, box))) {
        skipped.push({ ...box, diagnostic: "covered-by-legacy-formula" });
        return false;
      }
      return true;
    });
    if (!finalBoxes.length) {
      return {
        ok: true,
        restored: 0,
        reason: "none",
        skipped,
        ignoreBoxes: [],
        destLines: scannedLines,
        // 供版式 QA 做参考文献区域判定；mono/dual 都用同一源页行。
        sourceLines: source.lines || [],
        pageWidth: Number(dest.width) || 0,
        pageHeight: Number(dest.height) || 0
      };
    }
    const stamped = stampPreserveBoxes({ sourcePdf, destPdf, page, kind, boxes: finalBoxes });
    if (stamped.ok !== true) {
      throw new Error(`${stamped.reason || "preserve-stamp-failed"}${stamped.detail ? `:${stamped.detail}` : ""}`);
    }
    const after = extractPdfPageLines(destPdf, 1);
    if (!after.width) throw new Error("preserve-output-extraction-failed");
    const afterLines = kind === "dual"
      ? (after.lines || []).filter((line) => Number(line.x0) >= source.width * 0.85)
        .map((line) => ({ ...line, x0: line.x0 - source.width, x1: line.x1 - source.width }))
      : after.lines || [];
    return {
      ok: true,
      restored: stamped.restored ?? 0,
      boxes: finalBoxes,
      // 首页 front-matter 框：供版式 QA 忽略整块回贴的英文标题/作者区。
      ignoreBoxes: finalBoxes.filter((box) => String(box.reason || "") === "front-matter"),
      span: stamped.span || null,
      skipped: [...skipped, ...(stamped.skipped || [])],
      destLines: afterLines,
      // 供版式 QA 做参考文献区域判定；mono/dual 都用同一源页行。
      sourceLines: source.lines || [],
      pageWidth: Number(after.width) || 0,
      pageHeight: Number(after.height) || 0
    };
  } catch (error) {
    return { ok: false, restored: 0, reason: error.message || String(error), ignoreBoxes: [] };
  }
}

export function restorePreservedPageOutputs(sourcePdf, destMono, destDual, page, { equationTextGroups = [], preserveFrontMatter = false } = {}) {
  const results = [];
  if (destMono && fs.existsSync(destMono)) {
    results.push({ kind: "mono", ...restorePreservedRegions({ sourcePdf, destPdf: destMono, page, kind: "mono", equationTextGroups, preserveFrontMatter }) });
  }
  if (destDual && fs.existsSync(destDual) && destDual !== destMono) {
    results.push({ kind: "dual", ...restorePreservedRegions({ sourcePdf, destPdf: destDual, page, kind: "dual", equationTextGroups, preserveFrontMatter }) });
  }
  return results;
}

// 公式 span 级工具从本模块一并导出，调用方/探针不必直接依赖内部文件名。
export {
  buildFormulaRuns,
  collectFormulaSpanBoxes,
  matchFormulaRuns,
  shouldSuppressFormulaLeak
} from "./pdfFormulaSpans.js";
