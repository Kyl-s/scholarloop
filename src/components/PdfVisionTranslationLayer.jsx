import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { VISION_SCAN_MIN_CONFIDENCE, VISION_OVERLAY_KINDS, hasVisionFormula } from "../../shared/pdfVisionOverlayPolicy.js";

const validBox = (b) => Array.isArray(b) && b.length === 4 && b.every((v) => Number.isFinite(v) && v >= 0 && v <= 1000) && b[2] > b[0] && b[3] > b[1];
const intersects = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];
const union = (rows) => [Math.min(...rows.map((r) => r.bbox[0])), Math.min(...rows.map((r) => r.bbox[1])), Math.max(...rows.map((r) => r.bbox[2])), Math.max(...rows.map((r) => r.bbox[3]))];
const allowed = new Set(VISION_OVERLAY_KINDS);
const normalized = (text) => String(text || "").replace(/\s+/g, "").toLowerCase();

// Unsafe rows remain collision evidence. Unknown distant formulas do not veto a page.
export function visionOverlayPlan(result) {
  const lines = Array.isArray(result?.lines) ? result.lines : [];
  const blocks = result?.blocks || [];
  const rowsFor = (block) => Array.isArray(block.lineIndexes) ? block.lineIndexes.map((id) => lines.find((line) => line.index === id)).filter(Boolean) : [];
  const boxes = blocks.map((block) => {
    const rows = rowsFor(block).filter((line) => validBox(line.bbox));
    if (rows.length) return union(rows);
    if (validBox(block.bbox)) return block.bbox;
    const source = normalized(block.source);
    const matches = source.length > 2 ? lines.filter((line) => validBox(line.bbox) && normalized(line.text).length > 2 && (source.includes(normalized(line.text)) || (source.length >= 6 && normalized(line.text).includes(source)))) : [];
    return matches.length ? union(matches) : null;
  });
  const entries = blocks.map((block, index) => {
    const bbox = boxes[index];
    const rows = rowsFor(block);
    const selected = new Set(Array.isArray(block.lineIndexes) ? block.lineIndexes : []);
    let reason = "";
    if (result?.layoutVersion !== 1) reason = "旧结果缺少坐标，需重译当前页（会调用模型）";
    else if (result.textExtractionFailed || (result.textLayerPresent && !lines.length)) reason = "本页源行无法定位，保留原图";
    else if (!allowed.has(block.kind)) reason = "公式或图表保留原图";
    else if (hasVisionFormula(block.source) || hasVisionFormula(block.translation)) reason = "含公式，保留原图";
    else if (block.localAnchorMappingReason) reason = block.localAnchorMappingReason;
    else if (!block.translation?.trim()) reason = "未返回译文";
    else if (!bbox) reason = "缺少可靠段落坐标";
    // Real PDF anchors are authoritative; the confidence floor is for scans,
    // matching the server contract rather than rejecting anchored prose twice.
    else if (block.confidence != null && (!Number.isFinite(block.confidence) || block.confidence < 0 || block.confidence > 1 || (!lines.length && block.confidence < VISION_SCAN_MIN_CONFIDENCE))) reason = "定位置信度不足";
    else if (bbox[2] - bbox[0] > (lines.length ? 900 : 600) || bbox[3] - bbox[1] > 450) reason = "段落区域过大，保留原图";
    else if (lines.length) {
      if (!rows.length || rows.length !== block.lineIndexes?.length || selected.size !== rows.length || block.lineIndexes.some((id) => !Number.isInteger(id))) reason = "源行索引缺失或重复";
      else if (rows.some((row) => !validBox(row.bbox) || row.safe !== true || hasVisionFormula(row.text))) reason = rows.find((row) => row.safe !== true)?.unsafeReason || "源行含公式或坐标不可靠";
      else if (lines.some((line) => !selected.has(line.index) && validBox(line.bbox) && intersects(bbox, line.bbox))) reason = "区域与其他源行相交";
      else {
        const ordered = [...rows].sort((a, b) => a.bbox[1] - b.bbox[1]);
        if (ordered.some((row, i) => {
          const prev = ordered[i - 1];
          if (!prev) return false;
          const h = Math.max(row.bbox[3] - row.bbox[1], prev.bbox[3] - prev.bbox[1]);
          const overlap = Math.min(row.bbox[2], prev.bbox[2]) - Math.max(row.bbox[0], prev.bbox[0]);
          return row.bbox[1] < prev.bbox[3] - h * 0.35 || row.bbox[1] - prev.bbox[3] > h * 1.3 || overlap < Math.min(row.bbox[2] - row.bbox[0], prev.bbox[2] - prev.bbox[0]) * 0.45;
        })) reason = "源行不连续或跨栏";
      }
    } else if (block.overlaySafe !== true || !Number.isFinite(block.confidence) || block.confidence < VISION_SCAN_MIN_CONFIDENCE) reason = block.overlayReason || "扫描段落未获安全覆盖许可";
    // Preserve explicit refusals from the shared current contract. Legacy
    // results without a reason can be recomputed from complete local anchors.
    if (!reason && block.overlaySafe !== true && typeof block.overlayReason === "string" && block.overlayReason.trim()) reason = block.overlayReason;
    if (!reason && boxes.some((other, i) => i !== index && other && intersects(bbox, other))) reason = "区域与其他段落、公式或图表相交";
    if (!reason && blocks.some((other, i) => i !== index && (!allowed.has(other.kind) || hasVisionFormula(other.source)) && validBox(other.bbox) && intersects(bbox, other.bbox))) reason = "区域与受保护的公式或图表相交";
    return { ...block, bbox, key: `${block.id}-${index}`, blockIndex: index, overlayStatus: reason ? "rejected" : "candidate", rejectionReason: reason };
  });
  // Extend only anchored paragraphs into a small single-column gap, bounded by
  // all rows/blocks (including unsafe rows and protected model rectangles).
  return entries.map((entry) => {
    if (entry.rejectionReason || !lines.length) return entry;
    const bbox = [...entry.bbox];
    const selected = new Set(entry.lineIndexes);
    const rowHeight = Math.max(...rowsFor(entry).map((row) => row.bbox[3] - row.bbox[1]));
    let bottom = Math.min(1000, bbox[3] + rowHeight * 1.5);
    const obstacles = [...lines.filter((line) => !selected.has(line.index)).map((line) => line.bbox), ...boxes.filter((_, i) => i !== entry.blockIndex), ...blocks.filter((block, i) => i !== entry.blockIndex && !allowed.has(block.kind)).map((block) => block.bbox)];
    for (const box of obstacles) {
      if (validBox(box) && box[0] < bbox[2] && box[2] > bbox[0] && box[1] >= bbox[3]) bottom = Math.min(bottom, box[1] - Math.min(1, rowHeight * 0.08));
    }
    bbox[3] = Math.max(bbox[3], bottom);
    return { ...entry, bbox };
  });
}

