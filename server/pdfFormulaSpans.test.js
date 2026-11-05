import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  buildFormulaRuns,
  collectFormulaSpanBoxes,
  matchFormulaRuns,
  normalizeFormulaText,
  shouldSuppressFormulaLeak
} from "./pdfFormulaSpans.js";
import {
  collectFormulaLeakBoxes,
  extractPdfPageLines,
  resolvePreservePython
} from "./pdfPreserveRegions.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const JOB_ID = "82811601-7806-4efd-86fa-57ee7228543b";
const JOB_DIR = path.join(__dirname, "..", "data", "pdf-translations", JOB_ID);
const MATH_FONT_RE = /^(?:(?!CMTT)CM[A-Z]{1,4}|MS[AB]M|MSAM|EUSM|EURM|EUFM|RSFS)\d*$/;
const CJK_RE = /[\u3400-\u9fff]/;
const MATH_WORD_RE = /^(?:argmax|argmin|arg|max|min|log|exp|sin|cos|tan|lim|det|inf|sup|mod|sgn)$/i;

function mkSpan(text, font, {
  x0 = 0,
  y0 = 0,
  x1 = 10,
  y1 = 10,
  size = 10,
  chars = null
} = {}) {
  return {
    text,
    font,
    size,
    flags: 0,
    x0,
    y0,
    x1,
    y1,
    originX: x0,
    originY: y1,
    ...(chars ? { chars } : {})
  };
}

function mathSpan(text, x0, x1, y0 = 100, y1 = 112, font = "CMMI10") {
  return mkSpan(text, font, { x0, y0, x1, y1 });
}

function proseSpan(text, x0, x1, y0 = 100, y1 = 112, font = "NimbusRomNo9L-Regu") {
  return mkSpan(text, font, { x0, y0, x1, y1 });
}

function fixturePage(page) {
  if (!resolvePreservePython()) return null;
  const jobPath = path.join(JOB_DIR, "job.json");
  if (!fs.existsSync(jobPath)) return null;
  const job = JSON.parse(fs.readFileSync(jobPath, "utf8"));
  const state = (job.pages || []).find((item) => Number(item.page) === Number(page));
  if (!state?.monoFile) return null;
  const sourcePdf = path.join(JOB_DIR, "source.pdf");
  const monoPdf = path.join(JOB_DIR, "output", state.monoFile);
  if (!fs.existsSync(sourcePdf) || !fs.existsSync(monoPdf)) return null;
  return {
    source: extractPdfPageLines(sourcePdf, page, { chars: true }),
    dest: extractPdfPageLines(monoPdf, 1),
    sourcePdf,
    monoPdf,
    state
  };
}

function countProseCharsInClip(sourcePage, clip) {
  let count = 0;
  for (const line of sourcePage.lines || []) {
    for (const span of line.spans || []) {
      const font = String(span.font || "");
      for (const ch of span.chars || []) {
        const cx = (Number(ch.x0) + Number(ch.x1)) / 2;
        const cy = (Number(ch.y0) + Number(ch.y1)) / 2;
        if (cx < clip.x0 || cx > clip.x1 || cy < clip.y0 || cy > clip.y1) continue;
        const text = String(ch.c || "");
        if (!/[A-Za-z0-9]/.test(text)) continue;
        if (MATH_FONT_RE.test(font)) continue;
        if (MATH_WORD_RE.test(text)) continue;
        count += 1;
      }
    }
  }
  return count;
}

test("builds a formula run from math spans and excludes surrounding prose", () => {
  const line = {
    text: "the value p(W)=n is",
    spans: [
      proseSpan("the value ", 10, 80),
      mathSpan("p", 80, 90),
      mathSpan("(", 90, 94, 100, 112, "CMR10"),
      mathSpan("W", 94, 104),
      mathSpan(")", 104, 108, 100, 112, "CMR10"),
      mathSpan("=", 108, 116, 100, 112, "CMR10"),
      mathSpan("n", 116, 122),
      proseSpan(" is", 122, 135)
    ]
  };
  const runs = buildFormulaRuns(line);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].key, "p(W)=n");
  assert.equal(runs[0].mathSpans, 6);
  assert.equal(runs[0].hasOp, true);
  assert.ok(runs[0].x0 >= 80 && runs[0].x1 <= 122);
});

