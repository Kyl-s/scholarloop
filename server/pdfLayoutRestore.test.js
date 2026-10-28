import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { getPdfMathTranslationForPaper, unloadPdfMathTranslationJob } from "./pdfMathTranslate.js";
import { pdfLayoutJobMatchesRestore } from "./pdfLayoutRestore.js";

test("historical reading survives model, fingerprint and engine changes", () => {
  const request = { paperId: "paper", sourceSha256: "source", layoutAssist: true, sourceLang: "en", targetLang: "zh" };
  const job = {
    jobId: "old", paperId: "paper", sourceSha256: "source", layoutAssist: { enabled: true }, sourceLang: "en", targetLang: "zh",
    identity: { model: "old-model", baseUrl: "https://old.example", configFingerprint: "old", engine: { commandHash: "old" } }
  };
  assert.equal(pdfLayoutJobMatchesRestore(job, { ...request, model: "new-model", baseUrl: "https://new.example", configFingerprint: "new", engine: null }), true);
  assert.equal(pdfLayoutJobMatchesRestore({ ...job, identity: null }, request), true, "legacy snapshots remain readable");
  for (const patch of [
    { paperId: "other" }, { sourceSha256: "other" }, { sourceSha256: "" },
    { layoutAssist: false }, { layoutAssist: undefined }, { sourceLang: "fr" }, { targetLang: "fr" }
  ]) assert.equal(pdfLayoutJobMatchesRestore(job, { ...request, ...patch }), false);
});

test("restore skips a newer empty job and retains older partial output", () => {
  const paperId = `restore-regression-${randomUUID()}`;
  const ids = [randomUUID(), randomUUID()];
  const root = path.resolve("data/pdf-translations");
  const index = path.join(root, "by-paper", `${paperId}.json`);
  const sourceSha256 = "source-regression-hash";
  try {
    ids.forEach((jobId, i) => {
      const dir = path.join(root, jobId);
      fs.mkdirSync(path.join(dir, "output"), { recursive: true });
      if (i === 0) fs.writeFileSync(path.join(dir, "output", "page-1-mono.pdf"), "%PDF-1.4\n%%EOF\n");
      fs.writeFileSync(path.join(dir, "job.json"), JSON.stringify({
        jobId, paperId, sourceSha256, sourceLang: "en", targetLang: "zh",
        status: i === 0 ? "completed" : "failed", updatedAt: 100 + i,
        pageCount: 2, completedPages: i === 0 ? 1 : 0,
        layoutAssist: { enabled: true },
        identity: { model: "old-model", baseUrl: "https://old.example", configFingerprint: "old" },
        pages: [{ page: 1, status: i === 0 ? "completed" : "failed", monoFile: i === 0 ? "page-1-mono.pdf" : "" }]
      }));
    });
    const restored = getPdfMathTranslationForPaper(paperId, {
      sourceSha256, sourceLang: "en", targetLang: "zh", layoutAssist: true, requireOutput: true
    });
    assert.equal(restored?.jobId, ids[0]);
    assert.equal(getPdfMathTranslationForPaper(paperId, {
      sourceSha256: "different-source", layoutAssist: true, requireOutput: true
    }), null);
    assert.equal(getPdfMathTranslationForPaper(paperId, {
      sourceSha256, layoutAssist: false, requireOutput: true
    }), null);
    assert.equal(getPdfMathTranslationForPaper(paperId, {
      sourceSha256, targetLang: "fr", layoutAssist: true, requireOutput: true
    }), null);
    assert.equal(getPdfMathTranslationForPaper(paperId, {
      sourceSha256, layoutAssist: true, model: "new-model", requireOutput: true
    }), null, "strict model lookup remains strict");
    fs.rmSync(path.join(root, ids[0], "output", "page-1-mono.pdf"));
    ids.forEach(unloadPdfMathTranslationJob);
    assert.equal(getPdfMathTranslationForPaper(paperId, {
      sourceSha256, layoutAssist: true, requireOutput: true
    }), null, "missing output cannot be restored");
  } finally {
    ids.forEach((id) => {
      unloadPdfMathTranslationJob(id);
      fs.rmSync(path.join(root, id), { recursive: true, force: true });
    });
    fs.rmSync(index, { force: true });
  }
});

test("restore prefers legacy six-page output over a newer two-page task", () => {
  const paperId = `restore-coverage-${randomUUID()}`;
  const ids = [randomUUID(), randomUUID()];
  const root = path.resolve("data/pdf-translations");
  const sourceSha256 = "coverage-source";
  try {
    ids.forEach((jobId, index) => {
      const dir = path.join(root, jobId);
      fs.mkdirSync(path.join(dir, "output"), { recursive: true });
      const pages = Array.from({ length: index === 0 ? 6 : 2 }, (_, i) => {
        const monoFile = `page-${i + 1}.zh.mono.pdf`;
        fs.writeFileSync(path.join(dir, "output", monoFile), "%PDF-1.4\n%%EOF\n");
        return { page: i + 1, status: "completed", monoFile };
      });
      fs.writeFileSync(path.join(dir, "job.json"), JSON.stringify({
        jobId, paperId, sourceSha256, sourceLang: "en", targetLang: "zh", status: "completed",
        pages, pageCount: 12, completedPages: pages.length, updatedAt: 100 + index,
        ...(index === 0 ? {} : { layoutAssist: { enabled: false } })
      }));
    });
    const restored = getPdfMathTranslationForPaper(paperId, { sourceSha256, layoutAssist: false, requireOutput: true });
    assert.equal(restored?.jobId, ids[0]);
    assert.equal(restored.completedPages, 6);
    assert.equal(pdfLayoutJobMatchesRestore(restored, { paperId, sourceSha256, layoutAssist: false }), true);
    assert.equal(getPdfMathTranslationForPaper(paperId, { sourceSha256, layoutAssist: false })?.jobId, ids[1], "default strict query retains existing behavior");
  } finally {
    ids.forEach((id) => {
      unloadPdfMathTranslationJob(id);
      fs.rmSync(path.join(root, id), { recursive: true, force: true });
    });
    fs.rmSync(path.join(root, "by-paper", `${paperId}.json`), { force: true });
  }
});
