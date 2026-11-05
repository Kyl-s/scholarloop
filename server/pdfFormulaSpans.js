/**
 * 公式 span 级识别 / 匹配 / 回贴框计算（纯函数）。
 *
 * 背景：BabelDOC 会把公式拆成多个 span，甚至把 L_TD 拆成两行；旧的「整行矩形」
 * 回贴遇到「散文 + 公式同一行」时只能整行跳过，公式因此留下乱码。
 * 这里按 span 识别公式 run，用译文自己的公式 run bbox 做锚点，按源 span 的逐字符
 * bbox 裁剪 srcClip，交给 Python 逐字符回贴。
 *
 * 本模块不读写文件、不依赖 PyMuPDF，方便单测。
 */

const MATH_FONT_RE = /^(?:(?!CMTT)CM[A-Z]{1,4}|MS[AB]M|MSAM|EUSM|EURM|EUFM|RSFS)\d*$/;
const CJK_RE = /[\u3400-\u9fff]/;
// 纯标点/空格 glue：不含 CJK、字母、数字。
const GLUE_RE = /^[\s()[\]{},.;:|/\-+=<>~∼∗*'′″^_\\]*$/;
// BabelDOC 会把 arg max / log 等数学函数词重排成正文衬线字体，需要按词白名单并入公式。
const MATH_WORD_RE = /^(?:argmax|argmin|arg|max|min|log|exp|sin|cos|tan|lim|det|inf|sup|mod|sgn)$/i;
const LATEX_MARKUP_RE = /\\[a-zA-Z]+|\$[^$]*\$|_\{|\^\{|\\frac|\\mathrm/;
const PROSE_WORD_RUN_RE = /[A-Za-z]{2,}(?:\s*[,;:.)\]]?\s+[A-Za-z]{2,}){2,}/;
const URL_RE = /:\/\/|@[\w.-]+\.[A-Za-z]{2,}/;
const CITATION_ONLY_RE = /^\s*[[(]?\d+[\])]?\s*$/;

const OP_CHARS = new Set(Array.from("=+−-×÷→←↔∼≈≠≤≥<>|{}[]∫∑∏√∞∂∇∈∉⊂⊃∪∩∧∨¬∀∃∝≡"));
const NORMALIZE_MAP = new Map([
  ["−", "-"],
  ["∼", "~"],
  ["∗", "*"],
  ["′", "'"],
  ["″", '"'],
  ["–", "-"],
  ["—", "-"]
]);

const DEFAULT_MAX_BASELINE_DELTA = 45;
const MIN_COVERAGE = 0.75;
const EXACT_COVERAGE = 0.98;
const TRIM_PAD = 0.15;
const FOREIGN_MIN_AREA_RATIO = 0.1;

function normalizeLine(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

/** 公式文本归一化：统一数学符号并去掉空白，用于跨抽取器匹配。 */
export function normalizeFormulaText(text) {
  let out = "";
  for (const ch of String(text || "")) {
    if (/\s/.test(ch)) continue;
    out += NORMALIZE_MAP.get(ch) || ch;
  }
  return out;
}

function isCjkText(text) {
  return CJK_RE.test(String(text || ""));
}

function spanText(span) {
  return String(span?.text ?? "");
}

function rectFrom(value) {
  if (!value) return null;
  if (Array.isArray(value.bbox)) {
    const [x0, y0, x1, y1] = value.bbox.map(Number);
    if ([x0, y0, x1, y1].every(Number.isFinite)) return { x0, y0, x1, y1 };
  }
  const x0 = Number(value.x0);
  const y0 = Number(value.y0);
  const x1 = Number(value.x1);
  const y1 = Number(value.y1);
  if ([x0, y0, x1, y1].every(Number.isFinite)) return { x0, y0, x1, y1 };
  return null;
}

function lineRect(line) {
  const direct = rectFrom(line);
  if (direct) return direct;
  if (Array.isArray(line?.bbox)) {
    const [x0, y0, x1, y1] = line.bbox.map(Number);
    return [x0, y0, x1, y1].every(Number.isFinite) ? { x0, y0, x1, y1 } : null;
  }
  return null;
}

function rectUnion(a, b) {
  if (!a) return b ? { ...b } : null;
  if (!b) return { ...a };
  return {
    x0: Math.min(a.x0, b.x0),
    y0: Math.min(a.y0, b.y0),
    x1: Math.max(a.x1, b.x1),
    y1: Math.max(a.y1, b.y1)
  };
}

function rectArea(rect) {
  if (!rect) return 0;
  return Math.max(0, rect.x1 - rect.x0) * Math.max(0, rect.y1 - rect.y0);
}

function rectIntersection(a, b) {
  const x0 = Math.max(a.x0, b.x0);
  const y0 = Math.max(a.y0, b.y0);
  const x1 = Math.min(a.x1, b.x1);
  const y1 = Math.min(a.y1, b.y1);
  if (x1 <= x0 || y1 <= y0) return null;
  return { x0, y0, x1, y1 };
}

function centerInRect(rect, box) {
  const cx = (rect.x0 + rect.x1) / 2;
  const cy = (rect.y0 + rect.y1) / 2;
  return cx >= box.x0 && cx <= box.x1 && cy >= box.y0 && cy <= box.y1;
}

function padRect(rect, pad) {
  return { x0: rect.x0 - pad, y0: rect.y0 - pad, x1: rect.x1 + pad, y1: rect.y1 + pad };
}

function coverageOf(sourceKey, destKey) {
  if (!sourceKey || !destKey) return 0;
  if (sourceKey === destKey) return 1;
  const shorter = sourceKey.length <= destKey.length ? sourceKey : destKey;
  const longer = sourceKey.length <= destKey.length ? destKey : sourceKey;
  if (!longer.includes(shorter)) return 0;
  return shorter.length / longer.length;
}

/** 归一化 key 的包含覆盖率；用于源/译公式 run 对齐。 */
export function formulaCoverage(sourceKey, destKey) {
  return coverageOf(String(sourceKey || ""), String(destKey || ""));
}

function isMathFont(span) {
  return MATH_FONT_RE.test(String(span?.font || ""));
}

function isMathWordText(text) {
  return MATH_WORD_RE.test(normalizeFormulaText(text));
}

function isGlueSpan(span) {
  const text = spanText(span);
  if (!text || isCjkText(text)) return false;
  if (/[A-Za-z0-9]/.test(text)) return false;
  return GLUE_RE.test(text);
}

function hasMathInNext(entries, index, lookahead = 3) {
  for (let i = index + 1; i < Math.min(entries.length, index + 1 + lookahead); i += 1) {
    const entry = entries[i];
    if (entry.math) return true;
    if (entry.mathWord) continue;
    if (entry.glue) continue;
    return false;
  }
  return false;
}

function charRectFrom(value) {
  if (!value) return null;
  if (Array.isArray(value.bbox)) {
    const [x0, y0, x1, y1] = value.bbox.map(Number);
    if ([x0, y0, x1, y1].every(Number.isFinite)) return { x0, y0, x1, y1 };
  }
  const x0 = Number(value.x0);
  const y0 = Number(value.y0);
  const x1 = Number(value.x1);
  const y1 = Number(value.y1);
  if ([x0, y0, x1, y1].every(Number.isFinite)) return { x0, y0, x1, y1 };
  return null;
}

/**
 * 把 span 展开成逐字符 cell。PyMuPDF rawdict 的 span 带 chars；普通 dict 没有，
 * 此时按字符数在 span bbox 内等比插值（与探针一致），仅用于没有 chars 的测试/降级。
 */
function buildSpanCells(span, rect) {
  const rawChars = Array.isArray(span?.chars) ? span.chars : [];
  const cells = [];
  if (rawChars.length) {
    for (const ch of rawChars) {
      const charRect = charRectFrom(ch);
      if (!charRect) continue;
      const c = String(ch.c ?? "");
      if (!c) continue;
      cells.push({
        c,
        norm: normalizeFormulaText(c),
        ...charRect,
        font: String(span?.font || ""),
        synthetic: false
      });
    }
    return cells;
  }
  const text = spanText(span);
  const chars = Array.from(text);
  if (!chars.length || !rect) return cells;
  const width = Math.max(0.01, rect.x1 - rect.x0);
  for (let i = 0; i < chars.length; i += 1) {
    const c = chars[i];
    cells.push({
      c,
      norm: normalizeFormulaText(c),
      x0: rect.x0 + (width * i) / chars.length,
      y0: rect.y0,
      x1: rect.x0 + (width * (i + 1)) / chars.length,
      y1: rect.y1,
      font: String(span?.font || ""),
      synthetic: true
    });
  }
  return cells;
}

function cellsClip(cells, fallback) {
  let clip = null;
  for (const cell of cells) {
    if (!cell.norm) continue;
    clip = rectUnion(clip, cell);
  }
  if (clip) return clip;
  return fallback ? { ...fallback } : null;
}

function buildRunFromEntries(entries) {
  while (entries.length && !entries[0].math && !spanText(entries[0].span).trim()) entries.shift();
  while (entries.length && !entries[entries.length - 1].math && !spanText(entries[entries.length - 1].span).trim()) {
    entries.pop();
  }
  if (!entries.length) return null;
  const mathEntries = entries.filter((entry) => entry.math);
  if (!mathEntries.length) return null;
  const text = entries.map((entry) => spanText(entry.span)).join("");
  const key = normalizeFormulaText(text);
  if (!key) return null;
  const mathChars = mathEntries.reduce((sum, entry) => sum + normalizeFormulaText(spanText(entry.span)).length, 0);
  const hasOp = Array.from(text).some((ch) => OP_CHARS.has(ch));
  const hasParen = /[()[\]{}]/.test(text);
  const bodySize = Math.max(0.01, ...entries.map((entry) => entry.size || 0));
  const hasSub = mathEntries.some((entry) => entry.size > 0 && entry.size < bodySize * 0.9);
  const urlLike = URL_RE.test(text) || CITATION_ONLY_RE.test(text);
  let accepted = !urlLike;
  if (accepted && mathChars <= 1 && !hasOp) accepted = false;
  if (accepted && mathChars <= 2 && !hasOp && !hasSub && !hasParen) accepted = false;
  if (accepted && !hasOp && mathEntries.length < 2) accepted = false;
  if (!accepted) return null;

  const spanRect = entries.reduce((union, entry) => rectUnion(union, entry.rect), null);
  const cells = entries.flatMap((entry) => buildSpanCells(entry.span, entry.rect));
  const anchor = mathEntries.reduce((best, entry) => (
    !best || (entry.size || 0) > (best.size || 0) ? entry : best
  ), null);
  const origin = anchor?.span?.origin;
  const originY = Array.isArray(origin) && Number.isFinite(Number(origin[1]))
    ? Number(origin[1])
    : (anchor?.rect?.y1 ?? spanRect?.y1 ?? 0);
  const clip = cellsClip(cells, spanRect);
  return {
    key,
    text: text.trim(),
    x0: spanRect?.x0 ?? 0,
    y0: spanRect?.y0 ?? 0,
    x1: spanRect?.x1 ?? 0,
    y1: spanRect?.y1 ?? 0,
    baseline: originY,
    size: anchor?.size || bodySize,
    mathChars,
    mathSpans: mathEntries.length,
    hasOp,
    hasSub,
    hasParen,
    clip,
    cells
  };
}

/**
 * 把一行 span 切成公式 run。
 * 规则：数学字体为主 + glue（纯标点/空格）+ 数学函数词；URL/邮箱/citation/孤立单变量拒绝。
 * 返回 {key,x0,y0,x1,y1,text,clip,cells,...}。
 */
export function buildFormulaRuns(line) {
  const spans = Array.isArray(line?.spans) ? line.spans : [];
  if (!spans.length) return [];
  const entries = spans.map((span) => {
    const rect = rectFrom(span) || lineRect(line);
    const size = Number(span?.size) || 0;
    return {
      span,
      rect,
      size,
      math: isMathFont(span),
      mathWord: isMathWordText(spanText(span)),
      glue: isGlueSpan(span),
      text: spanText(span)
    };
  }).filter((entry) => entry.rect);
  if (!entries.length) return [];

  const runs = [];
  let current = [];
  const flush = () => {
    if (current.length) {
      const run = buildRunFromEntries(current);
      if (run) runs.push(run);
    }
    current = [];
  };

  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    if (entry.math) {
      if (!current.length && i > 0) {
        const prev = entries[i - 1];
        const prevText = prev.text.trim();
        if (prev.glue && prevText && /^[([{]+$/.test(prevText)) {
          current.push(prev);
        }
      }
      current.push(entry);
      continue;
    }
    if (current.length && entry.glue) {
      const glueText = entry.text.trim();
      const closing = Boolean(glueText) && /^[)\]}\s]*$/.test(glueText) && /[)\]}]/.test(glueText);
      if (closing || hasMathInNext(entries, i, 2)) {
        current.push(entry);
        continue;
      }
    }
    if (entry.mathWord && hasMathInNext(entries, i, 3)) {
      // arg / max 等函数词：即使前面没有数学 span（行首 arg max），也并入后续公式。
      current.push(entry);
      continue;
    }
    flush();
  }
  flush();
  return runs;
}

