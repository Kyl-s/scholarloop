import test from "node:test";
import assert from "node:assert/strict";
import { appendDialogMessage, createPendingFollowup, settleFollowup } from "./pdfChat.js";

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

test("settling against a stale list still keeps the user's question", () => {
  const next = settleFollowup([], "ask-1", "这是答案。", "done", [], { q: "解释图 2" });
  assert.equal(next.length, 1);
  assert.equal(next[0].id, "ask-1");
  assert.equal(next[0].q, "解释图 2");
  assert.equal(next[0].a, "这是答案。");
});

test("an answer keeps page evidence for clickable PDF navigation", () => {
  const pending = [createPendingFollowup("ask-1", "解释图 2")];
  assert.deepEqual(
    settleFollowup(pending, "ask-1", "这是答案。", "done", [{ page: 4, label: "第 4 页" }]),
    [{ id: "ask-1", q: "解释图 2", a: "这是答案。", evidence: [{ page: 4, label: "第 4 页" }], status: "done" }]
  );
});

test("a guided step dialog grows one message at a time on any record", () => {
  const withUser = appendDialogMessage(null, { role: "user", text: "再讲讲价值函数？", at: "2026-10-25T00:00:00.000Z" });
  assert.deepEqual(withUser, [
    { role: "user", text: "再讲讲价值函数？", evidence: [], error: false, at: "2026-10-25T00:00:00.000Z" }
  ]);

  const withReply = appendDialogMessage(
    { dialog: withUser },
    { role: "assistant", text: "它估计技能成功概率。", evidence: [{ page: 3, label: "第 3 页" }], at: "2026-10-25T00:00:05.000Z" }
  );
  assert.deepEqual(withReply, [
    { role: "user", text: "再讲讲价值函数？", evidence: [], error: false, at: "2026-10-25T00:00:00.000Z" },
    { role: "assistant", text: "它估计技能成功概率。", evidence: [{ page: 3, label: "第 3 页" }], error: false, at: "2026-10-25T00:00:05.000Z" }
  ]);

  // 失败提示也进对话，且用户消息不会带证据/错误标记
  const withError = appendDialogMessage(
    { dialog: withReply },
    { role: "assistant", text: "回复失败：网络错误", error: true, at: "2026-10-25T00:00:10.000Z" }
  );
  assert.equal(withError.length, 3);
  assert.equal(withError[2].error, true);
  assert.deepEqual(appendDialogMessage({ dialog: [] }, { role: "user", text: "x", evidence: [{ page: 1 }], error: true })[0].evidence, []);
});