test("rejects urls, cmtt fonts, citations, and isolated single variables", () => {
  assert.equal(normalizeFormulaText(" a − b ∼ c "), "a-b~c");
  // CMTT 是等宽正文/URL 字体，不能当公式。
  assert.equal(buildFormulaRuns({
    text: "http://example.com/x=1",
    spans: [mkSpan("http://example.com/x=1", "CMTT10", { x0: 10, x1: 150 })]
  }).length, 0);
  assert.equal(buildFormulaRuns({
    text: "[12]",
    spans: [mkSpan("[12]", "CMR10", { x0: 10, x1: 40 })]
  }).length, 0);
  assert.equal(buildFormulaRuns({
    text: "x",
    spans: [mkSpan("x", "CMMI10", { x0: 10, x1: 18 })]
  }).length, 0);
  assert.equal(buildFormulaRuns({
    text: "xy",
    spans: [mkSpan("xy", "CMMI10", { x0: 10, x1: 26 })]
  }).length, 0);
});

test("merges arg max math words rendered in a prose serif font", () => {
  const line = {
    text: "the best is arg max p",
    spans: [
      proseSpan("the best is ", 10, 70),
      mkSpan(" arg max", "Noto Serif Regular", { x0: 70, x1: 120 }),
      mathSpan("p", 120, 128),
      mathSpan("(", 128, 132, 100, 112, "CMR10"),
      mathSpan("x", 132, 140),
      mathSpan(")", 140, 144, 100, 112, "CMR10")
    ]
  };
  const runs = buildFormulaRuns(line);
  assert.equal(runs.length, 1);
  assert.ok(runs[0].key.startsWith("argmaxp("), runs[0].key);
});

test("matches exact keys and trims a source run to the matched substring", () => {
  const source = [{
    text: "LTD(θ)=e(s,a)+x",
    spans: [
      mathSpan("L", 100, 106),
      mathSpan("T", 106, 112),
      mathSpan("D", 112, 118),
      mathSpan("(", 118, 122, 100, 112, "CMR10"),
      mathSpan("θ", 122, 128),
      mathSpan(")", 128, 132, 100, 112, "CMR10"),
      mathSpan("=", 132, 140, 100, 112, "CMR10"),
      mathSpan("e", 140, 146),
      mathSpan("(s,a)+x", 146, 200)
    ]
  }];
  const dest = [{
    text: "(θ)=e(s,a)+x",
    spans: [
      mathSpan("(", 120, 124, 100, 112, "CMR10"),
      mathSpan("θ", 124, 130),
      mathSpan(")", 130, 134, 100, 112, "CMR10"),
      mathSpan("=", 134, 142, 100, 112, "CMR10"),
      mathSpan("e", 142, 148),
      mathSpan("(s,a)+x", 148, 205)
    ]
  }];
  const matches = matchFormulaRuns(source, dest);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].destRuns.length, 1);
  assert.ok(matches[0].coverage > 0.75 && matches[0].coverage < 0.98, String(matches[0].coverage));
  assert.deepEqual(matches[0].trim, [3, 0]);
  assert.ok(matches[0].srcClip.x0 >= 118, "srcClip must be cropped past the L_TD prefix");
});

test("matches exact formula runs and rejects far-away lines", () => {
  const source = [
    {
      text: "p(W)",
      spans: [
        mathSpan("p", 100, 108),
        mathSpan("(", 108, 112, 100, 112, "CMR10"),
        mathSpan("W", 112, 122),
        mathSpan(")", 122, 126, 100, 112, "CMR10")
      ]
    },
    {
      text: "Q",
      spans: [
        mathSpan("Q", 300, 308),
        mathSpan("π", 308, 314),
        mathSpan("(", 314, 318, 100, 112, "CMR10"),
        mathSpan("s,a", 318, 340),
        mathSpan(")", 340, 344, 100, 112, "CMR10")
      ]
    }
  ];
  const dest = [
    {
      text: "中文 p(W) 译文",
      x0: 10,
      y0: 100,
      x1: 120,
      y1: 112,
      spans: [
        proseSpan("中文 ", 10, 40, 100, 112),
        mathSpan("p", 40, 48, 100, 112),
        mathSpan("(", 48, 52, 100, 112, "CMR10"),
        mathSpan("W", 52, 62, 100, 112),
        mathSpan(")", 62, 66, 100, 112, "CMR10")
      ]
    },
    { text: "远处", x0: 300, y0: 500, x1: 340, y1: 512, spans: [proseSpan("远处", 300, 340, 500, 512)] }
  ];
  const matches = matchFormulaRuns(source, dest);
  assert.equal(matches.length, 2);
  assert.equal(matches[0].destRuns.length, 1);
  assert.equal(matches[0].coverage, 1);
  assert.equal(matches[1].destRuns.length, 0);
});

test("does not stamp exact formulas that merely share a line with Chinese", () => {
  const source = [{ text: "a+b", spans: [mathSpan("a+b", 100, 150, 100, 112)] }];
  const dest = [{
    text: "中文 a+b 译文",
    spans: [proseSpan("中文 ", 300, 340, 100, 112), mathSpan("a+b", 100, 150, 100, 112)]
  }];
  const boxes = collectFormulaSpanBoxes({ sourceLines: source, destLines: dest, kind: "mono", sourceWidth: 612 });
  assert.equal(boxes.length, 0, "exact formula kept in a CJK line must not be stamped");
});

