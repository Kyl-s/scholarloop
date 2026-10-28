import test from "node:test";
import assert from "node:assert/strict";
import { createAgentSession } from "./agentSession.js";

function setup(chat, saved = "[]") {
  const values = new Map([["scholarloop.agent.chat", saved]]);
  const storage = { getItem: (key) => values.get(key), setItem: (key, value) => values.set(key, value) };
  let clears = 0;
  const session = createAgentSession({ chat, storage, onClear: () => clears++ });
  return { session, values, clears: () => clears };
}

test("response survives removal of all subscribers and prevents concurrent sends", async () => {
  let resolve;
  let requests = 0;
  const { session, values } = setup(() => { requests++; return new Promise((done) => { resolve = done; }); });
  const unsubscribe = session.subscribe(() => {});
  const pending = session.send("question", {});
  unsubscribe();
  assert.equal(session.getSnapshot().busy, true);
  assert.equal(await session.send("duplicate", {}), false);
  assert.equal(session.clear(), false);
  resolve({ content: "background reply" });
  await pending;
  assert.equal(requests, 1);
  assert.equal(session.getSnapshot().busy, false);
  assert.equal(session.getSnapshot().messages[1].content, "background reply");
  assert.equal(JSON.parse(values.get("scholarloop.agent.chat"))[1].content, "background reply");
});

test("background failure remains visible and unlocks the conversation", async () => {
  const { session } = setup(async () => { throw new Error("offline"); });
  await session.send("question", {});
  assert.equal(session.getSnapshot().busy, false);
  assert.equal(session.getSnapshot().messages[1].content, "出错了：offline");
});

test("hydrated history, drafts and clear are shared by both subscribers", async () => {
  const { session, values, clears } = setup(async () => ({ content: "reply" }), '[{"role":"agent","content":[{"text":"saved"}]}]');
  assert.equal(session.getSnapshot().messages[0].content, "saved");
  const seenA = [], seenB = [];
  const offA = session.subscribe(() => seenA.push(session.getSnapshot()));
  const offB = session.subscribe(() => seenB.push(session.getSnapshot()));
  session.setInput("draft");
  assert.equal(seenA.at(-1), seenB.at(-1));
  await session.send(undefined, {});
  assert.equal(session.getSnapshot().input, "");
  assert.equal(session.clear(), true);
  assert.equal(clears(), 1);
  assert.deepEqual(JSON.parse(values.get("scholarloop.agent.chat")), []);
  offA(); offB();
});

test("tool results are stored with the reply so the next turn can reuse them", async () => {
  let sent;
  const { session, values } = setup(async (body) => {
    sent = body;
    return {
      content: "找到两篇",
      toolCalls: [{ name: "search_papers", args: { query: "VLN" }, result: { total: 2, papers: [{ title: "R2R" }] }, extra: "drop" }]
    };
  });
  await session.send("找 VLN", {});
  const saved = JSON.parse(values.get("scholarloop.agent.chat"));
  assert.equal(saved[1].toolCalls[0].name, "search_papers");
  assert.equal(saved[1].toolCalls[0].result.papers[0].title, "R2R");
  assert.equal(saved[1].toolCalls[0].extra, undefined);
  await session.send("继续", {});
  assert.equal(sent.messages[1].toolCalls[0].result.total, 2);
});

test("refresh or storage failures do not discard a successful reply", async () => {
  const session = createAgentSession({
    storage: { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("full"); } },
    chat: async () => ({ content: "done", toolCalls: [{ name: "complete_task" }] })
  });
  await session.send("question", {}, async () => { throw new Error("refresh failed"); });
  assert.equal(session.getSnapshot().messages[1].content, "done");
  assert.equal(session.getSnapshot().busy, false);
});
