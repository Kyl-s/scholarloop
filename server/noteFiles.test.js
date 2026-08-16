import test from "node:test";
import assert from "node:assert/strict";
import { attachmentToken, extensionOf, getNoteFile, removeNoteFile, sanitizeFileName, saveNoteFile } from "./noteFiles.js";

test("只接受白名单后缀", () => {
  assert.equal(extensionOf("shot.png", "image/png"), "png");
  assert.equal(extensionOf("notes.docx", ""), "docx");
  assert.equal(extensionOf("hack.exe", "application/octet-stream"), "");
});

test("文件名去掉路径和括号", () => {
  assert.equal(sanitizeFileName("C:\\\\a\\\\图[1].png"), "图1.png");
});

test("保存后能读回，并生成插入标记", () => {
  const saved = saveNoteFile({
    name: "示意图.png",
    mime: "image/png",
    data: Buffer.from("png-bytes").toString("base64")
  });
  try {
    assert.equal(saved.kind, "image");
    assert.equal(saved.token, attachmentToken(saved));
    const loaded = getNoteFile(saved.id);
    assert.equal(loaded?.name, "示意图.png");
    assert.equal(loaded?.size, 9);
  } finally {
    removeNoteFile(saved.id);
  }
});

test("拒绝空内容和超大文件类型伪装", () => {
  assert.throws(() => saveNoteFile({ name: "a.png", data: "" }), /空/);
  assert.throws(() => saveNoteFile({ name: "a.exe", data: "YQ==" }), /不支持/);
});
