import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  applyPdf2zhListMarkerPatch,
  isDingbatFontName,
  isListMarkerSpan,
  PDF2ZH_LIST_MARKER_SENTINEL
} from "./pdfListMarkers.js";

test("recognizes Cell highlight dingbats and unicode bullets", () => {
  assert.equal(isDingbatFontName("AdvPSMPi6"), true);
  assert.equal(isDingbatFontName("AdvPSHN-M"), false);
  assert.equal(isListMarkerSpan({ text: "•" }, { text: "Hello" }), true);
  assert.equal(
    isListMarkerSpan(
      { text: "d", fontName: "AdvPSMPi6", fontSize: 6.5, fontId: "F4" },
      { text: "Noninvasive", fontName: "AdvPSHN-M", fontSize: 10, fontId: "F3" }
    ),
    true
  );
  assert.equal(
    isListMarkerSpan(
      { text: "d", fontName: "AdvPSHN-M", fontSize: 10, fontId: "F3" },
      { text: "epth selectively", fontName: "AdvPSHN-M", fontSize: 10, fontId: "F3" }
    ),
    false
  );
});

test("patches BabelDOC paragraph_finder to split dingbat list items", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scholarloop-list-"));
  const file = path.join(dir, "paragraph_finder.py");
  fs.writeFileSync(file, [
    "from babeldoc.format.pdf.document_il.utils.layout_helper import is_bullet_point",
    "                    and (char := chars[0])",
    "                    and is_bullet_point(char)",
    "                ):",
    ""
  ].join("\n"), "utf8");
  try {
    const first = applyPdf2zhListMarkerPatch(file);
    assert.equal(first.ok, true);
    assert.equal(first.reason, "patched");
    const src = fs.readFileSync(file, "utf8");
    assert.match(src, /scholarloop_is_list_marker_line\(line\)/);
    assert.match(src, new RegExp(PDF2ZH_LIST_MARKER_SENTINEL));
    assert.equal(src.includes("and is_bullet_point(char)"), false);
    const second = applyPdf2zhListMarkerPatch(file);
    assert.equal(second.reason, "already");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
