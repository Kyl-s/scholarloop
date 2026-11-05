import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  boxAllowsChineseOverlap,
  buildPreservePythonEnv,
  chineseLineBelongsToBox,
  classifyPreserveLine,
  collectEquationRegionBoxes,
  collectFormulaLeakBoxes,
  collectFormulaSpanBoxes,
  collectFrontMatterBox,
  collectPreserveBoxes,
  countUntranslatedClusters,
  extractPdfPageLines,
  isAffiliationLine,
  isAuthorLine,
  isFormulaLikeLine,
  isMetaLine,
  isPureFormulaSourceLine,
  isSectionHeadingLine,
  isUntranslatedBodyLine,
  matchFormulaRuns,
  resolvePreservePython,
  restorePreservedRegions
} from "./pdfPreserveRegions.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const JOB_ID = "82811601-7806-4efd-86fa-57ee7228543b";

function loadJobPage(pageNo) {
  const jobDir = path.join(__dirname, "..", "data", "pdf-translations", JOB_ID);
  const jobPath = path.join(jobDir, "job.json");
  if (!fs.existsSync(jobPath)) return null;
  const job = JSON.parse(fs.readFileSync(jobPath, "utf8"));
  const state = (job.pages || []).find((item) => Number(item.page) === Number(pageNo));
  if (!state?.monoFile) return null;
  const sourcePdf = path.join(jobDir, "source.pdf");
  const monoPdf = path.join(jobDir, "output", state.monoFile);
  if (!fs.existsSync(sourcePdf) || !fs.existsSync(monoPdf)) return null;
  return { jobDir, state, sourcePdf, monoPdf };
}

function countCjkChars(pageData) {
  let count = 0;
  for (const line of pageData?.lines || []) {
    for (const span of line.spans || []) {
      for (const ch of span.chars || []) {
        if (/[\u3400-\u9fff]/.test(String(ch.c || ""))) count += 1;
      }
    }
  }
  return count;
}

function normalizedPageText(pageData) {
  const table = { "−": "-", "∼": "~", "∗": "*", "′": "'", "″": '"', "–": "-", "—": "-" };
  return String((pageData?.lines || []).map((line) => line.text).join(""))
    .replace(/[−∼∗′″–—]/g, (ch) => table[ch] || ch)
    .replace(/\s+/g, "");
}

function countNormalizedKey(pageData, key) {
  const text = normalizedPageText(pageData);
  const needle = String(key).replace(/[−∼∗′″–—]/g, (ch) => ({
    "−": "-", "∼": "~", "∗": "*", "′": "'", "″": '"', "–": "-", "—": "-"
  }[ch] || ch)).replace(/\s+/g, "");
  if (!needle) return 0;
  let count = 0;
  let index = 0;
  while ((index = text.indexOf(needle, index)) !== -1) {
    count += 1;
    index += needle.length;
  }
  return count;
}

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
  const authorBoxes = boxes.filter((box) => box.reason === "author-block");
  // 工作区刻意改成逐行返回：跨行 union 矩形会覆盖行间重排的中文正文，
  // 只要有一条中文行相交就会整块跳过；逐行框让作者行各自回贴、互不牵连。
  assert.equal(authorBoxes.length, 9);
  assert.equal(boxes.length, 9);
  for (const box of authorBoxes) {
    assert.equal(box.reason, "author-block");
    assert.ok(box.y1 - box.y0 < 20, "each box covers a single source line");
  }
  assert.ok(Math.min(...authorBoxes.map((box) => box.y0)) < 150);
  assert.ok(Math.max(...authorBoxes.map((box) => box.y1)) > 280);
  // SUMMARY 是 body-stop，作者块到此为止；标题行也不在框内。
  assert.ok(Math.max(...authorBoxes.map((box) => box.y1)) < 418);
  assert.ok(authorBoxes.every((box) => box.y0 >= 140));
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
  const authorBoxes = boxes.filter((box) => box.reason === "author-block");
  // 同样按行返回：Authors 标题、两行作者、Correspondence、邮箱各一个框。
  assert.equal(authorBoxes.length, 5);
  for (const box of authorBoxes) {
    assert.ok(box.y1 - box.y0 < 20, "each box covers a single source line");
  }
  assert.ok(Math.min(...authorBoxes.map((box) => box.y0)) >= 150);
  // In Brief 是 body-stop，侧栏作者块到此为止。
  assert.ok(Math.max(...authorBoxes.map((box) => box.y1)) < 265);
  assert.ok(Math.max(...authorBoxes.map((box) => box.y1)) > 248);
});

