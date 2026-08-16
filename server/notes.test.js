import test from "node:test";
import assert from "node:assert/strict";
import { normalizeNoteInput } from "./store.js";

test("独立手记可用标题或正文创建", () => {
  assert.deepEqual(normalizeNoteInput({ title: "实验想法", content: "先记一条假设。" }), {
    title: "实验想法",
    content: "先记一条假设。"
  });
  assert.equal(normalizeNoteInput({ title: "   ", content: "   " }), null);
});

test("没有标题时用正文第一行作标题", () => {
  const note = normalizeNoteInput({ content: "TI-TMS 还要补对照实验\n第二段" });
  assert.equal(note.title, "TI-TMS 还要补对照实验");
  assert.match(note.content, /第二段/);
});

test("更新手记时可只改标题并保留正文", () => {
  const note = normalizeNoteInput({ title: "新标题" }, {
    title: "旧标题",
    content: "已有正文"
  });
  assert.deepEqual(note, { title: "新标题", content: "已有正文" });
});
