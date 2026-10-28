import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createZoteroService, paperToZotero } from "./zotero.js";

const secret = "A".repeat(24);
const pdf = Buffer.from("%PDF-1.7\nunit-test");
const md5 = createHash("md5").update(pdf).digest("hex");
const paper = { id: "local-1", title: "A robotics paper", authors: ["Ada Lovelace"], doi: "https://doi.org/10.1234/TEST", year: 2026, tags: ["robotics"], pdfUrl: "/api/pdf/file/1234.pdf" };
function harness({ papers = [paper], pdfReader = async () => ({ buffer: pdf }), translationReader = async () => null, translationSignature = () => "", initial = {}, savedCredential = null, identity = {} } = {}) {
  let state = structuredClone(initial);
  let stored = savedCredential;
  let failUpload = false;
  let failRegistration = false;
  let failCreation = false;
  let authorizationStatus = 200;
  let permission = true;
  let requestFailure = 0;
  let revision = 1;
  const authorizedHashes = new Map();
  const items = new Map();
  const collections = new Map();
  const calls = [];
  const response = (body, status = 200, headers = {}) => new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
  async function fetcher(raw, options = {}) {
    const url = new URL(raw);
    calls.push({ url: url.href, options });
    if (url.host === "upload.example.test") {
      assert.equal(options.headers["Zotero-API-Key"], undefined, "API secret must not reach storage host");
      if (failUpload) { failUpload = false; return response({}, 500); }
      assert.ok(Buffer.from(options.body).includes(Buffer.from("%PDF-")));
      return response({}, 201);
    }
    assert.equal(url.host, "api.zotero.org");
    assert.equal(options.headers["Zotero-API-Key"], secret);
    if (url.pathname === "/keys/current") return response({ userID: 1, username: "researcher", access: { user: { library: true, write: permission, files: permission } }, ...identity });
    if (requestFailure) return response({}, requestFailure);
    const route = url.pathname.replace(/^\/users\/\d+/, "");
    if (route === "/collections" && !options.method) return response([...collections.values()]);
    if (["/items", "/collections"].includes(route) && options.method === "POST") {
      const [data] = JSON.parse(options.body);
      assert.equal(data.version, 0, "new objects with keys require version 0");
      const entry = { key: data.key, version: ++revision, data: { ...data, version: revision } };
      (route === "/items" ? items : collections).set(data.key, entry);
      if (failCreation && route === "/items") { failCreation = false; throw new Error("lost response"); }
      return response({ successful: { 0: entry }, failed: {} });
    }
    if (route === "/items/top") {
      const q = url.searchParams.get("q").toLowerCase();
      assert.equal(url.searchParams.get("qmode"), "everything");
      return response([...items.values()].filter((entry) => !entry.data.parentItem && `${entry.data.title} ${entry.data.DOI}`.toLowerCase().includes(q)));
    }
    const collectionMatch = route.match(/^\/collections\/([^/]+)$/);
    if (collectionMatch) return collections.has(collectionMatch[1]) ? response(collections.get(collectionMatch[1])) : response({}, 404);
    const childMatch = route.match(/^\/items\/([^/]+)\/children$/);
    if (childMatch) return response([...items.values()].filter((entry) => entry.data.parentItem === childMatch[1]));
    const fileMatch = route.match(/^\/items\/([^/]+)\/file$/);
    if (fileMatch) {
      const form = new URLSearchParams(options.body);
      if (form.has("upload")) {
        if (failRegistration) { failRegistration = false; return response({}, 500); }
        items.get(fileMatch[1]).data.md5 = authorizedHashes.get(fileMatch[1]);
        return response(null, 204);
      }
      authorizedHashes.set(fileMatch[1], form.get("md5"));
      if (authorizationStatus !== 200) return response({}, authorizationStatus);
      return response({ url: "https://upload.example.test/pdf", contentType: "multipart/form-data; boundary=x", prefix: "prefix", suffix: "suffix", uploadKey: "upload-key" });
    }
    const itemMatch = route.match(/^\/items\/([^/]+)$/);
    if (itemMatch) {
      const entry = items.get(itemMatch[1]);
      if (!entry) return response({}, 404);
      if (options.method === "PATCH") {
        assert.equal(options.headers["If-Unmodified-Since-Version"], String(entry.data.version));
        Object.assign(entry.data, JSON.parse(options.body), { version: ++revision });
        return response(null, 204);
      }
      return response(entry);
    }
    throw new Error(`Unexpected request: ${route}`);
  }
  const service = createZoteroService({
    vault: { load: async () => stored, save: async (value) => { stored = structuredClone(value); } },
    readState: () => structuredClone(state), writeState: (value) => { state = structuredClone(value); },
    getLibrary: () => papers, readPdf: pdfReader, readTranslation: translationReader, getTranslationSignature: translationSignature, fetcher
  });
  return { service, calls, items, collections, state: () => state, stored: () => stored,
    failUpload: () => { failUpload = true; }, failRegistration: () => { failRegistration = true; }, failCreation: () => { failCreation = true; }, denyPermission: () => { permission = false; }, setAuthorizationStatus: (value) => { authorizationStatus = value; }, setRequestFailure: (value) => { requestFailure = value; } };
}
async function connect(h, extra = {}) { await h.service.configure({ apiKey: secret, ...extra }); }
async function sync(h, ids) { await h.service.startSync(ids); await h.service.wait(); return h.service.status().lastRun; }

