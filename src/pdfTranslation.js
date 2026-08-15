export function normalizePdfSelection(value, maxLength = 4000) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length < 2) return "";
  return text.slice(0, maxLength);
}

export function normalizedSelectionAnchor(selectionRect, surfaceRect) {
  if (!selectionRect || !surfaceRect || surfaceRect.width <= 0 || surfaceRect.height <= 0) return null;
  const x = ((selectionRect.left + selectionRect.width / 2 - surfaceRect.left) / surfaceRect.width) * 100;
  const y = ((selectionRect.bottom - surfaceRect.top) / surfaceRect.height) * 100;
  return {
    x: Math.min(92, Math.max(8, x)),
    y: Math.min(94, Math.max(2, y))
  };
}
