import test from "node:test";
import assert from "node:assert/strict";
import { normalizeSavedInterpretation } from "./store.js";

test("server persistence keeps the full interpretation but drops unrelated config", () => {
  const saved = normalizeSavedInterpretation({
    mode: "full",
    usedChars: 2400,
    pageCoverage: "1-3",
    config: { apiKey: "should-not-persist", password: "should-not-persist" },
    result: {
      oneSentence: "完整结论",
      method: "方法细节",
      findings: "实验发现",
      evidence: [{ page: 3, label: "第 3 页", reason: "结果页", quote: "target result" }]
    },
    followups: [{ id: "q1", q: "图 2 说明什么？", a: "说明结果", status: "done", evidence: [{ page: 3, label: "第 3 页" }] }]
  });

  assert.equal(saved.config, undefined);
  assert.equal(saved.result.method, "方法细节");
  assert.equal(saved.followups[0].a, "说明结果");
  assert.deepEqual(saved.result.evidence, [{ page: 3, label: "第 3 页", reason: "结果页", quote: "target result" }]);
});
