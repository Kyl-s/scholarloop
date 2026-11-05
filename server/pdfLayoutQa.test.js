import assert from "node:assert/strict";
import test from "node:test";
import {
  detectLayoutIssues,
  detectReferenceRegion,
  isReferenceHeadingLine,
  looksLikeReferenceLine,
  summarizeLayoutIssues
} from "./pdfLayoutQa.js";

function line(text, y, x0 = 80, x1 = 520) {
  return { text, x0, y0: y, x1, y1: y + 12 };
}

// 源页行：size 可省略以模拟扫描版抽取结果。
function sourceLine(text, y, x0, size = 10, extra = {}) {
  return { text, x0, y0: y, x1: 504, y1: y + 9.5, size, ...extra };
}

/** 3 条带悬挂缩进的文献条目（每条 1 首行 + 2 续行）。 */
function referenceSourceLines({ heading = null, numbers = [1, 2, 3], startY = 92 } = {}) {
  const lines = [];
  if (heading) {
    lines.push(sourceLine(heading, 72.8, 108, 12, { flags: 20, y1: 83.6 }));
  }
  let y = startY;
  for (const number of numbers) {
    lines.push(sourceLine(`[${number}] A. Author, B. Writer, and C. Editor. Reference title ${number}.`, y, 108));
    lines.push(sourceLine("Proceedings of the International Conference on Robotics, 2020.", y + 10.9, 129.6));
    lines.push(sourceLine("Additional venue details and page numbers, 2020.", y + 21.8, 129.6));
    y += 43.6;
  }
  return { lines, lastEntryY1: y - 43.6 + 21.8 + 9.5 };
}


test("recognizes bibliography entry shapes", () => {
  const refs = [
    "[60] S. Srivastava, E. Fang, L. Riano, R. Zhang, and P. Abbeel. Learning to combine",
    "Twenty-Fourth International Joint Conference on Artifi-",
    "Twenty-Fourth AAAI Conference on Artificial Intelligence, 2010.",
    "Advances in Neural Information Processing Systems, 2019.[71] N. Savinov, A. Dosovitskiy",
    "载于第 64 届AAAI 人工智能会议研讨会, 2010.[60] S. Srivastava, E. Fang",
    "[59] L. P. Kaelbling and T. Lozano-P´erez. Hierarchical planning in the now. In Workshops at the",
    "N. Savinov、A. Dosovitskiy、V. Koltun. Semi-parametric topological memory for navigation.",
    "J. Oh, S. Singh, H. Lee, and P. Kohli. Zero-shot task generalization with multi-task deep RL.",
    "https://arxiv.org/abs/1803.00653"
  ];
  for (const text of refs) {
    assert.equal(looksLikeReferenceLine(text), true, text);
  }
  const prose = [
    "We also assume that we are given a set of skills where each skill performs a short task.",
    "In this paper, we propose a new method for robot manipulation using large language models.",
    "The robot receives the reward of 1.0 at the end of the episode if it was successful.",
    "3 S SayCan: Do As I Can"
  ];
  for (const text of prose) {
    assert.equal(looksLikeReferenceLine(text), false, text);
  }
});

test("detects References headings on both language variants", () => {
  assert.equal(isReferenceHeadingLine("References"), true);
  assert.equal(isReferenceHeadingLine("6 References"), true);
  assert.equal(isReferenceHeadingLine("6. References"), true);
  assert.equal(isReferenceHeadingLine("参考文献"), true);
  assert.equal(isReferenceHeadingLine("參考文獻"), true);
  assert.equal(isReferenceHeadingLine("参考文"), true);
  assert.equal(isReferenceHeadingLine("Reference frames in robotics"), false);
  assert.equal(isReferenceHeadingLine("参考文献管理工具"), false);
});

test("excludes bibliography lines from untranslated in both CJK and non-CJK branches", () => {
  const lines = [
    // 非 CJK 分支：页 16 真实报出的 5 处
    line("[60] S. Srivastava, E. Fang, L. Riano, R. Zhang, and P. Abbeel. Learning to combine", 100),
    line("Twenty-Fourth International Joint Conference on Artifi-", 114),
    line("Advances in Neural Information Processing Systems, 2019.[71] N. Savinov, A. Dosovitskiy", 128),
    // CJK 分支：参考文献里混入的中文标点/连接词
    line("[56] P. Goyal, S. Niekum, and R. Mooney. Pixl2r：通过将像素映射为奖励，利用自然语", 142),
    line("载于第 64 届AAAI 人工智能会议研讨会, 2010.[60] S. Srivastava, E. Fang", 156)
  ];
  const issues = detectLayoutIssues(lines, { pageWidth: 612, pageHeight: 792 });
  assert.equal(issues.untranslated.length, 0);
  // 其他检测不受影响
  assert.deepEqual(summarizeLayoutIssues(issues).counts.outOfBounds, 0);
});

