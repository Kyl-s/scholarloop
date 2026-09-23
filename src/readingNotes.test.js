import test from "node:test";
import assert from "node:assert/strict";
import { caretAfterLeadingMarker, collectNotePages, excerptNote, formatNoteForWriter, getReadingNoteContent, insertPageMarker, normalizeReadingNotes, parseReadingNotes, readReadingNotes, updateReadingNote } from "./readingNotes.js";

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

test("再标一页时新标记仍加在文首，旧页正文跟着旧标记", () => {
  const first = insertPageMarker("本篇论文是关于 TI-TMS。", 1, "2026/8/16 15:49:04");
  const second = insertPageMarker(first, 3, "2026/8/16 16:00:00");
  assert.equal(second.startsWith("—— 第 3 页 · 2026/8/16 16:00:00 ——"), true);
  assert.match(second, /—— 第 1 页 · 2026\/8\/16 15:49:04 ——\n本篇论文是关于 TI-TMS。/);
  const segments = parseReadingNotes(second);
  assert.equal(segments[0].page, 3);
  assert.equal(segments[0].content, "");
  assert.equal(segments[1].page, 1);
  assert.equal(segments[1].content, "本篇论文是关于 TI-TMS。");
  assert.equal(caretAfterLeadingMarker(second), second.indexOf("\n") + 1);
});

test("整理旧文末标记为文首标记加正文", () => {
  const normalized = normalizeReadingNotes("本篇论文是关于 TI-TMS。\n\n—— 第 1 页 · 2026/8/16 15:49:04 ——");
  assert.equal(normalized, "—— 第 1 页 · 2026/8/16 15:49:04 ——\n本篇论文是关于 TI-TMS。\n");
});

test("写入论文时带上文献标题和页码", () => {
  assert.equal(
    formatNoteForWriter({ title: "Tree of Thoughts", page: 3, content: "搜索空间可剪枝。" }),
    "【手记 · Tree of Thoughts · 第 3 页】\n搜索空间可剪枝。"
  );
  assert.equal(
    formatNoteForWriter({ kind: "standalone", title: "实验假设", content: "先补对照。" }),
    "【手记 · 实验假设】\n先补对照。"
  );
  assert.equal(excerptNote("一段很长的手记内容用来测试截断是否生效1234567890", 12), "一段很长的手记内容用来测…");
});

test("按文献和当前页读取旧版页码手记", () => {
  const text = [
    "整篇论文的总印象。",
    "",
    "—— 第 3 页 · 2026/9/21 21:54:17 ——",
    "第三页的方法说明。",
    "",
    "—— 第 4 页 · 2026/9/21 22:00:00 ——",
    "第四页的实验结果。"
  ].join("\n");
  const notes = readReadingNotes(text);
  assert.equal(notes.document, "整篇论文的总印象。");
  assert.equal(getReadingNoteContent(text, "page", 3), "第三页的方法说明。");
  assert.equal(getReadingNoteContent(text, "page", 4), "第四页的实验结果。");
  assert.deepEqual(notes.pages.map((segment) => segment.page), [3, 4]);
});

test("更新当前页手记不会影响其他页或文献手记", () => {
  let text = "整篇论文的总印象。\n";
  text = updateReadingNote(text, { scope: "page", page: 3, content: "第三页内容。", stamp: "now" });
  text = updateReadingNote(text, { scope: "page", page: 4, content: "第四页内容。", stamp: "later" });
  text = updateReadingNote(text, { scope: "page", page: 4, content: "第四页修订。" });
  assert.equal(getReadingNoteContent(text, "document"), "整篇论文的总印象。");
  assert.equal(getReadingNoteContent(text, "page", 3), "第三页内容。");
  assert.equal(getReadingNoteContent(text, "page", 4), "第四页修订。");
});

test("编辑框删空当前页时只移除当前页段落", () => {
  let text = "整篇论文的总印象。\n";
  text = updateReadingNote(text, { scope: "page", page: 3, content: "第三页内容。", stamp: "now" });
  text = updateReadingNote(text, { scope: "page", page: 4, content: "第四页内容。", stamp: "later" });
  text = updateReadingNote(text, { scope: "page", page: 4, content: "" });
  assert.equal(getReadingNoteContent(text, "document"), "整篇论文的总印象。");
  assert.equal(getReadingNoteContent(text, "page", 3), "第三页内容。");
  assert.equal(getReadingNoteContent(text, "page", 4), "");
  assert.deepEqual(readReadingNotes(text).pages.map((segment) => segment.page), [3]);
});

test("首次补写文献手记时不会把内容归到最后一页", () => {
  let text = updateReadingNote("", { scope: "page", page: 4, content: "第四页内容。", stamp: "later" });
  text = updateReadingNote(text, { scope: "document", content: "整篇论文总结。" });
  assert.equal(getReadingNoteContent(text, "document"), "整篇论文总结。");
  assert.equal(getReadingNoteContent(text, "page", 4), "第四页内容。");
});

test("同一页的旧分段合并且不丢失内容", () => {
  const text = [
    "—— 第 3 页 · first ——",
    "第一段。",
    "",
    "—— 第 3 页 · second ——",
    "第二段。"
  ].join("\n");
  const notes = readReadingNotes(text);
  assert.equal(notes.pages.length, 1);
  assert.equal(notes.pages[0].content, "第一段。\n\n第二段。");
  assert.equal(notes.pages[0].stamp, "first");
});
