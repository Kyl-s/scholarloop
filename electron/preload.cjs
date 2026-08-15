const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("scholarloop", {
  pdfFetch: (url) => ipcRenderer.invoke("pdf-fetch", url),
  openInstitution: (url) => ipcRenderer.invoke("institution-open", url),
  /** 用系统默认或自选程序打开本地 PDF */
  openPdfPath: (filePath, options) => ipcRenderer.invoke("pdf-open-path", filePath, options || {})
});