test("still reports genuinely untranslated body lines around references", () => {
  const issues = detectLayoutIssues([
    line("We also assume that we are given a set of skills where each skill performs a short task.", 100),
    line("这是中文说明，We also assume that we are given a set of skills where each skill", 114),
    line("[60] S. Srivastava, E. Fang, L. Riano, R. Zhang, and P. Abbeel. Learning to combine", 128)
  ], { pageWidth: 612, pageHeight: 792 });
  assert.equal(issues.untranslated.length, 2);
  assert.equal(issues.untranslated[0].kind, "untranslated");
});

test("reference heading suppresses untranslated after it but keeps latex checks", () => {
  const issues = detectLayoutIssues([
    line("本文介绍了一种新的机器人规划方法，并在多个任务上进行了验证。", 80),
    line("References", 100),
    line("This sentence stays in English without any reference marker at all and is long enough to count", 114),
    line("\\alpha + \\beta symbols left by the translator", 128)
  ], { pageWidth: 612, pageHeight: 792 });
  assert.equal(issues.untranslated.length, 0);
  assert.equal(issues.latex.length, 1);
});

test("detects a reference region from the References heading and geometry", () => {
  const { lines, lastEntryY1 } = referenceSourceLines({ heading: "References" });
  const region = detectReferenceRegion(lines);
  assert.equal(region?.reason, "heading");
  assert.ok(Math.abs(region.start - 78.6) < 0.01, `start=${region.start}`);
  assert.ok(Math.abs(region.end - (lastEntryY1 + 5)) < 0.01, `end=${region.end}`);
});

test("detects a headingless continuation page by entry/hanging/size fingerprints", () => {
  const { lines, lastEntryY1 } = referenceSourceLines({ numbers: [17, 18, 19], startY: 74.4 });
  const region = detectReferenceRegion(lines);
  assert.equal(region?.reason, "continuation");
  // 无标题时从第一条文献起算，避免把页眉/无关行吞进区域。
  assert.ok(Math.abs(region.start - (74.4 - 5)) < 0.01, `start=${region.start}`);
  assert.ok(Math.abs(region.end - (lastEntryY1 + 5)) < 0.01, `end=${region.end}`);
});

test("rejects appendix pages with a 12pt heading but no numbered entries", () => {
  const appendix = [
    sourceLine("A Version Control", 72.8, 108, 12, { flags: 20 }),
    sourceLine("v1 to v2: Added PaLM results and study about new capabilities.", 91.5, 108),
    sourceLine("B Contributions", 142.4, 108, 12, { flags: 20 }),
    sourceLine("Designed and built distributed robot learning infrastructure.", 178.6, 135.4),
    sourceLine("Brohan, Noah Brown, Yevgen Chebotar, Byron David, Chuyuan Fu", 189.6, 143.9)
  ];
  assert.equal(detectReferenceRegion(appendix), null);
});

test("falls back to the text heuristic when source lines have no font size", () => {
  const { lines } = referenceSourceLines({ heading: "References" });
  const noSize = lines.map(({ text, x0, y0, x1, y1 }) => ({ text, x0, y0, x1, y1 }));
  assert.equal(detectReferenceRegion(noSize), null);
  const dest = [
    line("[60] S. Srivastava, E. Fang, L. Riano, R. Zhang, and P. Abbeel. Learning to combine", 100),
    line("Twenty-Fourth International Joint Conference on Artifi-", 114),
    line("Advances in Neural Information Processing Systems, 2019.[71] N. Savinov", 128),
    line("[59] L. P. Kaelbling and T. Lozano-P´erez. Hierarchical planning in the now.", 142),
    line("[58] A. Author and B. Writer. Another reference entry with enough words here.", 156)
  ];
  const issues = detectLayoutIssues(dest, { pageWidth: 612, pageHeight: 792, sourceLines: noSize });
  assert.equal(issues.untranslated.length, 0);
});

