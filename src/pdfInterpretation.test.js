import test from "node:test";
import assert from "node:assert/strict";
import { createSavedInterpretation, interpretationStorageKey, normalizeSavedInterpretation } from "./pdfInterpretation.js";

test("保存完整 AI 解读时保留结构化结果、追问和元信息", () => {
  const saved = createSavedInterpretation({
    result: {
      oneSentence: "方法提高了定位精度。",
      method: "控制线圈电流比。",
      evidence: [{ page: 3, label: "图 2 · 第 3 页" }]
    },
    meta: { mode: "full", usedChars: 1234, pageCoverage: "1-3" },
    followups: [{ id: "q1", q: "图 2 说明什么？", a: "说明聚焦区域可调。", status: "done", evidence: [] }],
    savedAt: "2026-08-11T00:00:00.000Z"
  });

  assert.equal(saved.mode, "full");
  assert.equal(saved.usedChars, 1234);
  assert.equal(saved.result.method, "控制线圈电流比。");
  assert.equal(saved.followups[0].q, "图 2 说明什么？");
  assert.equal(saved.config, undefined);
  assert.equal(normalizeSavedInterpretation(saved).result.oneSentence, "方法提高了定位精度。");
});

test("临时 PDF 使用稳定的本机存储键并能恢复解读", () => {
  const key = interpretationStorageKey({ doi: "10.1000/test paper" });
  assert.equal(key, "scholarloop.pdf.interpretation.10.1000%2Ftest%20paper");
  const restored = normalizeSavedInterpretation({
    mode: "quick",
    result: { oneSentence: "已保存" },
    followups: [],
    savedAt: "2026-08-11"
  });
  assert.equal(restored.result.oneSentence, "已保存");
});
