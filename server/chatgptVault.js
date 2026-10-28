import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";

const ENTROPY = "ScholarLoop.ChatGPT.OAuth.v1";
export const chatGptCredentialPath = path.join(process.env.LOCALAPPDATA || os.homedir(), "ScholarLoop", "chatgpt", "credentials.dpapi");
const compatibleCredentialPath = path.join(process.env.APPDATA || os.homedir(), "scholar-loop", "chatgpt", "credentials.dpapi");

// Secrets travel only through anonymous child-process pipes, never argv or logs.
// DPAPI CurrentUser binds the ciphertext to this Windows user's login profile.
export function windowsProtect(value, decrypt = false) {
  if (process.platform !== "win32") return Promise.reject(new Error("持久 ChatGPT 登录目前需要 Windows DPAPI"));
  const operation = decrypt ? "Unprotect" : "Protect";
  const script = `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; $raw=[Console]::In.ReadToEnd(); $bytes=[Convert]::FromBase64String($raw); $entropy=[Text.Encoding]::UTF8.GetBytes('${ENTROPY}'); $result=[Security.Cryptography.ProtectedData]::${operation}($bytes,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($result))`;
  return new Promise((resolve, reject) => {
    const executable = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const child = spawn(executable, ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    const chunks = [];
    const timer = setTimeout(() => child.kill(), 15000);
    child.stdout.on("data", (part) => chunks.push(part));
    child.stderr.resume(); // Never log crypto errors which could contain input.
    child.stdin.on("error", () => {});
    child.once("error", () => { clearTimeout(timer); reject(new Error("无法启动 Windows 凭据加密服务")); });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) { reject(new Error("Windows 凭据加密或解密失败，请使用原 Windows 账号")); return; }
      resolve(Buffer.from(Buffer.concat(chunks).toString("utf8").trim(), "base64"));
    });
    child.stdin.end(Buffer.from(value).toString("base64"));
  });
}

export function createCredentialVault({ file = chatGptCredentialPath, protect = windowsProtect, fallbackFile = file === chatGptCredentialPath ? compatibleCredentialPath : null, renameFile = fs.rename } = {}) {
  let writes = Promise.resolve();
  let activeFile = file;
  async function load() {
    let ciphertext;
    // Once migrated, the newer vault is authoritative, including after logout.
    if (fallbackFile) {
      try { ciphertext = await fs.readFile(fallbackFile); activeFile = fallbackFile; }
      catch (error) { if (error.code !== "ENOENT") throw new Error("无法读取 ChatGPT 加密凭据"); }
    }
    try { ciphertext ??= await fs.readFile(file); }
    catch (error) { if (error.code === "ENOENT") return null; throw new Error("无法读取 ChatGPT 加密凭据"); }
    try { return JSON.parse((await protect(ciphertext, true)).toString("utf8")); }
    catch { throw new Error("ChatGPT 本地凭据无法解密，请使用原 Windows 账号或重新登录"); }
  }
  function save(record) {
    const snapshot = JSON.stringify(record);
    const write = async () => {
      const ciphertext = await protect(Buffer.from(snapshot, "utf8"));
      async function replace(target) {
        await fs.mkdir(path.dirname(target), { recursive: true });
        const temporary = `${target}.${randomUUID()}.tmp`;
        try {
          const handle = await fs.open(temporary, "wx", 0o600);
          try { await handle.writeFile(ciphertext); await handle.sync(); } finally { await handle.close(); }
          await renameFile(temporary, target);
        } finally { await fs.unlink(temporary).catch(() => {}); }
      }
      try { await replace(activeFile); }
      catch (error) {
        if (error.code !== "EXDEV" || !fallbackFile || activeFile === fallbackFile) throw error;
        // Windows EFS directories can reject same-directory replacement.
        // Move future writes to a DPAPI-protected vault that supports atomic rename.
        await replace(fallbackFile);
        activeFile = fallbackFile;
      }
    };
    const result = writes.then(write);
    writes = result.catch(() => {});
    return result;
  }
  return { load, save };
}

export const chatGptVault = createCredentialVault();
