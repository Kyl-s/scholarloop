import test from "node:test";
import assert from "node:assert/strict";
import { importChatGptShare, normalizeChatGptConversation, parseChatGptShareHtml, parseChatGptShareUrl } from "./chatgptShare.js";

test("只接受 ChatGPT 公开分享链接", () => {
  assert.deepEqual(parseChatGptShareUrl("https://chatgpt.com/share/12345678-abcd"), {
    url: "https://chatgpt.com/share/12345678-abcd",
    shareId: "12345678-abcd"
  });
  assert.throws(() => parseChatGptShareUrl("https://chatgpt.com/c/12345678-abcd"), /公开 \/share/);
  assert.throws(() => parseChatGptShareUrl("https://example.com/share/12345678-abcd"), /ChatGPT/);
  assert.throws(() => parseChatGptShareUrl("http://chatgpt.com/share/12345678-abcd"), /HTTPS/);
});

test("从 ChatGPT mapping 沿当前分支恢复消息顺序", () => {
  const result = normalizeChatGptConversation({
    title: "注意力机制",
    current_node: "a2",
    mapping: {
      root: { id: "root", message: { author: { role: "system" }, content: { parts: ["system"] } } },
      u1: { id: "u1", parent: "root", message: { author: { role: "user" }, content: { parts: ["什么是注意力？"] } } },
      a1: { id: "a1", parent: "u1", message: { author: { role: "assistant" }, content: { parts: ["它用于计算相关性。"] } } },
      u2: { id: "u2", parent: "a1", message: { author: { role: "user" }, content: { parts: ["请举例"] } } },
      a2: { id: "a2", parent: "u2", message: { author: { role: "assistant" }, content: { parts: ["可以看作加权聚合。"] } } }
    }
  });
  assert.equal(result.title, "注意力机制");
  assert.deepEqual(result.messages, [
    { role: "user", content: "什么是注意力？" },
    { role: "agent", content: "它用于计算相关性。" },
    { role: "user", content: "请举例" },
    { role: "agent", content: "可以看作加权聚合。" }
  ]);
});

test("支持服务器渲染的消息标记", () => {
  const result = parseChatGptShareHtml(`
    <html><head><title>公开对话</title></head><body>
      <div data-message-author-role="user"><p>问题</p></div>
      <div data-message-author-role="assistant"><p>回答</p></div>
    </body></html>
  `);
  assert.equal(result.title, "公开对话");
  assert.deepEqual(result.messages, [
    { role: "user", content: "问题" },
    { role: "agent", content: "回答" }
  ]);
});

test("通过公开分享页导入对话", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return new Response(`
      <html><head><title>研究讨论</title></head><body>
        <div data-message-author-role="user">问题</div>
        <div data-message-author-role="assistant">回答</div>
      </body></html>
    `, { status: 200, headers: { "content-type": "text/html" } });
  };
  try {
    const result = await importChatGptShare("https://chatgpt.com/share/12345678-abcd");
    assert.equal(result.title, "研究讨论");
    assert.deepEqual(result.messages, [
      { role: "user", content: "问题" },
      { role: "agent", content: "回答" }
    ]);
    assert.deepEqual(calls, ["https://chatgpt.com/share/12345678-abcd"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
