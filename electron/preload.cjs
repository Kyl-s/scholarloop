const { contextBridge, ipcRenderer } = require("electron");

// Keep the preload self-contained: the main window uses a sandboxed preload,
// where requiring arbitrary local CommonJS modules is not portable across
// Electron versions. The main-process helper performs the same validation
// before sending this event.
function safeHttpUrl(value) {
  if (typeof value !== "string") return null;
  const target = value.trim();
  if (!target) return null;
  try {
    const parsed = new URL(target);
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || !parsed.hostname) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

// PDF 下载拦截 API：scholarloop 与 scholarloopDownloads 共用同一实现
const pdfDownloadApi = {
  /**
   * 订阅内嵌浏览器捕获的 PDF 下载事件。
   * payload: { downloadId, url, filename, sourceUrl, state, receivedBytes, totalBytes, error? }
   * 返回取消订阅函数。
   */
  onPdfDownload: (listener) => {
    if (typeof listener !== "function") return () => {};
    const handler = (_event, payload) => listener(payload);
    ipcRenderer.on("pdf-download-captured", handler);
    return () => ipcRenderer.removeListener("pdf-download-captured", handler);
  },
  readCapturedPdf: (downloadId) => ipcRenderer.invoke("pdf-download-read", downloadId),
  downloadPortalPdf: (url, sourceUrl) => ipcRenderer.invoke("pdf-portal-download", url, sourceUrl),
  onPdfPortalStatus: (listener) => {
    if (typeof listener !== "function") return () => {};
    const handler = (_event, payload) => listener(payload);
    ipcRenderer.on("pdf-portal-status", handler);
    return () => ipcRenderer.removeListener("pdf-portal-status", handler);
  },
  /** 另存已接管的原始 PDF，不重放下载请求。 */
  savePdfAs: (downloadId) => ipcRenderer.invoke("pdf-download-save-as", downloadId),
  /**
   * 订阅「另存 PDF」结果事件。
   * payload: { downloadId, ok, path? | error? }
   * 返回取消订阅函数。
   */
  onPdfDownloadSaved: (listener) => {
    if (typeof listener !== "function") return () => {};
    const handler = (_event, payload) => listener(payload);
    ipcRenderer.on("pdf-download-saved", handler);
    return () => ipcRenderer.removeListener("pdf-download-saved", handler);
  }
};

contextBridge.exposeInMainWorld("scholarloop", {
  // Synchronous persistence keeps existing save/activate actions atomic and
  // restores the selection before React renders, regardless of server port.
  readAgentConfig: () => {
    const result = ipcRenderer.sendSync("agent-config-store", "read");
    if (!result?.ok) throw new Error(result?.error || "模型配置读取失败");
    return result.value;
  },
  writeAgentConfig: (value) => {
    const result = ipcRenderer.sendSync("agent-config-store", "write", value);
    if (!result?.ok) throw new Error(result?.error || "模型配置保存失败");
  },
  pdfFetch: (url) => ipcRenderer.invoke("pdf-fetch", url),
  openInstitution: (url) => ipcRenderer.invoke("institution-open", url),
  /** Subscribe to safe popup requests from the embedded institution browser. */
  onInstitutionPopup: (listener) => {
    if (typeof listener !== "function") return () => {};
    const handler = (_event, value) => {
      const url = safeHttpUrl(value);
      if (url) listener(url);
    };
    ipcRenderer.on("institution-popup", handler);
    return () => ipcRenderer.removeListener("institution-popup", handler);
  },
  /** 用系统默认或自选程序打开本地 PDF */
  openPdfPath: (filePath, options) => ipcRenderer.invoke("pdf-open-path", filePath, options || {}),
  /** 用系统默认程序打开手记附件 */
  openNoteFile: (fileId) => ipcRenderer.invoke("note-open-file", fileId),
  ...pdfDownloadApi
});

// 统一命名契约：前端通过 window.scholarloopDownloads 访问 PDF 下载 API
contextBridge.exposeInMainWorld("scholarloopDownloads", pdfDownloadApi);
