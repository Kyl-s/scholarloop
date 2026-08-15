import test from "node:test";
import assert from "node:assert/strict";
import { interpretPdf } from "./pdfInterpret.js";

const config = { baseUrl: "https://model.example/v1", apiKey: "test-key", model: "test-model" };
const pages = [
  { page: 1, text: "Abstract: The method improves targeting accuracy." },
  { page: 3, text: "Figure 2 shows the targeting result and the measured error." }
];

function mockResponse(content) {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
}

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