export function visionOverlayCandidates(result) {
  return visionOverlayPlan(result).filter((entry) => !entry.rejectionReason);
}

export default function PdfVisionTranslationLayer({ result, onCoverage, pageScale = 1 }) {
  const root = useRef(null);
  const plan = useMemo(() => visionOverlayPlan(result), [result]);
  const candidates = useMemo(() => plan.filter((entry) => !entry.rejectionReason), [plan]);
  const [fitted, setFitted] = useState({ result: null, widths: {} });
  useLayoutEffect(() => {
    const element = root.current;
    if (!element) return;
    let disposed = false;
    const measure = () => {
      if (disposed) return;
      const widths = {};
      const zoom = Math.max(0.05, pageScale);
      for (const node of element.querySelectorAll("[data-vision-measure]")) {
        const block = candidates.find((b) => b.key === node.dataset.visionMeasure);
        const height = element.clientHeight * (block.bbox[3] - block.bbox[1]) / 1000;
        const width = element.clientWidth * (block.bbox[2] - block.bbox[0]) / 1000;
        const start = Math.min((block.kind === "title" ? 30 : block.kind === "heading" ? 23 : 19) * zoom, height / 1.45);
        const minimum = 12 * zoom;
        node.style.width = `${width}px`;
        for (let size = start; size >= minimum - 0.01; size -= 0.5 * zoom) {
          node.style.fontSize = `${size}px`;
          if (node.getBoundingClientRect().height <= height + 0.5 && node.scrollHeight <= Math.ceil(height) && node.scrollWidth <= Math.ceil(width)) { widths[block.key] = size; break; }
        }
      }
      setFitted({ result, widths });
      const statuses = plan.map((entry) => ({ id: entry.id, blockIndex: entry.blockIndex, overlayStatus: widths[entry.key] ? "covered" : "rejected", rejectionReason: entry.rejectionReason || (widths[entry.key] ? "" : "译文在当前段落空白内排不下，保留原图") }));
      onCoverage?.({ covered: Object.keys(widths).length, total: plan.length, blocks: statuses });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    document.fonts?.ready.then(() => { if (!disposed) measure(); });
    return () => { disposed = true; observer.disconnect(); };
  }, [result, plan, candidates, onCoverage, pageScale]);
  return <div ref={root} className="pdf-vision-translation-layer" aria-label="视觉段落译文覆盖">
    {candidates.map((block) => {
      const size = fitted.result === result ? fitted.widths[block.key] : null;
      const style = { left: `${block.bbox[0] / 10}%`, top: `${block.bbox[1] / 10}%`, width: `${(block.bbox[2] - block.bbox[0]) / 10}%`, height: `${(block.bbox[3] - block.bbox[1]) / 10}%` };
      return <div key={block.key}>
        <div data-vision-measure={block.key} className={`pdf-vision-cover-copy pdf-vision-measure is-${block.kind}`} aria-hidden="true">{block.translation}</div>
        {size ? <div className={`pdf-vision-cover pdf-vision-cover-copy is-${block.kind}`} style={{ ...style, fontSize: `${size}px` }}>{block.translation}</div> : null}
      </div>;
    })}
  </div>;
}
