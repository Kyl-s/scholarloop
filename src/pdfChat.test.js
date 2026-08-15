import test from "node:test";
import assert from "node:assert/strict";
import { createPendingFollowup, settleFollowup } from "./pdfChat.js";

test("a follow-up is visible immediately while the AI is thinking", () => {
  assert.deepEqual(createPendingFollowup("ask-1", "  解释图 2  "), {
    id: "ask-1",
    q: "解释图 2",
    a: "",
    evidence: [],
    status: "thinking"
  });
});

test("the pending AI message is updated in place when the answer arrives", () => {
  const pending = [createPendingFollowup("ask-1", "解释图 2")];
  assert.deepEqual(settleFollowup(pending, "ask-1", "这是答案。"), [
    { id: "ask-1", q: "解释图 2", a: "这是答案。", evidence: [], status: "done" }
  ]);
});

test("a failed answer keeps the user's question and exposes the error state", () => {
  const pending = [createPendingFollowup("ask-1", "解释图 2")];
  assert.deepEqual(settleFollowup(pending, "ask-1", "追问失败：网络错误", "error"), [
    { id: "ask-1", q: "解释图 2", a: "追问失败：网络错误", evidence: [], status: "error" }
  ]);
});

test("an answer keeps page evidence for clickable PDF navigation", () => {
  const pending = [createPendingFollowup("ask-1", "解释图 2")];
  assert.deepEqual(
    settleFollowup(pending, "ask-1", "这是答案。", "done", [{ page: 4, label: "第 4 页" }]),
    [{ id: "ask-1", q: "解释图 2", a: "这是答案。", evidence: [{ page: 4, label: "第 4 页" }], status: "done" }]
  );
});
