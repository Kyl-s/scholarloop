const { app, BrowserWindow, dialog, shell, Tray, Menu, nativeImage, net, ipcMain, session } = require("electron");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

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
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", PORT: "61578" },
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
    }, 15000);

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
      mainWindow.loadURL(`http://127.0.0.1:${port}/`);

      mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        if (url.startsWith("http://") || url.startsWith("https://")) {
          shell.openExternal(url);
        }
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
        institutionWindow.webContents.setWindowOpenHandler(() => ({
          action: "allow",
          overrideBrowserWindowOptions: {
            autoHideMenuBar: true,
            webPreferences: {
              partition: "persist:scholarloop",
              contextIsolation: true,
              sandbox: true,
              nodeIntegration: false
            }
          }
        }));
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
          const res = await net.fetch(target, {
            headers: pdfHeaders,
            redirect: "follow",
            session: pdfSession,
            useSessionCookies: true
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
