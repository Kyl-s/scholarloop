import test from "node:test";
import assert from "node:assert/strict";
import { buildPdfTextLayout, extractReadablePdfText } from "./pdfText.js";

test("orders PDF text by its visible top-to-bottom line positions", () => {
  const items = [
    { str: "Abstract", transform: [10, 0, 0, 10, 20, 620] },
    { str: "English title", transform: [10, 0, 0, 10, 20, 680] },
    { str: "中文标题", transform: [10, 0, 0, 10, 20, 760] }
  ];
  assert.equal(extractReadablePdfText(items), "中文标题\nEnglish title\nAbstract");
});

test("keeps one visible line together in left-to-right order", () => {
  const items = [
    { str: "Technology", transform: [10, 0, 0, 10, 180, 500] },
    { str: "Journal", transform: [10, 0, 0, 10, 20, 500] },
    { str: "大学", transform: [10, 0, 0, 10, 70, 450] },
    { str: "河北工业", transform: [10, 0, 0, 10, 20, 450] }
  ];
  assert.equal(extractReadablePdfText(items), "Journal Technology\n河北工业大学");
});

test("keeps independent PDF columns in reading order instead of merging them by baseline", () => {
  const items = [
    { str: "Article title", width: 120, transform: [10, 0, 0, 10, 40, 760] },
    { str: "Left column first sentence.", width: 150, transform: [10, 0, 0, 10, 40, 700] },
    { str: "Right column first sentence.", width: 160, transform: [10, 0, 0, 10, 340, 700] },
    { str: "Left column second sentence.", width: 160, transform: [10, 0, 0, 10, 40, 680] },
    { str: "Right column second sentence.", width: 170, transform: [10, 0, 0, 10, 340, 680] }
  ];

  assert.equal(
    extractReadablePdfText(items),
    "Article title\nLeft column first sentence.\nLeft column second sentence.\nRight column first sentence.\nRight column second sentence."
  );
});

test("builds percentage text boxes without changing the page geometry", () => {
  const layout = buildPdfTextLayout([
    { str: "Title", width: 40, transform: [10, 0, 0, 10, 20, 760] },
    { str: "Body", width: 30, transform: [10, 0, 0, 10, 20, 700] }
  ], { transform: [1, 0, 0, -1, 0, 800], width: 600, height: 800 });

  assert.equal(layout.length, 2);
  assert.equal(layout[0].text, "Title");
  assert.equal(layout[0].left, 3.3333333333333335);
  assert.equal(layout[0].top, 3.9375);
  assert.equal(layout[0].width > 0, true);
  assert.equal(layout[0].height > 0, true);
});