function lineRuns(lines, role) {
  const out = [];
  const source = Array.isArray(lines) ? lines : [];
  for (let lineIndex = 0; lineIndex < source.length; lineIndex += 1) {
    const line = source[lineIndex] || {};
    const text = String(line.text ?? (Array.isArray(line.spans)
      ? line.spans.map((span) => spanText(span)).join("")
      : ""));
    const runs = buildFormulaRuns(line);
    for (const run of runs) {
      out.push({
        ...run,
        role,
        lineIndex,
        lineText: text
      });
    }
  }
  return out;
}

function keyCells(run) {
  return (run.cells || []).filter((cell) => cell.norm);
}

/** 按归一化 key 的字符区间裁剪 run 的 bbox（用逐字符 bbox 精确裁剪）。 */
function cropRunToKeyRange(run, start, end) {
  const cells = keyCells(run);
  const key = run.key || "";
  if (!cells.length || cells.length !== key.length) {
    // 没有逐字符信息：按 key 比例在 run bbox 内插值。
    const width = Math.max(0.01, run.x1 - run.x0);
    const ratio0 = key.length ? start / key.length : 0;
    const ratio1 = key.length ? end / key.length : 1;
    return {
      x0: run.x0 + width * ratio0,
      y0: run.y0,
      x1: run.x0 + width * ratio1,
      y1: run.y1
    };
  }
  const from = Math.max(0, start);
  const to = Math.min(cells.length, end);
  if (to <= from) return null;
  let clip = null;
  for (let i = from; i < to; i += 1) {
    clip = rectUnion(clip, cells[i]);
  }
  return clip;
}

