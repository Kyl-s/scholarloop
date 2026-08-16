import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  classifyPreserveLine,
  collectFormulaLeakBoxes,
  collectPreserveBoxes,
  isAffiliationLine,
  isAuthorLine,
  isFormulaLikeLine,
  isMetaLine,
  resolvePreservePython,
  restorePreservedRegions
} from "./pdfPreserveRegions.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test("classifies author names, labs, and correspondence", () => {
  assert.equal(classifyPreserveLine("Nir Grossman,1,2,3,4 David Bono,5 Nina Dedic,7,16"), "author");
  assert.equal(classifyPreserveLine("and Edward S. Boyden1,2,11,12,13,14,17,*"), "author");
  assert.equal(isAuthorLine("Nir Grossman, David Bono, Nina Dedic, ...,"), true);
  assert.equal(isAffiliationLine("1Media Lab, MIT, Cambridge, MA 02139, USA"), true);
  assert.equal(isAffiliationLine("5Department of Materials Science and Engineering, MIT, Cambridge, MA 02139, USA"), true);
  assert.equal(isMetaLine("*Correspondence: esb@media.mit.edu"), true);
  assert.equal(isMetaLine("16These authors contributed equally"), true);
  assert.equal(isMetaLine("http://dx.doi.org/10.1016/j.cell.2017.05.024"), true);
  assert.equal(classifyPreserveLine("SUMMARY"), "body-stop");
  assert.equal(classifyPreserveLine("In Brief"), "body-stop");
  assert.equal(classifyPreserveLine("Highlights"), "body-stop");
  assert.equal(classifyPreserveLine("Authors"), "keep-heading");
  assert.equal(
    isAuthorLine("Cell 169, 1029–1041, June 1, 2017 © 2017 The Authors. Published by Elsevier Inc."),
    false
  );
  assert.equal(
    isMetaLine("This is an open access article under the CC BY license (http://creativecommons.org/licenses/by/4.0/)."),
    false
  );
});

test("does not treat abstract prose as an author line", () => {
  assert.equal(isAuthorLine("We report a noninvasive strategy for electrically stimulating neurons at depth."), false);
  assert.equal(classifyPreserveLine("We report a noninvasive strategy for electrically stimulating neurons at depth."), "other");
});

test("collects the Cell first-text-page author block and stops at SUMMARY", () => {
  const lines = [
    { text: "Noninvasive Deep Brain Stimulation", x0: 53, y0: 100, x1: 360, y1: 120 },
    { text: "Nir Grossman,1,2,3,4 David Bono,5 Nina Dedic,7,16", x0: 53, y0: 150, x1: 537, y1: 162 },
    { text: "and Edward S. Boyden1,2,11,12,13,14,17,*", x0: 53, y0: 172, x1: 210, y1: 182 },
    { text: "1Media Lab, MIT, Cambridge, MA 02139, USA", x0: 53, y0: 183, x1: 217, y1: 192 },
    { text: "2McGovern Institute for Brain Research, MIT, Cambridge, MA 02139, USA", x0: 53, y0: 193, x1: 316, y1: 202 },
    { text: "Harvard Medical School, Boston, MA 02215, USA", x0: 53, y0: 213, x1: 230, y1: 221 },
    { text: "15Harvard-MIT Division of Health Sciences and Technology, MIT, Cambridge, MA 02139, USA", x0: 53, y0: 223, x1: 386, y1: 232 },
    { text: "16These authors contributed equally", x0: 53, y0: 242, x1: 181, y1: 251 },
    { text: "*Correspondence: esb@media.mit.edu", x0: 53, y0: 263, x1: 190, y1: 271 },
    { text: "http://dx.doi.org/10.1016/j.cell.2017.05.024", x0: 55, y0: 273, x1: 209, y1: 281 },
    { text: "SUMMARY", x0: 53, y0: 418, x1: 98, y1: 427 },
    { text: "We report a noninvasive strategy for electrically stim-", x0: 53, y0: 439, x1: 292, y1: 449 }
  ];
  const boxes = collectPreserveBoxes(lines);
  assert.equal(boxes.length, 1);
  assert.equal(boxes[0].reason, "author-block");
  assert.ok(boxes[0].y0 < 150);
  assert.ok(boxes[0].y1 > 280);
  assert.ok(boxes[0].y1 < 418);
});

