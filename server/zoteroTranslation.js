import fs from "node:fs";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getPdfMathTranslationForPaper, getPdfMathTranslateFile } from "./pdfMathTranslate.js";
import { resolvePdfPagePython, buildPdfPageRendererEnv } from "./pdfPageRender.js";

const execute = promisify(execFile);
const MAX_BYTES = 100 * 1024 * 1024;
const digest = (value) => createHash("sha256").update(value).digest("hex");
const MERGE = `import sys,json,fitz
files=json.loads(sys.argv[1])
result=fitz.open()
for file in files:
    with fitz.open(file) as page:
        if len(page)!=1: raise ValueError('Expected one translated page')
        result.insert_pdf(page)
result.set_metadata({})
sys.stdout.buffer.write(result.tobytes(garbage=4,deflate=True,no_new_id=True))
`;

export async function mergeTranslatedPages(files) {
  const python = resolvePdfPagePython();
  if (!python) throw new Error("中文逐页译文合并需要现有 PDF 翻译工具的 PyMuPDF，请安装后重试");
  try {
    const { stdout } = await execute(python.cmd, [...python.extra, "-c", MERGE, JSON.stringify(files)], {
      env: buildPdfPageRendererEnv(process.env, python.env), windowsHide: true,
      encoding: "buffer", timeout: 120000, maxBuffer: MAX_BYTES
    });
    return stdout;
  } catch { throw new Error("中文逐页译文合并失败，原文附件已保留，请重试"); }
}

export function createZoteroTranslationReader({ getJob = getPdfMathTranslationForPaper, resolveFile = getPdfMathTranslateFile, merge = mergeTranslatedPages } = {}) {
  function inspect(paper) {
    const job = getJob(paper.id, { targetLang: "zh", sourceSha256: paper.pdfSha256 || "", requireOutput: true });
    if (!job || !/^zh(?:[-_].*)?$/i.test(job.targetLang || "")) return { status: "unavailable", message: "暂无中文排版译文" };
    const full = job.result?.monoFile && job.status === "completed" ? resolveFile(job.result.jobId || job.jobId, job.result.monoFile) : null;
    let files = full ? [full] : [];
    if (!full && Number.isInteger(job.pageCount) && job.pageCount > 0) {
      const pages = new Map((job.pages || []).map((page) => [page.page, page]));
      files = Array.from({ length: job.pageCount }, (_, index) => {
        const page = pages.get(index + 1);
        return page?.status === "completed" && page.monoFile ? resolveFile(job.jobId, page.monoFile) : null;
      });
    }
    const available = files.filter(Boolean);
    const complete = files.length > 0 && available.length === files.length;
    const stats = available.map((file) => {
      try { const stat = fs.statSync(file); return [file, stat.size, stat.mtimeMs, stat.ctimeMs]; }
      catch { return [file, "missing"]; }
    });
    const signature = digest(JSON.stringify([job.jobId, job.sourceSha256, job.updatedAt, complete, stats]));
    if (!complete) return { signature, status: "incomplete", message: "中文译文尚未完整生成，完整后自动同步", job };
    return { signature, status: "ready", files, full: Boolean(full), stats, job };
  }
  function getTranslationSignature(paper) { return inspect(paper).signature || ""; }
  async function readTranslation(paper, original) {
    const selection = inspect(paper);
    if (selection.status !== "ready") return { status: selection.status, message: selection.message };
    if (original?.buffer && selection.job.sourceSha256 && digest(original.buffer) !== selection.job.sourceSha256) {
      return { status: "source-mismatch", message: "中文译文对应旧版原文，请重新翻译后同步" };
    }
    if (selection.stats.some((entry) => typeof entry[1] !== "number")) throw new Error("中文译文文件不可读取，请重新生成后重试");
    if (selection.full && selection.stats[0][1] > MAX_BYTES) throw new Error("中文译文超过 100 MB，请缩小后重试");
    const buffer = selection.full ? await fs.promises.readFile(selection.files[0]) : await merge(selection.files);
    if (buffer.length > MAX_BYTES || buffer.subarray(0, 5).toString() !== "%PDF-") throw new Error("中文译文不是有效 PDF 或超过 100 MB");
    if (getTranslationSignature(paper) !== selection.signature) throw new Error("中文译文在读取时发生变化，请重新同步");
    return { buffer, mtime: Math.trunc(Math.max(...selection.stats.map((entry) => entry[2]))) };
  }
  return { getTranslationSignature, readTranslation };
}

export const { getTranslationSignature, readTranslation: readZoteroTranslation } = createZoteroTranslationReader();