function destRunClip(run) {
  // destRect 用译文 run 的完整 span bbox（含 glue 空格），与可行性实测的锚点一致；
  // 逐字符 clip 只用于 srcClip 和 run 内文本裁剪。
  return { x0: run.x0, y0: run.y0, x1: run.x1, y1: run.y1 };
}

function shiftLine(line, deltaX) {
  if (!deltaX) return line;
  const rect = lineRect(line);
  const spans = Array.isArray(line.spans)
    ? line.spans.map((span) => {
      const spanRect = rectFrom(span);
      return {
        ...span,
        ...(spanRect
          ? { x0: spanRect.x0 + deltaX, y0: spanRect.y0, x1: spanRect.x1 + deltaX, y1: spanRect.y1 }
          : {}),
        ...(Array.isArray(span.chars)
          ? {
            chars: span.chars.map((ch) => {
              const charRect = charRectFrom(ch);
              return charRect
                ? { ...ch, x0: charRect.x0 + deltaX, y0: charRect.y0, x1: charRect.x1 + deltaX, y1: charRect.y1 }
                : ch;
            })
          }
          : {})
      };
    })
    : line.spans;
  return {
    ...line,
    ...(rect ? { x0: rect.x0 + deltaX, y0: rect.y0, x1: rect.x1 + deltaX, y1: rect.y1 } : {}),
    spans
  };
}

