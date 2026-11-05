import { isUntranslatedBodyLine } from "./pdfPreserveRegions.js"

// 确定性版式 QA：只做纯文本/几何判定，不读写文件，也不调用模型。
const CJK_RE = /[\u3400-\u9fff]/
const CID_GARBAGE_RE = /\(cid:\s*\d+\)/i
// 图内嵌文字常带坏掉的字体编码（C0 控制符），不是 LaTeX，先排除。
const BROKEN_GLYPH_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/
const LATEX_COMMAND_RE = /\\[a-zA-Z]{2,}/
const LATEX_INLINE_RE = /\$[^$]{2,}\$/
const LATEX_SCRIPT_RE = /[_^]\{[^}]+\}/
const URL_OR_EMAIL_RE = /\b(?:https?:\/\/|www\.)\S+|\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b/gi
// Windows 路径里的 \Users 之类会被误认成 LaTeX 命令，先整体去掉。
const WINDOWS_PATH_RE = /\b[A-Za-z]:\\[^\s]+/g
// 货币金额（$5、$10.99）不是行内公式，避免 "$5 到 $10" 被误判。
const CURRENCY_AMOUNT_RE = /\$\s?\d[\d,.]*/g

const MAX_PER_KIND = 5
const OVERLAP_MIN_VERTICAL_RATIO = 0.55
const OVERLAP_MIN_HORIZONTAL_RATIO = 0.2
const OVERLAP_MAX_HEIGHT_DIFF_RATIO = 0.3
const MAX_MERGED_ISSUES = 8

export const LAYOUT_QA_KINDS = ["latex", "untranslated", "overlap", "outOfBounds"]

export const LAYOUT_QA_LABELS = {
  latex: "LaTeX/公式标记残留",
  untranslated: "疑似未翻译英文",
  overlap: "译文行框重叠",
  outOfBounds: "译文行越界"
}

function normalizeText(text) {
  return String(text || "").replace(/\s+/g, " ").trim()
}

function stripNoisySpans(text) {
  return String(text || "")
    .replace(URL_OR_EMAIL_RE, " ")
    .replace(WINDOWS_PATH_RE, " ")
    .replace(CURRENCY_AMOUNT_RE, " ")
}

/**
 * 文本里是否残留 LaTeX/公式标记。URL、邮箱、盘符路径先剔除，避免正常正文误报。
 * 与回贴侧共用同一特征：\command、$...$、_{...}/^{...}。
 */
export function looksLikeLatexMarkup(text) {
  const raw = String(text || "")
  if (!raw.trim()) return false
  if (CID_GARBAGE_RE.test(raw)) return false
  if (BROKEN_GLYPH_RE.test(raw)) return false
  const cleaned = stripNoisySpans(raw)
  return LATEX_COMMAND_RE.test(cleaned)
    || LATEX_INLINE_RE.test(cleaned)
    || LATEX_SCRIPT_RE.test(cleaned)
}

function validBox(line) {
  const x0 = Number(line?.x0)
  const y0 = Number(line?.y0)
  const x1 = Number(line?.x1)
  const y1 = Number(line?.y1)
  if (![x0, y0, x1, y1].every(Number.isFinite)) return null
  if (x1 <= x0 || y1 <= y0) return null
  return { x0, y0, x1, y1 }
}

function issue(kind, description, text, box) {
  return {
    kind,
    description,
    text: String(text || ""),
    x0: box?.x0 ?? 0,
    y0: box?.y0 ?? 0,
    x1: box?.x1 ?? 0,
    y1: box?.y1 ?? 0
  }
}

function clip(text, limit = 28) {
  const t = normalizeText(text)
  return t.length > limit ? `${t.slice(0, limit)}…` : t
}

function pushIssue(list, item) {
  if (list.length >= MAX_PER_KIND) return
  list.push(item)
}

