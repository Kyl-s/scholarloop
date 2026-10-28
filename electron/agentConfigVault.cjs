const fs = require("node:fs");
const path = require("node:path");

function createAgentConfigVault(filePath, safeStorage) {
  let cached;
  return {
    read() {
      if (cached !== undefined) return cached;
      if (!fs.existsSync(filePath)) return null;
      if (!safeStorage.isEncryptionAvailable()) throw new Error("本机配置加密不可用");
      cached = JSON.parse(safeStorage.decryptString(fs.readFileSync(filePath)));
      return cached;
    },
    write(value) {
      // An empty store is retained as a tombstone so old browser data cannot
      // resurrect providers after the user explicitly clears their settings.
      const next = value ?? { version: 2, activeId: "", providers: [] };
      const raw = JSON.stringify(next);
      if (Buffer.byteLength(raw) > 1024 * 1024) throw new Error("模型配置过大");
      if (!safeStorage.isEncryptionAvailable()) throw new Error("本机配置加密不可用，配置未保存");
      const encrypted = safeStorage.encryptString(raw);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const temporary = `${filePath}.tmp`;
      fs.writeFileSync(temporary, encrypted, { mode: 0o600 });
      fs.renameSync(temporary, filePath);
      cached = next;
    }
  };
}

module.exports = { createAgentConfigVault };
