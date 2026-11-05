import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolvePreservePython, buildPreservePythonEnv } from "./pdfPreserveRegions.js";

const script = fileURLToPath(new URL("./pdfSafeLayoutRepair.py", import.meta.url));

// Candidates live in a private temporary directory. Model coordinates only
// select areas to inspect; text removal additionally requires exact matching,
// no overlapping glyphs, and an unchanged remaining text layer.
export async function trySafeLayoutRepair({ sourcePdf, monoPdf, dualPdf, page, review, renderPage, reviewer, config, fetchImpl, signal }) {
  const boxes = review.issues.filter((issue) => issue.category === "overlap" || issue.category === "missing").map((issue) => issue.bbox);
  if (!boxes.length || !monoPdf) return { repaired: false };
  const py = resolvePreservePython();
  if (!py) return { repaired: false };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scholarloop-layout-repair-"));
  try {
    const inputs = [monoPdf, ...(dualPdf ? [dualPdf] : [])];
    const candidates = [];
    for (let i = 0; i < inputs.length; i += 1) {
      signal?.throwIfAborted();
      const candidate = path.join(dir, `candidate-${i}.pdf`);
      const result = spawnSync(py.cmd, [...py.extra, script], { input: JSON.stringify({ source: sourcePdf, dest: inputs[i], candidate, page, kind: i ? "dual" : "mono", boxes }), encoding: "utf8", env: buildPreservePythonEnv(py.env), timeout: 60000, windowsHide: true });
      if (result.status !== 0) return { repaired: false };
      let detail;
      try { detail = JSON.parse(result.stdout); } catch { return { repaired: false }; }
      if (!detail.changed || !fs.existsSync(candidate)) return { repaired: false };
      if (i && JSON.stringify(detail.removed) !== JSON.stringify(candidates[0].removed)) return { repaired: false };
      candidates.push({ path: candidate, removed: detail.removed });
    }
    const source = await renderPage(sourcePdf, page, { signal });
    const translated = await renderPage(candidates[0].path, 1, { signal });
    const checked = await reviewer({ source, translated, page, config, fetchImpl, signal });
    // A repair is adopted only when the second visual inspection finds fewer
    // problems and introduces no new category. Otherwise retain the old files.
    const oldCategories = new Set(review.issues.map((issue) => issue.category));
    if (checked.issues.length >= review.issues.length || checked.issues.some((issue) => !oldCategories.has(issue.category))) return { repaired: false };
    signal?.throwIfAborted();
    const backups = inputs.map((input, i) => { const backup = path.join(dir, `backup-${i}.pdf`); fs.copyFileSync(input, backup); return backup; });
    try {
      for (let i = 0; i < inputs.length; i += 1) fs.copyFileSync(candidates[i].path, inputs[i]);
    } catch (error) {
      for (let i = 0; i < inputs.length; i += 1) fs.copyFileSync(backups[i], inputs[i]);
      throw error;
    }
    return { repaired: true, review: checked, removed: candidates[0].removed.length };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