// 参考文献条目特征：引用标号、作者缩写、年份+出版机构/会议名、DOI/arXiv、中文顿号连接的作者串。
// 这些行本来就应该保留英文（或中文译名+英文标题），计入 untranslated 只会触发无效整页重译。
const REFERENCE_LEAD_MARKER_RE = /^[\[(]\d{1,3}[\])]/
// 「2019.[71] N. Savinov」这类同一行拼接两条文献的标号。
const REFERENCE_MARKER_CHAIN_RE = /[.;:]\s?[\[(]\d{1,3}[\])]\s*[A-Z]/
const REFERENCE_MARKER_RE = /[\[(]\d{1,3}[\])]/
const REFERENCE_YEAR_RE = /\b(?:19|20)\d{2}\b/
const REFERENCE_VENUE_RE = /\b(?:proceedings|conference|workshop|symposium|journal|transactions|advances|letters|technical report|mit press|springer|elsevier|acm|ieee|aaai|ijcai|icra|icml|iclr|neurips|nips|cvpr|iccv|eccv|acl|emnlp|naacl|corl|kdd|sigir|uai|aistats|arxiv)\b/i
const REFERENCE_DOI_RE = /\bdoi\b|doi\.org|arxiv|\bhttps?:\/\/|\bwww\./i
const REFERENCE_HEADING_RE = /^(?:\d{1,2}(?:\.\d+)*[.)]?\s+)?(references?|bibliography|works cited|literature cited|参考文献|參考文獻)\s*[:：]?\s*$/i
// 续页没有 References 标题时，靠「参考文献行占比」识别整页文献列表。
const REFERENCE_PAGE_MIN_LINES = 4
const REFERENCE_PAGE_RATIO = 0.6

function countInitials(text) {
  return (String(text || "").match(/\b[A-Z]\./g) || []).length
}

