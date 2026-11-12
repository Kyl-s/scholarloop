import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { toolsPath } from "./runtimePaths.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(__dirname, "pdfPageRender.py");
let cachedPython;

function existsFile(value) {
  try {
    return Boolean(value) && fs.statSync(value).isFile();
  } catch {
    return false;
  }
}

function pythonCandidates() {
  const runtime = toolsPath("pdf2zh", "runtime", "python.exe");
  const site = toolsPath("pdf2zh", "site-packages");
  return [
    { cmd: process.env.PYTHON, extra: [], env: {} },
    { cmd: process.env.PDFMATH_PYTHON, extra: [], env: {} },
    { cmd: "python", extra: [], env: {} },
    { cmd: "py", extra: ["-3"], env: {} },
    { cmd: runtime, extra: [], env: site ? { PYTHONPATH: site } : {} }
  ].filter((item) => item.cmd);
}

export function buildPdfPageRendererEnv(baseEnv = process.env, pythonEnv = {}) {
  return {
    ...baseEnv,
    ...pythonEnv,
    PYTHONIOENCODING: "utf-8",
    PYTHONUTF8: "1"
  };
}

function abortError(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  const error = new Error("PDF 页面渲染已取消");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError(signal);
}

function killProcessTree(child) {
  if (!child?.pid) return;
  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore"
    });
    killer.once("error", () => {});
    return;
  }
  try {
    child.kill("SIGTERM");
  } catch {
    // 子进程可能已经退出。
  }
}

function runAsync(command, args, { env, signal, timeoutMs, maxBuffer = 32 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    throwIfAborted(signal);
    const stdout = [];
    const stderr = [];
    let outputBytes = 0;
    let settled = false;
    let timer;
    let abortListener;
    let child;

    const cleanup = () => {
      clearTimeout(timer);
      if (signal && abortListener) signal.removeEventListener("abort", abortListener);
      child?.stdout?.removeListener("data", onStdout);
      child?.stderr?.removeListener("data", onStderr);
      child?.removeListener("error", onError);
      child?.removeListener("close", onClose);
    };
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(value);
    };
    const terminate = (error) => {
      if (settled) return;
      // Promise 需要立即结束，但被终止的 child 仍可能异步发出 error/close；
      // 保留一个临时兜底监听，待 close 后移除，避免未处理错误或监听泄漏。
      const suppressChildError = () => {};
      const cleanupTerminatedChild = () => child.removeListener("error", suppressChildError);
      child.removeListener("error", onError);
      child.removeListener("close", onClose);
      child.once("error", suppressChildError);
      child.once("close", cleanupTerminatedChild);
      killProcessTree(child);
      finish(error);
    };
    const append = (target, chunk) => {
      outputBytes += chunk.length;
      if (outputBytes <= maxBuffer) target.push(chunk.toString());
    };
    const onStdout = (chunk) => append(stdout, chunk);
    const onStderr = (chunk) => append(stderr, chunk);
    const onError = (error) => finish(error);
    const onClose = (code, signalName) => finish(null, {
      code,
      signal: signalName,
      stdout: stdout.join(""),
      stderr: stderr.join("")
    });

    try {
      child = spawn(command, args, { env, windowsHide: true });
    } catch (error) {
      finish(error);
      return;
    }
    child.stdout?.on("data", onStdout);
    child.stderr?.on("data", onStderr);
    child.once("error", onError);
    child.once("close", onClose);
    abortListener = () => terminate(abortError(signal));
    if (signal) signal.addEventListener("abort", abortListener, { once: true });
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        const error = new Error("PDF 页面渲染超时");
        error.code = "ETIMEDOUT";
        terminate(error);
      }, timeoutMs);
    }
    if (signal?.aborted) abortListener();
  });
}

async function resolvePdfPagePythonAsync(signal) {
  if (cachedPython !== undefined) return cachedPython;
  for (const item of pythonCandidates()) {
    throwIfAborted(signal);
    const env = buildPdfPageRendererEnv(process.env, item.env);
    try {
      const check = await runAsync(item.cmd, [...item.extra, "-c", "import fitz; print('ok')"], {
        env,
        signal,
        timeoutMs: 15000,
        maxBuffer: 1024 * 1024
      });
      if (check.code === 0 && String(check.stdout || "").includes("ok")) {
        cachedPython = { cmd: item.cmd, extra: item.extra, env: item.env };
        return cachedPython;
      }
    } catch (error) {
      if (signal?.aborted) throw error;
    }
  }
  cachedPython = null;
  return null;
}

/** 同步版本仅供启动阶段的页数探测使用；页面渲染走下面的异步版本。 */
export function resolvePdfPagePython() {
  if (cachedPython !== undefined) return cachedPython;
  for (const item of pythonCandidates()) {
    const env = buildPdfPageRendererEnv(process.env, item.env);
    const check = spawnSync(item.cmd, [...item.extra, "-c", "import fitz; print('ok')"], {
      encoding: "utf8", env, timeout: 15000, windowsHide: true
    });
    if (check.status === 0 && String(check.stdout || "").includes("ok")) {
      cachedPython = { cmd: item.cmd, extra: item.extra, env: item.env };
      return cachedPython;
    }
  }
  cachedPython = null;
  return null;
}

function parseRendererOutput(stdout) {
  try {
    return JSON.parse(String(stdout || "").trim());
  } catch {
    throw new Error("PDF 页面渲染器返回了无效结果");
  }
}

function runRendererSync(args) {
  const python = resolvePdfPagePython();
  if (!python) throw new Error("未找到带 PyMuPDF 的 Python");
  const result = spawnSync(python.cmd, [...python.extra, SCRIPT, ...args], {
    encoding: "utf8",
    env: buildPdfPageRendererEnv(process.env, python.env),
    timeout: 120000,
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024
  });
  if (result.status !== 0) throw new Error(String(result.stderr || result.stdout || "PDF 页面渲染失败").trim().slice(0, 500));
  return parseRendererOutput(result.stdout);
}

async function runRenderer(args, signal, timeoutMs = 120000) {
  const python = await resolvePdfPagePythonAsync(signal);
  if (!python) throw new Error("未找到带 PyMuPDF 的 Python");
  const result = await runAsync(python.cmd, [...python.extra, SCRIPT, ...args], {
    env: buildPdfPageRendererEnv(process.env, python.env),
    signal,
    timeoutMs
  });
  if (result.code !== 0) throw new Error(String(result.stderr || result.stdout || "PDF 页面渲染失败").trim().slice(0, 500));
  return parseRendererOutput(result.stdout);
}

export async function renderPdfPage(pdfPath, page, { signal, timeoutMs = 120000 } = {}) {
  if (!existsFile(pdfPath)) throw new Error("PDF 源文件不存在");
  return runRenderer(["render", pdfPath, String(page)], signal, timeoutMs);
}

export function getPdfPageCount(pdfPath) {
  // 同一渲染器返回 pageCount；仅在 layoutAssist 缺少 pageCount 时调用。
  return Number(runRendererSync(["render", pdfPath, "1"]).pageCount) || 0;
}