test("maps metadata without exposing local paths, notes or secrets", () => {
  const mapped = paperToZotero({ ...paper, notes: "local-only", apiKey: secret }, "COLL2345");
  assert.equal(mapped.DOI, "10.1234/test");
  assert.equal(mapped.creators[0].name, "Ada Lovelace");
  assert.equal(mapped.date, "2026");
  assert.ok(!JSON.stringify(mapped).includes(secret));
  assert.ok(!JSON.stringify(mapped).includes("local-only"));
});
test("configuration verifies permissions and status/state never return API Key", async () => {
  const h = harness(); await connect(h);
  assert.equal(h.service.status().configured, true);
  assert.ok(!JSON.stringify(h.service.status()).includes(secret));
  assert.ok(!JSON.stringify(h.state()).includes(secret));
  assert.equal(h.stored().apiKey, secret);
  await h.service.configure({ collectionName: "Papers", autoSync: true });
  assert.equal(h.service.status().collectionName, "Papers");
});
test("invalid or insufficient authorization is not saved", async () => {
  const h = harness(); h.denyPermission();
  await assert.rejects(connect(h), /权限/);
  assert.equal(h.stored(), null);
  assert.equal(h.service.status().configured, false);
});
test("creates collection, metadata and binary PDF; second sync does not duplicate", async () => {
  const h = harness(); await connect(h);
  assert.equal((await sync(h)).synced, 1);
  assert.equal(h.collections.size, 1); assert.equal(h.items.size, 2);
  assert.equal((await sync(h)).synced, 1);
  assert.equal(h.items.size, 2); assert.equal(h.calls.filter((call) => call.url.startsWith("https://upload.")).length, 1);
});
test("finds existing DOI item and preserves its metadata and collections", async () => {
  const h = harness();
  h.items.set("EXIST234", { key: "EXIST234", data: { version: 2, title: "Zotero edited title", DOI: "10.1234/test", collections: ["OTHER234"], tags: [], note: "phone note" } });
  await connect(h); assert.equal((await sync(h)).synced, 1);
  assert.equal(h.items.size, 2);
  assert.equal(h.items.get("EXIST234").data.title, "Zotero edited title");
  assert.ok(h.items.get("EXIST234").data.collections.includes("OTHER234"));
});
test("missing PDF is metadata-only rather than full success", async () => {
  const h = harness({ pdfReader: async () => null }); await connect(h);
  const run = await sync(h);
  assert.equal(run.synced, 0); assert.equal(run.metadataOnly, 1); assert.equal(h.items.size, 1);
});
test("failed upload retries same attachment", async () => {
  const h = harness(); await connect(h); h.failUpload();
  assert.equal((await sync(h)).failed, 1);
  assert.equal(h.items.size, 2);
  assert.equal((await sync(h)).synced, 1);
  assert.equal(h.items.size, 2);
});
test("lost creation response is recovered without duplicate", async () => {
  const h = harness(); await connect(h); h.failCreation();
  assert.equal((await sync(h)).failed, 1);
  assert.equal(h.items.size, 1);
  assert.equal((await sync(h)).synced, 1);
  assert.equal(h.items.size, 2);
});
test("failed file registration remains retryable", async () => {
  const h = harness(); await connect(h); h.failRegistration();
  assert.equal((await sync(h)).failed, 1);
  assert.equal((await sync(h)).synced, 1); assert.equal(h.items.size, 2);
});
test("storage quota errors are reported and retain uploaded item mapping", async () => {
  const h = harness(); await connect(h); h.setAuthorizationStatus(413);
  const run = await sync(h); assert.equal(run.failed, 1); assert.match(run.results[0].error, /空间不足/);
  h.setAuthorizationStatus(200); assert.equal((await sync(h)).synced, 1); assert.equal(h.items.size, 2);
});
test("continues other papers after one PDF failure", async () => {
  const h = harness({ papers: [paper, { ...paper, id: "local-2", title: "Other paper", doi: "10.1234/other" }], pdfReader: async (item) => { if (item.id === paper.id) throw new Error("PDF missing"); return { buffer: pdf }; } });
  await connect(h); const run = await sync(h);
  assert.equal(run.processed, 2); assert.equal(run.failed, 1); assert.equal(run.synced, 1);
});
test("rejects simultaneous sync/config/disconnect", async () => {
  let release; const blocked = new Promise((resolve) => { release = resolve; });
  const h = harness({ pdfReader: async () => { await blocked; return { buffer: pdf }; } });
  await connect(h); await h.service.startSync();
  await assert.rejects(h.service.startSync(), /正在/);
  await assert.rejects(h.service.configure({}), /正在/);
  await assert.rejects(h.service.disconnect(), /正在/);
  release(); await h.service.wait();
});
test("disconnect clears credentials without deleting cloud items", async () => {
  const h = harness(); await connect(h); await sync(h); await h.service.disconnect();
  assert.equal(h.service.status().configured, false); assert.equal(h.stored(), null); assert.equal(h.items.size, 2);
  await assert.rejects(h.service.startSync(), /连接/);
});
test("auto sync is opt-in and processes only changed papers", async () => {
  const papers = [structuredClone(paper)]; const h = harness({ papers }); await connect(h);
  await h.service.autoTick(); assert.equal(h.items.size, 0);
  await h.service.configure({ autoSync: true }); await h.service.autoTick(); await h.service.wait();
  assert.equal(h.items.size, 2); const count = h.calls.length;
  await h.service.autoTick(); assert.equal(h.calls.length, count);
  papers[0].title = "Updated title"; await h.service.autoTick(); await h.service.wait();
  const parent = [...h.items.values()].find((item) => item.data.itemType === "journalArticle");
  assert.equal(parent.data.title, "Updated title"); assert.equal(h.items.size, 2);
});
test("saved credentials and mappings resume after restart", async () => {
  const h = harness(); await connect(h); await sync(h);
  const next = harness({ initial: h.state(), savedCredential: h.stored() });
  await next.service.ready;
  assert.equal(next.service.status().configured, true);
  assert.equal(next.service.status().lastRun.synced, 1);
});
test("restricted sync validates ids and preserves unselected papers", async () => {
  const h = harness(); await connect(h);
  await assert.rejects(h.service.startSync("local-1"), /格式/);
  assert.equal((await sync(h, [])).total, 0); assert.equal(h.items.size, 0);
});

