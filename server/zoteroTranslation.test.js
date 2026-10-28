import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { createZoteroTranslationReader, mergeTranslatedPages } from "./zoteroTranslation.js";
import { resolvePdfPagePython, buildPdfPageRendererEnv } from "./pdfPageRender.js";

const execute = promisify(execFile);
const fake = Buffer.from("%PDF-1.7\ntranslated");
function fixture(t, job) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scholarloop-zotero-translation-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = (name) => path.join(dir, name);
  return { dir, file, reader: (merge) => createZoteroTranslationReader({ getJob: () => job, resolveFile: (_id, name) => fs.existsSync(file(name)) ? file(name) : null, merge }) };
}
test("reuses completed mono output and rejects a changed source", async (t) => {
  const job = { jobId: "job", status: "completed", targetLang: "zh", sourceSha256: "old", result: { monoFile: "full.pdf" } };
  const f = fixture(t, job); fs.writeFileSync(f.file("full.pdf"), fake);
  const reader = f.reader(() => { throw new Error("must reuse full output"); });
  assert.deepEqual((await reader.readTranslation({ id: "paper" })).buffer, fake);
  assert.equal((await reader.readTranslation({ id: "paper" }, { buffer: fake })).status, "source-mismatch");
});
test("missing progressive page is never uploaded even when a restored job says completed", async (t) => {
  const job = { jobId: "job", status: "completed", targetLang: "zh", pageCount: 2, pages: [{ page: 1, status: "completed", monoFile: "one.pdf" }, { page: 2, status: "canceled" }] };
  const f = fixture(t, job); fs.writeFileSync(f.file("one.pdf"), fake);
  const reader = f.reader(() => { throw new Error("partial translation must never merge"); });
  assert.equal((await reader.readTranslation({ id: "paper" })).status, "incomplete");
  const before = reader.getTranslationSignature({ id: "paper" });
  job.pages[1] = { page: 2, status: "completed", monoFile: "two.pdf" };
  fs.writeFileSync(f.file("two.pdf"), fake);
  assert.notEqual(reader.getTranslationSignature({ id: "paper" }), before);
});
test("complete progressive translation merges in page order with stable PDF bytes", async (t) => {
  const python = resolvePdfPagePython();
  if (!python) return t.skip("existing PyMuPDF runtime unavailable");
  const job = { jobId: "job", status: "completed", targetLang: "zh", pageCount: 2, pages: [{ page: 2, status: "completed", monoFile: "two.pdf" }, { page: 1, status: "completed", monoFile: "one.pdf" }] };
  const f = fixture(t, job);
  const options = { env: buildPdfPageRendererEnv(process.env, python.env), windowsHide: true, timeout: 30000 };
  await execute(python.cmd, [...python.extra, "-c", "import sys,fitz; d=fitz.open(); p=d.new_page(); p.insert_text((72,72),sys.argv[2]); d.save(sys.argv[1])", f.file("one.pdf"), "PAGE ONE"], options);
  await execute(python.cmd, [...python.extra, "-c", "import sys,fitz; d=fitz.open(); p=d.new_page(); p.insert_text((72,72),sys.argv[2]); d.save(sys.argv[1])", f.file("two.pdf"), "PAGE TWO"], options);
  const reader = f.reader(mergeTranslatedPages);
  const one = await reader.readTranslation({ id: "paper" });
  const two = await reader.readTranslation({ id: "paper" });
  assert.deepEqual(one.buffer, two.buffer, "repeat sync must retain content hash for deduplication");
  fs.writeFileSync(f.file("merged.pdf"), one.buffer);
  const { stdout } = await execute(python.cmd, [...python.extra, "-c", "import sys,fitz,json; d=fitz.open(sys.argv[1]); print(json.dumps([p.get_text().strip() for p in d]))", f.file("merged.pdf")], options);
  assert.deepEqual(JSON.parse(stdout), ["PAGE ONE", "PAGE TWO"]);
});

test("large progressive input resources may merge to a PDF below the upload limit", async (t) => {
  const job = { jobId: "job", status: "completed", targetLang: "zh", pageCount: 2, pages: [{ page: 1, status: "completed", monoFile: "one.pdf" }, { page: 2, status: "completed", monoFile: "two.pdf" }] };
  const f = fixture(t, job);
  for (const name of ["one.pdf", "two.pdf"]) {
    fs.writeFileSync(f.file(name), fake);
    fs.truncateSync(f.file(name), 51 * 1024 * 1024);
  }
  let merged = false;
  const reader = f.reader(async (files) => {
    assert.deepEqual(files, [f.file("one.pdf"), f.file("two.pdf")]);
    assert.ok(files.reduce((total, file) => total + fs.statSync(file).size, 0) > 100 * 1024 * 1024);
    merged = true;
    return fake;
  });
  assert.deepEqual((await reader.readTranslation({ id: "paper" })).buffer, fake);
  assert.equal(merged, true);
});
