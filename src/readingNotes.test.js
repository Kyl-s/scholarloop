import test from "node:test";
import assert from "node:assert/strict";
import { collectNotePages, excerptNote, formatNoteForWriter, insertPageMarker, parseReadingNotes } from "./readingNotes.js";

test("无页标记的手记视为整段", () => {
  const segments = parseReadingNotes("方法核心是时间干涉。");
  assert.equal(segments.length, 1);
  assert.equal(segments[0].page, null);
  assert.equal(segments[0].content, "方法核心是时间干涉。");
});

test("按页标记拆分手记，并保留标记前的前言", () => {
  const text = [
    "先记总印象。",
    "",
    "—— 第 3 页 · 2026/8/16 12:00:00 ——",
    "方法关键是 TI。",
    "",
    "—— 第 7 页 · 2026/8/16 12:05:00 ——",
    "图 2 和讨论对不上。"
  ].join("\n");
  const segments = parseReadingNotes(text);
  assert.equal(segments.length, 3);
  assert.equal(segments[0].content, "先记总印象。");
  assert.equal(segments[1].page, 3);
  assert.equal(segments[1].content, "方法关键是 TI。");
  assert.equal(segments[2].page, 7);
  assert.equal(segments[2].stamp, "2026/8/16 12:05:00");
  assert.deepEqual(collectNotePages(segments), [3, 7]);
});

test("空手记返回空列表", () => {
  assert.deepEqual(parseReadingNotes("   \n"), []);
});

test("先写后标页：文末空标记把正文归到该页", () => {
  const text = [
    "本篇论文是关于利用TI-TMS理论设计线圈阵列。",
    "",
    "—— 第 1 页 · 2026/8/16 15:49:04 ——"
  ].join("\n");
  const segments = parseReadingNotes(text);
  assert.equal(segments.length, 1);
  assert.equal(segments[0].page, 1);
  assert.equal(segments[0].content, "本篇论文是关于利用TI-TMS理论设计线圈阵列。");
  assert.equal(segments[0].stamp, "2026/8/16 15:49:04");
});

test("插入页标记时，无标记的旧正文放在标记后面", () => {
  const next = insertPageMarker("本篇论文是关于 TI-TMS。", 1, "2026/8/16 15:49:04");
  assert.equal(next.startsWith("—— 第 1 页 · 2026/8/16 15:49:04 ——"), true);
  assert.match(next, /本篇论文是关于 TI-TMS。/);
  const segments = parseReadingNotes(next);
  assert.equal(segments.length, 1);
  assert.equal(segments[0].page, 1);
});

test("写入论文时带上文献标题和页码", () => {
  assert.equal(
    formatNoteForWriter({ title: "Tree of Thoughts", page: 3, content: "搜索空间可剪枝。" }),
    "【手记 · Tree of Thoughts · 第 3 页】\n搜索空间可剪枝。"
  );
  assert.equal(excerptNote("一段很长的手记内容用来测试截断是否生效1234567890", 12), "一段很长的手记内容用来测…");
});
