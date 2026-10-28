// Reading an existing PDF does not depend on the model or executable that is
// currently selected. Translation generation and resume keep their own strict
// identity checks; restoration only verifies the document and requested mode.
export function pdfLayoutJobMatchesRestore(job, {
  paperId = "", sourceSha256 = "", layoutAssist, sourceLang = "en", targetLang = "zh"
} = {}) {
  if (!job || !paperId || !sourceSha256 || typeof layoutAssist !== "boolean") return false;
  return String(job.paperId || "") === String(paperId)
    && String(job.sourceSha256 || "") === String(sourceSha256)
    && (job.layoutAssist?.enabled === true) === layoutAssist
    && String(job.sourceLang || "en").toLowerCase() === String(sourceLang).toLowerCase()
    && String(job.targetLang || "zh").toLowerCase() === String(targetLang).toLowerCase();
}
