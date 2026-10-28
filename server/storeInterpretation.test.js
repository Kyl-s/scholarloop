import test from "node:test";
import assert from "node:assert/strict";
import { normalizeSavedInterpretation } from "./store.js";

test("server persistence keeps the full interpretation but drops unrelated config", () => {
  const saved = normalizeSavedInterpretation({
    mode: "full",
    usedChars: 2400,
    pageCoverage: "1-3",
    config: { apiKey: "should-not-persist", password: "should-not-persist" },
    usage: { promptTokens: 900, completionTokens: 200, totalTokens: 1100, cachedTokens: 300 },
    model: "deepseek-chat",
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
  // usage / model 随解读一起保存，重启后用量条仍能显示
  assert.equal(saved.usage.totalTokens, 1100);
  assert.equal(saved.model, "deepseek-chat");
});

test("server persistence keeps guided reading progress with the plan", () => {
  const saved = normalizeSavedInterpretation({
    mode: "quick",
    result: {
      oneSentence: "方法提高了定位精度。",
      guidedSteps: [
        { id: "s1", title: "整体印象", question: "这篇文章研究什么？", hint: "先读摘要", pages: [1] },
        { id: "s2", title: "核心问题", question: "要解决什么问题？", pages: [1] }
      ]
    },
    guided: {
      plan: [
        { id: "s1", title: "整体印象", question: "这篇文章研究什么？", hint: "先读摘要", pages: [1] },
        { id: "s2", title: "核心问题", question: "要解决什么问题？", pages: [1] }
      ],
      index: 1,
      answers: {
        s1: {
          answer: "研究定位精度。",
          verdict: "good",
          feedback: "概括到位。",
          reference: "参考答案。",
          strengths: ["抓住了主线"],
          evidence: [{ page: 1, label: "第 1 页", reason: "摘要页", quote: "" }],
          answeredAt: "2026-10-24T00:00:00.000Z"
        }
      }
    },
    followups: []
  });

  assert.equal(saved.guided.plan.length, 2);
  assert.equal(saved.guided.index, 1);
  assert.equal(saved.guided.answers.s1.verdict, "good");
  assert.equal(saved.guided.answers.s1.feedback, "概括到位。");
  assert.equal(saved.guided.answers.s2, undefined);
});
