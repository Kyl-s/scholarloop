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

contextBridge.exposeInMainWorld("scholarloop", {
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
  /**
   * 订阅内嵌浏览器捕获的 PDF 下载事件。
   * payload: { downloadId, url, filename, sourceUrl, cookies }
   * 返回取消订阅函数。
   */
  onPdfDownload: (listener) => {
    if (typeof listener !== "function") return () => {};
    const handler = (_event, payload) => listener(payload);
    ipcRenderer.on("pdf-download-captured", handler);
    return () => ipcRenderer.removeListener("pdf-download-captured", handler);
  },
  /** 用户选择「仍另存到磁盘」：主进程用原始 URL 重新下载并弹保存对话框 */
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
});