/**
 * 源/译公式 run 匹配。
 * exact key → 「短串包含于长串」覆盖率 ≥0.75；允许一个源 run 对应同一译文行内
 * 阅读序相邻的多个译文 run（concat 后算覆盖率）。
 * 返回 [{sourceRun, destRuns, coverage, srcClip, destClip, trim}]。
 */
export function matchFormulaRuns(sourceLines = [], destLines = [], options = {}) {
  const maxBaselineDelta = Number(options.maxBaselineDelta) || DEFAULT_MAX_BASELINE_DELTA;
  const sourceRuns = lineRuns(sourceLines, "source");
  const destRuns = lineRuns(destLines, "dest").sort((a, b) => (
    a.lineIndex - b.lineIndex || a.x0 - b.x0 || a.baseline - b.baseline
  ));
  const used = new Set();
  const matches = [];

  const consider = (sourceRun, indexes, coverage) => {
    if (coverage < MIN_COVERAGE) return null;
    const runs = indexes.map((index) => destRuns[index]);
    const dy = Math.min(...runs.map((run) => Math.abs(sourceRun.baseline - run.baseline)));
    if (dy > maxBaselineDelta) return null;
    let destClip = null;
    for (const run of runs) destClip = rectUnion(destClip, destRunClip(run));
    const destKey = runs.map((run) => run.key).join("");
    let srcClip = sourceRun.clip
      ? { ...sourceRun.clip }
      : { x0: sourceRun.x0, y0: sourceRun.y0, x1: sourceRun.x1, y1: sourceRun.y1 };
    let destCrop = destClip;
    let trim = [0, 0];
    if (coverage < 1 && destKey.length < sourceRun.key.length && sourceRun.key.includes(destKey)) {
      const index = sourceRun.key.indexOf(destKey);
      const cropped = cropRunToKeyRange(sourceRun, index, index + destKey.length);
      if (cropped) {
        srcClip = cropped;
        trim = [index, sourceRun.key.length - index - destKey.length];
      }
    } else if (coverage < 1 && sourceRun.key.length < destKey.length && destKey.includes(sourceRun.key) && runs.length === 1) {
      // 译文 run 比源 run 长：只回贴译文 run 中与源公式对齐的子串，避免 redaction 吃掉多余译文。
      const index = destKey.indexOf(sourceRun.key);
      const cropped = cropRunToKeyRange(runs[0], index, index + sourceRun.key.length);
      if (cropped) destCrop = cropped;
    }
    return {
      sourceRun,
      destRuns: runs,
      coverage,
      srcClip,
      destClip: destCrop,
      trim,
      destKey
    };
  };

  for (const sourceRun of sourceRuns) {
    let best = null;
    for (let i = 0; i < destRuns.length; i += 1) {
      if (used.has(i)) continue;
      const destRun = destRuns[i];
      const dy = Math.abs(sourceRun.baseline - destRun.baseline);
      if (dy > maxBaselineDelta) continue;
      const coverage = coverageOf(sourceRun.key, destRun.key);
      if (coverage < MIN_COVERAGE) continue;
      const score = coverage * 1000 - dy;
      if (!best || score > best.score) best = { score, indexes: [i], coverage };
    }
    // 同一译文行内相邻 run 的 concat（例如公式被拆成 `p(W)` + `=Πn`）。
    for (let i = 0; i < destRuns.length; i += 1) {
      if (used.has(i)) continue;
      const first = destRuns[i];
      if (Math.abs(sourceRun.baseline - first.baseline) > maxBaselineDelta) continue;
      const indexes = [i];
      let previous = first;
      for (let extra = 1; extra <= 2; extra += 1) {
        const nextIndex = i + extra;
        if (nextIndex >= destRuns.length) break;
        if (used.has(nextIndex)) break;
        const next = destRuns[nextIndex];
        if (next.lineIndex !== first.lineIndex) break;
        const gap = next.x0 - previous.x1;
        if (!Number.isFinite(gap) || gap > 48 || gap < -2) break;
        indexes.push(nextIndex);
        previous = next;
        const concatKey = indexes.map((idx) => destRuns[idx].key).join("");
        const coverage = coverageOf(sourceRun.key, concatKey);
        if (coverage < MIN_COVERAGE) continue;
        // 单 run 已能精确匹配时不为了 concat 破坏其它 run 的锚点。
        if (coverage < 1 && best && best.coverage >= 1) continue;
        if (!best || coverage > best.coverage + 0.01
          || (Math.abs(coverage - best.coverage) <= 0.01 && indexes.length < best.indexes.length)) {
          best = { score: coverage * 1000, indexes: [...indexes], coverage };
        }
      }
    }
    if (best) {
      const match = consider(sourceRun, best.indexes, best.coverage);
      if (match) {
        for (const index of best.indexes) used.add(index);
        matches.push(match);
        continue;
      }
    }
    matches.push({
      sourceRun,
      destRuns: [],
      coverage: 0,
      srcClip: sourceRun.clip,
      destClip: null,
      trim: [0, 0],
      destKey: ""
    });
  }
  return matches;
}

