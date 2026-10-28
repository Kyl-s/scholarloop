import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createCredentialVault } from "./chatgptVault.js";

test("EXDEV migrates atomically and the newer vault remains authoritative after logout", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "scholarloop-vault-migration-"));
  const file = path.join(dir, "legacy.dpapi");
  const fallbackFile = path.join(dir, "compatible.dpapi");
  const protect = async (value) => value;
  try {
    await fs.writeFile(file, JSON.stringify({ session: { access_token: "old-test-token" } }));
    const vault = createCredentialVault({ file, fallbackFile, protect, renameFile: async (source, target) => {
      if (target === file) throw Object.assign(new Error("same directory replacement rejected"), { code: "EXDEV" });
      return fs.rename(source, target);
    } });
    assert.equal((await vault.load()).session.access_token, "old-test-token");
    await vault.save({ session: { access_token: "new-test-token" } });
    assert.equal((await createCredentialVault({ file, fallbackFile, protect }).load()).session.access_token, "new-test-token");
    await vault.save({ session: null });
    assert.deepEqual(await createCredentialVault({ file, fallbackFile, protect }).load(), { session: null });
    await fs.writeFile(fallbackFile, "invalid");
    await assert.rejects(createCredentialVault({ file, fallbackFile, protect }).load(), /无法解密/);
    assert.deepEqual((await fs.readdir(dir)).sort(), ["compatible.dpapi", "legacy.dpapi"]);
  } finally {
    await fs.unlink(file).catch(() => {});
    await fs.unlink(fallbackFile).catch(() => {});
    await fs.rmdir(dir);
  }
});

test("Windows DPAPI survives a new vault instance, encrypts tokens and atomically replaces them", { skip: process.platform !== "win32" }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "scholarloop-oauth-vault-test-"));
  const file = path.join(dir, "credentials.dpapi");
  try {
    const vault = createCredentialVault({ file });
    assert.equal(await vault.load(), null);
    const record = { version: 1, session: { access_token: "fake-test-access-token", refresh_token: "fake-test-refresh-token" } };
    await vault.save(record);
    const ciphertext = await fs.readFile(file);
    assert.equal(ciphertext.includes(Buffer.from("fake-test-access-token")), false);
    assert.deepEqual(await createCredentialVault({ file }).load(), record);
    await Promise.all([vault.save({ version: 1, session: { access_token: "rotated-test-token" } }), vault.save({ version: 1, session: null })]);
    assert.deepEqual(await createCredentialVault({ file }).load(), { version: 1, session: null });
    assert.deepEqual(await fs.readdir(dir), ["credentials.dpapi"]);
  } finally { await fs.unlink(file).catch(() => {}); await fs.rmdir(dir); }
});

test("corrupt ciphertext fails closed without exposing contents", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "scholarloop-oauth-vault-test-"));
  const file = path.join(dir, "credentials.dpapi");
  try {
    await fs.writeFile(file, "broken-ciphertext");
    const vault = createCredentialVault({ file, protect: async () => { throw new Error("secret should not escape"); } });
    await assert.rejects(vault.load(), (error) => /无法解密/.test(error.message) && !error.message.includes("secret"));
  } finally { await fs.unlink(file); await fs.rmdir(dir); }
});
