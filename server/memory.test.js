import test from "node:test";
import assert from "node:assert/strict";
import { normalizeMemoryInput } from "./store.js";
import {
  buildAgentMemoryContext,
  buildConversationSummary,
  buildLearningStateContext,
  buildSessionContext,
  selectAgentMemories
} from "./agent.js";

test("ScholarLoop memory keeps personal content but redacts credentials", () => {
  const memory = normalizeMemoryInput({
    title: "我的研究方向",
    content: "研究时间干涉磁刺激。apiKey: sk-test-secret-123456 password=secret-value Cookie: sid=abc",
    tags: "研究方向,阅读偏好",
    enabled: true
  });

  assert.equal(memory.enabled, true);
  assert.deepEqual(memory.tags, ["研究方向", "阅读偏好"]);
  assert.match(memory.content, /研究时间干涉磁刺激/);
  assert.doesNotMatch(memory.content, /sk-test-secret-123456|secret-value|sid=abc/);
  assert.match(memory.content, /已隐藏/);
});

test("memory update can preserve content while disabling an entry", () => {
  const memory = normalizeMemoryInput({ enabled: false }, {
    title: "阅读偏好",
    content: "先解释基础概念，再进入公式。",
    tags: ["新手"],
    enabled: true
  });

  assert.deepEqual(memory, {
    title: "阅读偏好",
    content: "先解释基础概念，再进入公式。",
    tags: ["新手"],
    enabled: false
  });
});

test("Agent only receives enabled ScholarLoop memories", () => {
  assert.equal(
    buildAgentMemoryContext([
      { title: "已启用", content: "研究时间干涉磁刺激", enabled: true },
      { title: "已停用", content: "不要注入", enabled: false }
    ]),
    "- 已启用：研究时间干涉磁刺激"
  );
});

test("Agent memory selection prefers entries that match the current question", () => {
  const memories = [
    { title: "作息", content: "晚上写笔记", enabled: true },
    { title: "研究方向", content: "时间干涉磁刺激的刺激参数", enabled: true },
    { title: "停用方向", content: "时间干涉磁刺激不要用这条", enabled: false }
  ];
  assert.equal(selectAgentMemories(memories, "时间干涉磁刺激怎么选参数")[0].title, "研究方向");
  assert.match(buildAgentMemoryContext(memories, "时间干涉磁刺激"), /刺激参数/);
  assert.doesNotMatch(buildAgentMemoryContext(memories, "时间干涉磁刺激"), /不要用这条/);
});

test("older turns become a summary and prior tool results stay visible", () => {
  const messages = Array.from({ length: 17 }, (_, index) => ({
    role: index % 2 ? "agent" : "user",
    content: `第${index}轮`,
    toolCalls: index === 0 ? [{ name: "search_papers", result: { total: 2, papers: [{ title: "World Models", year: 2018, url: "https://example.test/wm" }] } }] : []
  }));
  assert.match(buildConversationSummary(messages), /第0轮/);
  assert.match(buildConversationSummary(messages), /World Models/);
  assert.doesNotMatch(buildConversationSummary(messages), /第16轮/);
  assert.match(buildSessionContext(messages), /更早对话摘要/);
  assert.match(buildSessionContext(messages), /https:\/\/example\.test\/wm/);
});

test("learning state injects the next task and the latest progress log", () => {
  const text = buildLearningStateContext({
    field: "具身导航",
    goal: "读懂 VLN",
    stages: [{ id: "literature", title: "文献精读", tasks: [{ title: "精读 R2R", done: false, status: "todo" }] }],
    progressLog: [{ summary: "已分清 agent 和 oracle", blocker: "数据集空格子", next: "读方法分类" }]
  });
  assert.match(text, /具身导航/);
  assert.match(text, /精读 R2R/);
  assert.match(text, /已分清 agent 和 oracle/);
  assert.match(text, /读方法分类/);
});