function collectUnits(lines, options = {}) {
  const units = [];
  const source = Array.isArray(lines) ? lines : [];
  for (const line of source) {
    const spans = Array.isArray(line?.spans) ? line.spans : [];
    for (const span of spans) {
      const rect = rectFrom(span);
      if (!rect) continue;
      const chars = Array.isArray(span.chars) ? span.chars : [];
      const font = String(span.font || "");
      const spanFormula = MATH_FONT_RE.test(font) || isGlueSpan(span) || isMathWordText(spanText(span));
      if (chars.length) {
        for (const ch of chars) {
          const charRect = charRectFrom(ch);
          if (!charRect) continue;
          const text = String(ch.c ?? "");
          if (!text.trim()) continue;
          units.push({ rect: charRect, text, formula: MATH_FONT_RE.test(font) });
        }
      } else {
        const text = spanText(span);
        if (!text.trim()) continue;
        units.push({ rect, text, formula: spanFormula });
      }
    }
  }
  if (!units.length && options.lineRectFallback) {
    for (const line of source) {
      const rect = lineRect(line);
      const text = String(line?.text || "");
      if (rect && text.trim()) units.push({ rect, text });
    }
  }
  return units;
}

function unionHasForeign(units, union, memberRects) {
  if (!union || !units.length) return false;
  for (const unit of units) {
    // 只把散文/CJK 当作外来字符：相邻公式 run 的数学字符可以落在同一 clip 内，
    // 由连通分组合并成一个框；真正危险的是夹进来的正文（第 3 页会丢汉字）。
    if (unit.formula) continue;
    const intersection = rectIntersection(unit.rect, union);
    if (!intersection) continue;
    const ratio = rectArea(intersection) / Math.max(0.01, rectArea(unit.rect));
    if (ratio < FOREIGN_MIN_AREA_RATIO) continue;
    if (memberRects.some((rect) => centerInRect(unit.rect, rect))) continue;
    return true;
  }
  return false;
}

