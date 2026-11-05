import test from "node:test";
import assert from "node:assert/strict";
import {
  findQuotePages,
  guideDialogTurn,
  interpretPdf,
  normalizeQuoteText,
  resolveGuidedStepPages,
  reviewGuidedAnswer
} from "./pdfInterpret.js";

const config = { baseUrl: "https://model.example/v1", apiKey: "test-key", model: "test-model" };
const pages = [
  { page: 1, text: "Abstract: The method improves targeting accuracy." },
  { page: 3, text: "Figure 2 shows the targeting result and the measured error." }
];

function mockResponse(content, usage = {
  prompt_tokens: 100,
  completion_tokens: 40,
  total_tokens: 140,
  prompt_tokens_details: { cached_tokens: 20 }
}, finishReason = "stop") {
  return new Response(JSON.stringify({
    choices: [{ message: { content }, finish_reason: finishReason }],
    usage
  }), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
}

const quotePages = [
  { page: 1, text: "Abstract: We study grounded skill selection for long-horizon tasks." },
  { page: 2, text: "Introduction. Our approach nearly doubles the performance of the strongest baseline on the benchmark." },
  { page: 3, text: "Related work discusses prior skill libraries and planning baselines." },
  { page: 4, text: "Method: a value function scores candidate skills at each state." },
  { page: 5, text: "Training details and data collection are described here." },
  { page: 6, text: "Ablations vary the number of candidate skills." },
  { page: 7, text: "Discussion of failure modes follows." },
  { page: 8, text: "Results show that 65% of the errors were LLM failures in evaluation." }
];

test("keeps structured page evidence in a full interpretation", async () => {
  const previousFetch = global.fetch;
  global.fetch = async () => mockResponse(JSON.stringify({
    oneSentence: "方法提高了定位精度。",
    problem: "如何提高定位精度？",
    method: "提出新的控制方法。",
    findings: "实验结果更好。",
    evidence: [
      { page: 3, label: "图 2 · 第 3 页", reason: "该页展示实验结果", quote: "targeting result" },
      { page: 99, label: "第 99 页", reason: "不存在的页码", quote: "" }
    ]
  }));

  try {
    const result = await interpretPdf({ title: "Test paper", mode: "quick", config, pages });
    assert.deepEqual(result.result.evidence, [{
      page: 3,
      label: "图 2 · 第 3 页",
      reason: "该页展示实验结果",
      quote: "targeting result"
    }]);
    assert.equal(result.usage.promptTokens, 100);
    assert.equal(result.usage.cachedTokens, 20);
    assert.equal(result.model, "test-model");
  } finally {
    global.fetch = previousFetch;
  }
});

test("retries with a trimmed request when the interpretation output is truncated", async () => {
  const previousFetch = global.fetch;
  const bodies = [];
  let call = 0;
  global.fetch = async (url, init) => {
    bodies.push(JSON.parse(init.body));
    call += 1;
    if (call === 1) return mockResponse('{"oneSentence":"被截断的解读"', undefined, "length");
    return mockResponse(JSON.stringify({
      oneSentence: "完整解读",
      problem: "核心问题",
      method: "方法",
      findings: "结论",
      evidence: []
    }));
  };

  try {
    const result = await interpretPdf({ title: "Test paper", mode: "full", config, pages });
    assert.equal(result.result.oneSentence, "完整解读");
    assert.equal(bodies.length, 2);
    // 第二次请求必须明确要求压缩输出，而不是原样重试。
    assert.match(bodies[1].messages[1].content, /精简/);
  } finally {
    global.fetch = previousFetch;
  }
});

test("reports truncated output clearly when the trimmed retry is still cut off", async () => {
  const previousFetch = global.fetch;
  global.fetch = async () => mockResponse('{"oneSentence":"仍然被截断"', undefined, "length");

  try {
    await assert.rejects(
      () => interpretPdf({ title: "Test paper", mode: "full", config, pages }),
      /模型输出被截断/
    );
  } finally {
    global.fetch = previousFetch;
  }
});

test("returns structured page evidence for a follow-up answer", async () => {
  const previousFetch = global.fetch;
  global.fetch = async () => mockResponse(JSON.stringify({
    answer: "图 2 说明方法在目标区域更集中。",
    evidence: [{ page: 3, reason: "图 2 位于第 3 页", quote: "Figure 2" }]
  }));

  try {
    const result = await interpretPdf({
      title: "Test paper",
      mode: "quick",
      config,
      pages,
      question: "图 2 说明了什么？",
      prior: { oneSentence: "已有解读" }
    });
    assert.equal(result.answer, "图 2 说明方法在目标区域更集中。");
    assert.deepEqual(result.evidence, [{
      page: 3,
      label: "第 3 页",
      reason: "图 2 位于第 3 页",
      quote: "Figure 2"
    }]);
  } finally {
    global.fetch = previousFetch;
  }
});

test("normalizes guided steps in an interpretation result", async () => {
  const previousFetch = global.fetch;
  global.fetch = async () => mockResponse(JSON.stringify({
    oneSentence: "方法提高了定位精度。",
    guidedSteps: [
      { stage: "整体印象", title: "这篇论文在做什么", goal: "建立整体印象", pages: [1, "2", 99], question: "用一句话说说这篇文章研究什么？", hint: "先读摘要" },
      { title: "", goal: "", question: "  " },
      "备用问题：作者的核心主张是什么？"
    ]
  }));

  try {
    const result = await interpretPdf({ title: "Test paper", mode: "quick", config, pages });
    assert.equal(result.result.guidedSteps.length, 2);
    // 页码只保留语料中真实存在的页（语料页为 1、3）
    assert.deepEqual(result.result.guidedSteps[0].pages, [1]);
    assert.equal(result.result.guidedSteps[0].question, "用一句话说说这篇文章研究什么？");
    assert.equal(result.result.guidedSteps[1].question, "备用问题：作者的核心主张是什么？");
  } finally {
    global.fetch = previousFetch;
  }
});

test("corrects guided step pages from pageQuotes across pages", async () => {
  const previousFetch = global.fetch;
  global.fetch = async () => mockResponse(JSON.stringify({
    oneSentence: "方法提升了性能。",
    guidedSteps: [{
      stage: "实验证据",
      title: "理解性能与错误来源",
      goal: "看清性能提升与错误构成",
      pages: [2],
      pageQuotes: [
        { page: 2, quote: "nearly doubles the performance" },
        { page: 2, quote: "65% of the errors were LLM failures" }
      ],
      question: "性能提升来自哪里，主要错误又来自哪里？",
      hint: "先看引言里的性能对比，再看实验里的错误分析"
    }]
  }));

  try {
    const result = await interpretPdf({ title: "Test paper", mode: "quick", config, pages: quotePages });
    const step = result.result.guidedSteps[0];
    // 第 2 页命中第一句；第二句实际在第 8 页，应被纠正过来
    assert.deepEqual(step.pages, [2, 8]);
    assert.equal(step.pageQuotes.length, 2);
    // 不保留语料中不存在的页码
    assert.ok(step.pages.every((page) => [1, 2, 3, 4, 5, 6, 8].includes(page)));
  } finally {
    global.fetch = previousFetch;
  }
});

test("keeps legacy pages when a step has no pageQuotes", async () => {
  const previousFetch = global.fetch;
  global.fetch = async () => mockResponse(JSON.stringify({
    oneSentence: "方法提升了性能。",
    guidedSteps: [{
      title: "整体印象",
      pages: [2, 9],
      question: "这篇论文研究什么？",
      hint: "先读摘要"
    }]
  }));

  try {
    const result = await interpretPdf({ title: "Test paper", mode: "quick", config, pages: quotePages });
    assert.deepEqual(result.result.guidedSteps[0].pages, [2]);
    assert.deepEqual(result.result.guidedSteps[0].pageQuotes, []);
  } finally {
    global.fetch = previousFetch;
  }
});

test("drops guided step pages when the quote cannot be found in the paper", async () => {
  const previousFetch = global.fetch;
  global.fetch = async () => mockResponse(JSON.stringify({
    oneSentence: "方法提升了性能。",
    guidedSteps: [{
      title: "关键细节",
      pages: [2],
      pageQuotes: [{ page: 2, quote: "this sentence never appears in the paper body" }],
      question: "关键设计是什么？",
      hint: "看方法部分"
    }]
  }));

  try {
    const result = await interpretPdf({ title: "Test paper", mode: "quick", config, pages: quotePages });
    assert.deepEqual(result.result.guidedSteps[0].pages, []);
  } finally {
    global.fetch = previousFetch;
  }
});

test("matches quotes after normalizing hyphenation, casing and whitespace", () => {
  assert.equal(normalizeQuoteText("Vali-  date\nThe MODEL"), "validate the model");
  assert.equal(normalizeQuoteText("State\u2014of\u2014the\u2014art   results"), "state-of-the-art results");

  const hyphenated = [
    { page: 4, text: "We vali-\ndate the model on three suites." },
    { page: 6, text: "Nothing relevant here." }
  ];
  assert.deepEqual(findQuotePages("validate the model", hyphenated), [4]);
  assert.deepEqual(findQuotePages("missing phrase entirely", hyphenated), []);
});

test("resolveGuidedStepPages prefers the declared page when it truly matches", () => {
  const step = {
    pages: [1],
    pageQuotes: [
      { page: 4, quote: "a value function scores candidate skills" },
      { page: 2, quote: "candidate policies ranked by value" }
    ]
  };
  // 第一条命中声明页 4；第二条在正文中找不到，被丢弃
  assert.deepEqual(resolveGuidedStepPages(step, quotePages), [4]);
  // 没有 pageQuotes 时回退到旧 pages
  assert.deepEqual(resolveGuidedStepPages({ pages: [3, 3, 1] }, quotePages), [1, 3]);
});

test("reviews a guided answer with verdict, feedback and page evidence", async () => {
  const previousFetch = global.fetch;
  global.fetch = async () => mockResponse(JSON.stringify({
    verdict: "partial",
    strengths: [" correctly identified the problem domain"],
    feedback: "你抓住了问题背景，但漏掉了方法的闭环控制。",
    reference: "参考答案：论文用闭环控制把误差压到 2% 以内。",
    evidence: [
      { page: 3, reason: "实验结果页", quote: "measured error" },
      { page: 77, reason: "不存在的页码", quote: "" }
    ]
  }));

  try {
    const result = await reviewGuidedAnswer({
      title: "Test paper",
      mode: "quick",
      config,
      pages,
      step: { id: "s1", index: 0, total: 5, title: "整体印象", question: "这篇论文研究什么？", goal: "", hint: "", pages: [1] },
      userAnswer: "研究如何提高定位精度。",
      prior: { oneSentence: "已有解读" }
    });
    assert.equal(result.verdict, "partial");
    assert.equal(result.strengths.length, 1);
    assert.match(result.feedback, /闭环控制/);
    assert.match(result.reference, /参考答案/);
    assert.deepEqual(result.evidence, [{
      page: 3,
      label: "第 3 页",
      reason: "实验结果页",
      quote: "measured error"
    }]);
    assert.equal(result.model, "test-model");
  } finally {
    global.fetch = previousFetch;
  }
});

test("falls back gracefully when the guide review output is not JSON", async () => {
  const previousFetch = global.fetch;
  global.fetch = async () => mockResponse("这是一段无法解析为 JSON 的批改文本。");

  try {
    const result = await reviewGuidedAnswer({
      title: "Test paper",
      mode: "quick",
      config,
      pages,
      step: { id: "s1", index: 0, total: 5, question: "这篇论文研究什么？" },
      userAnswer: "随便答答"
    });
    assert.equal(result.verdict, "partial");
    assert.equal(result.feedback, "这是一段无法解析为 JSON 的批改文本。");
    assert.deepEqual(result.evidence, []);
  } finally {
    global.fetch = previousFetch;
  }
});

test("continues a guided step dialog and keeps only corpus page evidence", async () => {
  const previousFetch = global.fetch;
  let capturedBody = "";
  global.fetch = async (_url, options) => {
    capturedBody = String(options?.body || "");
    return mockResponse(JSON.stringify({
      reply: "价值函数估计每个技能在当前状态的成功率，这就是 grounding 的来源。",
      evidence: [
        { page: 3, reason: "实验页", quote: "measured error" },
        { page: 99, reason: "不存在的页码", quote: "" }
      ]
    }));
  };

  try {
    const result = await guideDialogTurn({
      title: "Test paper",
      mode: "quick",
      config,
      pages,
      step: { index: 1, total: 5, title: "核心问题", question: "方法为什么有效？" },
      record: {
        answer: "因为有闭环控制。",
        feedback: "对，再加一点 grounding 的理解。",
        reference: "参考：价值函数提供 grounding。"
      },
      messages: [
        { role: "assistant", text: "你抓住了闭环控制。" },
        { role: "user", text: "那价值函数在这里起什么作用？" }
      ],
      prior: { oneSentence: "已有解读" }
    });
    assert.match(result.reply, /grounding/);
    assert.deepEqual(result.evidence, [{
      page: 3,
      label: "第 3 页",
      reason: "实验页",
      quote: "measured error"
    }]);
    assert.equal(result.model, "test-model");
    // 请求里带上步骤上下文、最初的回答与对话记录
    assert.match(capturedBody, /核心问题/);
    assert.match(capturedBody, /因为有闭环控制。/);
    assert.match(capturedBody, /那价值函数在这里起什么作用？/);
    assert.match(capturedBody, /导师：你抓住了闭环控制。/);
  } finally {
    global.fetch = previousFetch;
  }
});

test("rejects a guided dialog turn without any user message", async () => {
  await assert.rejects(
    guideDialogTurn({
      config,
      pages,
      step: { question: "q" },
      messages: [{ role: "assistant", text: "只有导师的话" }]
    }),
    /缺少要回复的消息/
  );
  await assert.rejects(
    guideDialogTurn({ config, pages, step: { question: "q" }, messages: [] }),
    /缺少要回复的消息/
  );
});
