/**
 * PDF.js gives text items in drawing order, which is often different from the
 * order a person reads the page.  Build lines from their page coordinates so
 * the text sent to translation follows the visible document from top to bottom.
 */
export const PDF_TEXT_LAYOUT_VERSION = 4;

/** 从 PDF 字体名猜字重。期刊嵌入字体常不带 bold 位，只能看名字。 */
export function inferFontWeightFromName(fontName) {
  const name = String(fontName || "");
  if (/black|heavy|extrabold/i.test(name) || /[-_]h(?:[-_]|$)/i.test(name)) return 800;
  if (/bold|semibold|demibold/i.test(name) || /[-_]b(?:[-_]|$)/i.test(name)) return 700;
  if (/medium/i.test(name) || /[-_]m(?:[-_]|$)/i.test(name)) return 600;
  return 400;
}

function normalizeTextItems(items) {
  const source = Array.isArray(items) ? items : [];
  return source
    .map((item, index) => {
      const text = String(item?.str || "").replace(/\s+/g, " ").trim();
      const transform = Array.isArray(item?.transform) ? item.transform : [];
      return {
        text,
        index,
        x: Number(transform[4]) || 0,
        y: Number(transform[5]) || 0,
        // PDF coordinates grow upward.  Use the font height as a tolerant
        // line-grouping threshold for superscripts and baseline drift.
        height: Math.max(1, Math.abs(Number(transform[3])) || Number(item?.height) || 8),
        width: Math.max(1, Math.abs(Number(item?.width)) || 0),
        widthKnown: Number(item?.width) > 0,
        hasEOL: Boolean(item?.hasEOL),
        fontName: String(item?.fontName || "")
      };
    })
    .filter((item) => item.text);
}

