const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { createAgentConfigVault } = require("./agentConfigVault.cjs");

test("vault survives a new process instance, clears durably, and preserves unreadable data", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "scholarloop-vault-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "config.enc");
  const key = crypto.randomBytes(32);
  const storage = {
    isEncryptionAvailable: () => true,
    encryptString(raw) {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
      const encrypted = Buffer.concat([cipher.update(raw, "utf8"), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
    },
    decryptString(raw) {
      const decipher = crypto.createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
      decipher.setAuthTag(raw.subarray(12, 28));
      return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
    }
  };
  const initial = createAgentConfigVault(file, storage);
  assert.equal(initial.read(), null);
  const config = { version: 2, activeId: "b", providers: [{ id: "a", model: "model-a" }, { id: "b", model: "custom-model", apiKey: "fake-test-secret" }] };
  initial.write(config);
  assert.ok(!fs.readFileSync(file).includes(Buffer.from("fake-test-secret")));
  assert.deepEqual(createAgentConfigVault(file, storage).read(), config);
  const bytes = fs.readFileSync(file);
  const unavailable = createAgentConfigVault(file, { isEncryptionAvailable: () => false });
  assert.throws(() => unavailable.write({}));
  assert.deepEqual(fs.readFileSync(file), bytes);
  initial.write(null);
  assert.deepEqual(createAgentConfigVault(file, storage).read().providers, []);
  fs.writeFileSync(file, "corrupt");
  assert.throws(() => createAgentConfigVault(file, storage).read());
  assert.equal(fs.readFileSync(file, "utf8"), "corrupt");
});
