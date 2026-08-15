import test from "node:test";
import assert from "node:assert/strict";
import { buildLayoutTranslationPrompt, joinLayoutTranslation, parseLayoutTranslation } from "./pdfLayoutTranslation.js";

test("keeps layout translation segments aligned to their original lines", () => {
  const lines = [{ text: "Title" }, { text: "Authors" }];
  const prompt = buildLayoutTranslationPrompt(lines);
  assert.match(prompt, /__SCHOLARLOOP_KEEP_0__\nTitle/);
  const translated = parseLayoutTranslation("__SCHOLARLOOP_KEEP_0__\n标题\n__SCHOLARLOOP_KEEP_1__\n作者", lines);
  assert.deepEqual(translated.map((line) => line.text), ["标题", "作者"]);
  assert.equal(joinLayoutTranslation(translated), "标题\n作者");
});

test("distributes cached plain-text translations across legacy PDF lines", () => {
  const lines = [{ text: "A long title" }, { text: "Author list" }, { text: "Abstract" }];
  const translated = parseLayoutTranslation("长标题\n作者列表\n摘要", lines);
  assert.equal(translated.length, 3);
  assert.equal(joinLayoutTranslation(translated), "长标题\n作者列表\n摘要");
});