/**
 * 源 clip 的外来字符检查用「字符中心」：Python mask 只保留中心在 clip 内的字符，
 * 相邻行探进来的降部会被 redaction 删掉，不算在外来字符里。
 */
function clipHasForeignCenter(units, union, memberRects) {
  if (!union || !units.length) return false;
  for (const unit of units) {
    if (unit.formula) continue;
    if (!centerInRect(unit.rect, union)) continue;
    if (memberRects.some((rect) => centerInRect(unit.rect, rect))) continue;
    return true;
  }
  return false;
}

function mergeEntries(entries, sourceUnits, destUnits) {
  let merged = true;
  while (merged) {
    merged = false;
    for (let i = 0; i < entries.length && !merged; i += 1) {
      for (let j = i + 1; j < entries.length; j += 1) {
        const a = entries[i];
        const b = entries[j];
        const destUnion = rectUnion(a.destRect, b.destRect);
        const srcUnion = rectUnion(a.srcRect, b.srcRect);
        if (!rectIntersection(a.destRect, b.destRect)) continue;
        // 合并后的 redaction 区域不能包含「不属于任一成员 run」的字符，否则会擦掉
        // 相邻行/相邻中文（第 3 页 union 实测会丢 5 个汉字）。
        if (unionHasForeign(destUnits, destUnion, [...a.destRects, ...b.destRects])) continue;
        if (clipHasForeignCenter(sourceUnits, srcUnion, [...a.srcRects, ...b.srcRects])) continue;
        entries[i] = {
          destRect: destUnion,
          srcRect: srcUnion,
          destRects: [...a.destRects, ...b.destRects],
          srcRects: [...a.srcRects, ...b.srcRects],
          boxes: [...a.boxes, ...b.boxes]
        };
        entries.splice(j, 1);
        merged = true;
        break;
      }
    }
  }
  return entries;
}

function looksLikeMixedProse(text) {
  const t = normalizeLine(text);
  if (!t || isCjkText(t)) return false;
  if (PROSE_WORD_RUN_RE.test(t)) return true;
  const tokens = t.match(/[A-Za-z]+/g) || [];
  if (!tokens.length) return false;
  const totalLetters = tokens.reduce((sum, word) => sum + word.length, 0);
  const wordLetters = tokens
    .filter((word) => word.length >= 3 && !MATH_WORD_RE.test(word))
    .reduce((sum, word) => sum + word.length, 0);
  return wordLetters > totalLetters * 0.2;
}