test("remote PDF edits are preserved and surfaced as a conflict", async () => {
  const h = harness(); await connect(h); await sync(h);
  const attachment = [...h.items.values()].find((item) => item.data.itemType === "attachment");
  attachment.data.md5 = "remote-phone-edit";
  const uploads = h.calls.filter((call) => call.url.startsWith("https://upload.")).length;
  const run = await sync(h);
  assert.equal(run.failed, 1); assert.match(run.results[0].error, /已被修改/);
  assert.equal(attachment.data.md5, "remote-phone-edit");
  assert.equal(h.calls.filter((call) => call.url.startsWith("https://upload.")).length, uploads);
});
test("auto sync schedules bounded retries after transient failures", async () => {
  const h = harness(); await connect(h, { autoSync: true });
  h.setRequestFailure(503);
  await h.service.autoTick(); await h.service.wait();
  assert.match(h.service.status().lastRun.error, /503/);
  h.setRequestFailure(0);
  const count = h.calls.length;
  await h.service.autoTick(); assert.equal(h.calls.length, count, "no immediate retry storm");
  const originalNow = Date.now;
  try {
    const future = originalNow() + 301000;
    Date.now = () => future;
    await h.service.autoTick(); await h.service.wait();
  } finally { Date.now = originalNow; }
  assert.equal(h.service.status().lastRun.synced, 1);
});

test("changing collection includes already synced papers in next automatic run", async () => {
  const h = harness(); await connect(h, { autoSync: true });
  await h.service.autoTick(); await h.service.wait();
  await h.service.configure({ collectionName: "New research", autoSync: true });
  await h.service.autoTick(); await h.service.wait();
  assert.equal(h.collections.size, 2); assert.equal(h.items.size, 2);
  const parent = [...h.items.values()].find((item) => item.data.itemType === "journalArticle");
  assert.equal(parent.data.collections.length, 2);
});