test("collects the first-page title and author block into a single front-matter box", () => {
  const lines = [
    // 左侧竖排 arXiv 水印：x0 小于页宽 12%，必须排除。
    { text: "arXiv:2204.01691v2 [cs.RO] 1 Apr 2022", x0: 10, y0: 40, x1: 38, y1: 260, size: 8 },
    { text: "Do As I Can, Not As I Say: Grounding Language in Robotic Affordances", x0: 90, y0: 83, x1: 520, y1: 101, size: 17 },
    { text: "Grounding Language in Robotic Affordances", x0: 90, y0: 103, x1: 470, y1: 121, size: 17 },
    { text: "Michael Ahn, Anthony Brohan, Noah Brown, Yevgen Chebotar", x0: 90, y0: 128, x1: 520, y1: 140, size: 10 },
    { text: "and Karol Hausman", x0: 90, y0: 143, x1: 300, y1: 155, size: 10 },
    { text: "1Robotics at Google, Mountain View, CA 94043, USA", x0: 90, y0: 165, x1: 480, y1: 177, size: 9 },
    { text: "Abstract: Large language models can be used to plan robot behavior from instructions.", x0: 90, y0: 210, x1: 520, y1: 222, size: 11 },
    { text: "Large language models can be used to plan robot behavior from instructions.", x0: 90, y0: 226, x1: 520, y1: 238, size: 10 }
  ];
  const box = collectFrontMatterBox(lines, { pageWidth: 612, pageHeight: 792 });
  assert.ok(box, "front matter must be detected");
  assert.equal(box.reason, "front-matter");
  // 覆盖标题到机构行（pad 2）
  assert.ok(box.x0 <= 88 && box.x0 > 38, "watermark must stay outside the box");
  assert.ok(box.y0 <= 83 && box.y0 > 40);
  assert.ok(box.y1 >= 177 && box.y1 < 210, "abstract heading must stay outside the box");
  assert.equal(box.sourceText, "Do As I Can, Not As I Say: Grounding Language in Robotic Affordances");
  // 没有标题起点时保持旧行为
  const noTitle = lines.filter((line) => line.y0 >= 128);
  assert.equal(collectFrontMatterBox(noTitle, { pageWidth: 612, pageHeight: 792 }), null);
});

test("merges the first-page author lines into the front-matter box", () => {
  const lines = [
    { text: "arXiv:2204.01691v2 [cs.RO] 1 Apr 2022", x0: 10, y0: 40, x1: 38, y1: 260, size: 8 },
    { text: "Do As I Can, Not As I Say: Grounding Language in Robotic Affordances", x0: 90, y0: 83, x1: 520, y1: 101, size: 17 },
    { text: "Michael Ahn, Anthony Brohan, Noah Brown, Yevgen Chebotar", x0: 90, y0: 128, x1: 520, y1: 140, size: 10 },
    { text: "and Karol Hausman", x0: 90, y0: 143, x1: 300, y1: 155, size: 10 },
    { text: "1Robotics at Google, Mountain View, CA 94043, USA", x0: 90, y0: 165, x1: 480, y1: 177, size: 9 },
    { text: "Abstract", x0: 90, y0: 210, x1: 150, y1: 222, size: 11 }
  ];
  const boxes = collectPreserveBoxes(lines, { frontMatter: true, pageWidth: 612, pageHeight: 792 });
  const frontBoxes = boxes.filter((box) => box.reason === "front-matter");
  assert.equal(frontBoxes.length, 1);
  assert.deepEqual(boxes, frontBoxes, "author/affiliation boxes inside front matter must be dropped");
  // 默认（第 2 页起）行为不变：逐行 author-block 仍然生成
  const legacy = collectPreserveBoxes(lines, { pageWidth: 612, pageHeight: 792 });
  assert.equal(legacy.filter((box) => box.reason === "front-matter").length, 0);
  assert.ok(legacy.some((box) => box.reason === "author-block"));
});

