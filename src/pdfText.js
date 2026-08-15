/**
 * PDF.js gives text items in drawing order, which is often different from the
 * order a person reads the page.  Build lines from their page coordinates so
 * the text sent to translation follows the visible document from top to bottom.
 */
export const PDF_TEXT_LAYOUT_VERSION = 2;

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
        hasEOL: Boolean(item?.hasEOL)
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
  return {
    text: joinLineItems(row),
    items: row,
    x: left,
    y: Math.max(...row.map((item) => item.y)),
    width: Math.max(1, right - left),
    height: Math.max(...row.map((item) => item.height))
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
      fontSize: Math.max(6, line.height)
    };
  });
}

export function extractReadablePdfText(items) {
  return groupReadablePdfLines(items).map((line) => line.text).join("\n");
}
