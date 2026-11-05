const { app, BrowserWindow, dialog, shell, Tray, Menu, nativeImage, net, ipcMain, session, safeStorage } = require("electron");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { createInstitutionPopupHandler, safeHttpUrl } = require("./institutionPopup.cjs");
const { createAgentConfigVault } = require("./agentConfigVault.cjs");

const ROOT = path.join(__dirname, "..");
const PRELOAD = path.join(__dirname, "preload.cjs");
const DIST_INDEX = path.join(ROOT, "dist", "index.html");
let serverProc = null;
let mainWindow = null;
let institutionWindow = null;
let tray = null;
let isQuitting = false;

async function waitForHealth(port, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1500) });
      if (res.ok) return true;
    } catch {
      /* server still booting */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

/** 收集目录下最新 mtime（毫秒）；目录不存在返回 0 */
function latestMtime(dir, exts) {
  if (!fs.existsSync(dir)) return 0;
  let latest = 0;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      const full = path.join(cur, ent.name);
      if (ent.isDirectory()) {
        if (ent.name === "node_modules" || ent.name === "dist" || ent.name === "data") continue;
        stack.push(full);
      } else if (ent.isFile()) {
        if (exts && !exts.some((e) => ent.name.endsWith(e))) continue;
        try {
          const t = fs.statSync(full).mtimeMs;
          if (t > latest) latest = t;
        } catch {
          /* skip */
        }
      }
    }
  }
  return latest;
}

function needsRebuild() {
  if (!fs.existsSync(DIST_INDEX)) return true;
  let distTime = 0;
  try {
    distTime = fs.statSync(DIST_INDEX).mtimeMs;
  } catch {
    return true;
  }
  // 前端源码 / 入口 / 配置变更时重建，避免桌面版一直吃旧 dist（例如缺 AI 解读按钮）
  const srcTime = Math.max(
    latestMtime(path.join(ROOT, "src"), [".js", ".jsx", ".ts", ".tsx", ".css", ".svg", ".png"]),
    latestMtime(path.join(ROOT, "shared")),
    latestMtime(path.join(ROOT, "public")),
    ...["index.html", "vite.config.js", "vite.config.ts", "package.json"].map((f) => {
      try {
        return fs.statSync(path.join(ROOT, f)).mtimeMs;
      } catch {
        return 0;
      }
    })
  );
  return srcTime > distTime + 500; // 500ms 容差，避免时钟抖动误判
}

async function ensureBuild() {
  if (!needsRebuild()) return;
  console.log("[scholarloop] rebuilding frontend (src newer than dist or dist missing)…");
  await new Promise((resolve, reject) => {
    const child = spawn("npm", ["run", "build"], {
      cwd: ROOT,
      shell: true,
      windowsHide: true,
      stdio: "inherit"
    });
    child.once("error", reject);
    child.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`build failed with code ${code}`))));
  });
}

function stopServer() {
  if (serverProc && !serverProc.killed) {
    serverProc.kill();
    serverProc = null;
  }
}

function readMinimizeToTray() {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "store.json"), "utf8"));
    return raw?.settings?.minimizeToTray !== false;
  } catch {
    return true;
  }
}

function restoreWindow() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function createTray() {
  const iconPath = path.join(ROOT, "assets", "app-v2.ico");
  const image = nativeImage.createFromPath(iconPath);
  tray = new Tray(image);
  tray.setToolTip("ScholarLoop");
  tray.setContextMenu(Menu.buildFromTemplate([
    {
      label: "打开 ScholarLoop",
      click: restoreWindow
    },
    { type: "separator" },
    {
      label: "彻底退出",
      click: () => {
        isQuitting = true;
        stopServer();
        app.quit();
      }
    }
  ]));
  tray.on("click", restoreWindow);
}