/** 标题式大写：多数词以大写/数字/引号开头，用于识别没有年份的会议名行。 */
function looksTitleCased(text) {
  const words = String(text || "").split(/\s+/).filter((word) => /[A-Za-z]{2,}/.test(word))
  if (words.length < 3) return false
  const capitalized = words.filter((word) => /^[A-Z0-9“"'(]/.test(word)).length
  return capitalized >= Math.ceil(words.length * 0.5)
}

/**
 * 参考文献条目统一判定（CJK / 非 CJK 分支共用）。
 * 覆盖：行首或行中的 [数字] 标号、≥2 个 "A." 作者缩写、顿号连接的姓名串、
 * 19xx/20xx 年份 + 会议/期刊名、DOI/URL/arXiv。
 */
export function looksLikeReferenceLine(text) {
  const t = normalizeText(text)
  if (!t || t.length < 8) return false
  const initials = countInitials(t)
  const hasMarker = REFERENCE_MARKER_RE.test(t)
  const hasYear = REFERENCE_YEAR_RE.test(t)
  const hasVenue = REFERENCE_VENUE_RE.test(t)
  const hasDoi = REFERENCE_DOI_RE.test(t)
  if (REFERENCE_LEAD_MARKER_RE.test(t) || REFERENCE_MARKER_CHAIN_RE.test(t)) return true
  if (hasMarker && (hasYear || hasVenue || initials >= 1 || /\bet al\b/i.test(t))) return true
  if (initials >= 2) return true
  if (hasVenue && (hasYear || looksTitleCased(t))) return true
  if (/、/.test(t) && initials >= 1) return true
  if (hasDoi && (hasYear || hasMarker || initials >= 1 || /\b(?:doi|arxiv)\b/i.test(t))) return true
  return /\bet al\b/i.test(t) && (hasYear || hasVenue)
}

/** 「References」/「参考文献」标题行：其后整页都是文献列表。 */
export function isReferenceHeadingLine(text) {
  const t = normalizeText(text)
  if (!t || t.length > 40) return false
  if (REFERENCE_HEADING_RE.test(t)) return true
  // 抽取器可能把标题截断或产出损坏字形（「参考文�?」），只接受残行+标点/替换符。
  return /^参考文[献獻]?[\s:：?？\uFFFD]*$/.test(t) || /^參考文[獻献]?[\s:：?？\uFFFD]*$/.test(t)
}

/**
 * 标记哪些行属于参考文献区：标题行之后全部算；无标题的续页按命中占比识别。
 * 只影响 untranslated 判定，latex/overlap/outOfBounds 仍逐行扫描。
 */
function markReferenceRows(rows) {
  const flags = rows.map((row) => looksLikeReferenceLine(row.text))
  const headingIndex = rows.findIndex((row) => isReferenceHeadingLine(row.text))
  if (headingIndex >= 0) {
    for (let i = headingIndex + 1; i < flags.length; i += 1) flags[i] = true
    return flags
  }
  if (rows.length >= REFERENCE_PAGE_MIN_LINES) {
    const hits = flags.filter(Boolean).length
    if (hits / rows.length >= REFERENCE_PAGE_RATIO) return flags.map(() => true)
  }
  return flags
}

// ---- 参考文献版面区域识别 ----
// 纯文本正则无法区分「文献页」和「正文里恰好有 [n] 引用的页」。
// 这里用源页几何指纹（编号条目、悬挂缩进、字号单一性、编号连续性）做保守区域判定；
// 任一指纹不成立就返回 null，由调用方回退到 markReferenceRows 正则。
const REGION_BODY_TOP = 60
const REGION_BODY_BOTTOM = 730
const REGION_BODY_LEFT = 50
// 同一基线的碎片行（PyMuPDF 常把一行拆成多个 line）先合并成视觉行。
const ROW_BASELINE_TOLERANCE = 2.5
const ENTRY_MARKER_RE = /^\[(\d{1,3})\]\s*/
// 条目首行与列左界的最大偏移：p13 前几条首行在 113，列左界 108。
const ENTRY_LEFT_TOLERANCE = 10
const ENTRY_SIZE_TOLERANCE = 0.6
const MIN_REFERENCE_ENTRIES = 3
// 悬挂缩进：续行相对条目首行缩进 12–30pt，且是长行（p13 为 16.6/21.6pt）。
const HANGING_INDENT_MIN = 12
const HANGING_INDENT_MAX = 30
const HANGING_MIN_X1_OFFSET = 150
const HANGING_MIN_ROW_RATIO = 0.2
// 字号单一性：文献页几乎只有正文一种字号（p13–17 ≥0.98，表格页 <0.56）。
const SIZE_UNIFORMITY_MIN = 0.8
// 编号连续率与允许缺号；防止把「正文里零散 [n] 引用」拼成区域。
const NUMBER_CONTINUITY_MIN = 0.8
const NUMBER_MAX_MISSING = 2
// 条目块的续行必须与块内上一行足够近，避免把页脚/脚注并入最后一条。
const HANGING_BLOCK_MAX_GAP = 25
// 双栏判定：两个显著左界簇，第二簇在页面右半边 → 回退正则（不硬套全局 colLeft）。
const COLUMN_CLUSTER_GAP = 24
const COLUMN_MIN_SHARE = 0.2
export const REFERENCE_REGION_TOLERANCE = 15
const BOLD_FLAG_BIT = 16

function lineSize(line) {
  const size = Number(line?.size)
  return Number.isFinite(size) && size > 0 ? size : 0
}

/** PyMuPDF flags 位 16 = bold；测试/探针里也可能是 flags 数组。 */
function lineIsBold(line) {
  const flags = line?.flags
  if (Array.isArray(flags)) return flags.some((value) => (Number(value) & BOLD_FLAG_BIT) !== 0)
  return (Number(flags) & BOLD_FLAG_BIT) !== 0
}

function modeSize(rows) {
  const counts = new Map()
  for (const row of rows) {
    if (!(row.size > 0)) continue
    const key = Math.round(row.size * 10) / 10
    counts.set(key, (counts.get(key) || 0) + 1)
  }
  let best = 0
  let bestCount = 0
  for (const [size, count] of counts) {
    // 并列时保留先出现的字号，保证结果与行序一致、可复现。
    if (count > bestCount) {
      best = size
      bestCount = count
    }
  }
  return best
}

/** 按 y 容差合并同一基线的碎片行，保留最左/最右边界、最大字号与粗体信息。 */
function mergeBaselineRows(lines) {
  const items = []
  for (const line of lines) {
    const text = normalizeText(line?.text)
    const box = validBox(line)
    if (!text || !box) continue
    items.push({ text, ...box, size: lineSize(line), bold: lineIsBold(line) })
  }
  items.sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0)
  const rows = []
  for (const item of items) {
    const prev = rows[rows.length - 1]
    if (prev && Math.abs(item.y0 - prev.y0) <= ROW_BASELINE_TOLERANCE) {
      const separator = prev.x1 < item.x0 - 1 ? " " : ""
      prev.text = `${prev.text}${separator}${item.text}`.trim()
      prev.x0 = Math.min(prev.x0, item.x0)
      prev.x1 = Math.max(prev.x1, item.x1)
      prev.y1 = Math.max(prev.y1, item.y1)
      prev.size = Math.max(prev.size, item.size)
      prev.bold = prev.bold || item.bold
      continue
    }
    rows.push({ ...item })
  }
  return rows
}

/**
 * 双栏页判定：x0 形成 ≥2 个占比 ≥20% 的簇，且第二簇起点在页面右半边。
 * 只用于「拒绝建区域」，命中时调用方回退到纯文本正则。
 */
function hasSignificantColumnSplit(rows, pageWidth) {
  if (!(pageWidth > 0) || rows.length < 8) return false
  const xs = rows.map((row) => row.x0).sort((a, b) => a - b)
  const clusters = []
  for (const x of xs) {
    const last = clusters[clusters.length - 1]
    if (last && x - last.max <= COLUMN_CLUSTER_GAP) {
      last.max = x
      last.count += 1
    } else {
      clusters.push({ min: x, max: x, count: 1 })
    }
  }
  const significant = clusters.filter((cluster) => cluster.count / rows.length >= COLUMN_MIN_SHARE)
  if (significant.length < 2) return false
  return significant[1].min > pageWidth / 2
}

function inRegionBody(line) {
  const box = validBox(line)
  if (!box) return null
  if (box.y0 < REGION_BODY_TOP || box.y0 > REGION_BODY_BOTTOM) return null
  if (box.x0 < REGION_BODY_LEFT) return null
  return box
}

/**
 * 从源页行识别参考文献区域（保守判定，不确定性一律返回 null）。
 * sourceLines: [{ text, x0, y0, x1, y1, size }]；pageWidth 可选，默认取行框 x1 最大值。
 * 返回 { start, end, reason: "heading" | "continuation" } 或 null。
 */
export function detectReferenceRegion(sourceLines = [], { pageWidth = 0 } = {}) {
  const lines = Array.isArray(sourceLines) ? sourceLines : []
  const bodyLines = []
  for (const line of lines) {
    const box = inRegionBody(line)
    if (!box) continue
    bodyLines.push({ ...box, text: line.text, size: lineSize(line), flags: line.flags })
  }
  if (bodyLines.length < MIN_REFERENCE_ENTRIES) return null

  const width = Number(pageWidth) > 0
    ? Number(pageWidth)
    : Math.max(...lines.map((line) => Number(line?.x1)).filter((value) => Number.isFinite(value) && value > 0))
  // 双栏必须在合并碎片行之前判定：合并会把左右栏同基线行并成一行，破坏 x0 簇。
  if (hasSignificantColumnSplit(bodyLines, width)) return null

  const rows = mergeBaselineRows(bodyLines)
  if (rows.length < MIN_REFERENCE_ENTRIES) return null
  // 扫描版/抽取失败没有字号：无法做版面判定，交给正则回退。
  const bodySize = modeSize(rows)
  if (!(bodySize > 0)) return null

  const colLeft = Math.min(...rows.map((row) => row.x0))
  const entries = []
  for (const row of rows) {
    const match = ENTRY_MARKER_RE.exec(row.text)
    if (!match) continue
    if (Math.abs(row.x0 - colLeft) > ENTRY_LEFT_TOLERANCE) continue
    if (row.size > 0 && Math.abs(row.size - bodySize) > ENTRY_SIZE_TOLERANCE) continue
    entries.push({ row, number: Number(match[1]) })
  }
  if (entries.length < MIN_REFERENCE_ENTRIES) return null

  // 条目块：从条目首行到下一个条目首行之间，且与块内上一行间距不超阈值。
  const blockRowsOf = (entry, nextY0) => {
    const block = []
    let lastY = entry.row.y1
    for (const row of rows) {
      if (row.y0 <= entry.row.y0) continue
      if (nextY0 != null && row.y0 >= nextY0) break
      if (row.y0 - lastY > HANGING_BLOCK_MAX_GAP) break
      block.push(row)
      lastY = Math.max(lastY, row.y1)
    }
    return block
  }

  let hangingRows = 0
  let lastEntryY1 = entries[entries.length - 1].row.y1
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i]
    const nextY0 = entries[i + 1]?.row.y0 ?? null
    const block = blockRowsOf(entry, nextY0)
    let blockY1 = entry.row.y1
    for (const row of block) {
      blockY1 = Math.max(blockY1, row.y1)
      const indent = row.x0 - entry.row.x0
      if (indent < HANGING_INDENT_MIN || indent > HANGING_INDENT_MAX) continue
      if (row.x1 <= colLeft + HANGING_MIN_X1_OFFSET) continue
      hangingRows += 1
    }
    if (i === entries.length - 1) lastEntryY1 = blockY1
  }
  if (hangingRows / rows.length < HANGING_MIN_ROW_RATIO) return null

  const sizedRows = rows.filter((row) => row.size > 0)
  const uniformRows = sizedRows.filter((row) => Math.abs(row.size - bodySize) <= ENTRY_SIZE_TOLERANCE)
  if (!sizedRows.length || uniformRows.length / sizedRows.length < SIZE_UNIFORMITY_MIN) return null

  let consecutive = 0
  let missing = 0
  for (let i = 1; i < entries.length; i += 1) {
    const diff = entries[i].number - entries[i - 1].number
    if (diff === 1) consecutive += 1
    else if (diff > 1) missing += diff - 1
  }
  const continuity = entries.length > 1 ? consecutive / (entries.length - 1) : 1
  if (continuity < NUMBER_CONTINUITY_MIN || missing > NUMBER_MAX_MISSING) return null

  const firstEntryY0 = entries[0].row.y0
  let heading = null
  for (const row of rows) {
    if (row.y0 >= firstEntryY0) break
    if (row.size < bodySize * 1.08 && !row.bold) continue
    if (!isReferenceHeadingLine(row.text)) continue
    heading = row
  }
  if (heading) {
    return { start: heading.y1 - 5, end: lastEntryY1 + 5, reason: "heading" }
  }
  // 无标题续页：只有整页指纹都成立才建立区域，起点从第一条文献开始。
  return { start: firstEntryY0 - 5, end: lastEntryY1 + 5, reason: "continuation" }
}

