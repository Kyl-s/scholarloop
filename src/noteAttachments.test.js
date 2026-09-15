import test from "node:test";
import assert from "node:assert/strict";
import { insertAtCursor, mergeNoteAttachments, noteAttachmentTokens, parseNoteAttachments, stripNoteAttachments } from "./noteAttachments.js";
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

test("编辑正文时可隐藏附件标记，保存时保留附件引用", () => {
  const text = "[推导.md](/api/note-files/11111111-1111-4111-8111-111111111111)\n正文第一句";
  const tokens = noteAttachmentTokens(text);
  assert.equal(stripNoteAttachments(text), "正文第一句");
  assert.equal(mergeNoteAttachments("正文更新", tokens), "[推导.md](/api/note-files/11111111-1111-4111-8111-111111111111)\n正文更新");
});

test("合并编辑前和编辑中新加入的附件，不丢失且会去重", () => {
  const markdown = "[推导.md](/api/note-files/11111111-1111-4111-8111-111111111111)";
  const image = "![结果.png](/api/note-files/22222222-2222-4222-8222-222222222222)";
  const content = `更新后的正文\n${image}\n[保留链接](https://example.com)`;

  assert.equal(
    mergeNoteAttachments(content, [markdown, image, markdown]),
    `${markdown}\n${image}\n更新后的正文\n\n[保留链接](https://example.com)`
  );
});
