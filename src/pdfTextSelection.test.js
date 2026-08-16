import test from "node:test";
import assert from "node:assert/strict";
import { isPdfSelectionOverlayTarget, orderPdfTextLayerForSelection, pickSelectionAnchorRect, sortPdfTextLayerBoxes, usesNativePdfSelection } from "./pdfTextSelection.js";

test("anchors the translation popover on the last visible selection line", () => {
  const last = pickSelectionAnchorRect(
    [
      { left: 10, top: 10, width: 80, height: 12 },
      { left: 10, top: 28, width: 40, height: 12 }
    ],
    { left: 10, top: 10, width: 80, height: 30 }
  );
  assert.deepEqual(last, { left: 10, top: 28, width: 40, height: 12 });
});

test("ignores empty client rects when choosing a selection anchor", () => {
  const fallback = { left: 0, top: 0, width: 10, height: 10 };
  assert.equal(
    pickSelectionAnchorRect([{ left: 0, top: 0, width: 0, height: 0 }], fallback),
    fallback
  );
});

test("ignores mouse events that originate from the translation popover", () => {
  const popover = { classList: { contains: (name) => name === "pdf-selection-popover" } };
  const button = { closest: (selector) => selector.includes("pdf-selection-popover") ? popover : null };
  const pageText = { closest: () => null };
  assert.equal(isPdfSelectionOverlayTarget(button), true);
  assert.equal(isPdfSelectionOverlayTarget(pageText), false);
});

test("sorts text-layer boxes into visual reading order", () => {
  const ordered = sortPdfTextLayerBoxes([
    { top: 53.3, left: 8.8, text: "摘要" },
    { top: 5.0, left: 8.8, text: "文章" },
    { top: 19.5, left: 31.0, text: "5" },
    { top: 19.6, left: 8.8, text: "Nir Grossman" }
  ]);
  assert.deepEqual(ordered.map((item) => item.text), ["文章", "Nir Grossman", "5", "摘要"]);
});

test("reorders a text layer so later stamped author spans come before the abstract", () => {
  const kids = [];
  const makeSpan = (top, left, text) => ({
    tagName: "SPAN",
    classList: { contains: () => false },
    style: { top: `${top}%`, left: `${left}%` },
    textContent: text,
    after(node) {
      const index = kids.indexOf(this);
      kids.splice(index + 1, 0, node);
    }
  });
  const abstract = makeSpan(53.3, 8.8, "摘要");
  const title = makeSpan(5, 8.8, "文章");
  const author = makeSpan(19.6, 8.8, "Nir");
  kids.push(abstract, title, author);
  const layer = {
    children: kids,
    ownerDocument: {
      createElement: (tag) => ({
        tagName: tag.toUpperCase(),
        setAttribute() {},
        after() {}
      })
    },
    querySelector(selector) {
      return selector.includes("endOfContent") ? null : null;
    },
    querySelectorAll(selector) {
      if (selector.includes("markedContent") || selector.includes("br")) return [];
      return [];
    },
    append(node) {
      const index = kids.indexOf(node);
      if (index >= 0) kids.splice(index, 1);
      kids.push(node);
    }
  };
  const count = orderPdfTextLayerForSelection(layer);
  assert.equal(count, 3);
  assert.deepEqual(
    kids.filter((node) => node.tagName === "SPAN").map((node) => node.textContent),
    ["文章", "Nir", "摘要"]
  );
});

test("treats Chromium 148+ as having native PDF selection", () => {
  assert.equal(
    usesNativePdfSelection({ navigator: { userAgent: "Mozilla/5.0 Chrome/148.0.0.0" } }),
    true
  );
  assert.equal(
    usesNativePdfSelection({ navigator: { userAgent: "Mozilla/5.0 Chrome/140.0.0.0" } }),
    false
  );
});