test("only the detected region is suppressed, body text below it still reports", () => {
  const { lines: sourceLines } = referenceSourceLines({ heading: "References" });
  const dest = [
    line("References", 80, 108, 200),
    line("[60] S. Srivastava, E. Fang, L. Riano, R. Zhang, and P. Abbeel. Learning to combine", 100, 108),
    // 区域外（end≈215）的正文：行首是 [12]，但整行仍是中英混杂的未翻译正文。
    line("[12] 我们假设每个技能执行一个简短任务，We also assume that we are given a set of skills where each skill performs a short task.", 400, 108)
  ];
  const withRegion = detectLayoutIssues(dest, { pageWidth: 612, pageHeight: 792, sourceLines });
  assert.equal(withRegion.untranslated.length, 1);
  assert.match(withRegion.untranslated[0].text, /We also assume/);
  // 没有源页几何时的旧正则路径会因 References 标题整页抑制（说明区域判定确实收窄了范围）。
  const withoutRegion = detectLayoutIssues(dest, { pageWidth: 612, pageHeight: 792 });
  assert.equal(withoutRegion.untranslated.length, 0);
});

test("ignore boxes hide stamped front-matter english from untranslated and overlap checks", () => {
  const title = line("Grounding Language in Robotic Affordances with Large Language Models", 100);
  const body = line("We also assume that we are given a set of skills where each skill performs a short task.", 200);
  const ignoreBoxes = [{ x0: 70, y0: 90, x1: 530, y1: 120 }];
  const withBox = detectLayoutIssues([title, body], { pageWidth: 612, pageHeight: 792, ignoreBoxes });
  // 标题行（>=40 字符、>=6 词）本会判 untranslated，落进 ignoreBox 后不再计数。
  assert.equal(withBox.untranslated.length, 1);
  assert.match(withBox.untranslated[0].text, /We also assume/);
  const withoutBox = detectLayoutIssues([title, body], { pageWidth: 612, pageHeight: 792 });
  assert.equal(withoutBox.untranslated.length, 2);

  // overlap 两端都在 ignoreBox 内时不报；框外同一对行仍然报。
  const overlayA = { text: "First overlay line inside the front matter region", x0: 80, y0: 100, x1: 520, y1: 112 };
  const overlayB = { text: "Second overlay line inside the front matter region", x0: 80, y0: 104, x1: 520, y1: 116 };
  assert.equal(detectLayoutIssues([overlayA, overlayB], { pageWidth: 612, pageHeight: 792 }).overlap.length, 1);
  assert.equal(detectLayoutIssues([overlayA, overlayB], {
    pageWidth: 612,
    pageHeight: 792,
    ignoreBoxes
  }).overlap.length, 0);

  // outOfBounds 不因 ignoreBox 被排除。
  const outOfPage = { text: "Out of bounds line", x0: 500, y0: 100, x1: 700, y1: 112 };
  const outOfBounds = detectLayoutIssues([outOfPage], {
    pageWidth: 612,
    pageHeight: 792,
    ignoreBoxes: [{ x0: 70, y0: 90, x1: 730, y1: 120 }]
  });
  assert.equal(outOfBounds.outOfBounds.length, 1);
});

test("reference-heavy continuation pages are treated as bibliography lists", () => {
  const refs = Array.from({ length: 5 }, (_, i) => (
    line(`[${60 + i}] A. Author, B. Writer, and C. Editor. Reference title number ${i}, 2020.`, 100 + i * 14)
  ));
  const continuation = detectLayoutIssues([
    ...refs,
    // 比例 5/6 ≥ 0.6：整页按文献续页处理
    line("This line has no marker but belongs to the same reference continuation page block", 100 + 5 * 14)
  ], { pageWidth: 612, pageHeight: 792 });
  assert.equal(continuation.untranslated.length, 0);

  const mixedPage = detectLayoutIssues([
    ...refs.slice(0, 3),
    line("We also assume that we are given a set of skills where each skill performs a short task.", 200),
    line("The robot receives the reward of 1.0 at the end of the episode if it was successful today.", 214),
    line("This corresponds to the task-grounding function that scores which skills are useful now.", 228)
  ], { pageWidth: 612, pageHeight: 792 });
  // 3/6 = 0.5 < 0.6，正文行仍要报
  assert.ok(mixedPage.untranslated.length >= 2);
});
