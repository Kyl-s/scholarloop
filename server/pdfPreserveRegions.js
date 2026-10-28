import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STAMP_SCRIPT = path.join(__dirname, "pdfPreserveRegions.py");

const BODY_STOP_RE = /^(graphical abstract|highlights|in brief|summary|abstract|introduction|keywords|significance|background|results?|discussion|methods?|materials and methods|references|acknowledgements?|acknowledgments?|funding|conflict of interest|author contributions?|supplementary|附录|摘要|引言|亮点|参考文献|结论)$/i;

const KEEP_HEADING_RE = /^(authors?|correspondence|affiliations?)$/i;

const ORG_RE = /\b(department|dept\.|institute|university|universit|laboratory|laboratories|\blabs?\b|college|school\b|center for|centre for|hospital|foundation|division of|faculty of|media lab|academy|inc\.|ltd\.|gmbh)\b/i;

const LOC_RE = /\b(USA|U\.S\.A\.|UK|U\.K\.|China|Germany|Japan|France|Switzerland|Canada|Australia|Italy|Spain|Sweden|Netherlands|Korea|Singapore|Israel|India|Austria|Belgium|Denmark|Norway|Finland|Ireland|Poland|Brazil|Mexico)\b|\b(MA|NY|CA|TX|PA|IL|WA|FL|NC|MD|VA|OH|MI|NJ|CT|GA|AZ|CO|OR)\s+\d{4,6}\b|\b\d{4,6}\b/;

const NAME_RE = /[A-Z][\p{L}'’-]+(?:\s+[A-Z]\.)?(?:\s+[A-Z][\p{L}'’-]+)+/gu;

const MATH_RE = /[=∑∫±≤≥×÷√∞∂∇∆∏≈≠∈∉⊂⊃∪∩∧∨¬∀∃∝∼≡≪≫†‡α-ωΑ-Ω^_{}\\]/g;

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
  if (isAuthorLine(t) || isAffiliationLine(t) || isMetaLine(t) || isKeepHeadingLine(t) || isBodyStopLine(t)) return false;
  if (/^(fig(?:ure)?|table|eq(?:uation)?)\.?\s*\d/i.test(t)) return false;
  const math = (t.match(MATH_RE) || []).length;
  // 散文+公式混排行（如「…for learning L_TD(θ)=E[…]」）同样会把公式译坏，数学符号密集时放宽长度上限
  if (t.length > (math >= 6 ? 240 : 160)) return false;
  if (/\\[a-zA-Z]+/.test(t) || /\$[^$]+\$/.test(t)) return true;
  if (/^[A-Za-z]\w{0,8}\s*[=≈]/.test(t) && math >= 1) return true;
  if (/\b[A-Za-z]\w?\d*\(\s*[A-Za-z](?:\s*,\s*[A-Za-z])+\s*\)/.test(t)) return true;
  return math >= 2 && t.length < 120;
}

