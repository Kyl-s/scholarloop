/**
 * PDF 文字层选区：沿用 pdf.js TextLayerBuilder 的协议。
 * span 是绝对定位，浏览器按 DOM 顺序延展选区时会闪、会偏；
 * 拖选时用 .endOfContent + .selecting 挡住尚未经过的 span。
 */

export function pickSelectionAnchorRect(rects, fallback) {
  const list = Array.from(rects || []).filter((rect) => rect && rect.width > 0 && rect.height > 0);
  return list.at(-1) || fallback || null;
}

/** 点在翻译气泡/译文卡片上时，不要当成新的 PDF 选区 */
export function isPdfSelectionOverlayTarget(target) {
  return Boolean(target?.closest?.(".pdf-selection-popover, .pdf-selection-translation-card"));
}

export function usesNativePdfSelection(win = globalThis, probeEl = null) {
  const nav = win.navigator;
  if (!nav) return false;
  if (probeEl && win.getComputedStyle) {
    try {
      if (win.getComputedStyle(probeEl).getPropertyValue("-moz-user-select") === "none") {
        return true;
      }
    } catch {
      /* 非浏览器或节点未挂载 */
    }
  }
  const chromiumVersion = nav.userAgentData
    ? nav.userAgentData.brands?.find((item) => item.brand === "Chromium")?.version
    : /\bChrome\/(\d+)\b/.exec(nav.userAgent || "")?.[1];
  return !!chromiumVersion && Number.parseInt(chromiumVersion, 10) >= 148;
}

export function resolvePdfSelectionAnchorNode(range, prevRange) {
  if (!range) return null;
  const modifyStart = Boolean(
    prevRange
    && (range.compareBoundaryPoints(Range.END_TO_END, prevRange) === 0
      || range.compareBoundaryPoints(Range.START_TO_END, prevRange) === 0)
  );
  let anchor = modifyStart ? range.startContainer : range.endContainer;
  if (anchor?.nodeType === Node.TEXT_NODE) anchor = anchor.parentNode;
  if (anchor?.classList?.contains("highlight")) anchor = anchor.parentNode;
  if (!modifyStart && range.endOffset === 0 && anchor) {
    do {
      while (anchor && !anchor.previousSibling) anchor = anchor.parentNode;
      anchor = anchor?.previousSibling || null;
    } while (anchor && !anchor.childNodes?.length);
  }
  return { anchor, modifyStart };
}

export function repositionPdfSelectionEnd(textLayer, endDiv, range, prevRange) {
  const resolved = resolvePdfSelectionAnchorNode(range, prevRange);
  const anchor = resolved?.anchor;
  if (!anchor || !textLayer?.contains(anchor)) return false;
  const parentTextLayer = anchor.parentElement?.closest(".textLayer");
  if (parentTextLayer !== textLayer) return false;
  endDiv.style.width = textLayer.style.width;
  endDiv.style.height = textLayer.style.height;
  endDiv.style.userSelect = "text";
  anchor.parentElement.insertBefore(endDiv, resolved.modifyStart ? anchor : anchor.nextSibling);
  return true;
}

export function attachPdfTextLayerSelection(textLayer, { onSelectionStart } = {}) {
  if (!textLayer) return () => {};

  let endOfContent = textLayer.querySelector(":scope > .endOfContent");
  if (!endOfContent) {
    endOfContent = document.createElement("div");
    endOfContent.className = "endOfContent";
    textLayer.append(endOfContent);
  }

  const abort = new AbortController();
  const { signal } = abort;
  let isPointerDown = false;
  let prevRange = null;
  let nativeSelection = null;

  const reset = () => {
    if (!endOfContent.isConnected) textLayer.append(endOfContent);
    else if (endOfContent.parentNode !== textLayer) textLayer.append(endOfContent);
    endOfContent.style.width = "";
    endOfContent.style.height = "";
    endOfContent.style.userSelect = "";
    textLayer.classList.remove("selecting");
  };

  textLayer.addEventListener("mousedown", (event) => {
    if (event.button !== 0) return;
    textLayer.classList.add("selecting");
    onSelectionStart?.();
  }, { signal });

  document.addEventListener("pointerdown", () => {
    isPointerDown = true;
  }, { signal });

  document.addEventListener("pointerup", () => {
    isPointerDown = false;
    reset();
  }, { signal });

  window.addEventListener("blur", () => {
    isPointerDown = false;
    reset();
  }, { signal });

  document.addEventListener("keyup", () => {
    if (!isPointerDown) reset();
  }, { signal });

  document.addEventListener("selectionchange", () => {
    const selection = document.getSelection();
    if (!selection || selection.rangeCount < 1 || selection.isCollapsed) {
      if (!isPointerDown) reset();
      return;
    }
    const range = selection.getRangeAt(0);
    if (!range.intersectsNode(textLayer)) {
      reset();
      return;
    }
    textLayer.classList.add("selecting");
    nativeSelection ??= usesNativePdfSelection(window, endOfContent);
    if (!nativeSelection) {
      repositionPdfSelectionEnd(textLayer, endOfContent, range, prevRange);
    }
    try {
      prevRange = range.cloneRange();
    } catch {
      prevRange = null;
    }
  }, { signal });

  return () => {
    abort.abort();
    reset();
    endOfContent.remove();
  };
}
