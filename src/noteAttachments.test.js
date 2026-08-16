import test from "node:test";
import assert from "node:assert/strict";
import { insertAtCursor, parseNoteAttachments, stripNoteAttachments } from "./noteAttachments.js";
import { excerptNote } from "./readingNotes.js";

test("解析手记里的图片和文件标记", () => {
  const items = parseNoteAttachments("见图\n![示意.png](/api/note-files/11111111-1111-4111-8111-111111111111)\n[数据.xlsx](/api/note-files/22222222-2222-4222-8222-222222222222)");
  assert.equal(items.length, 2);
  assert.equal(items[0].kind, "image");
  assert.equal(items[1].kind, "file");
  assert.equal(items[1].name, "数据.xlsx");
});

test("摘要会去掉附件标记", () => {
  const text = "结论如下\n![图.png](/api/note-files/11111111-1111-4111-8111-111111111111)";
  assert.equal(stripNoteAttachments(text), "结论如下");
  assert.equal(excerptNote(text, 20), "结论如下");
});

test("在光标处插入附件标记", () => {
  const token = "![a.png](/api/note-files/11111111-1111-4111-8111-111111111111)\n";
  const result = insertAtCursor("前后", token, 1, 1);
  assert.equal(result.next, `前${token}后`);
  assert.equal(result.caret, 1 + token.length);
});