/** 中文行内连续出现的英文词 run，用于识别「中文夹整句英文」。 */
function hasLongEnglishRun(text) {
  const tokens = String(text || "").split(/\s+/).filter(Boolean)
  let run = 0
  let letters = 0
  for (const token of tokens) {
    const word = token.replace(/^[^A-Za-z]+/, "").replace(/[^A-Za-z'’-]+$/, "")
    if (/^[A-Za-z][A-Za-z'’-]*$/.test(word)) {
      run += 1
      letters += word.length
    } else {
      run = 0
      letters = 0
    }
    if (run >= 6 && letters >= 40) return true
  }
  return false
}

function detectOverlaps(rows, issues) {
  const ordered = rows
    .filter((row) => row.box)
    .sort((a, b) => a.box.y0 - b.box.y0 || a.box.x0 - b.box.x0)
  for (let i = 0; i < ordered.length; i += 1) {
    if (issues.overlap.length >= MAX_PER_KIND) break
    const a = ordered[i]
    for (let j = i + 1; j < ordered.length; j += 1) {
      if (issues.overlap.length >= MAX_PER_KIND) break
      const b = ordered[j]
      // 已按 y0 排序；当前行完全在 a 下方（含恰好相接）时后续行也不会再相交。
      if (b.box.y0 >= a.box.y1) break
      const aH = a.box.y1 - a.box.y0
      const bH = b.box.y1 - b.box.y0
      const minH = Math.min(aH, bH)
      if (minH <= 0) continue
      const vOverlap = Math.min(a.box.y1, b.box.y1) - Math.max(a.box.y0, b.box.y0)
      if (vOverlap <= OVERLAP_MIN_VERTICAL_RATIO * minH) continue
      const aW = a.box.x1 - a.box.x0
      const bW = b.box.x1 - b.box.x0
      const hOverlap = Math.min(a.box.x1, b.box.x1) - Math.max(a.box.x0, b.box.x0)
      if (hOverlap <= OVERLAP_MIN_HORIZONTAL_RATIO * Math.min(aW, bW)) continue
      if (Math.abs(aH - bH) >= OVERLAP_MAX_HEIGHT_DIFF_RATIO * Math.max(aH, bH)) continue
      issues.overlap.push(issue(
        "overlap",
        `译文行框重叠：「${clip(a.text)}」与「${clip(b.text)}」`,
        `${clip(a.text, 40)} / ${clip(b.text, 40)}`,
        {
          x0: Math.max(a.box.x0, b.box.x0),
          y0: Math.max(a.box.y0, b.box.y0),
          x1: Math.min(a.box.x1, b.box.x1),
          y1: Math.min(a.box.y1, b.box.y1)
        }
      ))
    }
  }
}

function detectOutOfBounds(rows, issues, { pageWidth, pageHeight }) {
  for (const row of rows) {
    if (issues.outOfBounds.length >= MAX_PER_KIND) break
    if (!row.box) continue
    const badX = pageWidth > 0 && (row.box.x0 < -1 || row.box.x1 > pageWidth + 1)
    const badY = pageHeight > 0 && (row.box.y0 < -1 || row.box.y1 > pageHeight + 1)
    if (!badX && !badY) continue
    issues.outOfBounds.push(issue("outOfBounds", "译文行越出页面边界", row.text, row.box))
  }
}

function centerInsideBoxes(row, boxes) {
  if (!row?.box || !Array.isArray(boxes) || !boxes.length) return false
  const cx = (row.box.x0 + row.box.x1) / 2
  const cy = (row.box.y0 + row.box.y1) / 2
  return boxes.some((box) => {
    const x0 = Number(box?.x0)
    const y0 = Number(box?.y0)
    const x1 = Number(box?.x1)
    const y1 = Number(box?.y1)
    if (![x0, y0, x1, y1].every(Number.isFinite)) return false
    return cx >= x0 && cx <= x1 && cy >= y0 && cy <= y1
  })
}

/**
 * 扫描译文页文本行，返回四类确定性问题。
 * lines: [{ text, x0, y0, x1, y1 }]，pageWidth/pageHeight 为 0 时跳过越界判定。
 * sourceLines: 可选的源页行；能识别出文献区域时只抑制区域内的 untranslated，
 * 识别不出时回退到 markReferenceRows 的纯文本正则（旧行为）。
 * ignoreBoxes: 首页整块回贴的 front-matter 框；行中心落在框内的行不参与
 * latex/untranslated/overlap 检测（outOfBounds 仍然检测），避免回贴英文标题后误判漏译。
 */
export function detectLayoutIssues(lines = [], { pageWidth = 0, pageHeight = 0, sourceLines = null, ignoreBoxes = null } = {}) {
  const issues = { latex: [], untranslated: [], overlap: [], outOfBounds: [] }
  const rows = []
  for (const line of Array.isArray(lines) ? lines : []) {
    const text = normalizeText(line?.text)
    if (!text) continue
    const box = validBox(line)
    rows.push({ text, box })
  }
  const ignoredRows = ignoreBoxes?.length
    ? rows.map((row) => centerInsideBoxes(row, ignoreBoxes))
    : null
  const qaRows = ignoredRows ? rows.filter((_, index) => !ignoredRows[index]) : rows
  for (const row of qaRows) {
    if (looksLikeLatexMarkup(row.text)) {
      pushIssue(issues.latex, issue("latex", "疑似 LaTeX/公式标记被当作正文排版", row.text, row.box))
    }
  }
  // 参考文献区（标题之后 / 整页文献续页）不算漏译；其余三类检测不受影响。
  // 有源页版面时按几何区域判定，区域外仍照常检测，避免整页抑制误伤正文。
  const referenceRegion = detectReferenceRegion(sourceLines || [])
  const referenceRows = referenceRegion
    ? qaRows.map((row) => Boolean(row.box)
      && row.box.y0 >= referenceRegion.start - REFERENCE_REGION_TOLERANCE
      && row.box.y1 <= referenceRegion.end + REFERENCE_REGION_TOLERANCE)
    : markReferenceRows(qaRows)
  for (let i = 0; i < qaRows.length; i += 1) {
    const { text, box } = qaRows[i]
    if (referenceRows[i]) continue
    if (CJK_RE.test(text)) {
      if (hasLongEnglishRun(stripNoisySpans(text))) {
        pushIssue(issues.untranslated, issue("untranslated", "中文行内夹杂整句英文", text, box))
      }
    } else if (isUntranslatedBodyLine(text)) {
      pushIssue(issues.untranslated, issue("untranslated", "整行英文疑似未翻译", text, box))
    }
  }
  detectOverlaps(qaRows, issues)
  detectOutOfBounds(rows, issues, { pageWidth: Number(pageWidth) || 0, pageHeight: Number(pageHeight) || 0 })
  return issues
}

/** 汇总各类命中数量；counts 始终包含四个键（无命中为 0）。 */
export function summarizeLayoutIssues(issues = {}) {
  const counts = {}
  for (const kind of LAYOUT_QA_KINDS) {
    counts[kind] = Array.isArray(issues?.[kind]) ? issues[kind].length : 0
  }
  return {
    total: LAYOUT_QA_KINDS.reduce((sum, kind) => sum + counts[kind], 0),
    counts
  }
}

/** 把四类问题合并成一个列表（最多 8 条），供页面状态展示。 */
export function mergeLayoutIssues(issues = {}) {
  const merged = []
  for (const kind of LAYOUT_QA_KINDS) {
    for (const item of Array.isArray(issues?.[kind]) ? issues[kind] : []) {
      if (merged.length >= MAX_MERGED_ISSUES) return merged
      merged.push(item)
    }
  }
  return merged
}
