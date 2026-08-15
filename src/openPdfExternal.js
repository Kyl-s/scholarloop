import { api } from "./api.js";

function hasElectronOpen() {
  return typeof window !== "undefined" && typeof window.scholarloop?.openPdfPath === "function";
}

/**
 * 用系统默认或自选程序打开 PDF。
 * @param {{ paperId?: string, pdfUrl?: string, data?: string, title?: string, chooseApp?: boolean }} opts
 * - paperId: 文献库条目（优先用已缓存的本地文件）
 * - data: base64 PDF（阅读器当前原文）
 * - chooseApp: true 时弹出「打开方式」让用户选软件（Windows / macOS）
 */
export async function openPdfExternal({
  paperId = "",
  pdfUrl = "",
  data = "",
  title = "",
  chooseApp = false
} = {}) {
  let filePath = "";

  if (paperId) {
    try {
      const local = await api.getPdfLocalPath(paperId);
      filePath = local?.path || "";
    } catch {
      filePath = "";
    }
  }

  if (!filePath && data) {
    const material = await api.materializePdf({
      data,
      sourceUrl: pdfUrl || title || ""
    });
    filePath = material?.path || "";
    // 若有 paperId，顺带写入文献库本地缓存，下次直接外部打开
    if (paperId && data) {
      try {
        await api.savePaperPdf(paperId, { data, sourceUrl: pdfUrl || "" });
      } catch {
        /* 非致命：仍可用 materialize 路径打开 */
      }
    }
  }

  if (!filePath) {
    throw new Error(
      paperId
        ? "该文献还没有本地 PDF。请先用内置阅读器打开一次，再点「用其他软件打开」。"
        : "当前没有可打开的 PDF 数据。"
    );
  }

  if (hasElectronOpen()) {
    const result = await window.scholarloop.openPdfPath(filePath, { chooseApp: Boolean(chooseApp) });
    if (result?.canceled) return { ok: false, canceled: true, path: filePath };
    return { ok: true, path: filePath, mode: result?.mode || "default" };
  }

  // 浏览器环境：无法可靠「自选程序」，退回下载让用户双击打开
  if (data) {
    const binary = atob(data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    const blob = new Blob([bytes], { type: "application/pdf" });
    const objectUrl = URL.createObjectURL(blob);
    const rawName = String(title || "paper")
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80) || "paper";
    const fileName = rawName.toLowerCase().endsWith(".pdf") ? rawName : `${rawName}.pdf`;
    const anchor = document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = fileName;
    anchor.rel = "noopener";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 2000);
    return { ok: true, mode: "download", path: fileName };
  }

  if (pdfUrl && /^https?:\/\//i.test(pdfUrl)) {
    window.open(pdfUrl, "_blank", "noopener");
    return { ok: true, mode: "browser", path: pdfUrl };
  }

  throw new Error("当前环境无法用外部软件打开，请使用桌面版 ScholarLoop。");
}

export function canOpenPdfExternal() {
  return hasElectronOpen();
}