function joinLineItems(items) {
  return items
    .sort((a, b) => (a.x - b.x) || (a.index - b.index))
    .map((item, index, row) => {
      const previous = row[index - 1];
      // Preserve intentional word gaps but do not add them between Chinese glyphs.
      const needsGap = previous && /[A-Za-z0-9)]$/.test(previous.text) && /^[A-Za-z0-9(]/.test(item.text);
      return `${needsGap ? " " : ""}${item.text}`;
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

function lineFromItems(items) {
  const row = [...items].sort((a, b) => (a.x - b.x) || (a.index - b.index));
  const left = Math.min(...row.map((item) => item.x));
  const right = Math.max(...row.map((item) => item.x + item.width));
  const widest = row.reduce((best, item) => ((item.width || 0) > (best.width || 0) ? item : best), row[0]);
  const fontName = widest?.fontName || "";
  return {
    text: joinLineItems(row),
    items: row,
    x: left,
    y: Math.max(...row.map((item) => item.y)),
    width: Math.max(1, right - left),
    height: Math.max(...row.map((item) => item.height)),
    fontName,
    fontWeight: inferFontWeightFromName(fontName)
  };
}

function groupItemsByBaseline(positioned) {
  const bands = [];
  const ordered = [...positioned].sort((a, b) => (b.y - a.y) || (a.x - b.x) || (a.index - b.index));
  for (const item of ordered) {
    let nearest = null;
    let nearestDistance = Infinity;
    for (const band of bands) {
      const distance = Math.abs(band.y - item.y);
      const tolerance = Math.max(2, Math.min(8, Math.max(band.height, item.height) * 0.45));
      if (distance <= tolerance && distance < nearestDistance) {
        nearest = band;
        nearestDistance = distance;
      }
    }
    if (!nearest) {
      bands.push({ y: item.y, height: item.height, items: [item] });
    } else {
      nearest.items.push(item);
      nearest.height = Math.max(nearest.height, item.height);
      nearest.y = Math.max(nearest.y, item.y);
    }
  }
  return bands;
}

function splitBaselineBand(band) {
  const items = [...band.items].sort((a, b) => (a.x - b.x) || (a.index - b.index));
  // PDF.js normally supplies item widths. If it does not, keep the historical
  // behavior because an x-gap may simply be an unknown word gap.
  if (!items.some((item) => item.widthKnown)) return [lineFromItems(items)];

  const gapLimit = Math.max(24, Math.min(48, band.height * 3.5));
  const fragments = [];
  let current = [];
  let currentRight = -Infinity;
  for (const item of items) {
    const gap = item.x - currentRight;
    const previousEndsLine = current.length && current[current.length - 1].hasEOL;
    if (current.length && (previousEndsLine || (gap > gapLimit && item.x >= currentRight))) {
      fragments.push(lineFromItems(current));
      current = [];
    }
    current.push(item);
    currentRight = Math.max(currentRight, item.x + item.width);
  }
  if (current.length) fragments.push(lineFromItems(current));
  return fragments;
}

function orderedColumnLines(lines) {
  if (lines.length < 4) return [...lines].sort((a, b) => (b.y - a.y) || (a.x - b.x));

  const contentLeft = Math.min(...lines.map((line) => line.x));
  const contentRight = Math.max(...lines.map((line) => line.x + line.width));
  const contentWidth = Math.max(1, contentRight - contentLeft);
  const wideLimit = contentWidth * 0.68;
  // Use the compact body lines to infer column anchors. Title, affiliation,
  // and footer lines can be wider than one column without being true columns.
  const candidates = lines.filter((line) => line.width <= contentWidth * 0.5);
  if (candidates.length < 4) return [...lines].sort((a, b) => (b.y - a.y) || (a.x - b.x));

  const startGap = Math.max(32, contentWidth * 0.12);
  const starts = [...new Set(candidates.map((line) => Math.round(line.x * 100) / 100))].sort((a, b) => a - b);
  const clusters = [];
  for (const start of starts) {
    const previous = clusters[clusters.length - 1];
    if (!previous || start - previous.maxStart > startGap) {
      clusters.push({ minStart: start, maxStart: start, starts: [start] });
    } else {
      previous.starts.push(start);
      previous.maxStart = start;
    }
  }
  if (clusters.length < 2) return [...lines].sort((a, b) => (b.y - a.y) || (a.x - b.x));

  const clusterStats = clusters.map((cluster) => {
    const members = candidates.filter((line) => {
      const start = Math.round(line.x * 100) / 100;
      return start >= cluster.minStart && start <= cluster.maxStart;
    });
    return {
      ...cluster,
      members,
      anchor: members.reduce((sum, line) => sum + line.x, 0) / Math.max(1, members.length),
      right: Math.max(...members.map((line) => line.x + line.width))
    };
  });
  const populated = clusterStats.filter((cluster) => cluster.members.length >= 2);
  if (populated.length < 2) return [...lines].sort((a, b) => (b.y - a.y) || (a.x - b.x));

  // An indented paragraph or a hanging citation is not a column if its text
  // overlaps the main text band. Real columns have a visible gutter.
  const separated = populated.every((cluster, index) => {
    const next = populated[index + 1];
    return !next || next.anchor - cluster.right >= Math.max(12, contentWidth * 0.02);
  });
  if (!separated) return [...lines].sort((a, b) => (b.y - a.y) || (a.x - b.x));

  const anchors = populated.map((cluster) => cluster.anchor);
  // The first y-coordinate shared by the detected columns marks the start of
  // the column region. Everything above it is a title/author/header block and
  // must stay in normal top-to-bottom order before reading column 1 then 2.
  const columnRegionTop = Math.min(...populated.map((cluster) => Math.max(...cluster.members.map((line) => line.y))));
  const baselineTolerance = 4;
  const assignments = new Map();
  const wideLines = [];
  for (const line of lines) {
    if (line.y > columnRegionTop + baselineTolerance) continue;
    if (line.width >= wideLimit) {
      wideLines.push(line);
      continue;
    }
    let column = 0;
    let distance = Infinity;
    anchors.forEach((anchor, index) => {
      const nextDistance = Math.abs(line.x - anchor);
      if (nextDistance < distance) {
        distance = nextDistance;
        column = index;
      }
    });
    if (!assignments.has(column)) assignments.set(column, []);
    assignments.get(column).push(line);
  }

  const leading = lines.filter((line) => line.y > columnRegionTop + baselineTolerance);
  const trailing = wideLines;
  const orderedColumns = [...assignments.keys()].sort((a, b) => a - b).map((column) =>
    assignments.get(column).sort((a, b) => (b.y - a.y) || (a.x - b.x))
  );
  const maxColumnGap = Math.max(42, Math.max(...lines.map((line) => line.height)) * 4);
  const interruptedColumn = orderedColumns.some((column) => column.some((line, index) => {
    const next = column[index + 1];
    return next && line.y - next.y > maxColumnGap;
  }));
  let orderedBody;
  if (interruptedColumn) {
    const bodyLines = [...orderedColumns.flat(), ...trailing];
    const blocks = [];
    for (const line of bodyLines.sort((a, b) => (b.y - a.y) || (a.x - b.x))) {
      const previous = blocks[blocks.length - 1];
      const gap = previous ? previous.bottom - line.y : 0;
      if (!previous || gap > maxColumnGap) {
        blocks.push({ top: line.y, bottom: line.y, left: line.x, lines: [line] });
      } else {
        previous.lines.push(line);
        previous.bottom = line.y;
        previous.left = Math.min(previous.left, line.x);
      }
    }
    orderedBody = blocks
      .sort((a, b) => (b.top - a.top) || (a.left - b.left))
      .flatMap((block) => block.lines.sort((a, b) => (b.y - a.y) || (a.x - b.x)));
  } else {
    orderedBody = [...orderedColumns.flat(), ...trailing];
  }
  const ordered = [
    ...leading.sort((a, b) => (b.y - a.y) || (a.x - b.x)),
    ...orderedBody,
  ];
  return ordered.length === lines.length ? ordered : [...lines].sort((a, b) => (b.y - a.y) || (a.x - b.x));
}

export function groupReadablePdfLines(items) {
  const positioned = normalizeTextItems(items);
  if (!positioned.length) return [];
  const fragments = groupItemsByBaseline(positioned).flatMap(splitBaselineBand).filter((line) => line.text);
  return orderedColumnLines(fragments);
}

export function buildPdfTextLayout(items, viewport) {
  const lines = groupReadablePdfLines(items);
  const matrix = Array.isArray(viewport?.transform) ? viewport.transform : [1, 0, 0, 1, 0, 0];
  const pageWidth = Math.max(1, Number(viewport?.width) || 1);
  const pageHeight = Math.max(1, Number(viewport?.height) || 1);
  const transformPoint = (x, y) => ({
    x: matrix[0] * x + matrix[2] * y + matrix[4],
    y: matrix[1] * x + matrix[3] * y + matrix[5]
  });

  return lines.map((line) => {
    const points = line.items.flatMap((item) => [
      transformPoint(item.x, item.y - item.height),
      transformPoint(item.x + item.width, item.y - item.height),
      transformPoint(item.x, item.y),
      transformPoint(item.x + item.width, item.y)
    ]);
    const left = Math.min(...points.map((point) => point.x));
    const top = Math.min(...points.map((point) => point.y));
    const right = Math.max(...points.map((point) => point.x));
    const bottom = Math.max(...points.map((point) => point.y));
    const heightPercent = ((bottom - top) / pageHeight) * 100;
    return {
      text: line.text,
      left: Math.max(0, Math.min(100, (left / pageWidth) * 100)),
      // PDF.js positions text spans on the baseline. Move the cover box up
      // by most of the glyph height so it covers the painted PDF text itself.
      top: Math.max(0, Math.min(100, (top / pageHeight) * 100 - heightPercent * 0.85)),
      width: Math.max(0.5, Math.min(100, ((right - left) / pageWidth) * 100)),
      height: Math.max(0.5, Math.min(100, heightPercent)),
      fontSize: Math.max(6, line.height),
      fontName: line.fontName || "",
      fontWeight: line.fontWeight || inferFontWeightFromName(line.fontName)
    };
  });
}

export function extractReadablePdfText(items) {
  return groupReadablePdfLines(items).map((line) => line.text).join("\n");
}

// Actual glyph bounds in the screenshot viewport; deliberately independent of
// buildPdfTextLayout's historical cover-box offset. Indices are page-local.
export function buildPdfVisionLines(content, viewport) {
  const m = viewport?.transform;
  if (!Array.isArray(m) || !viewport.width || !viewport.height) return [];
  const diagnostics = { unpositionedItems: 0, clampedItems: 0, truncatedRows: 0, omittedRows: 0, scope: "local" };
  const point = (x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
  const glyphs = (content?.items || []).flatMap((item, order) => {
    const t = item.transform;
    if (!item.str?.trim()) return [];
    if (!Array.isArray(t) || t.length < 6 || t.some((v) => !Number.isFinite(v))) { diagnostics.unpositionedItems += 1; return []; }
    const size = Math.hypot(t[2], t[3]);
    const style = content.styles?.[item.fontName] || {};
    const ascent = Number.isFinite(style.ascent) ? style.ascent : 0.9;
    const descent = Number.isFinite(style.descent) ? style.descent : -0.25;
    const axis = point(t[4] + t[0], t[5] + t[1]);
    const origin = point(t[4], t[5]);
    let safe = size > 0 && Number(item.width) > 0 && Math.abs(axis[1] - origin[1]) < Math.abs(axis[0] - origin[0]) * 0.015
      && Math.abs(t[2]) < size * 0.015 && t[0] > 0 && !style.vertical
      && !/symbol|math|cmmi|cmsy|cmex|msam|msbm/i.test(item.fontName || "");
    const width = Number(item.width) > 0 ? Number(item.width) : Math.max(1, size * item.str.length * 0.5);
    const axisSize = Math.hypot(t[0], t[1]) || 1;
    const dx = t[0] / axisSize * width;
    const dy = t[1] / axisSize * width;
    const corners = [point(t[4] + t[2] * ascent, t[5] + t[3] * ascent), point(t[4] + dx + t[2] * ascent, t[5] + dy + t[3] * ascent),
      point(t[4] + t[2] * descent, t[5] + t[3] * descent), point(t[4] + dx + t[2] * descent, t[5] + dy + t[3] * descent)];
    const bbox = [Math.min(...corners.map((p) => p[0])) / viewport.width * 1000,
      Math.min(...corners.map((p) => p[1])) / viewport.height * 1000,
      Math.max(...corners.map((p) => p[0])) / viewport.width * 1000,
      Math.max(...corners.map((p) => p[1])) / viewport.height * 1000];
    if (bbox.some((v) => !Number.isFinite(v))) { diagnostics.unpositionedItems += 1; return []; }
    if (bbox.some((v) => v < 0 || v > 1000)) { safe = false; diagnostics.clampedItems += 1; }
    // Even an edge glyph must leave a small unsafe collision footprint.
    const left = Math.max(0, Math.min(999.9, bbox[0]));
    const top = Math.max(0, Math.min(999.9, bbox[1]));
    const clamped = [left, top, Math.max(left + 0.1, Math.min(1000, bbox[2])), Math.max(top + 0.1, Math.min(1000, bbox[3]))];
    return [{ text: item.str, bbox: clamped, baseline: origin[1] / viewport.height * 1000, safe, order }];
  }).sort((a, b) => a.baseline - b.baseline || a.bbox[0] - b.bbox[0] || a.order - b.order);
  // First collect baseline bands, THEN sort each band left-to-right. Drawing a
  // right-hand fragment first must not leave two overlapping physical rows.
  const bands = [];
  for (const glyph of glyphs) {
    const height = glyph.bbox[3] - glyph.bbox[1];
    const band = bands.findLast((b) => Math.abs(b.baseline - glyph.baseline) <= Math.min(height, b.height) * 0.4);
    if (band) band.glyphs.push(glyph);
    else bands.push({ baseline: glyph.baseline, height, glyphs: [glyph] });
  }
  const rows = [];
  for (const band of bands) {
   let row = null;
   for (const glyph of band.glyphs.sort((a, b) => a.bbox[0] - b.bbox[0] || a.order - b.order)) {
    const h = glyph.bbox[3] - glyph.bbox[1];
    if (row && glyph.bbox[0] - row.bbox[2] < Math.max(h * 2, 10)) {
      row.text += `${/[a-z0-9)]$/i.test(row.text) && /^[a-z0-9(]/i.test(glyph.text) ? " " : ""}${glyph.text}`;
      row.bbox = [Math.min(row.bbox[0], glyph.bbox[0]), Math.min(row.bbox[1], glyph.bbox[1]), Math.max(row.bbox[2], glyph.bbox[2]), Math.max(row.bbox[3], glyph.bbox[3])];
      row.safe = row.safe && glyph.safe;
    } else { row = { ...glyph, height: h }; rows.push(row); }
   }
  }
  const limited = [];
  let textBudget = 100000;
  for (const row of rows.slice(0, 800)) {
    if (textBudget <= 0) break;
    const source = row.text.trim();
    const text = source.slice(0, Math.min(1600, textBudget));
    if (text.length !== source.length) diagnostics.truncatedRows += 1;
    limited.push({ index: limited.length, text, bbox: row.bbox, safe: row.safe && text.length === source.length,
      ...(!row.safe ? { unsafeReason: "源行方向、字体或边界不可靠" } : text.length !== source.length ? { unsafeReason: "源行超过文本限额，局部保留原图" } : {}) });
    textBudget -= text.length;
  }
  // Omitted rows would no longer be available to the intersection veto.
  if (limited.length !== rows.length) {
    diagnostics.omittedRows = rows.length - limited.length;
    diagnostics.scope = "page";
    for (const line of limited) { line.safe = false; line.unsafeReason = "本页超过源行或总文本限额，缺少碰撞证据"; }
  }
  if (!limited.length && diagnostics.unpositionedItems) diagnostics.scope = "page";
  limited.diagnostics = diagnostics;
  return limited;
}

function quantizeRgb(r, g, b, step = 12) {
  return [Math.round(r / step) * step, Math.round(g / step) * step, Math.round(b / step) * step];
}

function modeRgb(pixels) {
  if (!pixels.length) return null;
  const counts = new Map();
  for (const [r, g, b] of pixels) {
    const key = quantizeRgb(r, g, b).join(",");
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  let best = null;
  let bestCount = 0;
  for (const [key, count] of counts) {
    if (count > bestCount) {
      best = key.split(",").map(Number);
      bestCount = count;
    }
  }
  return best;
}

function rgbCss(rgb) {
  return rgb ? `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})` : "";
}

/**
 * 从已渲染的原页 canvas 取样：前景色给译文，浅色给遮罩，避免一律深蓝+白底。
 * canvas 须已画好原文；cssWidth/cssHeight 是 CSS 像素（不含 DPR）。
 */
export function samplePdfLineAppearance(canvas, line, cssWidth, cssHeight) {
  const width = Number(cssWidth) || 0;
  const height = Number(cssHeight) || 0;
  if (!canvas || !width || !height || !line) return {};
  const ctx = canvas.getContext?.("2d", { willReadFrequently: true });
  if (!ctx?.getImageData) return {};
  const dpr = canvas.width / width;
  const x = Math.max(0, Math.floor((Number(line.left) / 100) * width * dpr));
  const y = Math.max(0, Math.floor((Number(line.top) / 100) * height * dpr));
  const w = Math.max(1, Math.floor((Number(line.width) / 100) * width * dpr));
  const h = Math.max(1, Math.floor((Number(line.height) / 100) * height * dpr));
  const sw = Math.min(w, canvas.width - x);
  const sh = Math.min(h, canvas.height - y);
  if (sw < 1 || sh < 1) return {};
  let data;
  try {
    data = ctx.getImageData(x, y, sw, sh).data;
  } catch {
    return {};
  }
  const foreground = [];
  const background = [];
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    if (data[i + 3] < 128) continue;
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const chroma = Math.max(r, g, b) - Math.min(r, g, b);
    if (lum > 242 && chroma < 18) background.push([r, g, b]);
    else foreground.push([r, g, b]);
  }
  const color = rgbCss(modeRgb(foreground));
  const backgroundColor = rgbCss(modeRgb(background));
  const next = {};
  if (color) next.color = color;
  if (backgroundColor) next.background = backgroundColor;
  return next;
}

export function applySampledLineAppearance(lines, canvas, cssWidth, cssHeight) {
  return (Array.isArray(lines) ? lines : []).map((line) => ({
    ...line,
    ...samplePdfLineAppearance(canvas, line, cssWidth, cssHeight)
  }));
}
