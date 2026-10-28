import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { createCredentialVault } from "./chatgptVault.js";
import { createStateFile, createZoteroService } from "./zotero.js";
import { readZoteroTranslation, getTranslationSignature } from "./zoteroTranslation.js";
import { getData, getSettings } from "./store.js";
import { getPdfCache, resolveLocalPdfPath, resolvePaperPdfPath } from "./pdfCache.js";
import { downloadPdf, MAX_PDF_BYTES } from "./pdfImportShared.js";
import { isPdfBuffer } from "./pdfResolve.js";
import { fetchWithProxy, getProxyUrl } from "./proxy.js";
import { isLocalChatGptRequest } from "./chatgptAuth.js";

const dataDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data");
export async function readZoteroPdf(paper) {
  const file = resolvePaperPdfPath(paper) || resolveLocalPdfPath(getPdfCache(paper.id)?.pdfUrl);
  if (file) {
    const stat = await fs.stat(file);
    if (stat.size > MAX_PDF_BYTES) throw new Error("PDF 超过 100 MB，请缩小文件后重试");
    const buffer = await fs.readFile(file);
    if (!isPdfBuffer(buffer)) throw new Error("本地附件不是有效 PDF，请重新导入全文");
    return { buffer, mtime: Math.trunc(stat.mtimeMs) };
  }
  if (!/^https?:\/\//i.test(String(paper.pdfUrl || ""))) return null;
  try {
    return await downloadPdf(paper.pdfUrl, { fetcher: (url, options) => fetchWithProxy(url, options, getProxyUrl(getSettings().proxy)) });
  } catch { return null; }
}

export function installZoteroRoutes(app) {
  let service;
  const getService = () => service ||= createZoteroService({
    vault: createCredentialVault({ file: path.join(process.env.LOCALAPPDATA || os.homedir(), "ScholarLoop", "zotero", "credentials.dpapi"), fallbackFile: null }),
    ...createStateFile(path.join(dataDir, "zotero-state.json")),
    getLibrary: () => getData().library,
    readPdf: readZoteroPdf,
    readTranslation: readZoteroTranslation,
    getTranslationSignature,
    fetcher: (url, options) => fetchWithProxy(url, options, getProxyUrl(getSettings().proxy))
  });
  app.use("/api/zotero", (req, res, next) => {
    res.set("Cache-Control", "no-store");
    if (!isLocalChatGptRequest(req)) return res.status(403).json({ error: "Zotero 授权与同步仅支持在本机操作" });
    next();
  });
  const route = (handler) => async (req, res) => {
    try {
      const zotero = getService();
      await zotero.ready;
      res.json(await handler(zotero, req));
    } catch (error) { res.status(400).json({ error: error.message }); }
  };
  app.get("/api/zotero/status", route((zotero) => zotero.status()));
  app.post("/api/zotero/config", route((zotero, req) => zotero.configure(req.body || {})));
  app.post("/api/zotero/test", route((zotero) => zotero.testConnection()));
  app.post("/api/zotero/disconnect", route((zotero) => zotero.disconnect()));
  app.post("/api/zotero/sync", route((zotero, req) => zotero.startSync(req.body?.ids)));
  const timer = setInterval(() => { try { getService().autoTick().catch(() => {}); } catch { /* Status endpoint exposes initialization errors. */ } }, 60000);
  timer.unref();
}