const chinesePdf = Buffer.from("%PDF-1.7\nChinese translation");
test("Chinese PDF is an independent attachment and repeated sync deduplicates both", async () => {
  const h = harness({ translationReader: async () => ({ buffer: chinesePdf }) });
  await connect(h); const run = await sync(h);
  assert.equal(run.results[0].translationStatus, "synced");
  assert.equal(h.items.size, 3);
  const attachment = [...h.items.values()].find((entry) => entry.data.filename === "paper.zh.pdf");
  assert.equal(attachment.data.title, "ScholarLoop 中文译文");
  await sync(h);
  assert.equal(h.items.size, 3);
  assert.equal(h.calls.filter((call) => call.url.startsWith("https://upload.")).length, 2);
});
test("new translation is discovered by auto sync without paper metadata changes", async () => {
  let translation = null; let revision = "";
  const h = harness({ translationReader: async () => translation, translationSignature: () => revision });
  await connect(h, { autoSync: true });
  await h.service.autoTick(); await h.service.wait();
  assert.equal(h.items.size, 2);
  translation = { buffer: chinesePdf }; revision = "zh-v1";
  await h.service.autoTick(); await h.service.wait();
  assert.equal(h.items.size, 3);
  assert.equal(h.service.status().lastRun.results[0].translationStatus, "synced");
  const count = h.calls.length;
  await h.service.autoTick(); assert.equal(h.calls.length, count);
});
test("translation failure retries without reuploading original or duplicating attachments", async () => {
  let fail = true;
  const h = harness({ translationReader: async () => { if (fail) throw new Error("translation read failed"); return { buffer: chinesePdf }; } });
  await connect(h); const failed = await sync(h);
  assert.equal(failed.failed, 1);
  assert.equal(failed.metadataOnly, 0);
  assert.equal(failed.results[0].pdfStatus, "全文已同步");
  assert.equal(failed.results[0].translationStatus, "failed");
  assert.equal(failed.results[0].translationMessage, "中文译文同步失败");
  assert.equal(h.state().accounts["1"].papers[paper.id].signature, undefined);
  fail = false; assert.equal((await sync(h)).synced, 1);
  assert.equal(h.items.size, 3);
  assert.equal(h.calls.filter((call) => call.url.startsWith("https://upload.")).length, 2);
});
test("remote Chinese edits stay intact and changed local Chinese gets its own attachment", async () => {
  let content = chinesePdf;
  const h = harness({ translationReader: async () => ({ buffer: content }) });
  await connect(h); await sync(h);
  const attachment = [...h.items.values()].find((entry) => entry.data.filename === "paper.zh.pdf");
  attachment.data.md5 = "phone-chinese-edit";
  assert.equal((await sync(h)).failed, 1);
  assert.equal(attachment.data.md5, "phone-chinese-edit");
  content = Buffer.from("%PDF-1.7\nRevised Chinese");
  assert.equal((await sync(h)).synced, 1);
  assert.equal(h.items.size, 4);
  assert.equal(attachment.data.md5, "phone-chinese-edit");
});
test("incomplete Chinese is clearly reported and never uploaded", async () => {
  const h = harness({ translationReader: async () => ({ status: "incomplete", message: "中文译文尚未完整生成" }) });
  await connect(h); const run = await sync(h);
  assert.equal(run.synced, 1); assert.equal(h.items.size, 2);
  assert.equal(run.results[0].translationStatus, "incomplete");
});

test("interrupted Chinese upload retries the same attachment and preserves original", async () => {
  let translated = null;
  const h = harness({ translationReader: async () => translated });
  await connect(h); await sync(h);
  translated = { buffer: chinesePdf };
  h.failUpload();
  assert.equal((await sync(h)).failed, 1); assert.equal(h.items.size, 3);
  assert.equal((await sync(h)).synced, 1); assert.equal(h.items.size, 3);
  assert.equal(h.calls.filter((call) => call.url.startsWith("https://upload.")).length, 3);
});
test("Chinese translation still gets a distinct attachment when bytes match original", async () => {
  const h = harness({ translationReader: async () => ({ buffer: pdf }) });
  await connect(h); await sync(h);
  assert.equal(h.items.size, 3);
  assert.ok([...h.items.values()].some((entry) => entry.data.filename === "paper.zh.pdf"));
});

test("automatic retry preserves original success after a Chinese upload fails", async () => {
  let translation = null; let revision = "";
  const h = harness({ translationReader: async () => translation, translationSignature: () => revision });
  await connect(h, { autoSync: true });
  await h.service.autoTick(); await h.service.wait();
  translation = { buffer: chinesePdf }; revision = "new-chinese";
  h.failUpload();
  await h.service.autoTick(); await h.service.wait();
  const failed = h.service.status().lastRun;
  assert.equal(failed.failed, 1); assert.equal(failed.metadataOnly, 0);
  assert.equal(failed.results[0].pdfStatus, "全文已同步");
  assert.equal(failed.results[0].translationStatus, "failed");
  assert.match(failed.results[0].error, /上传失败/);
  const originalNow = Date.now;
  try {
    const future = originalNow() + 301000; Date.now = () => future;
    await h.service.autoTick(); await h.service.wait();
  } finally { Date.now = originalNow; }
  assert.equal(h.service.status().lastRun.synced, 1);
  assert.equal(h.service.status().lastRun.results[0].translationStatus, "synced");
  assert.equal(h.items.size, 3);
  assert.equal(h.calls.filter((call) => call.url.startsWith("https://upload.")).length, 3);
});
