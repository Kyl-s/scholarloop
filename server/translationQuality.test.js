import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  ACADEMIC_ZH_SYSTEM_PROMPT,
  buildGlossaryHintForText,
  buildTextTranslateSystemPrompt,
  getAcademicGlossaryPath,
  protectUrls,
  restoreUrls
} from "./translationQuality.js";

test("academic system prompt asks for fluent Simplified Chinese", () => {
  assert.match(ACADEMIC_ZH_SYSTEM_PROMPT, /Simplified Chinese|简体中文/i);
  assert.match(ACADEMIC_ZH_SYSTEM_PROMPT, /academic|学术|journal/i);
  assert.match(ACADEMIC_ZH_SYSTEM_PROMPT, /terminology|consistent|术语/i);
  // 必须兼容 BabelDOC 批量 JSON，禁止「只输出纯译文」
  assert.match(ACADEMIC_ZH_SYSTEM_PROMPT, /JSON array|Output Format/i);
  assert.doesNotMatch(ACADEMIC_ZH_SYSTEM_PROMPT, /Output only the translation/i);
  assert.match(ACADEMIC_ZH_SYSTEM_PROMPT, /URL|http|doi/i);
});

test("text translate prompt preserves ScholarLoop tokens when requested", () => {
  const plain = buildTextTranslateSystemPrompt();
  const withTokens = buildTextTranslateSystemPrompt({ preserveTokens: true });
  assert.match(plain, /简体中文/);
  assert.match(plain, /网址|链接|http/i);
  assert.equal(plain.includes("SCHOLARLOOP_KEEP"), false);
  assert.match(withTokens, /SCHOLARLOOP_KEEP/);
  assert.match(withTokens, /SCHOLARLOOP_URL/);
});

test("protectUrls leaves links intact after restore", () => {
  const input =
    "See https://doi.org/10.1016/j.cell.2017.05.024 and www.example.com/path?q=1, then doi: 10.1000/xyz.";
  const { text, urls } = protectUrls(input);
  assert.match(text, /__SCHOLARLOOP_URL_0__/);
  assert.equal(text.includes("https://doi.org"), false);
  assert.ok(urls.length >= 2);
  const restored = restoreUrls(`参见 ${text}`, urls);
  assert.match(restored, /https:\/\/doi\.org\/10\.1016\/j\.cell\.2017\.05\.024/);
  assert.match(restored, /www\.example\.com\/path\?q=1/);
});

test("glossary file exists and glossary hint only includes matching terms", () => {
  const file = getAcademicGlossaryPath();
  assert.equal(fs.existsSync(file), true);
  const hint = buildGlossaryHintForText(
    "We report a noninvasive deep brain stimulation strategy using temporally interfering electric fields."
  );
  assert.match(hint, /noninvasive/);
  assert.match(hint, /非侵入性/);
  assert.match(hint, /deep brain stimulation|DBS|时间干涉|temporally interfering/i);
  const empty = buildGlossaryHintForText("hello world only");
  assert.equal(empty, "");
});