test("front-matter boxes may overwrite their own chinese translations", () => {
  assert.equal(boxAllowsChineseOverlap({ reason: "front-matter" }), true);
  assert.equal(boxAllowsChineseOverlap({ reason: "author-block" }), false);
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
  // 源文本随框返回，供回贴 guard 判断是否为纯公式行。
  assert.equal(leaks[0].sourceText, "E1(x, y) = A sin(2πf1 t)");
});

test("only pure formula source lines may overwrite their chinese translation", () => {
  // 散文+公式混排行（第 2 页真实文本）：整行回贴会把中文译文换成英文。
  assert.equal(isPureFormulaSourceLine("W = {w0, w1, w2, ..., wn}, a sequence of strings w"), false);
  assert.equal(isPureFormulaSourceLine("j=0p(wj|w<j), such that each successive string"), false);
  assert.equal(isPureFormulaSourceLine("M = (S, A, P, R, γ), where S and A are state and action sets"), false);
  // 纯公式行：字母以变量/数学函数为主，没有连续英文单词。
  assert.equal(isPureFormulaSourceLine("LT D(θ) = E(s,a,s′∼D [R(s, a) + γEa∗∼πQπ"), true);
  assert.equal(isPureFormulaSourceLine("E1(x, y) = A sin(2πf1 t)"), true);
  assert.equal(isPureFormulaSourceLine("θ (s′, a′) −Qπ"), true);
  assert.equal(isPureFormulaSourceLine("p(cπ|s, ℓπ) ∝ p(cπ|s) p(ℓπ|i)"), true);
  // 中文译文自身不是纯公式源行
  assert.equal(isPureFormulaSourceLine("其中 D 是状态和动作的数据集"), false);
});

test("only vision equations and pure formula boxes may overwrite chinese lines", () => {
  const proseSource = "W = {w0, w1, w2, ..., wn}, a sequence of strings w";
  const pureSource = "LT D(θ) = E(s,a,s′∼D [R(s, a) + γEa∗∼πQπ";
  assert.equal(boxAllowsChineseOverlap({ reason: "formula", sourceText: pureSource }), true);
  assert.equal(boxAllowsChineseOverlap({ reason: "formula", sourceText: proseSource }), false);
  // 视觉模型明确标记的 equation 区域不依赖源行文本
  assert.equal(boxAllowsChineseOverlap({ reason: "vision-equation", sourceText: proseSource }), true);
  // 混排泄漏框保持原有「相交即跳过」，不覆盖整句中文
  assert.equal(boxAllowsChineseOverlap({ reason: "formula-leak", sourceText: pureSource }), false);
  assert.equal(boxAllowsChineseOverlap({ reason: "latex-leak", sourceText: pureSource }), false);
  assert.equal(boxAllowsChineseOverlap({ reason: "author-block" }), false);
});

test("does not classify numbered section titles as author lines", () => {
  const title = "3 SayCan: Do As I Can, Not As I Say";
  assert.equal(isSectionHeadingLine(title), true);
  assert.equal(isAuthorLine(title), false);
  assert.equal(classifyPreserveLine(title), "heading");
  // 数字开头的正文句子仍不是标题
  assert.equal(isSectionHeadingLine("3 orders of magnitude better than the baseline in every setting"), false);
});

test("treats long math-dense prose+formula lines as formula-like", () => {
  const mixed = "where the TD loss, an approximate dynamic programming approach for learning the value function along trajectories, is L_{TD}(θ) = E_{(s,a,s′)∼D}[R(s,a) + γE_{a∗∼π}Q_θ(s′,a∗) − Q_θ(s,a)]";
  assert.ok(mixed.length > 160);
  assert.equal(isFormulaLikeLine(mixed), true);
  const prose = "We also assume that we are given a set of skills where each skill performs a short task in the environment described by the natural language instruction provided by the user.";
  assert.ok(prose.length > 160);
  assert.equal(isFormulaLikeLine(prose), false);
});