test("triggers when the destination formula run itself contains CJK or LaTeX", () => {
  const source = [{ text: "a+公式", spans: [mathSpan("a+公式", 100, 150, 100, 112)] }];
  const dest = [{
    text: "中文 a+公式 译文",
    spans: [proseSpan("中文 ", 300, 340, 100, 112), mathSpan("a+公式", 100, 150, 100, 112)]
  }];
  const boxes = collectFormulaSpanBoxes({ sourceLines: source, destLines: dest, kind: "mono", sourceWidth: 612 });
  assert.equal(boxes.length, 1);
  assert.ok(CJK_RE.test(String(boxes[0].key)));
});

test("triggers on broken coverage and merges safe overlapping runs", () => {
  const source = [
    { text: "a+b!", spans: [mathSpan("a+b!", 100, 155, 100, 112)] },
    { text: "c+d!", spans: [mathSpan("c+d!", 140, 195, 105, 117)] }
  ];
  const dest = [
    {
      text: "中文 a+b 译文",
      spans: [proseSpan("中文 ", 300, 340, 100, 112), mathSpan("a+b", 100, 150, 100, 112)]
    },
    {
      text: "中文 c+d 译文",
      spans: [proseSpan("中文 ", 300, 340, 105, 117), mathSpan("c+d", 140, 190, 105, 117)]
    }
  ];
  const boxes = collectFormulaSpanBoxes({ sourceLines: source, destLines: dest, kind: "mono", sourceWidth: 612 });
  assert.equal(boxes.length, 1, "overlapping broken runs merge into one union box");
  assert.ok(boxes[0].merged);
  assert.equal(boxes[0].keys.length, 2);

  // 并集里若出现不属于成员 run 的汉字（中心在并集内），必须拒绝合并。
  const withForeign = [
    ...dest,
    { text: "函数", spans: [proseSpan("函数", 120, 170, 112, 126, "Source Han Serif CN Regu")] }
  ];
  const split = collectFormulaSpanBoxes({ sourceLines: source, destLines: withForeign, kind: "mono", sourceWidth: 612 });
  assert.equal(split.length, 2, "foreign CJK inside the union must prevent merging");
});

test("dual formula-span boxes stay in source coordinates", () => {
  const source = [{ text: "a+b!", spans: [mathSpan("a+b!", 100, 155)] }];
  const dest = [{
    text: "中文 a+b 译文",
    x0: 712,
    y0: 100,
    x1: 950,
    y1: 112,
    spans: [
      proseSpan("中文 ", 912, 950, 100, 112),
      mathSpan("a+b", 712, 762, 100, 112)
    ]
  }];
  const boxes = collectFormulaSpanBoxes({ sourceLines: source, destLines: dest, kind: "dual", sourceWidth: 612 });
  assert.equal(boxes.length, 1);
  assert.ok(Math.abs(boxes[0].destX0 - 99.85) < 0.5, String(boxes[0].destX0));
  assert.ok(boxes[0].x1 < 612, "box must be mapped back into source coordinates");
});

test("stage 1 suppresses formula leaks when every run matches exactly without CJK", () => {
  const source = {
    text: "p(W)",
    spans: [
      mathSpan("p", 100, 108),
      mathSpan("(", 108, 112, 100, 112, "CMR10"),
      mathSpan("W", 112, 122),
      mathSpan(")", 122, 126, 100, 112, "CMR10")
    ]
  };
  const dest = {
    text: "中文 p(W) 译文",
    x0: 10,
    y0: 100,
    x1: 100,
    y1: 112,
    spans: [
      proseSpan("中文 ", 10, 40),
      mathSpan("p", 40, 48),
      mathSpan("(", 48, 52, 100, 112, "CMR10"),
      mathSpan("W", 52, 62),
      mathSpan(")", 62, 66, 100, 112, "CMR10")
    ]
  };
  const matches = matchFormulaRuns([source], [dest]);
  assert.equal(shouldSuppressFormulaLeak(source, matches), true);
  assert.equal(shouldSuppressFormulaLeak(source, [{ ...matches[0], coverage: 0.9 }]), false);
  assert.equal(shouldSuppressFormulaLeak(source, []), false);
  // 没有 span 明细的旧测试行不做门控。
  assert.equal(shouldSuppressFormulaLeak({ text: "p(W)", x0: 100, y0: 100, x1: 140, y1: 112 }, matches), false);
});

