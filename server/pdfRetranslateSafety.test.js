import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { buildPreservePythonEnv, resolvePreservePython } from "./pdfPreserveRegions.js";
import { writeMinimalPdf } from "./pdfTestFixtures.js";
import { startPdfMathTranslation, cancelPdfMathTranslation, getPdfMathTranslationJob, unloadPdfMathTranslationJob, createPdfMathTranslationIdentity } from "./pdfMathTranslate.js";

const jobsDir = path.resolve("data/pdf-translations");
const source = Buffer.from("%PDF-1.7\nfixture\n%%EOF\n");
const base = { data: source.toString("base64"), pageCount: 34, progressive: true, priorityPage: 2, retranslatePage: 2, config: { baseUrl: "https://example.invalid/v1", apiKey: "fixture", model: "new-model" }, layoutAssist: { enabled: true } };

test("single-page retranslation without its original job never starts a new job", () => {
  const before = new Set(fs.readdirSync(jobsDir));
  assert.throws(() => startPdfMathTranslation(base), /无法确认原翻译任务/);
  assert.deepEqual(new Set(fs.readdirSync(jobsDir)), before);
});

test("single-page retranslation rejects a different PDF and preserves old pages", () => {
  const id = crypto.randomUUID();
  const dir = path.join(jobsDir, id);
  fs.mkdirSync(path.join(dir, "output"), { recursive: true });
  const output = path.join(dir, "output", "page-001.zh.mono.pdf");
  fs.writeFileSync(output, source);
  const job = { jobId: id, status: "completed", pageCount: 34, completedPages: 1, sourceSha256: crypto.createHash("sha256").update(source).digest("hex"), sourceLang: "en", targetLang: "zh", layoutAssist: { enabled: true }, identity: { model: "old-model" }, identityHash: "old-identity", pages: [{ page: 1, status: "completed", monoFile: "page-001.zh.mono.pdf" }] };
  fs.writeFileSync(path.join(dir, "job.json"), JSON.stringify(job));
  try {
    const before = new Set(fs.readdirSync(jobsDir));
    assert.throws(() => startPdfMathTranslation({ ...base, jobId: id, data: Buffer.from("%PDF-different").toString("base64") }), /原翻译任务或 PDF 不匹配/);
    assert.deepEqual(new Set(fs.readdirSync(jobsDir)), before);
    assert.deepEqual(fs.readFileSync(output), source);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});


test("matching single-page request resumes the selected job and preserves other pages", async () => {
  const id = crypto.randomUUID();
  const dir = path.join(jobsDir, id);
  const outputDir = path.join(dir, "output");
  fs.mkdirSync(outputDir, { recursive: true });
  const executable = path.join(dir, process.platform === "win32" ? "fixture.cmd" : "fixture.sh");
  fs.writeFileSync(executable, process.platform === "win32" ? "@echo off\r\nping 127.0.0.1 -n 20 >nul\r\n" : "#!/bin/sh\nsleep 20\n", { mode: 0o755 });
  fs.writeFileSync(path.join(dir, "source.pdf"), source);
  fs.writeFileSync(path.join(outputDir, "page-001.zh.mono.pdf"), source);
  fs.writeFileSync(path.join(outputDir, "page-003.zh.mono.pdf"), source);
  const config = { baseUrl: "https://example.invalid/v1", apiKey: "fixture", model: "test" };
  const sha = crypto.createHash("sha256").update(source).digest("hex");
  const identity = createPdfMathTranslationIdentity({ config, sourceSha256: sha, sourceLang: "en", targetLang: "zh", layoutAssist: { enabled: false }, binary: executable });
  const pages = [1, 2, 3].map((page) => ({ page, status: page === 2 ? "queued" : "completed", monoFile: page === 2 ? "" : `page-00${page}.zh.mono.pdf`, dualFile: "" }));
  fs.writeFileSync(path.join(dir, "job.json"), JSON.stringify({ jobId: id, status: "failed", pageCount: 3, completedPages: 2, sourceSha256: sha, sourceLang: "en", targetLang: "zh", layoutAssist: { enabled: false }, ...identity, pages }));
  try {
    const result = startPdfMathTranslation({ data: source.toString("base64"), pageCount: 3, progressive: true, priorityPage: 2, retranslatePage: 2, config, binary: executable, layoutAssist: { enabled: false }, jobId: id });
    assert.equal(result.jobId, id);
    assert.equal(result.pages.find((page) => page.page === 1).status, "completed");
    assert.equal(result.pages.find((page) => page.page === 3).status, "completed");
    assert.deepEqual(fs.readFileSync(path.join(outputDir, "page-003.zh.mono.pdf")), source);
  } finally {
    cancelPdfMathTranslation(id);
    for (let i = 0; i < 100; i += 1) {
      if (["canceled", "failed", "completed"].includes(getPdfMathTranslationJob(id)?.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});


test("mixed-model single-page success replaces only that page and survives reload", async (t) => {
  const py = resolvePreservePython();
  if (!py) return t.skip("PyMuPDF unavailable");
  const id = crypto.randomUUID(), dir = path.join(jobsDir, id), output = path.join(dir, "output");
  fs.mkdirSync(output, { recursive: true });
  const sourceFile = path.join(dir, "source.pdf"), generated = path.join(dir, "fixture-output.pdf");
  const script = "import fitz,sys\nd=fitz.open()\nfor i in range(3):\n p=d.new_page(); p.insert_text((50,80),'Original text page '+str(i+1))\nd.save(sys.argv[1])\nd=fitz.open(); p=d.new_page(); p.insert_text((50,80),'New translated page')\nd.save(sys.argv[2])";
  const made = spawnSync(py.cmd, [...py.extra, "-c", script, sourceFile, generated], { env: buildPreservePythonEnv(py.env), encoding: "utf8" });
  assert.equal(made.status, 0, made.stderr);
  const original = fs.readFileSync(sourceFile), old = fs.readFileSync(generated);
  for (const n of [1,2,3]) fs.copyFileSync(generated, path.join(output, `page-00${n}.zh.mono.pdf`));
  const executable = path.join(dir, process.platform === "win32" ? "fixture.cmd" : "fixture.sh");
  fs.writeFileSync(executable, process.platform === "win32" ? `@echo off\r\ncopy /y "${generated}" "%~3\\source.zh.mono.pdf" >nul\r\n` : `#!/bin/sh\ncp "${generated}" "$3/source.zh.mono.pdf"\n`, { mode: 0o755 });
  const sha = crypto.createHash("sha256").update(original).digest("hex");
  const oldIdentity = { model: "old-model", provider: "old-provider" };
  const pages = [1,2,3].map((page) => ({ page, status: "completed", monoFile: `page-00${page}.zh.mono.pdf`, dualFile: "" }));
  fs.writeFileSync(path.join(dir, "job.json"), JSON.stringify({ jobId: id, status: "completed", pageCount: 3, completedPages: 3, sourceSha256: sha, sourceLang: "en", targetLang: "zh", layoutAssist: { enabled: false }, identity: oldIdentity, identityHash: "old-hash", pages }));
  try {
    let result = startPdfMathTranslation({ data: original.toString("base64"), pageCount: 3, progressive: true, priorityPage: 2, retranslatePage: 2, config: { baseUrl: "https://example.invalid/v1", apiKey: "fixture", model: "new-model" }, binary: executable, layoutAssist: { enabled: false }, jobId: id });
    assert.equal(result.jobId, id);
    for (let i=0; i<100 && !["completed", "failed"].includes(result.status); i++) { await new Promise(r => setTimeout(r, 50)); result = getPdfMathTranslationJob(id); }
    assert.equal(result.status, "completed", result.error);
    assert.equal(result.completedPages, 3);
    const page2 = result.pages.find(p => p.page === 2);
    assert.match(page2.monoFile, /^page-002\.v-/);
    assert.equal(page2.translationIdentity.model, "new-model");
    assert.deepEqual(fs.readFileSync(path.join(output, "page-002.zh.mono.pdf")), old);
    assert.deepEqual(fs.readFileSync(path.join(output, "page-003.zh.mono.pdf")), old);
    unloadPdfMathTranslationJob(id);
    const restored = getPdfMathTranslationJob(id);
    assert.equal(restored.pages.find(p => p.page === 2).monoFile, page2.monoFile);
    assert.equal(restored.pages.find(p => p.page === 2).translationIdentity.model, "new-model");
    assert.equal(restored.completedPages, 3);
  } finally {
    cancelPdfMathTranslation(id);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("mixed-model failed retranslation retains the previous page and all other pages", async () => {
  const id = crypto.randomUUID(), dir = path.join(jobsDir, id), output = path.join(dir, "output");
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(dir, "source.pdf"), source);
  for (const page of [1,2,3]) fs.writeFileSync(path.join(output, `page-00${page}.zh.mono.pdf`), source);
  const executable = path.join(dir, process.platform === "win32" ? "failure.cmd" : "failure.sh");
  fs.writeFileSync(executable, process.platform === "win32" ? "@echo off\r\nexit /b 7\r\n" : "#!/bin/sh\nexit 7\n", { mode: 0o755 });
  const sha = crypto.createHash("sha256").update(source).digest("hex");
  const pages = [1,2,3].map((page) => ({ page, status: "completed", monoFile: `page-00${page}.zh.mono.pdf`, translationIdentity: { model: "old-model" } }));
  fs.writeFileSync(path.join(dir, "job.json"), JSON.stringify({ jobId: id, status: "completed", pageCount: 3, completedPages: 3, sourceSha256: sha, sourceLang: "en", targetLang: "zh", layoutAssist: { enabled: false }, identity: { model: "old-model" }, identityHash: "old", pages }));
  try {
    let result = startPdfMathTranslation({ data: source.toString("base64"), pageCount: 3, progressive: true, priorityPage: 2, retranslatePage: 2, config: { baseUrl: "https://example.invalid", apiKey: "fixture", model: "new-model" }, binary: executable, layoutAssist: { enabled: false }, jobId: id });
    for (let i=0; i<100 && !["completed", "failed"].includes(result.status); i++) { await new Promise(r => setTimeout(r, 50)); result = getPdfMathTranslationJob(id); }
    assert.equal(result.status, "failed");
    assert.equal(result.pages.find(p => p.page === 2).status, "completed");
    assert.equal(result.pages.find(p => p.page === 2).translationIdentity.model, "old-model");
    assert.deepEqual(fs.readFileSync(path.join(output, "page-002.zh.mono.pdf")), source);
    assert.deepEqual(fs.readFileSync(path.join(output, "page-003.zh.mono.pdf")), source);
    unloadPdfMathTranslationJob(id);
    assert.equal(getPdfMathTranslationJob(id).completedPages, 3);
  } finally { cancelPdfMathTranslation(id); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("canceling mixed-model retranslation restores the old page and its provenance", async () => {
  const id = crypto.randomUUID(), dir = path.join(jobsDir, id), output = path.join(dir, "output");
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(dir, "source.pdf"), source);
  for (const page of [1,2,3]) fs.writeFileSync(path.join(output, `page-00${page}.zh.mono.pdf`), source);
  const executable = path.join(dir, process.platform === "win32" ? "wait.cmd" : "wait.sh");
  fs.writeFileSync(executable, process.platform === "win32" ? "@echo off\r\nping 127.0.0.1 -n 20 >nul\r\n" : "#!/bin/sh\nsleep 20\n", { mode: 0o755 });
  const sha = crypto.createHash("sha256").update(source).digest("hex");
  const pages = [1,2,3].map((page) => ({ page, status: "completed", monoFile: `page-00${page}.zh.mono.pdf`, translationIdentity: { model: "old-model" } }));
  fs.writeFileSync(path.join(dir, "job.json"), JSON.stringify({ jobId: id, status: "completed", pageCount: 3, completedPages: 3, sourceSha256: sha, sourceLang: "en", targetLang: "zh", layoutAssist: { enabled: false }, identity: { model: "old-model" }, identityHash: "old", pages }));
  try {
    startPdfMathTranslation({ data: source.toString("base64"), pageCount: 3, progressive: true, priorityPage: 2, retranslatePage: 2, config: { baseUrl: "https://example.invalid", apiKey: "fixture", model: "new-model" }, binary: executable, layoutAssist: { enabled: false }, jobId: id });
    cancelPdfMathTranslation(id);
    let result;
    for (let i=0; i<100; i++) { await new Promise(r => setTimeout(r, 50)); result = getPdfMathTranslationJob(id); if (result.status === "canceled") break; }
    assert.equal(result.status, "canceled");
    const previous = result.pages.find(p => p.page === 2);
    assert.equal(previous.status, "completed");
    assert.equal(previous.monoFile, "page-002.zh.mono.pdf");
    assert.equal(previous.translationIdentity.model, "old-model");
    assert.deepEqual(fs.readFileSync(path.join(output, previous.monoFile)), source);
  } finally { cancelPdfMathTranslation(id); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("continuing with a legacy identity starts a new job and preserves old pages", async (t) => {
  const py = resolvePreservePython(); if (!py) return t.skip("PyMuPDF unavailable");
  const id = crypto.randomUUID(), dir = path.join(jobsDir,id), output = path.join(dir,"output");
  fs.mkdirSync(output,{recursive:true});
  const input = path.join(dir,"source.pdf"), generated = path.join(dir,"candidate.pdf");
  const script = "import fitz,sys\nd=fitz.open()\nfor i in range(3):\n p=d.new_page(); p.insert_text((50,80),'Original page '+str(i+1))\nd.save(sys.argv[1])\nd=fitz.open();p=d.new_page();p.insert_text((50,80),'Translated page')\nd.save(sys.argv[2])";
  const made=spawnSync(py.cmd,[...py.extra,"-c",script,input,generated],{env:buildPreservePythonEnv(py.env),encoding:"utf8"}); assert.equal(made.status,0,made.stderr);
  const original=fs.readFileSync(input), existing=fs.readFileSync(generated);
  for(const p of [1,2]) fs.copyFileSync(generated,path.join(output,`page-00${p}.zh.mono.pdf`));
  const executable=path.join(dir,process.platform==="win32"?"fixture.cmd":"fixture.sh");
  fs.writeFileSync(executable,process.platform==="win32"?`@echo off\r\ncopy /y "${generated}" "%~3\\source.zh.mono.pdf" >nul\r\n`:`#!/bin/sh\ncp "${generated}" "$3/source.zh.mono.pdf"\n`,{mode:0o755});
  const sha=crypto.createHash("sha256").update(original).digest("hex");
  const pages=[1,2,3].map(p=>({page:p,status:p===3?"queued":"completed",monoFile:p===3?"":`page-00${p}.zh.mono.pdf`}));
  // 旧身份没有 termGlossaryHash：按新策略视为术语表失效，不能继续复用旧页。
  fs.writeFileSync(path.join(dir,"job.json"),JSON.stringify({jobId:id,status:"failed",pageCount:3,completedPages:2,sourceSha256:sha,sourceLang:"en",targetLang:"zh",layoutAssist:{enabled:false},identity:{model:"old-model"},identityHash:"old",pages}));
  let newJobId = "";
  try {
    let result=startPdfMathTranslation({data:original.toString("base64"),pageCount:3,progressive:true,priorityPage:1,config:{baseUrl:"https://example.invalid",apiKey:"fixture",model:"new-model"},binary:executable,layoutAssist:{enabled:false},jobId:id});
    assert.notEqual(result.jobId, id);
    assert.equal(result.staleReason, "terminology-updated");
    assert.equal(result.supersededJobId, id);
    newJobId = result.jobId;
    for(let i=0;i<100&&!['completed','failed','canceled'].includes(result.status);i++){await new Promise(r=>setTimeout(r,50));result=getPdfMathTranslationJob(newJobId)}
    assert.equal(result.status,"completed",result.error); assert.equal(result.completedPages,3);
    assert.equal(result.pages[2].translationIdentity.model,"new-model");
    // 旧任务的完成页必须原样保留，不被新任务覆盖。
    const oldJob = getPdfMathTranslationJob(id);
    assert.equal(oldJob.completedPages, 2);
    assert.deepEqual(fs.readFileSync(path.join(output,"page-001.zh.mono.pdf")),existing);
    assert.deepEqual(fs.readFileSync(path.join(output,"page-002.zh.mono.pdf")),existing);
  } finally {
    if (newJobId) cancelPdfMathTranslation(newJobId);
    for (let i=0;i<100;i+=1) {
      const current = newJobId ? getPdfMathTranslationJob(newJobId) : null;
      if (!current || ["completed","failed","canceled"].includes(current.status)) break;
      await new Promise(r=>setTimeout(r,50));
    }
    cancelPdfMathTranslation(id);
    fs.rmSync(dir,{recursive:true,force:true});
    if (newJobId) fs.rmSync(path.join(jobsDir,newJobId),{recursive:true,force:true});
  }
});

test("legacy identity continues in place when the glossary is explicitly disabled", async () => {
  const id = crypto.randomUUID(), dir = path.join(jobsDir, id), output = path.join(dir, "output");
  fs.mkdirSync(output, { recursive: true });
  const input = writeMinimalPdf(path.join(dir, "source.pdf"), { pages: 3, text: "Original page text" });
  const generated = writeMinimalPdf(path.join(dir, "translated.pdf"), { pages: 1, text: "Hello" });
  const original = fs.readFileSync(input), existing = fs.readFileSync(generated);
  for (const page of [1, 2]) fs.copyFileSync(generated, path.join(output, `page-00${page}.zh.mono.pdf`));
  const executable = path.join(dir, process.platform === "win32" ? "fixture.cmd" : "fixture.sh");
  fs.writeFileSync(
    executable,
    process.platform === "win32" ? `@echo off\r\ncopy /y "${generated}" "%~3\\source.zh.mono.pdf" >nul\r\n` : `#!/bin/sh\ncp "${generated}" "$3/source.zh.mono.pdf"\n`,
    { mode: 0o755 }
  );
  const sha = crypto.createHash("sha256").update(original).digest("hex");
  const pages = [1, 2, 3].map((page) => ({
    page,
    status: page === 3 ? "queued" : "completed",
    monoFile: page === 3 ? "" : `page-00${page}.zh.mono.pdf`
  }));
  fs.writeFileSync(path.join(dir, "job.json"), JSON.stringify({
    jobId: id,
    status: "failed",
    pageCount: 3,
    completedPages: 2,
    sourceSha256: sha,
    sourceLang: "en",
    targetLang: "zh",
    layoutAssist: { enabled: false },
    identity: { model: "old-model" },
    identityHash: "old",
    pages
  }));
  try {
    let result = startPdfMathTranslation({
      data: original.toString("base64"),
      pageCount: 3,
      progressive: true,
      priorityPage: 1,
      config: { baseUrl: "https://example.invalid", apiKey: "fixture", model: "new-model", pdfMathNoGlossary: true },
      binary: executable,
      layoutAssist: { enabled: false },
      jobId: id
    });
    assert.equal(result.jobId, id, "显式关闭术语表时，旧 identity 不应被误判为术语表失效");
    assert.equal(result.staleReason || "", "");
    for (let i = 0; i < 100 && !["completed", "failed", "canceled"].includes(result.status); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      result = getPdfMathTranslationJob(id);
    }
    assert.equal(result.status, "completed", result.error || result.progress);
    assert.equal(result.completedPages, 3);
    assert.equal(result.pages[2].translationIdentity.model, "new-model");
    assert.deepEqual(fs.readFileSync(path.join(output, "page-001.zh.mono.pdf")), existing);
    assert.deepEqual(fs.readFileSync(path.join(output, "page-002.zh.mono.pdf")), existing);
  } finally {
    cancelPdfMathTranslation(id);
    for (let i = 0; i < 100; i += 1) {
      const current = getPdfMathTranslationJob(id);
      if (!current || ["completed", "failed", "canceled"].includes(current.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    fs.rmSync(path.join(jobsDir, id), { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

