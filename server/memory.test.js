import test from "node:test";
import assert from "node:assert/strict";
import { normalizeMemoryInput } from "./store.js";
import { buildAgentMemoryContext } from "./agent.js";

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
