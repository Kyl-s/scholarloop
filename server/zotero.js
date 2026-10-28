import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

const API = "https://api.zotero.org";
const alphabet = "23456789ABCDEFGHIJKLMNPQRSTUVWXYZ";
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const doiOf = (value) => String(value || "").trim().replace(/^https?:\/\/(dx\.)?doi\.org\//i, "").replace(/^doi:\s*/i, "").toLowerCase();
const text = (value) => String(value || "").trim();
export const paperSignature = (paper) => hash([paper.title, paper.authors, paper.doi, paper.year, paper.venue, paper.abstract, paper.url, paper.tags, paper.pdfUrl, paper.pdfSha256, paper.pdfBytes]);
export function objectKey(value) {
  return [...createHash("sha256").update(String(value)).digest().subarray(0, 8)].map((byte) => alphabet[byte % alphabet.length]).join("");
}
export function paperToZotero(paper, collection) {
  const authors = Array.isArray(paper.authors) ? paper.authors : text(paper.authors).split(/[;；]/);
  return {
    itemType: "journalArticle", title: text(paper.title),
    creators: authors.filter(Boolean).map((author) => ({ creatorType: "author", name: text(typeof author === "object" ? author.name || [author.given, author.family].filter(Boolean).join(" ") : author) })).filter((author) => author.name),
    DOI: doiOf(paper.doi), date: text(paper.year), publicationTitle: text(paper.venue),
    abstractNote: text(paper.abstract), url: /^https?:\/\//i.test(text(paper.url)) ? text(paper.url) : "",
    tags: (Array.isArray(paper.tags) ? paper.tags : []).map((tag) => ({ tag: text(typeof tag === "object" ? tag.tag : tag) })).filter((tag) => tag.tag),
    collections: [collection]
  };
}
export function createZoteroService({ vault, readState, writeState, getLibrary, readPdf, readTranslation = async () => null, getTranslationSignature = () => "", fetcher = fetch, now = () => new Date().toISOString() }) {
  let state = { collectionName: "ScholarLoop", autoSync: false, accounts: {}, ...readState() };
  let credential = null;
  let loadError = "";
  let busy = false;
  let configBusy = false;
  let run = null;
  let task = Promise.resolve();
  let lastAutoSignature = "";
  let autoRetryAt = 0;
  let notBefore = 0;
  const ready = vault.load().then((record) => { credential = record?.apiKey ? record : null; }).catch(() => { loadError = "Zotero 凭据无法读取，请重新填写 API Key"; });
  const persist = () => writeState(state);
  const syncSignature = (paper) => hash([state.collectionName, paperSignature(paper), getTranslationSignature(paper)]);
  function status() {
    return { configured: Boolean(credential), username: credential?.username || "", userID: credential?.userID || "", collectionName: state.collectionName, autoSync: state.autoSync, busy: busy || configBusy, lastRun: run || state.lastRun || null, error: loadError };
  }
  function safeError(error) {
    const message = text(error?.message || error);
    return credential?.apiKey ? message.split(credential.apiKey).join("[已隐藏]") : message;
  }
  async function request(route, options = {}, key = credential?.apiKey) {
    if (Date.now() < notBefore) throw new Error("Zotero 正在限流，请稍后重试");
    let response;
    try {
      response = await fetcher(`${API}${route}`, { ...options, redirect: "error", signal: AbortSignal.timeout(120000), headers: { "Zotero-API-Version": "3", "Zotero-API-Key": key, ...options.headers } });
    } catch { throw new Error("连接 Zotero 失败，请检查网络或代理后重试"); }
    const backoff = Number(response.headers.get("Backoff") || response.headers.get("Retry-After"));
    if (backoff > 0) notBefore = Date.now() + backoff * 1000;
    if (!response.ok) {
      const messages = { 401: "API Key 无效，请重新配置", 403: "API Key 缺少个人库读取、写入或文件权限", 404: "Zotero 条目或分类已被删除，请重试同步", 409: "Zotero 文献库正忙，请稍后重试", 412: "Zotero 内容已变化，请重新同步，避免覆盖手机修改", 413: "Zotero 附件空间不足，请清理或扩容后重试", 429: "Zotero 请求过于频繁，请稍后重试" };
      const error = new Error(messages[response.status] || `Zotero 请求失败（HTTP ${response.status}）`);
      error.status = response.status;
      throw error;
    }
    return response.status === 204 ? null : response.json();
  }
  async function identify(key) {
    if (!key || !/^[a-z0-9]{16,128}$/i.test(key)) throw new Error("请输入有效的 Zotero API Key");
    const identity = await request("/keys/current", {}, key);
    if (!identity.userID || !identity.access?.user?.library || !identity.access?.user?.write || !identity.access?.user?.files) throw new Error("请为 API Key 勾选个人库读取、写入和文件访问权限");
    return { apiKey: key, userID: String(identity.userID), username: text(identity.username) };
  }
  async function configure(input = {}) {
    await ready;
    if (busy || configBusy) throw new Error("正在同步或连接 Zotero，请完成后再修改配置");
    configBusy = true;
    try {
      const key = text(input.apiKey) || credential?.apiKey;
      const next = await identify(key);
      try { await vault.save(next); } catch { throw new Error("Zotero API Key 加密保存失败，请检查本机权限后重试"); }
      credential = next;
      loadError = "";
      state.collectionName = text(input.collectionName).slice(0, 120) || "ScholarLoop";
      state.autoSync = input.autoSync === true;
      lastAutoSignature = "";
      autoRetryAt = 0;
      persist();
      return status();
    } finally { configBusy = false; }
  }
  async function testConnection() {
    await ready;
    if (!credential) throw new Error("请先填写并保存 Zotero API Key");
    await identify(credential.apiKey);
    return status();
  }
  async function disconnect() {
    await ready;
    if (busy || configBusy) throw new Error("正在同步或连接 Zotero，请完成后再断开");
    configBusy = true;
    try {
      try { await vault.save(null); } catch { throw new Error("Zotero 授权清除失败，请检查本机权限后重试"); }
      credential = null;
      loadError = "";
      state.autoSync = false;
      persist();
      return status();
    } finally { configBusy = false; }
  }
  const prefix = () => `/users/${credential.userID}`;
  const account = () => state.accounts[credential.userID] ||= { papers: {}, collections: {} };
  async function getOptional(route) {
    try { return await request(route); } catch (error) { if (error.status === 404) return null; throw error; }
  }
  async function create(route, item) {
    const result = await request(route, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify([{ version: 0, ...item }]) });
    if (result.failed?.[0]) throw new Error(`Zotero 写入失败（${result.failed[0].code || "未知错误"}）`);
    return result.successful?.[0] || (result.unchanged?.[0] ? { key: result.unchanged[0] } : null) || Promise.reject(new Error("Zotero 未确认写入结果，请重试"));
  }
  async function collectionKey() {
    const saved = account().collections[state.collectionName];
    if (saved && await getOptional(`${prefix()}/collections/${saved}`)) return saved;
    let found = null;
    for (let start = 0; ; start += 100) {
      const list = await request(`${prefix()}/collections?limit=100&start=${start}`);
      found = list.find((entry) => entry.data?.name === state.collectionName && !entry.data.parentCollection);
      if (found || list.length < 100) break;
    }
    if (!found) {
      const key = objectKey(`ScholarLoop:collection:${credential.userID}:${state.collectionName}`);
      found = await getOptional(`${prefix()}/collections/${key}`) || await create(`${prefix()}/collections`, { key, name: state.collectionName, parentCollection: false });
    }
    account().collections[state.collectionName] = found.key;
    persist();
    return found.key;
  }
  async function findDuplicate(paper) {
    const doi = doiOf(paper.doi);
    const query = doi || text(paper.title);
    if (!query) return null;
    for (let start = 0; ; start += 100) {
      const list = await request(`${prefix()}/items/top?q=${encodeURIComponent(query)}&qmode=everything&limit=100&start=${start}`);
      const match = list.find((entry) => doi ? doiOf(entry.data?.DOI) === doi : text(entry.data?.title).toLowerCase() === text(paper.title).toLowerCase() && text(entry.data?.date).slice(0, 4) === text(paper.year).slice(0, 4));
      if (match) return match;
      if (list.length < 100) return null;
    }
  }
  async function syncPaper(paper, collection) {
    const records = account().papers;
    const record = records[paper.id] ||= {};
    let remote = record.key ? await getOptional(`${prefix()}/items/${record.key}`) : null;
    if (!remote) {
      // Persist a stable key before any network write, including uncertain failures.
      const key = record.key || objectKey(`ScholarLoop:paper:${credential.userID}:${doiOf(paper.doi) || paper.id}`);
      remote = await getOptional(`${prefix()}/items/${key}`) || await findDuplicate(paper);
      if (!remote) {
        record.key = key;
        record.owned = true;
        persist();
        remote = await create(`${prefix()}/items`, { key, ...paperToZotero(paper, collection) });
      }
      record.key = remote.key;
      persist();
    }
    const desired = paperToZotero(paper, collection);
    const fingerprint = hash(desired);
    const data = remote.data || (await request(`${prefix()}/items/${record.key}`)).data;
    const collections = [...new Set([...(data.collections || []), collection])];
    if ((record.owned && record.fingerprint !== fingerprint) || !data.collections?.includes(collection)) {
      const patch = record.owned ? { ...desired, tags: [...new Map([...(data.tags || []), ...desired.tags].map((tag) => [tag.tag, tag])).values()], collections } : { collections };
      await request(`${prefix()}/items/${record.key}`, { method: "PATCH", headers: { "Content-Type": "application/json", "If-Unmodified-Since-Version": String(data.version ?? remote.version) }, body: JSON.stringify(patch) });
    }
    record.fingerprint = fingerprint;
    persist();
    const signature = syncSignature(paper);
    const pdf = await readPdf(paper);
    const result = { status: pdf ? "synced" : "metadata-only", pdfStatus: pdf ? "全文已同步" : "未找到 PDF，请先在文献库打开或导入全文后重试" };
    if (pdf) await syncAttachment(record, pdf);
    try {
      const translation = await readTranslation(paper, pdf);
      if (translation?.buffer) {
        await syncAttachment(record, translation, true);
        result.translationStatus = "synced";
        result.translationMessage = "中文译文已同步";
      } else {
        result.translationStatus = translation?.status || "unavailable";
        result.translationMessage = translation?.message || "暂无中文译文";
      }
    } catch (error) {
      // Preserve original-PDF success and leave the paper eligible for automatic retry.
      delete record.signature;
      persist();
      return { ...result, status: "failed", translationStatus: "failed", translationMessage: "中文译文同步失败", error: safeError(error) };
    }
    // Later changes stay pending even if they arrive while uploading this snapshot.
    record.signature = signature;
    persist();
    return result;
  }
  async function syncAttachment(record, pdf, translated = false) {
    const filename = translated ? "paper.zh.pdf" : "paper.pdf";
    const md5 = createHash("md5").update(pdf.buffer).digest("hex");
    const children = await request(`${prefix()}/items/${record.key}/children?limit=100`);
    // Never replace a remotely edited PDF; each changed local file gets its own attachment.
    let attachment = children.find((entry) => entry.data?.contentType === "application/pdf" && entry.data?.md5 === md5 && (!translated || entry.data?.filename === "paper.zh.pdf" || entry.data?.title === "ScholarLoop 中文译文") && ["imported_file", "imported_url"].includes(entry.data?.linkMode));
    if (attachment) return;
    const attachmentKey = objectKey(`ScholarLoop:${translated ? "pdf-zh" : "pdf"}:${credential.userID}:${record.key}:${md5}`);
    attachment = await getOptional(`${prefix()}/items/${attachmentKey}`);
    if (!attachment) attachment = await create(`${prefix()}/items`, { key: attachmentKey, itemType: "attachment", parentItem: record.key, linkMode: "imported_file", title: translated ? "ScholarLoop 中文译文" : "ScholarLoop PDF", contentType: "application/pdf", filename, tags: [], relations: {} });
    if (attachment.data?.md5 && attachment.data.md5 !== md5) throw new Error("Zotero 中的 PDF 已被修改，已保留手机端文件；请手动确认版本后重试");
    const condition = attachment.data?.md5 ? { "If-Match": attachment.data.md5 } : { "If-None-Match": "*" };
    const fileRoute = `${prefix()}/items/${attachmentKey}/file`;
    const authorization = await request(fileRoute, { method: "POST", headers: { ...condition, "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ md5, filename, filesize: String(pdf.buffer.length), mtime: String(pdf.mtime || Date.now()) }).toString() });
    if (!authorization.exists) {
      const url = new URL(authorization.url);
      if (url.protocol !== "https:" || url.username || url.password) throw new Error("Zotero 返回了无效上传地址");
      const body = Buffer.concat([Buffer.from(authorization.prefix, "utf8"), pdf.buffer, Buffer.from(authorization.suffix, "utf8")]);
      let uploaded;
      try { uploaded = await fetcher(url.href, { method: "POST", headers: { "Content-Type": authorization.contentType }, body, redirect: "error", signal: AbortSignal.timeout(180000) }); }
      catch { throw new Error("PDF 上传中断，条目已保留，可重新同步"); }
      if (!uploaded.ok) throw new Error(`PDF 上传失败（HTTP ${uploaded.status}），可重新同步`);
      await request(fileRoute, { method: "POST", headers: { ...condition, "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ upload: authorization.uploadKey }).toString() });
    }
  }
  async function perform(papers) {
    try {
      const collection = await collectionKey();
      for (const paper of papers) {
        const result = { id: paper.id, title: paper.title };
        try {
          Object.assign(result, await syncPaper(paper, collection));
          if (result.status === "synced") run.synced++;
          else if (result.status === "failed") run.failed++;
          else run.metadataOnly++;
        } catch (error) { result.status = "failed"; result.error = safeError(error); run.failed++; }
        run.results.push(result);
        run.processed++;
        persistRun();
        if (Date.now() < notBefore) { run.error = "Zotero 要求暂停请求，请稍后重试剩余文献"; break; }
      }
    } catch (error) { run.error = safeError(error); }
    finally {
      run.running = false; run.finishedAt = now(); busy = false;
      if (run.error || run.failed || run.processed < run.total) { lastAutoSignature = ""; autoRetryAt = Date.now() + 300000; }
      persistRun();
    }
  }
  function persistRun() { state.lastRun = run; persist(); }
  async function startSync(ids) {
    await ready;
    if (!credential) throw new Error("请先在设置中连接 Zotero");
    if (busy || configBusy) throw new Error("Zotero 正在同步或连接，请稍候");
    if (ids !== undefined && (!Array.isArray(ids) || ids.some((id) => typeof id !== "string"))) throw new Error("文献选择格式不正确");
    const papers = structuredClone(getLibrary().filter((paper) => !ids || ids.includes(paper.id)));
    busy = true;
    run = { running: true, total: papers.length, processed: 0, synced: 0, failed: 0, metadataOnly: 0, results: [], startedAt: now() };
    try { persistRun(); } catch (error) { busy = false; throw error; }
    task = perform(papers).catch(() => { run.error = "同步记录保存失败，请检查磁盘后重试"; run.running = false; busy = false; });
    return { started: true };
  }
  async function autoTick() {
    await ready;
    if (!credential || !state.autoSync || busy || configBusy || Date.now() < Math.max(autoRetryAt, notBefore)) return;
    const papers = getLibrary();
    const signature = hash(papers.map((paper) => [paper.id, syncSignature(paper)]));
    if (lastAutoSignature === signature) return;
    lastAutoSignature = signature;
    const pending = papers.filter((paper) => account().papers[paper.id]?.signature !== syncSignature(paper));
    if (pending.length) await startSync(pending.map((paper) => paper.id));
  }
  if (state.lastRun?.running) { state.lastRun.running = false; state.lastRun.error = "上次同步被中断，请重新同步"; }
  return { ready, status, configure, testConnection, disconnect, startSync, autoTick, wait: () => task };
}

export function createStateFile(file) {
  return {
    readState() {
      try { return JSON.parse(fs.readFileSync(file, "utf8")); }
      catch (error) { if (error.code === "ENOENT") return {}; throw new Error("Zotero 同步记录无法读取，请恢复记录后重试"); }
    },
    writeState(state) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(`${file}.tmp`, JSON.stringify(state, null, 2), { mode: 0o600 });
      fs.renameSync(`${file}.tmp`, file);
    }
  };
}