test("formula leak detection tolerates reflowed translations but not other columns", () => {
  const src = { text: "E1(x, y) = A sin(2πf1 t)", x0: 80, y0: 200, x1: 240, y1: 212 };
  // 译文行被重排下移：重叠不足 40%，但行中心落在源行 ±3pt 带内 → 命中
  const shifted = collectFormulaLeakBoxes(
    [src],
    [{ text: "E1(x, y) 等于振幅正弦", x0: 80, y0: 209, x1: 240, y1: 221 }]
  );
  assert.equal(shifted.length, 1);
  // 另一栏同一水平线上的中文行：水平无重叠 → 不命中
  const otherColumn = collectFormulaLeakBoxes(
    [src],
    [{ text: "右栏译文内容", x0: 300, y0: 200, x1: 450, y1: 212 }]
  );
  assert.equal(otherColumn.length, 0);
  // 远离源行的中文行：不命中
  const farAway = collectFormulaLeakBoxes(
    [src],
    [{ text: "远处的中文行", x0: 80, y0: 224, x1: 240, y1: 236 }]
  );
  assert.equal(farAway.length, 0);
});

test("maps vision equation regions onto source line boxes", () => {
  const sourceLines = [
    { text: "L_{TD}(θ) = E[R(s,a) + γQ]", x0: 80, y0: 100, x1: 300, y1: 112 },
    { text: "We now describe the SayCan approach.", x0: 80, y0: 130, x1: 300, y1: 142 },
    { text: "p(c_π|s, ℓ_π) ∝ p(c_π|s) p(ℓ_π|i) (2)", x0: 80, y0: 160, x1: 300, y1: 172 }
  ];
  const boxes = collectEquationRegionBoxes(sourceLines, [
    ["L_{TD}(θ) = E[R(s,a) + γQ]"],
    ["p(c_π|s, ℓ_π) ∝ p(c_π|s) p(ℓ_π|i)"]
  ]);
  assert.equal(boxes.length, 2);
  assert.ok(boxes.every((box) => box.reason === "vision-equation"));
  assert.ok(boxes[0].y1 < 130);
  assert.ok(boxes[1].y0 > 142);
  // 源文本里没有的行 → 空结果
  const missing = collectEquationRegionBoxes(sourceLines, [["Q(s′,a∗) = some unseen line"]]);
  assert.equal(missing.length, 0);
  assert.deepEqual(collectEquationRegionBoxes(sourceLines, []), []);
});

test("vision equation regions protect matched lines even when they read as prose", () => {
  const sourceLines = [
    { text: "where S and A are the state and action sets", x0: 80, y0: 100, x1: 300, y1: 112 },
    { text: "Nir Grossman, David Bono, Nina Dedic", x0: 80, y0: 130, x1: 300, y1: 142 }
  ];
  assert.equal(isFormulaLikeLine(sourceLines[0].text), false);
  const boxes = collectEquationRegionBoxes(sourceLines, [
    ["where S and A are the state and action sets"],
    ["Nir Grossman, David Bono, Nina Dedic"]
  ]);
  assert.equal(boxes.length, 1);
  assert.equal(boxes[0].reason, "vision-equation");
  assert.ok(boxes[0].y1 < 130);
});

test("tolerates chinese translations that belong to the preserved formula box", () => {
  const box = { x0: 100, y0: 100, x1: 300, y1: 112 };
  // 整体落在框内
  assert.equal(chineseLineBelongsToBox(box, { x0: 105, y0: 100, x1: 295, y1: 112 }), true);
  // 比框窄且水平中心在框内（译文略缩）
  assert.equal(chineseLineBelongsToBox(box, { x0: 120, y0: 101, x1: 250, y1: 113 }), true);
  // 宽度超过框宽 1.2 倍且中心在框外：明显越出框，仍要跳过
  assert.equal(chineseLineBelongsToBox(box, { x0: 250, y0: 100, x1: 520, y1: 112 }), false);
  // 垂直不相交
  assert.equal(chineseLineBelongsToBox(box, { x0: 105, y0: 200, x1: 295, y1: 212 }), false);
  // 只擦到下一行中文的顶边：垂直占比不足，跳过（SayCan 第 3 页真实形态，
  // 直接盖章会把「Q 函数的参数」整行 redaction 掉）
  const narrowBox = { x0: 286.56, y0: 115.94, x1: 347.17, y1: 131.1 };
  const adjacent = {
    text: "Q 函数的参数",
    x0: 108.05,
    y0: 127.37,
    x1: 174.32,
    y1: 141.02
  };
  assert.equal(chineseLineBelongsToBox(narrowBox, adjacent), false);
  // 公式与后文并成一行、框只覆盖行首公式片段：仍按越界处理，
  // 避免 redaction 裁掉公式字符后出现重复/缺字（已用第 3 页实测渲染确认）。
  const merged = {
    text: "θ (s, a)], 其中 D 是状态和动作的数据集，θ 是 Q 函数的参数",
    x0: 308.92,
    y0: 113.17,
    x1: 502.25,
    y1: 129.51
  };
  assert.equal(chineseLineBelongsToBox(narrowBox, merged), false);
});