function startServer() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, "server", "index.js")], {
      cwd: ROOT,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", PORT: "0" },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    serverProc = child;
    let stdout = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error("本地服务启动超时"));
      }
    }, 60000);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      const match = stdout.match(/SCHOLARLOOP_PORT=(\d+)/);
      if (match && !settled) {
        settled = true;
        clearTimeout(timer);
        console.log(`[scholarloop] spawned server on port ${match[1]}`);
        resolve(Number(match[1]));
      }
    });
    child.stderr.on("data", (chunk) => console.error("[scholarloop] server stderr:", chunk.toString()));
    child.on("error", (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(err);
      }
    });
    child.on("exit", (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error(`本地服务异常退出 code=${code}`));
      }
    });
  });
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    restoreWindow();
  });

  app.whenReady().then(async () => {
    try {
      app.setAppUserModelId("com.scholarloop.desktop");
      await ensureBuild();
      console.log("[scholarloop] build ok");
      const port = await startServer();
      const healthy = await waitForHealth(port, 80);
      console.log(`[scholarloop] healthy=${healthy}`);
      if (!healthy) throw new Error(`本地服务启动失败 (port ${port})`);

      mainWindow = new BrowserWindow({
        width: 1440,
        height: 900,
        minWidth: 1060,
        minHeight: 680,
        title: "ScholarLoop",
        icon: path.join(ROOT, "assets", "app-v2.ico"),
        autoHideMenuBar: true,
        backgroundColor: "#f4f6fb",
        webPreferences: {
          contextIsolation: true,
          sandbox: true,
          webviewTag: true,
          preload: PRELOAD
        }
      });

      mainWindow.setMenuBarVisibility(false);
      const configVault = createAgentConfigVault(path.join(app.getPath("userData"), "agent-config.enc"), safeStorage);
      const rendererOrigin = `http://127.0.0.1:${port}`;
      ipcMain.on("agent-config-store", (event, operation, value) => {
        try {
          if (event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame ||
              new URL(event.senderFrame.url).origin !== rendererOrigin) throw new Error("模型配置访问被拒绝");
          if (operation === "read") event.returnValue = { ok: true, value: configVault.read() };
          else if (operation === "write") {
            configVault.write(value);
            event.returnValue = { ok: true };
          } else throw new Error("未知配置操作");
        } catch {
          event.returnValue = { ok: false, error: "无法读取或保存本机模型配置" };
        }
      });
      mainWindow.loadURL(`http://127.0.0.1:${port}/`);

      // 所有机构页面的弹窗都交由主渲染进程创建内嵌标签页，避免产生未受控原生窗口。
      const forwardInstitutionPopup = (url) => {
        if (!mainWindow || mainWindow.isDestroyed()) return;
        mainWindow.webContents.send("institution-popup", url);
      };

      // <webview> uses a separate guest WebContents, so the main window's
      // handler below does not receive target="_blank" requests from it.
      mainWindow.webContents.on("did-attach-webview", (_event, guestContents) => {
        // 给 webview 实际使用的 session 挂 PDF 下载接管（内部按 session 去重，不会重复触发）
        attachPdfDownloadHandler(guestContents.session);
        guestContents.on("dom-ready", () => {
          // Annual Reviews uses empty POST forms around href="#" PDF buttons.
          // Its /deliver/fulltext PDF endpoint accepts GET as well (verified in-app).
          // Route only this observed, same-origin, field-free form through native downloads.
          guestContents.executeJavaScript(`(() => {
            if (!/(^|\\.)annualreviews\\.org$/i.test(location.hostname)) return;
            document.addEventListener('click', event => {
              const control = event.target.closest?.('a,button');
              const form = control?.closest('form');
              if (!form || !control.matches('[aria-label="Download PDF"],.access-options-icon')) return;
              const action = new URL(form.action, location.href);
              if (action.origin !== location.origin || !/^\\/deliver\\/fulltext\\/.+\\.pdf$/i.test(action.pathname) || form.querySelector('input[name],select[name],textarea[name]')) return;
              event.preventDefault();
              event.stopImmediatePropagation();
              location.assign(action.href);
            }, true);
          })()`).catch(() => { /* guest navigated before installation */ });
        });
        guestContents.setWindowOpenHandler(createInstitutionPopupHandler({
          notify: (url) => {
            if (!capturePdfNavigation(guestContents, url)) forwardInstitutionPopup(url);
          },
          onRejected: () => sendPortalStatus({ state: "failed", error: "站点尝试打开无法接管的临时窗口，请使用页面中的直接 PDF 链接或在外部浏览器下载后导入。" })
        }));
        guestContents.on("will-navigate", (event, url) => {
          if (!safeHttpUrl(url)) {
            event.preventDefault();
            sendPortalStatus({ state: "failed", error: "该临时文件链接无法直接打开，请在外部浏览器下载 PDF 后导入。" });
          } else if (capturePdfNavigation(guestContents, url)) event.preventDefault();
        });
      });

      mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        if (safeHttpUrl(url)) shell.openExternal(url);
        return { action: "deny" };
      });

      mainWindow.on("close", (e) => {
        if (!isQuitting && readMinimizeToTray()) {
          e.preventDefault();
          mainWindow.hide();
        }
      });

      mainWindow.on("closed", () => {
        mainWindow = null;
        stopServer();
        app.quit();
      });

      createTray();

      const pdfHeaders = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
        Accept: "application/pdf,application/octet-stream,*/*"
      };
      const pdfSession = session.fromPartition("persist:scholarloop");
      const browserUserAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

      // ===== 内嵌浏览器 PDF 下载接管 =====
      // webview 设置了 partition="persist:scholarloop"（见 src/pages/SearchPage.jsx），
      // 其实际 session 即 pdfSession；按 session 用 WeakSet 去重挂载 will-download，
      // 避免多个 webview / 重复 attach 造成同一 session 上处理器叠加触发。
      const pdfDownloadAttachedSessions = new WeakSet();
      /** downloadId -> original browser download state and app-owned temporary PDF. */
      const pdfDownloads = new Map();
      let pdfDownloadSeq = 0;

      /** 从响应头里不区分大小写地取 content-disposition */
      function getContentDisposition(item) {
        try {
          const headers = item.getResponseHeaders?.() || {};
          for (const key of Object.keys(headers)) {
            if (key.toLowerCase() === "content-disposition") {
              return String((headers[key] || [])[0] || "");
            }
          }
        } catch { /* ignore */ }
        return "";
      }

      /** 从 Content-Disposition 提取 filename（兼容 RFC5987 filename*） */
      function filenameFromDisposition(disposition) {
        if (!disposition) return "";
        const star = disposition.match(/filename\*=(?:UTF-8'')?([^;]+)/i);
        if (star) {
          try {
            return decodeURIComponent(star[1].trim().replace(/^"|"$/g, ""));
          } catch { /* 解码失败则回退普通 filename */ }
        }
        const plain = disposition.match(/filename="?([^";]+)"?/i);
        return plain ? plain[1].trim() : "";
      }

      /** 依次判定 PDF：MIME -> Content-Disposition 文件名 -> URL 路径 -> 快照文件名 */
      function isPdfDownloadItem(item) {
        try {
          const mime = String(item.getMimeType?.() || "").toLowerCase();
          if (mime.includes("pdf")) return true;
          const dispositionName = filenameFromDisposition(getContentDisposition(item));
          if (/\.pdf$/i.test(dispositionName)) return true;
          const url = String(item.getURL?.() || "");
          try {
            if (/\.pdf$/i.test(new URL(url).pathname)) return true;
          } catch { /* URL 非法，跳过该判定 */ }
          // Electron 未公开 snapshotFilename 字段，做兼容探测；退回 getFilename()
          const snapshotName = String(item.snapshotFilename?.() ?? item.getFilename?.() ?? "");
          return /\.pdf$/i.test(snapshotName.trim());
        } catch {
          return false;
        }
      }

      /** 推荐保存文件名：Content-Disposition > URL basename > downloadItem 文件名 */
      function recommendPdfFilename(item) {
        const fromDisposition = filenameFromDisposition(getContentDisposition(item));
        if (fromDisposition) return fromDisposition;
        const url = String(item.getURL?.() || "");
        try {
          const base = decodeURIComponent(new URL(url).pathname.split("/").pop() || "");
          if (base) return base;
        } catch { /* ignore */ }
        return String(item.getFilename?.() || "download.pdf");
      }

      const maxCapturedPdfBytes = 100 * 1024 * 1024;
      const pendingPortalDownloads = new Map();
      const capturedPdfDir = fs.mkdtempSync(path.join(app.getPath("temp"), "ScholarLoop-pdf-"));
      app.once("will-quit", () => {
        const target = path.resolve(capturedPdfDir);
        const tempRoot = path.resolve(app.getPath("temp"));
        if (path.dirname(target) !== tempRoot || !path.basename(target).startsWith("ScholarLoop-pdf-")) return;
        try { fs.rmSync(target, { recursive: true, force: true }); } catch { /* app-owned temp only */ }
      });
      function sendPortalStatus(payload) {
        const state = payload.state === "error" ? "failed" : payload.state;
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("pdf-portal-status", { ...payload, state, message: payload.message || payload.error });
      }
      function beginPortalDownload(contents, target, referer) {
        const previous = pendingPortalDownloads.get(target);
        if (previous) clearTimeout(previous.timer);
        const timer = setTimeout(() => {
          pendingPortalDownloads.delete(target);
          sendPortalStatus({ state: "failed", url: target, error: "站点未开始 PDF 下载，请确认已登录，或在外部浏览器下载后导入。" });
        }, 45000);
        timer.unref();
        pendingPortalDownloads.set(target, { timer, sourceUrl: referer || "" });
        sendPortalStatus({ state: "connecting", url: target, message: "正在请求站点 PDF…" });
        try { contents.downloadURL(target, referer ? { headers: { Referer: referer } } : undefined); }
        catch (error) {
          clearTimeout(timer);
          pendingPortalDownloads.delete(target);
          sendPortalStatus({ state: "failed", url: target, error: error.message || "无法开始下载 PDF" });
          throw error;
        }
      }
      function capturePdfNavigation(contents, url) {
        const target = safeHttpUrl(url);
        if (!target) return false;
        const pathname = new URL(target).pathname;
        if (!(/\.pdf(?:$|\/)/i.test(pathname) || /\/(?:doi\/(?:e?pdf)|pdf|pdfdirect)\//i.test(pathname) || /\/content\/journals\/.*\/pdf$/i.test(pathname))) return false;
        try {
          // Preserve the originating browser session and its authenticated request.
          beginPortalDownload(contents, target, safeHttpUrl(contents.getURL()));
        } catch { /* beginPortalDownload reports the error */ }
        return true;
      }
      function assertDownloadSender(event) {
        if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents ||
            event.senderFrame !== mainWindow.webContents.mainFrame || new URL(event.senderFrame.url).origin !== rendererOrigin) {
          throw new Error("PDF 下载访问被拒绝");
        }
      }
      function publishCapturedPdf(meta) {
        if (!mainWindow || mainWindow.isDestroyed()) return;
        const { downloadId, url, filename, sourceUrl, state, receivedBytes, totalBytes, error } = meta;
        mainWindow.webContents.send("pdf-download-captured", { downloadId, url, filename, sourceUrl, state, receivedBytes, totalBytes, error });
      }
      /** Retain the original authenticated download, including POST and temporary URLs. */
      function attachPdfDownloadHandler(sess) {
        if (!sess || pdfDownloadAttachedSessions.has(sess)) return;
        pdfDownloadAttachedSessions.add(sess);
        sess.on("will-download", (_event, item, webContents) => {
          const chain = item.getURLChain();
          let requested = false;
          let requestedSourceUrl = "";
          for (const url of chain) {
            const pending = pendingPortalDownloads.get(url);
            if (pending) {
              requested = true;
              requestedSourceUrl = pending.sourceUrl;
              clearTimeout(pending.timer);
              pendingPortalDownloads.delete(url);
            }
          }
          if (!isPdfDownloadItem(item)) {
            if (requested) {
              _event.preventDefault();
              sendPortalStatus({ state: "failed", error: "站点返回的不是 PDF，请确认已登录或使用外部浏览器下载。" });
            }
            return;
          }
          const downloadId = ++pdfDownloadSeq;
          let sourceUrl = requestedSourceUrl;
          try { if (webContents && !webContents.isDestroyed()) sourceUrl = webContents.getURL() || sourceUrl; } catch { /* closed tab */ }
          const meta = {
            downloadId, url: String(item.getURL() || ""),
            filename: path.basename(recommendPdfFilename(item)).replace(/[<>:"/\\|?*\x00-\x1f]/g, "_") || "download.pdf",
            sourceUrl, state: "downloading", receivedBytes: 0, totalBytes: item.getTotalBytes(),
            filePath: path.join(capturedPdfDir, `${randomUUID()}.pdf`)
          };
          pdfDownloads.set(downloadId, meta);
          item.setSavePath(meta.filePath);
          publishCapturedPdf(meta);
          let lastPublished = 0;
          const fail = (message) => {
            meta.state = "failed";
            meta.error = message;
            publishCapturedPdf(meta);
          };
          let stalledTimer;
          const watchDownload = () => {
            clearTimeout(stalledTimer);
            stalledTimer = setTimeout(() => {
              fail("PDF 下载长时间没有进展，请回到门户重试或另用浏览器下载。");
              item.cancel();
            }, 90000);
            stalledTimer.unref();
          };
          watchDownload();
          item.on("updated", (_event, state) => {
            meta.receivedBytes = item.getReceivedBytes();
            meta.totalBytes = item.getTotalBytes();
            if (meta.state === "failed") return;
            watchDownload();
            if (meta.receivedBytes > maxCapturedPdfBytes || meta.totalBytes > maxCapturedPdfBytes) {
              fail("PDF 超过 100 MB，请在外部浏览器下载后导入。");
              item.cancel();
              return;
            }
            const now = Date.now();
            if (now - lastPublished >= 250) {
              lastPublished = now;
              meta.error = state === "interrupted" ? "下载连接中断，正在等待恢复…" : undefined;
              publishCapturedPdf(meta);
            }
          });
          item.once("done", (_event, state) => {
            clearTimeout(stalledTimer);
            if (meta.state !== "failed") {
              try {
                if (state !== "completed") throw new Error(state === "cancelled" ? "PDF 下载已取消" : "PDF 下载中断，请重试或使用外部浏览器下载。");
                const stat = fs.statSync(meta.filePath);
                if (stat.size > maxCapturedPdfBytes) throw new Error("PDF 超过 100 MB");
                const fd = fs.openSync(meta.filePath, "r");
                const header = Buffer.alloc(5);
                let count;
                try { count = fs.readSync(fd, header, 0, header.length, 0); } finally { fs.closeSync(fd); }
                if (count != 5 || !header.equals(Buffer.from("%PDF-"))) throw new Error("站点返回的不是 PDF，可能需要登录或重新获取下载链接。");
                meta.receivedBytes = stat.size;
                meta.state = "ready";
                meta.error = undefined;
                publishCapturedPdf(meta);
              } catch (error) { fail(error.message || "PDF 下载失败"); }
            }
            if (meta.state === "failed") {
              try { fs.unlinkSync(meta.filePath); } catch { /* no partial file */ }
            }
          });
          if (meta.totalBytes > maxCapturedPdfBytes) {
            fail("PDF 超过 100 MB，请在外部浏览器下载后导入。");
            item.cancel();
          }
        });
      }
      attachPdfDownloadHandler(pdfSession);
      ipcMain.handle("pdf-portal-download", (event, url, sourceUrl) => {
        assertDownloadSender(event);
        const target = safeHttpUrl(url);
        if (!target) throw new Error("PDF 链接不合法");
        const referer = safeHttpUrl(sourceUrl);
        try {
          beginPortalDownload(pdfSession, target, referer);
          return { ok: true };
        } catch (error) {
          const message = error.message || "无法开始下载 PDF";
          return { ok: false, error: message };
        }
      });
      ipcMain.handle("pdf-download-read", async (event, downloadId) => {
        assertDownloadSender(event);
        const meta = pdfDownloads.get(Number(downloadId));
        if (!meta || meta.state !== "ready") throw new Error("PDF 尚未下载完成，请稍候或重试。");
        const stat = await fs.promises.stat(meta.filePath);
        if (stat.size > maxCapturedPdfBytes) throw new Error("PDF 超过 100 MB");
        return { data: (await fs.promises.readFile(meta.filePath)).toString("base64"), filename: meta.filename };
      });
      ipcMain.handle("pdf-download-save-as", async (event, downloadId) => {
        assertDownloadSender(event);
        const id = Number(downloadId);
        const meta = pdfDownloads.get(id);
        const result = (payload) => {
          if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("pdf-download-saved", { downloadId: id, ...payload });
          return payload;
        };
        if (!meta || meta.state !== "ready") return result({ ok: false, error: "PDF 尚未下载完成，请稍候或重试。" });
        const picked = await dialog.showSaveDialog(mainWindow, {
          title: "另存 PDF", defaultPath: meta.filename,
          filters: [{ name: "PDF 文件", extensions: ["pdf"] }]
        });
        if (picked.canceled || !picked.filePath) return result({ ok: false, canceled: true, error: "canceled" });
        try {
          // Never overwrite or remove a pre-existing user file, even after a failed copy.
          await fs.promises.copyFile(meta.filePath, picked.filePath, fs.constants.COPYFILE_EXCL);
          return result({ ok: true, path: picked.filePath });
        } catch (error) {
          return result({ ok: false, error: error.code === "EEXIST" ? "文件已存在，请选择其他文件名。" : error.message || "另存失败" });
        }
      });

      ipcMain.handle("institution-open", async (_event, url) => {
        const target = String(url || "").trim();
        if (!/^https:\/\//i.test(target)) throw new Error("机构入口必须是 HTTPS 地址");
        if (institutionWindow && !institutionWindow.isDestroyed()) {
          institutionWindow.show();
          institutionWindow.focus();
          await institutionWindow.loadURL(target);
          return { ok: true };
        }

        institutionWindow = new BrowserWindow({
          width: 1180,
          height: 820,
          minWidth: 860,
          minHeight: 620,
          title: "ScholarLoop · 机构资源登录",
          parent: mainWindow,
          autoHideMenuBar: true,
          backgroundColor: "#ffffff",
          webPreferences: {
            partition: "persist:scholarloop",
            contextIsolation: true,
            sandbox: true,
            nodeIntegration: false
          }
        });
        institutionWindow.setMenuBarVisibility(false);
        institutionWindow.webContents.setUserAgent(browserUserAgent);
        institutionWindow.webContents.setWindowOpenHandler(createInstitutionPopupHandler({
          notify: (url) => {
            if (!capturePdfNavigation(institutionWindow.webContents, url)) forwardInstitutionPopup(url);
          },
          onRejected: () => sendPortalStatus({ state: "failed", error: "站点打开了无法接管的临时窗口，请使用直接 PDF 链接或外部浏览器。" })
        }));
        institutionWindow.webContents.on("will-navigate", (event, url) => {
          if (capturePdfNavigation(institutionWindow.webContents, url)) event.preventDefault();
        });
        institutionWindow.on("closed", () => {
          institutionWindow = null;
        });
        await institutionWindow.loadURL(target);
        return { ok: true };
      });

      const isPdfBody = (buf) => buf.length >= 5 && buf.slice(0, 5).toString("latin1") === "%PDF-";

      // net.fetch 的 redirect:"manual" 会返回 opaque-redirect（读不到 Location），
      // 手动跟随必须用 Node 全局 fetch（undici）以保持每跳的 Location 可见。
      const fetchPdfManual = async (target, maxHops = 5) => {
        let url = target;
        let prevUrl = "";
        const seen = new Set();
        for (let i = 0; i <= maxHops; i++) {
          const hopHeaders = { ...pdfHeaders };
          try {
            const cookies = (await pdfSession.cookies.get({ url })).map((c) => `${c.name}=${c.value}`).join("; ");
            if (cookies) hopHeaders.Cookie = cookies;
          } catch { /* cookies unavailable */ }
          if (prevUrl) hopHeaders.Referer = prevUrl;
          const res = await fetch(url, { headers: hopHeaders, redirect: "manual", signal: AbortSignal.timeout(60000) });
          if (res.status >= 300 && res.status < 400) {
            const loc = res.headers.get("location");
            if (!loc) throw new Error(`重定向目标缺失（${res.status}）`);
            prevUrl = url;
            url = new URL(loc, url).toString();
            if (!/^https?:\/\//i.test(url)) throw new Error("重定向到非法协议");
            if (seen.has(url)) throw new Error("检测到重定向循环");
            seen.add(url);
            continue;
          }
          if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
          const buf = Buffer.from(await res.arrayBuffer());
          if (!isPdfBody(buf)) throw new Error("该链接不是可直接下载的 PDF 文件（可能是网页或需要登录）");
          return { data: buf.toString("base64") };
        }
        throw new Error("重定向次数过多");
      };

      ipcMain.handle("pdf-fetch", async (_event, url) => {
        const target = String(url || "").trim();
        if (!/^https?:\/\//i.test(target)) throw new Error("PDF 链接不合法");
        try {
          // 复用内嵌浏览器登录态（persist:scholarloop 分区的 cookie），解决需登录站点的 403/重定向循环
          const res = await pdfSession.fetch(target, {
            headers: pdfHeaders,
            redirect: "follow"
          });
          if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
          const buf = Buffer.from(await res.arrayBuffer());
          if (!isPdfBody(buf)) {
            throw new Error("该链接不是可直接下载的 PDF 文件（可能是网页或需要登录）");
          }
          return { data: buf.toString("base64") };
        } catch (err) {
          // 只有重定向类错误才走手动跟随（带 cookie + Referer），其余直接抛出
          if (!/TOO_MANY_REDIRECTS|redirect/i.test(err.message || "")) throw err;
          return fetchPdfManual(target);
        }
      });

      /** 用系统默认 PDF 程序打开；chooseApp=true 时弹出「打开方式」让用户自选软件 */
      ipcMain.handle("pdf-open-path", async (_event, filePath, options = {}) => {
        const abs = path.resolve(String(filePath || ""));
        if (!abs || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
          throw new Error("PDF 文件不存在或路径无效");
        }
        const chooseApp = Boolean(options?.chooseApp);
        if (chooseApp && process.platform === "win32") {
          // Windows「打开方式」对话框
          const child = spawn("rundll32.exe", ["shell32.dll,OpenAs_RunDLL", abs], {
            detached: true,
            stdio: "ignore",
            windowsHide: true
          });
          child.unref();
          return { ok: true, mode: "choose" };
        }
        if (chooseApp && process.platform === "darwin") {
          const picked = await dialog.showOpenDialog(mainWindow || undefined, {
            title: "选择打开 PDF 的应用",
            defaultPath: "/Applications",
            properties: ["openFile"],
            filters: [{ name: "Applications", extensions: ["app"] }]
          });
          if (picked.canceled || !picked.filePaths?.[0]) {
            return { ok: false, canceled: true };
          }
          const child = spawn("open", ["-a", picked.filePaths[0], abs], {
            detached: true,
            stdio: "ignore"
          });
          child.unref();
          return { ok: true, mode: "choose" };
        }
        if (chooseApp && process.platform === "linux") {
          // Linux 无统一「打开方式」对话框，退回默认程序
          const errMsg = await shell.openPath(abs);
          if (errMsg) throw new Error(errMsg || "无法打开 PDF");
          return { ok: true, mode: "default-fallback" };
        }
        const errMsg = await shell.openPath(abs);
        if (errMsg) throw new Error(errMsg || "无法用默认程序打开 PDF");
        return { ok: true, mode: "default" };
      });

      ipcMain.handle("note-open-file", async (_event, fileId) => {
        const id = String(fileId || "").trim();
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
          throw new Error("附件标识无效");
        }
        const noteDir = path.join(ROOT, "data", "note-files");
        const metaPath = path.join(noteDir, `${id}.json`);
        const binPath = path.join(noteDir, `${id}.bin`);
        if (!fs.existsSync(metaPath) || !fs.existsSync(binPath)) throw new Error("附件不存在或已被删除");
        let meta;
        try {
          meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
        } catch {
          throw new Error("附件信息损坏");
        }
        const ext = String(meta?.ext || "bin").toLowerCase().replace(/[^a-z0-9]/g, "") || "bin";
        const tempDir = path.join(app.getPath("temp"), "scholarloop-notes");
        fs.mkdirSync(tempDir, { recursive: true });
        const openedPath = path.join(tempDir, `${id}.${ext}`);
        fs.copyFileSync(binPath, openedPath);
        const errMsg = await shell.openPath(openedPath);
        if (errMsg) throw new Error(errMsg || "无法用系统默认程序打开附件");
        return { ok: true, mode: "default" };
      });
    } catch (err) {
      stopServer();
      dialog.showErrorBox("ScholarLoop 启动失败", err.message || String(err));
      app.quit();
    }
  });

  app.on("window-all-closed", () => {
    stopServer();
    app.quit();
  });

  app.on("before-quit", () => {
    isQuitting = true;
    stopServer();
  });
}