test("records formula-no-anchor for mixed prose lines but not pure formula lines", () => {
  const mixed = {
    text: "where the loss is L(θ)=E[r] and the model learns",
    spans: [
      proseSpan("where the loss is ", 10, 100),
      mathSpan("L", 100, 108),
      mathSpan("(θ)=E[r]", 108, 160),
      proseSpan(" and the model learns", 160, 260)
    ]
  };
  const pure = {
    text: "L(θ)=E[r]",
    spans: [mathSpan("L", 100, 108), mathSpan("(θ)=E[r]", 108, 160)]
  };
  const diagnostics = [];
  const boxes = collectFormulaSpanBoxes({
    sourceLines: [mixed, pure],
    destLines: [],
    kind: "mono",
    sourceWidth: 612,
    diagnostics
  });
  assert.equal(boxes.length, 0);
  assert.equal(diagnostics.filter((item) => item.reason === "formula-no-anchor").length, 1);
  assert.match(diagnostics[0].sourceText, /where the loss/);
});

test("real page 2: 7/7 runs match exactly and source clips contain no prose", () => {
  const fixture = fixturePage(2);
  if (!fixture) return;
  const matches = matchFormulaRuns(fixture.source.lines, fixture.dest.lines);
  assert.equal(matches.length, 7);
  assert.equal(matches.filter((match) => match.destRuns.length).length, 7);
  for (const match of matches) {
    assert.equal(match.coverage, 1, match.sourceRun.key);
    assert.ok(match.srcClip, match.sourceRun.key);
    assert.equal(countProseCharsInClip(fixture.source, match.srcClip), 0, match.sourceRun.key);
  }
  // 公式完整保留、只是与中文同行：不再生成 formula-span 框。
  const boxes = collectFormulaSpanBoxes({
    sourceLines: fixture.source.lines,
    destLines: fixture.dest.lines,
    kind: "mono",
    sourceWidth: fixture.source.width
  });
  assert.equal(boxes.length, 0);
  // Stage 1：该页公式全部精确匹配，不再生成整行 formula-leak 框。
  assert.equal(collectFormulaLeakBoxes(fixture.source.lines, fixture.dest.lines).length, 0);
});

test("real page 3: L_TD is cropped to the matched substring instead of stamped twice", () => {
  const fixture = fixturePage(3);
  if (!fixture) return;
  const matches = matchFormulaRuns(fixture.source.lines, fixture.dest.lines);
  const lt = matches.find((match) => String(match.sourceRun.key).toLowerCase().startsWith("ltd("));
  assert.ok(lt, "L_TD run must match the split translation");
  assert.ok(lt.coverage > 0.75 && lt.coverage < 0.98, String(lt.coverage));
  assert.deepEqual(lt.trim, [3, 0]);
  assert.ok(lt.srcClip.x0 > lt.sourceRun.x0 + 10, "srcClip must drop the L_TD prefix");
  const boxes = collectFormulaSpanBoxes({
    sourceLines: fixture.source.lines,
    destLines: fixture.dest.lines,
    kind: "mono",
    sourceWidth: fixture.source.width
  });
  const trimmed = boxes.find((box) => String(box.key).toLowerCase().startsWith("(θ)=e(s,a,s"));
  assert.ok(trimmed, "trimmed L_TD span box must exist");
  assert.ok(!String(trimmed.key).toLowerCase().includes("ltd"), "trimmed box must not carry L_TD");
  // 收紧触发条件后，r2/r3 本身精确匹配，不再生成合并框；L_TD 区域只应有一个框。
  const merged = boxes.find((box) => {
    const key = String(box.key).toLowerCase();
    return key.includes("θ(s',a*)-qπ") && key.includes("θ(s,a)]");
  });
  assert.equal(merged, undefined, "exact r2/r3 runs must not be stamped again");
  assert.equal(boxes.filter((box) => Number(box.y0) < 135).length, 1,
    "L_TD region must have exactly one trimmed box, not a union with r2/r3");
});

test("real page 4: the inline arg-max formula matches exactly", () => {
  const fixture = fixturePage(4);
  if (!fixture) return;
  const matches = matchFormulaRuns(fixture.source.lines, fixture.dest.lines);
  assert.equal(matches.filter((match) => match.destRuns.length).length, 9);
  const argmax = matches.find((match) => String(match.sourceRun.key).startsWith("ℓπ=argmax"));
  assert.ok(argmax);
  assert.equal(argmax.coverage, 1);
  assert.ok(argmax.destRuns[0].lineText.includes("最优技能"), "anchor must sit inside the Chinese prose line");
  const boxes = collectFormulaSpanBoxes({
    sourceLines: fixture.source.lines,
    destLines: fixture.dest.lines,
    kind: "mono",
    sourceWidth: fixture.source.width
  });
  const box = boxes.find((item) => String(item.key).startsWith("ℓπ=argmax"));
  assert.equal(box, undefined, "complete formula on a CJK line must not be stamped again");
});