export function classifyPreserveLine(text) {
  const t = normalizeLine(text);
  if (!t) return "empty";
  if (isBodyStopLine(t)) return "body-stop";
  if (isKeepHeadingLine(t)) return "keep-heading";
  if (isMetaLine(t)) return "meta";
  if (isAffiliationLine(t)) return "affiliation";
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

/**
 * 从带 bbox 的行里收出应保留原文的矩形：作者/单位块，以及疑似公式行。
 */
export function collectPreserveBoxes(lines = []) {
  const ordered = [...lines]
    .filter((line) => line && normalizeLine(line.text))
    .sort((a, b) => Number(a.y0) - Number(b.y0) || Number(a.x0) - Number(b.x0));
  const boxes = [];
  let i = 0;
  while (i < ordered.length) {
    const kind = classifyPreserveLine(ordered[i].text);
    if (kind === "formula") {
      boxes.push({ ...unionBox([ordered[i]], 1.5), reason: "formula" });
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
      boxes.push({ ...unionBox(cluster, 2.2), reason: "author-block" });
    }
    i = j + 1;
  }
  return boxes.filter(Boolean);
}

/**
 * 原文是公式、译文同位置却出现了汉字时，把该框加入恢复列表。
 * BabelDOC 重排会把译文行推离原位：垂直重叠占比足够，或译文行中心落回源行 ±3pt 带内都算命中；
 * 水平无重叠（如另一栏同行）不算。
 */
export function collectFormulaLeakBoxes(sourceLines = [], destLines = []) {
  const leaks = [];
  for (const src of sourceLines) {
    if (!isFormulaLikeLine(src.text)) continue;
    const srcH = Math.max(1, Number(src.y1) - Number(src.y0));
    const hit = destLines.some((dst) => {
      if (!CJK_RE.test(String(dst.text || ""))) return false;
      const dstH = Math.max(1, Number(dst.y1) - Number(dst.y0));
      const hOverlap = Math.min(Number(src.x1), Number(dst.x1)) - Math.max(Number(src.x0), Number(dst.x0));
      if (hOverlap <= 1) return false;
      const vOverlap = Math.min(Number(src.y1), Number(dst.y1)) - Math.max(Number(src.y0), Number(dst.y0));
      const dstCenter = (Number(dst.y0) + Number(dst.y1)) / 2;
      const centerInBand = dstCenter >= Number(src.y0) - 3 && dstCenter <= Number(src.y1) + 3;
      const ratio = vOverlap / Math.min(srcH, dstH);
      return centerInBand || ratio >= 0.4;
    });
    if (hit) leaks.push({ ...unionBox([src], 1.5), reason: "formula-leak" });
  }
  return leaks;
}

function matchKey(text) {
  return String(text || "").toLowerCase().replace(/\s+/g, "");
}

/**
 * 把视觉辅助识别的 equation 区域行文本映射回源 PDF 行，union 成回贴框。
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
    if (matched.length) boxes.push({ ...unionBox(matched, 2), reason: "vision-equation" });
  }
  return boxes.filter(Boolean);
}

const UNTRANSLATED_REF_HINT_RE = /\bet\s+al\b|\bvol\.\s*\d|\bpp\.\s*\d|\bproc\.\b|\barxiv\b|doi\.org|https?:\/\/|^\s*[\[(]\d+[\])]/i;

/** 译文页里「整行仍是英文长句」的正文行：疑似漏译 */
export function isUntranslatedBodyLine(text) {
  const t = normalizeLine(text);
  if (!t || CJK_RE.test(t)) return false;
  if (t.length < 40) return false;
  if (isFormulaLikeLine(t)) return false;
  if (isAuthorLine(t) || isAffiliationLine(t) || isMetaLine(t) || isBodyStopLine(t)) return false;
  if (/^(fig(?:ure)?|table)\b[\s.:]/i.test(t)) return false;
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

export function extractPdfPageLines(pdfPath, page) {
  return runPreservePython(["extract", pdfPath, String(page)]);
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
 * 结果携带译文页文本行（mono 为全部行，dual 为译文半幅行），调用方可复用做漏译扫描，省一次抽取。
 * 失败不抛给翻译任务。
 */
export function restorePreservedRegions({ sourcePdf, destPdf, page, kind = "mono", equationTextGroups = [] } = {}) {
  if (!sourcePdf || !destPdf || !page || !fs.existsSync(sourcePdf) || !fs.existsSync(destPdf)) {
    return { ok: false, restored: 0, reason: "missing" };
  }
  try {
    const source = extractPdfPageLines(sourcePdf, page);
    const dest = extractPdfPageLines(destPdf, page);
    const destLines = kind === "dual"
      ? (dest.lines || []).filter((line) => Number(line.x0) >= (source.width || 0) * 0.85)
      : dest.lines || [];
    const mappedDest = destLines.map((line) => (
      kind === "dual"
        ? { ...line, x0: line.x0 - source.width, x1: line.x1 - source.width }
        : line
    ));
    const scannedLines = kind === "mono" ? destLines : mappedDest;
    const boxes = [
      ...collectPreserveBoxes(source.lines || []),
      ...collectFormulaLeakBoxes(source.lines || [], mappedDest),
      ...(kind === "mono" ? collectEquationRegionBoxes(source.lines || [], equationTextGroups) : [])
    ];
    if (!boxes.length) return { ok: true, restored: 0, reason: "none", destLines: scannedLines };
    const stamped = stampPreserveBoxes({ sourcePdf, destPdf, page, kind, boxes });
    return { ok: true, restored: stamped.restored || boxes.length, boxes, destLines: scannedLines };
  } catch (error) {
    return { ok: false, restored: 0, reason: error.message || String(error) };
  }
}

export function restorePreservedPageOutputs(sourcePdf, destMono, destDual, page, { equationTextGroups = [] } = {}) {
  const results = [];
  if (destMono && fs.existsSync(destMono)) {
    results.push({ kind: "mono", ...restorePreservedRegions({ sourcePdf, destPdf: destMono, page, kind: "mono", equationTextGroups }) });
  }
  if (destDual && fs.existsSync(destDual) && destDual !== destMono) {
    results.push({ kind: "dual", ...restorePreservedRegions({ sourcePdf, destPdf: destDual, page, kind: "dual", equationTextGroups }) });
  }
  return results;
}