test("keeps the Cell first-page Authors sidebar and excludes In Brief", () => {
  const lines = [
    { text: "Authors", x0: 355, y0: 152, x1: 398, y1: 164 },
    { text: "Nir Grossman, David Bono, Nina Dedic, ...,", x0: 355, y0: 170, x1: 543, y1: 180 },
    { text: "Edward S. Boyden", x0: 355, y0: 197, x1: 440, y1: 207 },
    { text: "Correspondence", x0: 355, y0: 224, x1: 447, y1: 236 },
    { text: "esb@media.mit.edu", x0: 355, y0: 240, x1: 445, y1: 250 },
    { text: "In Brief", x0: 355, y0: 265, x1: 394, y1: 277 },
    { text: "A noninvasive method for deep-brain", x0: 355, y0: 283, x1: 526, y1: 293 }
  ];
  const boxes = collectPreserveBoxes(lines);
  assert.equal(boxes.length, 1);
  assert.equal(boxes[0].reason, "author-block");
  assert.ok(boxes[0].y1 < 265);
  assert.ok(boxes[0].y1 > 248);
});

test("marks leaked formula lines for restore", () => {
  assert.equal(isFormulaLikeLine("E1(x, y) = A sin(2πf1 t)"), true);
  assert.equal(isFormulaLikeLine("We report a noninvasive strategy."), false);
  const leaks = collectFormulaLeakBoxes(
    [{ text: "E1(x, y) = A sin(2πf1 t)", x0: 80, y0: 200, x1: 240, y1: 212 }],
    [{ text: "E1(x, y) 等于振幅正弦", x0: 80, y0: 201, x1: 240, y1: 213 }]
  );
  assert.equal(leaks.length, 1);
  assert.equal(leaks[0].reason, "formula-leak");
});

test("academic prompt forbids translating author blocks and formulas", async () => {
  const { ACADEMIC_ZH_SYSTEM_PROMPT, buildTextTranslateSystemPrompt } = await import("./translationQuality.js");
  assert.match(ACADEMIC_ZH_SYSTEM_PROMPT, /author names|affiliations|laboratory/i);
  assert.match(ACADEMIC_ZH_SYSTEM_PROMPT, /formulae|equations/i);
  const textPrompt = buildTextTranslateSystemPrompt();
  assert.match(textPrompt, /作者姓名|单位\/实验室/);
  assert.match(textPrompt, /公式/);
});

test("stamps the Cell author block back onto the translated page", () => {
  const py = resolvePreservePython();
  if (!py) {
    return;
  }
  const source = path.join(
    __dirname,
    "..",
    "data",
    "pdf-translations",
    "b261bcd1-f82a-48ef-92ec-fb3925fd3701",
    "source.pdf"
  );
  const mono = path.join(
    __dirname,
    "..",
    "data",
    "pdf-translations",
    "b261bcd1-f82a-48ef-92ec-fb3925fd3701",
    "output",
    "page-002.zh.mono.pdf"
  );
  if (!fs.existsSync(source) || !fs.existsSync(mono)) {
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scholarloop-preserve-"));
  const dest = path.join(dir, "page-002.zh.mono.pdf");
  try {
    fs.copyFileSync(mono, dest);
    const result = restorePreservedRegions({
      sourcePdf: source,
      destPdf: dest,
      page: 2,
      kind: "mono"
    });
    assert.equal(result.ok, true);
    assert.ok(result.restored >= 1);
    const dumped = spawnSync(py.cmd, [
      ...py.extra,
      "-c",
      "import fitz,sys; d=fitz.open(sys.argv[1]); t=d[0].get_text('text'); print(t)",
      dest
    ], { encoding: "utf8", env: { ...process.env, ...py.env }, timeout: 20000, windowsHide: true });
    assert.equal(dumped.status, 0);
    const text = dumped.stdout;
    assert.match(text, /Nir Grossman/);
    assert.match(text, /Media Lab, MIT/);
    assert.doesNotMatch(text, /尼爾|格羅斯曼|麻省理工学院媒体实验室/);
    assert.match(text, /摘要|我们报道/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