/**
 * 生成 `formula-span` 回贴框（坐标均为源 PDF 坐标系；dual 的 dest 已减 src_w）。
 * 只为「译文匹配 run 自身含 CJK/LaTeX」或 coverage<0.98 的 run 生成；重叠 run 做
 * 连通分组，union 中有外来字符时拒绝合并。公式完整、只是与中文同行时不回贴。
 */
export function collectFormulaSpanBoxes({
  sourceLines = [],
  destLines = [],
  kind = "mono",
  sourceWidth = 0,
  diagnostics = null
} = {}) {
  const source = Array.isArray(sourceLines) ? sourceLines : [];
  const rawDest = Array.isArray(destLines) ? destLines : [];
  const width = Number(sourceWidth) || 0;
  const dual = kind === "dual" && width > 0;
  const destForMatch = dual
    ? rawDest
      .filter((line) => Number(line?.x0) >= width * 0.85)
      .map((line) => shiftLine(line, -width))
    : rawDest;
  const matches = matchFormulaRuns(source, destForMatch);
  const sourceUnits = collectUnits(source);
  const destUnits = collectUnits(destForMatch);
  const entries = [];
  const boxes = [];

  for (const match of matches) {
    const run = match.sourceRun;
    if (!match.destRuns.length) {
      if (diagnostics && looksLikeMixedProse(run.lineText)) {
        diagnostics.push({
          reason: "formula-no-anchor",
          diagnostic: "formula-no-anchor",
          key: run.key,
          sourceText: run.lineText,
          x0: run.x0,
          y0: run.y0,
          x1: run.x1,
          y1: run.y1
        });
      }
      continue;
    }
    // 触发条件只看译文匹配 run 自身：公式完整保留、只是与中文同行时不应回贴。
    // - coverage<0.98：公式被改写/缺失/拆分后无法拼回完整；
    // - 译文 run 自身含 CJK/LaTeX：公式被吞进中文或被当正文排版。
    const destRunTrigger = match.destRuns.some((destRun) => (
      isCjkText(destRun.text) || LATEX_MARKUP_RE.test(String(destRun.text || ""))
    ));
    // 不在这里直接丢弃未触发的 run：它与已触发 run 重叠时仍要参与连通分组，
    // 否则只 redaction 一半，另一半公式会被擦掉（第 3 页 r2/r3 实测）。
    const triggered = match.coverage < EXACT_COVERAGE || destRunTrigger;
    const srcRaw = match.srcClip;
    const destRaw = match.destClip;
    if (!srcRaw || !destRaw) continue;
    const srcRect = padRect(srcRaw, TRIM_PAD);
    const destRect = padRect(destRaw, TRIM_PAD);
    if (rectArea(srcRect) < 1 || rectArea(destRect) < 1) continue;
    // srcClip 内只能有公式 run 自己的字符：夹进散文（或相邻行降部）时宁可跳过，
    // 避免把散文字符一起盖回译文。
    const srcMembers = (run.cells || []).filter((cell) => cell.norm);
    if (srcMembers.length && clipHasForeignCenter(sourceUnits, srcRect, srcMembers)) {
      if (diagnostics) {
        diagnostics.push({
          reason: "formula-span-foreign-source",
          diagnostic: "formula-span-foreign-source",
          key: run.key,
          sourceText: run.lineText,
          x0: srcRect.x0,
          y0: srcRect.y0,
          x1: srcRect.x1,
          y1: srcRect.y1
        });
      }
      continue;
    }
    if (match.destRuns.length > 1
      && unionHasForeign(destUnits, destRect, match.destRuns.map((destRun) => destRunClip(destRun)))) {
      if (diagnostics) {
        diagnostics.push({
          reason: "formula-span-unsafe-union",
          diagnostic: "formula-span-unsafe-union",
          key: run.key,
          sourceText: run.lineText,
          x0: destRect.x0,
          y0: destRect.y0,
          x1: destRect.x1,
          y1: destRect.y1
        });
      }
      continue;
    }
    const box = {
      reason: "formula-span",
      x0: destRect.x0,
      y0: destRect.y0,
      x1: destRect.x1,
      y1: destRect.y1,
      srcX0: srcRect.x0,
      srcY0: srcRect.y0,
      srcX1: srcRect.x1,
      srcY1: srcRect.y1,
      destX0: destRect.x0,
      destY0: destRect.y0,
      destX1: destRect.x1,
      destY1: destRect.y1,
      sourceText: run.lineText || run.text,
      key: match.destKey || run.key,
      keys: [match.destKey || run.key],
      coverage: Math.round(match.coverage * 1000) / 1000,
      trim: match.trim,
      triggered
    };
    entries.push({
      destRect,
      srcRect,
      destRects: [destRect],
      srcRects: [srcRect],
      boxes: [box]
    });
  }

  const merged = mergeEntries(entries, sourceUnits, destUnits);
  for (const entry of merged) {
    // 连通分组里只要有一个 run 触发（coverage<0.98 或译文 run 自身含 CJK/LaTeX）就整组回贴。
    if (!entry.boxes.some((box) => box.triggered)) continue;
    if (entry.boxes.length === 1) {
      const { triggered, ...box } = entry.boxes[0];
      boxes.push({
        ...box,
        x0: entry.destRect.x0,
        y0: entry.destRect.y0,
        x1: entry.destRect.x1,
        y1: entry.destRect.y1,
        destX0: entry.destRect.x0,
        destY0: entry.destRect.y0,
        destX1: entry.destRect.x1,
        destY1: entry.destRect.y1,
        srcX0: entry.srcRect.x0,
        srcY0: entry.srcRect.y0,
        srcX1: entry.srcRect.x1,
        srcY1: entry.srcRect.y1
      });
      continue;
    }
    const keys = [...new Set(entry.boxes.flatMap((box) => box.keys || [box.key]))].filter(Boolean);
    boxes.push({
      reason: "formula-span",
      x0: entry.destRect.x0,
      y0: entry.destRect.y0,
      x1: entry.destRect.x1,
      y1: entry.destRect.y1,
      srcX0: entry.srcRect.x0,
      srcY0: entry.srcRect.y0,
      srcX1: entry.srcRect.x1,
      srcY1: entry.srcRect.y1,
      destX0: entry.destRect.x0,
      destY0: entry.destRect.y0,
      destX1: entry.destRect.x1,
      destY1: entry.destRect.y1,
      sourceText: entry.boxes.map((box) => box.sourceText).filter(Boolean).join(" "),
      key: keys.join("+"),
      keys,
      coverage: Math.min(...entry.boxes.map((box) => Number(box.coverage) || 0)),
      merged: true
    });
  }
  for (const box of boxes) {
    box.x0 = Math.round(box.x0 * 100) / 100;
    box.y0 = Math.round(box.y0 * 100) / 100;
    box.x1 = Math.round(box.x1 * 100) / 100;
    box.y1 = Math.round(box.y1 * 100) / 100;
    box.srcX0 = Math.round(box.srcX0 * 100) / 100;
    box.srcY0 = Math.round(box.srcY0 * 100) / 100;
    box.srcX1 = Math.round(box.srcX1 * 100) / 100;
    box.srcY1 = Math.round(box.srcY1 * 100) / 100;
    box.destX0 = Math.round(box.destX0 * 100) / 100;
    box.destY0 = Math.round(box.destY0 * 100) / 100;
    box.destX1 = Math.round(box.destX1 * 100) / 100;
    box.destY1 = Math.round(box.destY1 * 100) / 100;
  }
  return boxes.sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
}

function sameRun(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  return String(a.key) === String(b.key)
    && Math.abs(Number(a.x0) - Number(b.x0)) <= 0.6
    && Math.abs(Number(a.y0) - Number(b.y0)) <= 0.6;
}

/**
 * Stage 1 门控：该源行所有公式 run 都在译文精确匹配（coverage≥0.98），且译文 run
 * 自身不含 CJK/LaTeX → 说明公式在译文里是好的，不需要生成 formula-leak 整行框。
 */
export function shouldSuppressFormulaLeak(sourceLine, matchResult) {
  const runs = buildFormulaRuns(sourceLine);
  if (!runs.length) return false;
  const matches = Array.isArray(matchResult)
    ? matchResult
    : (matchResult ? [matchResult] : []);
  for (const run of runs) {
    const hit = matches.find((match) => match && sameRun(match.sourceRun, run));
    if (!hit || !Array.isArray(hit.destRuns) || !hit.destRuns.length) return false;
    if (Number(hit.coverage) < EXACT_COVERAGE) return false;
    for (const destRun of hit.destRuns) {
      const runText = String(destRun?.text ?? "");
      if (isCjkText(runText) || LATEX_MARKUP_RE.test(runText)) return false;
    }
  }
  return true;
}
