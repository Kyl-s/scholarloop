import test from "node:test";
import assert from "node:assert/strict";
import {
  createGuidedSession,
  createSavedInterpretation,
  interpretationStorageKey,
  normalizeGuidedState,
  normalizeSavedInterpretation
} from "./pdfInterpretation.js";

test("保存完整 AI 解读时保留结构化结果、追问和元信息", () => {
  const saved = createSavedInterpretation({
    result: {
      oneSentence: "方法提高了定位精度。",
      method: "控制线圈电流比。",
      evidence: [{ page: 3, label: "图 2 · 第 3 页" }]
    },
    meta: {
      mode: "full",
      usedChars: 1234,
      pageCoverage: "1-3",
      model: "deepseek-chat",
      usage: { promptTokens: 900, completionTokens: 200, totalTokens: 1100, cachedTokens: 300 }
    },
    followups: [{ id: "q1", q: "图 2 说明什么？", a: "说明聚焦区域可调。", status: "done", evidence: [] }],
    savedAt: "2026-08-11T00:00:00.000Z"
  });

  assert.equal(saved.mode, "full");
  assert.equal(saved.usedChars, 1234);
  assert.equal(saved.model, "deepseek-chat");
  assert.equal(saved.usage.cachedTokens, 300);
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

test("解读结果可以生成带步骤 id 的引导计划", () => {
  const session = createGuidedSession({
    guidedSteps: [
      { title: "整体印象", question: "这篇文章研究什么？", hint: "先读摘要", pages: [1] },
      { question: "核心问题是什么？" }
    ]
  });
  assert.equal(session.index, 0);
  assert.deepEqual(session.plan.map((step) => step.id), ["s1", "s2"]);
  assert.equal(session.plan[1].title, "第 2 步");
  assert.equal(createGuidedSession({ oneSentence: "没有引导步骤" }), null);
});

test("保存并恢复引导进度（含回答与批改）", () => {
  const result = {
    oneSentence: "方法提高了定位精度。",
    guidedSteps: [
      { title: "整体印象", question: "这篇文章研究什么？", pages: [1] },
      { title: "核心问题", question: "要解决什么问题？", pages: [1, 2] }
    ]
  };
  const guided = {
    ...createGuidedSession(result),
    index: 1,
    answers: {
      s1: {
        answer: "研究定位精度的提高。",
        verdict: "good",
        feedback: "概括到位。",
        reference: "参考：闭环控制。",
        strengths: ["抓住了主线"],
        evidence: [{ page: 1, label: "第 1 页", reason: "摘要页", quote: "targeting accuracy" }],
        answeredAt: "2026-10-24T00:00:00.000Z"
      },
      sX: { answer: "幽灵步骤", verdict: "good" }
    }
  };
  const saved = createSavedInterpretation({ result, meta: { mode: "quick" }, guided });
  assert.equal(saved.guided.plan.length, 2);

  const restored = normalizeSavedInterpretation(saved);
  assert.equal(restored.guided.index, 1);
  assert.equal(restored.guided.answers.s1.verdict, "good");
  assert.equal(restored.guided.answers.s1.evidence[0].page, 1);
  // 不在计划里的回答不会残留
  assert.equal(restored.guided.answers.sX, undefined);
});

test("引导步骤内的对话记录随解读持久化并保留", () => {
  const result = {
    oneSentence: "方法提高了定位精度。",
    guidedSteps: [{ title: "整体印象", question: "这篇文章研究什么？", pages: [1] }]
  };
  const guided = {
    ...createGuidedSession(result),
    index: 1,
    answers: {
      s1: {
        answer: "研究定位精度的提高。",
        verdict: "good",
        feedback: "概括到位。",
        reference: "",
        strengths: [],
        evidence: [],
        answeredAt: "2026-10-24T00:00:00.000Z",
        dialog: [
          { role: "user", text: "为什么闭环控制能提高精度？", at: "2026-10-24T01:00:00.000Z" },
          {
            role: "assistant",
            text: "因为反馈能实时纠正偏差。",
            evidence: [{ page: 2, label: "第 2 页", reason: "方法节", quote: "closed-loop" }],
            at: "2026-10-24T01:00:10.000Z"
          },
          { role: "assistant", text: "", at: "2026-10-24T01:00:11.000Z" },
          { role: "学员", text: "未知角色按学员处理", at: "2026-10-24T01:00:12.000Z" }
        ]
      }
    }
  };
  const saved = createSavedInterpretation({ result, meta: { mode: "quick" }, guided });
  const restored = normalizeSavedInterpretation(saved);
  const dialog = restored.guided.answers.s1.dialog;
  assert.equal(dialog.length, 3);
  assert.equal(dialog[0].role, "user");
  assert.equal(dialog[0].text, "为什么闭环控制能提高精度？");
  assert.equal(dialog[1].role, "assistant");
  assert.equal(dialog[1].evidence[0].page, 2);
  // 空消息被丢弃，未知角色归一为学员（user）
  assert.equal(dialog.some((m) => m.text === ""), false);
  assert.equal(dialog[2].role, "user");
  // 恢复后的记录继续可追加
  assert.equal(restored.guided.answers.s1.dialog.length, 3);
});

test("旧解读没有 guided 时按步骤计划从头开始，超界进度被收敛", () => {
  const result = { oneSentence: "旧解读", guidedSteps: [{ question: "先说说研究什么？" }] };
  const restored = normalizeSavedInterpretation({
    mode: "quick",
    result,
    savedAt: "2026-10-24"
  });
  assert.equal(restored.guided.index, 0);
  assert.equal(restored.guided.plan.length, 1);

  const clamped = normalizeGuidedState({ plan: result.guidedSteps, index: 9, answers: {} }, result);
  assert.equal(clamped.index, 1);
  // verdict 非法值回落到 partial
  const badVerdict = normalizeGuidedState({
    plan: [{ question: "q" }],
    index: 0,
    answers: { s1: { answer: "a", verdict: "excellent" } }
  });
  assert.equal(badVerdict.answers.s1.verdict, "partial");
});
