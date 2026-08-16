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
  if (!t || t.length > 160 || CJK_RE.test(t)) return false;
  if (isAuthorLine(t) || isAffiliationLine(t) || isMetaLine(t) || isKeepHeadingLine(t) || isBodyStopLine(t)) return false;
  if (/^(fig(?:ure)?|table|eq(?:uation)?)\.?\s*\d/i.test(t)) return false;
  const math = (t.match(MATH_RE) || []).length;
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
 */
export function collectFormulaLeakBoxes(sourceLines = [], destLines = []) {
  const leaks = [];
  for (const src of sourceLines) {
    if (!isFormulaLikeLine(src.text)) continue;
    const hit = destLines.some((dst) => {
      if (!CJK_RE.test(String(dst.text || ""))) return false;
      const overlap = Math.min(Number(src.y1), Number(dst.y1)) - Math.max(Number(src.y0), Number(dst.y0));
      return overlap > 1;
    });
    if (hit) leaks.push({ ...unionBox([src], 1.5), reason: "formula-leak" });
  }
  return leaks;
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

export function resolvePreservePython() {
  if (cachedPython !== undefined) return cachedPython;
  for (const item of pythonCandidates()) {
    const args = [...(item.env.extra || []), "-c", "import fitz; print('ok')"];
    const env = { ...process.env };
    if (item.env.PYTHONPATH) env.PYTHONPATH = item.env.PYTHONPATH;
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
    env: { ...process.env, ...py.env },
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
 * 译完后把作者/单位块和泄漏公式从原文盖回去，保住原排版。
 * 失败不抛给翻译任务。
 */
export function restorePreservedRegions({ sourcePdf, destPdf, page, kind = "mono" } = {}) {
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
    const boxes = [
      ...collectPreserveBoxes(source.lines || []),
      ...collectFormulaLeakBoxes(source.lines || [], mappedDest)
    ];
    if (!boxes.length) return { ok: true, restored: 0, reason: "none" };
    const stamped = stampPreserveBoxes({ sourcePdf, destPdf, page, kind, boxes });
    return { ok: true, restored: stamped.restored || boxes.length, boxes };
  } catch (error) {
    return { ok: false, restored: 0, reason: error.message || String(error) };
  }
}

export function restorePreservedPageOutputs(sourcePdf, destMono, destDual, page) {
  const results = [];
  if (destMono && fs.existsSync(destMono)) {
    results.push({ kind: "mono", ...restorePreservedRegions({ sourcePdf, destPdf: destMono, page, kind: "mono" }) });
  }
  if (destDual && fs.existsSync(destDual) && destDual !== destMono) {
    results.push({ kind: "dual", ...restorePreservedRegions({ sourcePdf, destPdf: destDual, page, kind: "dual" }) });
  }
  return results;
}
