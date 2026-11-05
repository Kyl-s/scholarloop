import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { trySafeLayoutRepair } from "./pdfSafeLayoutRepair.js";
import { resolvePreservePython, buildPreservePythonEnv, extractPdfPageLines } from "./pdfPreserveRegions.js";

const py = resolvePreservePython();
const sentence = "This is a complete original English sentence that must be removed only when it is independently duplicated.";
function makeFixture(dir, overlap) {
  const source = path.join(dir, "source.pdf"), mono = path.join(dir, "mono.pdf");
  const script = `import fitz,sys\ns='${sentence}'\nfor i,p in enumerate(sys.argv[1:3]):\n d=fitz.open(); page=d.new_page(width=612,height=792); page.insert_text((40,100),s,fontsize=10); page.insert_text((40,150),'Independent safe content',fontsize=10)\n if i==1 and sys.argv[3]=='1': page.insert_text((40,100),'OTHER CONTENT',fontsize=10)\n d.save(p)\n`;
  const r = spawnSync(py.cmd, [...py.extra, "-c", script, source, mono, overlap ? "1" : "0"], { encoding: "utf8", env: buildPreservePythonEnv(py.env) });
  assert.equal(r.status, 0, r.stderr);
  return { source, mono };
}
function args(source, mono, reviewer) { return { sourcePdf: source, monoPdf: mono, page: 1, review: { issues: [{ category: "overlap", bbox: [0, 0.08, 1, 0.16] }] }, renderPage: async () => ({ image: "fake" }), reviewer, config: {} }; }

test("removes only a verified independent duplicate and accepts a better second review", { skip: !py }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sl-layout-test-"));
  try {
    const { source, mono } = makeFixture(dir, false);
    const result = await trySafeLayoutRepair(args(source, mono, async () => ({ issues: [] })));
    assert.equal(result.repaired, true);
    const output = extractPdfPageLines(mono, 1).lines.map((x) => x.text).join(" ");
    assert.ok(!output.includes(sentence));
    assert.match(output, /Independent safe content/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("never changes a page when another text line overlaps or the second review does not improve", { skip: !py }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sl-layout-test-"));
  try {
    const { source, mono } = makeFixture(dir, true);
    const original = fs.readFileSync(mono);
    const result = await trySafeLayoutRepair(args(source, mono, async () => ({ issues: [] })));
    assert.equal(result.repaired, false);
    assert.deepEqual(fs.readFileSync(mono), original);
    const other = makeFixture(dir, false);
    const original2 = fs.readFileSync(other.mono);
    const retry = await trySafeLayoutRepair(args(other.source, other.mono, async () => ({ issues: [{ category: "overlap", bbox: [0, 0, 1, 1] }] })));
    assert.equal(retry.repaired, false);
    assert.deepEqual(fs.readFileSync(other.mono), original2);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("keeps mono and bilingual files unchanged when only one has a safe candidate", { skip: !py }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sl-layout-test-"));
  try {
    const { source, mono } = makeFixture(dir, false);
    const dual = path.join(dir, "dual.pdf");
    const script = "import fitz,sys\ns=fitz.open(sys.argv[1]);d=fitz.open();p=d.new_page(width=1224,height=792);p.show_pdf_page(fitz.Rect(0,0,612,792),s,0);p.show_pdf_page(fitz.Rect(612,0,1224,792),s,0);p.insert_text((652,100),'OTHER CONTENT',fontsize=10);d.save(sys.argv[2])";
    const made = spawnSync(py.cmd, [...py.extra, "-c", script, mono, dual], { encoding: "utf8", env: buildPreservePythonEnv(py.env) });
    assert.equal(made.status, 0, made.stderr);
    const beforeMono = fs.readFileSync(mono), beforeDual = fs.readFileSync(dual);
    const result = await trySafeLayoutRepair({ ...args(source, mono, async () => ({ issues: [] })), dualPdf: dual });
    assert.equal(result.repaired, false);
    assert.deepEqual(fs.readFileSync(mono), beforeMono);
    assert.deepEqual(fs.readFileSync(dual), beforeDual);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