test("counts clusters of untranslated English body lines", () => {
  assert.equal(isUntranslatedBodyLine("We also assume that we are given a set of skills where each skill performs a short task."), true);
  assert.equal(isUntranslatedBodyLine("在本工作中，我们利用基于 TD 的方法学习上述价值函数，该函数还以语言指令为附加条件。"), false);
  assert.equal(isUntranslatedBodyLine("A. Brohan et al. Do as I can not as i say grounding language in robotic affordances 2023."), false);
  assert.equal(isUntranslatedBodyLine("3 S SayCan: Do As I Can"), false);
  const lines = [
    { text: "在本工作中，我们利用基于 TD 的方法学习上述价值函数，并利用这些价值函数判断给定指令是否可行。", x0: 80, y0: 100, x1: 500, y1: 112 },
    { text: "We also assume that we are given a set of skills where each skill performs a short", x0: 80, y0: 130, x1: 500, y1: 142 },
    { text: "task in the environment and the natural language instruction provided by the user", x0: 80, y0: 144, x1: 500, y1: 156 },
    { text: "describes what the robot should do in that particular state of the world today", x0: 80, y0: 158, x1: 500, y1: 170 },
    { text: "将大型语言模型与机器人连接。大型语言模型虽然能够利用从海量文本中学到的丰富知识。", x0: 80, y0: 200, x1: 500, y1: 212 },
    { text: "This corresponds to the task-grounding function that scores which skills are useful", x0: 80, y0: 240, x1: 500, y1: 252 },
    { text: "for making progress towards completing the instruction given by the user here", x0: 80, y0: 254, x1: 500, y1: 266 }
  ];
  assert.equal(countUntranslatedClusters(lines), 2);
  // 单行不成簇
  assert.equal(countUntranslatedClusters([lines[1]]), 0);
  // 整页参考文献式的英文行（et al 过滤后只剩少量）不会算成散发漏译
  const refs = Array.from({ length: 10 }, (_, i) => ({
    text: `A. Author et al. Title of reference number ${i} journal series volume pages ${2000 + i}.`,
    x0: 80, y0: 100 + i * 14, x1: 500, y1: 112 + i * 14
  }));
  assert.equal(countUntranslatedClusters(refs), 0);
});

test("treats bibliography entries as already-english reference lines", () => {
  const refs = [
    "[60] S. Srivastava, E. Fang, L. Riano, R. Zhang, and P. Abbeel. Learning to combine",
    "Twenty-Fourth International Joint Conference on Artificial Intelligence, 2010.",
    "Advances in Neural Information Processing Systems, 2019.[71] N. Savinov, A. Dosovitskiy",
    "载于第 64 届AAAI 人工智能会议研讨会, 2010.[60] S. Srivastava, E. Fang",
    "[59] L. P. Kaelbling and T. Lozano-P´erez. Hierarchical planning in the now. In Workshops at the"
  ];
  for (const text of refs) {
    assert.equal(isUntranslatedBodyLine(text), false, text);
  }
  assert.equal(
    isUntranslatedBodyLine("We also assume that we are given a set of skills where each skill performs a short task."),
    true
  );
});

test("academic prompt forbids translating author blocks and formulas", async () => {
  const { ACADEMIC_ZH_SYSTEM_PROMPT, buildTextTranslateSystemPrompt } = await import("./translationQuality.js");
  assert.match(ACADEMIC_ZH_SYSTEM_PROMPT, /author names|affiliations|laboratory/i);
  assert.match(ACADEMIC_ZH_SYSTEM_PROMPT, /formulae|equations/i);
  const textPrompt = buildTextTranslateSystemPrompt();
  assert.match(textPrompt, /作者姓名|单位\/实验室/);
  assert.match(textPrompt, /公式/);
});

test("stamps the first-page title and author block as one front-matter box", () => {
  if (!resolvePreservePython()) return;
  const fixture = loadJobPage(1);
  if (!fixture) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scholarloop-front-matter-"));
  const dest = path.join(dir, fixture.state.monoFile);
  try {
    fs.copyFileSync(fixture.monoPdf, dest);
    const result = restorePreservedRegions({
      sourcePdf: fixture.sourcePdf,
      destPdf: dest,
      page: 1,
      kind: "mono",
      preserveFrontMatter: true
    });
    assert.equal(result.ok, true, result.reason);
    assert.equal(result.ignoreBoxes?.length, 1);
    assert.equal(result.ignoreBoxes[0].reason, "front-matter");
    assert.ok(result.restored >= 1);
    const joined = (result.destLines || []).map((line) => String(line.text || "")).join("\n");
    // 标题 + 作者整块回贴英文，BabelDOC 重排碎片（Juli/mont/L/Rett/Vi）被完整原文覆盖。
    assert.match(joined, /Do As I Can, Not As I Say/);
    assert.match(joined, /Dmitry Kalashnikov/);
    assert.match(joined, /Robotics at Google/);
    // 框只到机构行：摘要仍是中文。
    assert.match(joined, /摘要|大型语言模型/);
    // 汉字守卫：框内不应残留中文行（标题/作者区已被整块覆盖）。
    const box = result.ignoreBoxes[0];
    const cjkInside = (result.destLines || []).filter((line) => {
      const cx = (Number(line.x0) + Number(line.x1)) / 2;
      const cy = (Number(line.y0) + Number(line.y1)) / 2;
      return /[\u3400-\u9fff]/.test(String(line.text || ""))
        && cx >= box.x0 && cx <= box.x1 && cy >= box.y0 && cy <= box.y1;
    });
    assert.deepEqual(cjkInside, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
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
    ], { encoding: "utf8", env: buildPreservePythonEnv(py.env), timeout: 20000, windowsHide: true });
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

test("restores vision equation boxes into the dual translation column", () => {
  if (!resolvePreservePython()) {
    return;
  }
  const jobDir = path.join(
    __dirname,
    "..",
    "data",
    "pdf-translations",
    "82811601-7806-4efd-86fa-57ee7228543b"
  );
  const sourcePdf = path.join(jobDir, "source.pdf");
  const jobPath = path.join(jobDir, "job.json");
  if (!fs.existsSync(sourcePdf) || !fs.existsSync(jobPath)) {
    return;
  }
  const job = JSON.parse(fs.readFileSync(jobPath, "utf8"));
  const pageState = (job.pages || []).find((item) => Number(item.page) === 24);
  const dualPdf = pageState?.dualFile ? path.join(jobDir, "output", pageState.dualFile) : "";
  if (!dualPdf || !fs.existsSync(dualPdf)) {
    return;
  }
  const source = extractPdfPageLines(sourcePdf, 24);
  // 与 collectVisionEquationGroups 同形：equation 区域行号 → 源文本层行文本
  const groups = (pageState.assist?.context?.regions || [])
    .filter((region) => String(region?.kind) === "equation" && Number(region?.confidence) >= 0.7)
    .map((region) => (region.lineIndexes || [])
      .map((index) => source.lines?.[index]?.text || "")
      .filter(Boolean))
    .filter((group) => group.length);
  assert.ok(groups.length >= 1, "fixture must contain a persisted equation region");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scholarloop-preserve-dual-"));
  const dest = path.join(dir, "page-024.zh.dual.pdf");
  const englishInTranslationColumn = (page) => (page.lines || []).filter((line) => (
    Number(line.x0) >= source.width * 0.85
    && /^[\x20-\x7e]+$/.test(String(line.text))
    && /[A-Za-z]{3}/.test(String(line.text))
  )).length;
  try {
    fs.copyFileSync(dualPdf, dest);
    const before = extractPdfPageLines(dest, 1);
    assert.ok(before.width > source.width * 1.8, "fixture must be a dual page");
    const result = restorePreservedRegions({
      sourcePdf,
      destPdf: dest,
      page: 24,
      kind: "dual",
      equationTextGroups: groups
    });
    assert.equal(result.ok, true);
    const visionBoxes = (result.boxes || []).filter((box) => box.reason === "vision-equation");
    // dual 也必须收集 equation 区域框，且框保持源 PDF 坐标（偏移由 Python stamp_boxes 统一加 src_w）。
    assert.ok(visionBoxes.length >= 1, "dual must collect vision equation boxes");
    for (const box of visionBoxes) {
      assert.ok(box.x1 <= source.width, "vision box must stay in source coordinates");
    }
    assert.ok(result.restored >= 1);
    const after = extractPdfPageLines(dest, 1);
    // 盖章后译文栏出现源公式文本：证明框确实落到右栏而不是源栏。
    assert.ok(
      englishInTranslationColumn(after) > englishInTranslationColumn(before),
      "stamped equation content must land in the translation column"
    );
    for (const box of visionBoxes) {
      assert.ok(
        (after.lines || []).some((line) => (
          Number(line.x0) >= source.width * 0.85
          && Math.abs(Number(line.x0) - (Number(box.x0) + source.width)) <= 3
          && Math.abs(Number(line.y0) - Number(box.y0)) <= 3
        )),
        "each vision box must have translated-column content at x + src_w"
      );
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("does not re-stamp complete page-2 formula spans that share lines with Chinese", () => {
  if (!resolvePreservePython()) return;
  const fixture = loadJobPage(2);
  if (!fixture) return;
  const source = extractPdfPageLines(fixture.sourcePdf, 2, { chars: true });
  const destBefore = extractPdfPageLines(fixture.monoPdf, 1, { chars: true });
  const matches = matchFormulaRuns(source.lines, destBefore.lines);
  assert.equal(matches.length, 7, "page 2 must expose 7 source formula runs");
  assert.equal(matches.filter((match) => match.destRuns.length === 1 && match.coverage === 1).length, 7);
  assert.equal(collectFormulaLeakBoxes(source.lines, destBefore.lines).length, 0);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scholarloop-span-p2-"));
  const dest = path.join(dir, fixture.state.monoFile);
  try {
    fs.copyFileSync(fixture.monoPdf, dest);
    const result = restorePreservedRegions({
      sourcePdf: fixture.sourcePdf,
      destPdf: dest,
      page: 2,
      kind: "mono"
    });
    assert.equal(result.ok, true, result.reason);
    const spanBoxes = (result.boxes || []).filter((box) => box.reason === "formula-span");
    // 公式本来就完整：收紧触发条件后这里应为 0，不产生重影风险。
    assert.equal(spanBoxes.length, 0);
    assert.equal(result.restored, 0);
    assert.equal(result.reason, "none");
    assert.equal(result.span ?? null, null);
    const after = extractPdfPageLines(dest, 1, { chars: true });
    assert.equal(countCjkChars(after), countCjkChars(destBefore));
    assert.equal(countNormalizedKey(after, "p(W)=Πn"), 1);
    assert.equal(countNormalizedKey(after, "j=0p(wj|w<j)"), 1);
    assert.equal(countNormalizedKey(after, "W={w0,w1,w2,...,wn}"), 1);
    assert.equal(countNormalizedKey(after, "p(W)"), countNormalizedKey(destBefore, "p(W)"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("restores only the split L_TD run on page 3 without losing Chinese", () => {
  if (!resolvePreservePython()) return;
  const fixture = loadJobPage(3);
  if (!fixture) return;
  const source = extractPdfPageLines(fixture.sourcePdf, 3, { chars: true });
  const destBefore = extractPdfPageLines(fixture.monoPdf, 1, { chars: true });
  const boxes = collectFormulaSpanBoxes({
    sourceLines: source.lines,
    destLines: destBefore.lines,
    kind: "mono",
    sourceWidth: source.width
  });
  const trimmed = boxes.find((box) => String(box.key).toLowerCase().startsWith("(θ)=e(s,a,s"));
  const merged = boxes.find((box) => {
    const key = String(box.key).toLowerCase();
    return key.includes("θ(s',a*)-qπ") && key.includes("θ(s,a)]");
  });
  assert.ok(trimmed, "trimmed L_TD span box must exist");
  assert.equal(merged, undefined, "exact r2/r3 runs must not be stamped again");
  // L_TD 区域只能有一个裁剪框，不能 union 到下一行中文。
  assert.equal(boxes.filter((box) => Number(box.y0) < 135).length, 1);
  assert.equal(countNormalizedKey(destBefore, "LTD"), 1);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scholarloop-span-p3-"));
  const dest = path.join(dir, fixture.state.monoFile);
  try {
    fs.copyFileSync(fixture.monoPdf, dest);
    const result = restorePreservedRegions({
      sourcePdf: fixture.sourcePdf,
      destPdf: dest,
      page: 3,
      kind: "mono"
    });
    assert.equal(result.ok, true, result.reason);
    assert.equal((result.boxes || []).filter((box) => box.reason === "formula-span").length, 3);
    assert.equal(result.span?.cjkBefore, 1197);
    assert.equal(result.span?.cjkAfter, 1197);
    // 混排行无锚点时记录 formula-no-anchor 并跳过，而不是退回整行回贴。
    assert.ok((result.skipped || []).some((item) => (
      item.diagnostic === "formula-no-anchor" || item.reason === "formula-no-anchor"
    )));
    const after = extractPdfPageLines(dest, 1, { chars: true });
    assert.equal(countCjkChars(after), 1197);
    assert.equal(countNormalizedKey(after, "LTD"), 1, "L_TD must not be stamped twice");
    assert.equal(countNormalizedKey(after, "LTD"), countNormalizedKey(destBefore, "LTD"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("does not re-stamp the complete page-4 arg-max formula", () => {
  if (!resolvePreservePython()) return;
  const fixture = loadJobPage(4);
  if (!fixture) return;
  const destBefore = extractPdfPageLines(fixture.monoPdf, 1, { chars: true });
  assert.equal(countCjkChars(destBefore), 1074);
  assert.equal(countNormalizedKey(destBefore, "ℓπ=argmaxℓπ∈ℓΠp(ℓπ|i)"), 1);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scholarloop-span-p4-"));
  const dest = path.join(dir, fixture.state.monoFile);
  try {
    fs.copyFileSync(fixture.monoPdf, dest);
    const result = restorePreservedRegions({
      sourcePdf: fixture.sourcePdf,
      destPdf: dest,
      page: 4,
      kind: "mono"
    });
    assert.equal(result.ok, true, result.reason);
    const spanBoxes = (result.boxes || []).filter((box) => box.reason === "formula-span");
    // 公式完整保留、只是与中文同行：不生成 span 框。
    assert.equal(spanBoxes.length, 0);
    assert.equal(result.restored, 0);
    assert.equal(result.span ?? null, null);
    const after = extractPdfPageLines(dest, 1, { chars: true });
    assert.equal(countCjkChars(after), 1074);
    assert.equal(countNormalizedKey(after, "ℓπ=argmaxℓπ∈ℓΠp(ℓπ|i)"), 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("pure formula lines keep the legacy whole-line fallback when no span anchor exists", () => {
  const line = { text: "E1(x, y) = A sin(2πf1 t)", x0: 80, y0: 200, x1: 240, y1: 212 };
  const legacy = collectPreserveBoxes([line]);
  assert.equal(legacy.length, 1);
  assert.equal(legacy[0].reason, "formula");
  assert.equal(boxAllowsChineseOverlap(legacy[0]), true);
  const spanBoxes = collectFormulaSpanBoxes({
    sourceLines: [line],
    destLines: [],
    kind: "mono",
    sourceWidth: 612
  });
  assert.equal(spanBoxes.length, 0, "no dest anchor -> legacy box remains the fallback");
});


