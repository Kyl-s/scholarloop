import express from "express";
import { installZoteroRoutes } from "./zoteroRoutes.js";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { searchPapers, buildAiSearchPlan, resolveByDoi, parseBibtex, makeManualPaper, getPaperSourceInfo, PAPER_SOURCE_PORTALS, checkPaperSource, redactSensitiveError } from "./sources.js";
import { analyzePaper, deepAnalyze } from "./analyze.js";
import { generatePath, pathProgress, syncPathEvidence } from "./path.js";
import { agentChat } from "./agent.js";
import { buildJournal, refineJournal } from "./journal.js";
import { importChatGptShare } from "./chatgptShare.js";
import {
  getData,
  loadData,
  getMemories,
  upsertMemory,
  updateMemory,
  removeMemory,
  upsertPaper,
  updatePaper,
  findByDoi,
  getPaperInterpretation,
  savePaperInterpretation,
  removePaper,
  setPath,
  getDrafts,
  upsertDraft,
  removeDraft,
  getJournals,
  upsertJournal,
  removeJournal,
  getNotes,
  upsertNote,
  updateNote,
  removeNote,
  getSettings,
  updateSettings,
  importAll,
  addPathTask,
  splitPathTask,
  updatePathTaskStatus,
  appendPathLog
} from "./store.js";
import { getNoteFile, saveNoteFile } from "./noteFiles.js";
import { getProxyUrl, fetchWithFallback } from "./proxy.js";
import { interpretPdf, reviewGuidedAnswer, guideDialogTurn } from "./pdfInterpret.js";
import { mergeUsages, parseChatUsage } from "../src/llmUsage.js";
import { clearPdfCache, getPdfCache, listPdfCaches, resolveLocalPdfPath, resolvePaperPdfPath, savePdfCache, savePdfSource } from "./pdfCache.js";
import { parseReadingNotes } from "../src/readingNotes.js";
import { extractPdfText, fetchPdfWithOpenAccessFallback, isPdfBuffer, normalizeDoi } from "./pdfResolve.js";
import { buildImportedPdfPaper, downloadPdf, guessPdfNameFromUrl, normalizeAuthorsInput } from "./pdfImportShared.js";
import {
  cancelPdfMathTranslation,
  clearPdfMathTranslationsForPaper,
  createPdfMathTranslationIdentity,
  getPdfMathTranslateFile,
  getPdfMathTranslationForPaper,
  getPdfMathCompletedOutputCount,
  hasUsablePdfMathOutput,
  getPdfMathTranslationJob,
  getPdfMathInstallState,
  getPdfMathTranslateStatus,
  installPdfMathTranslate,
  setPdfMathPaperDeleting,
  setPdfMathTranslationPriority,
  startPdfMathTranslation
} from "./pdfMathTranslate.js";
import {
  buildGlossaryHintForText,
  buildTextTranslateSystemPrompt,
  protectUrls,
  restoreUrls,
  sanitizeTranslationModelOutput
} from "./translationQuality.js";
import { handlePdfMathLlmProxy, setPdfMathLlmProxyPort } from "./pdfMathLlmProxy.js";
import { pdfLayoutJobMatchesRestore } from "./pdfLayoutRestore.js";
import { extractModelText, modelResponseError } from "./modelResponse.js";
import { chatGptAuth, isLocalChatGptRequest } from "./chatgptAuth.js";
import { chatgptModelFetch, isChatGptModelUrl } from "./chatgptModel.js";
import { handlePdfVisionTranslation } from "./pdfVisionTranslation.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 8787;
const APP_VERSION = process.env.SCHOLARLOOP_VERSION || "1.1.0";
const DATA_FILE = path.join(__dirname, "..", "data", "store.json");
const latestPaperSourceWrites = new Map();
const latestPdfCacheWrites = new Map();
const latestPdfMathPriorities = new Map();

function acceptsLatestWrite(map, paperId, key, sequence) {
  const writeKey = String(key || "").trim();
  const writeSequence = Number(sequence);
  if (!writeKey || !Number.isFinite(writeSequence)) return true;
  // 同一论文的写入必须跨 Reader 实例做 latest-wins，不能把客户端 key 当隔离域。
  const mapKey = paperId;
  const latest = Number(map.get(mapKey));
  if (Number.isFinite(latest) && writeSequence < latest) return false;
  map.set(mapKey, writeSequence);
  return true;
}

// PDF.js 5+ loads OpenJPEG/JBIG2/QCMS decoders from this directory at runtime.
// Keep the URL stable for both the desktop build and the Vite development proxy.
app.use(
  "/pdfjs-wasm",
  express.static(path.join(__dirname, "..", "node_modules", "pdfjs-dist", "wasm"), {
    fallthrough: false,
    immutable: true,
    maxAge: "1y"
  })
);

process.on("unhandledRejection", (reason) => {
  console.error("未处理的异步错误：", reason);
});

function guessPdfMetadata(text) {
  const clean = String(text || "").replace(/\r/g, "").trim();
  const lines = clean.split("\n").map((l) => l.trim()).filter(Boolean);
  let title = "";
  for (const line of lines) {
    if (line.length >= 8 && line.length <= 300 && !/^(abstract|introduction|1\s|doi|keywords|authors?|@|http|arxiv|contents)/i.test(line)) {
      title = line;
      break;
    }
  }
  let authors = [];
  const authorBlock = clean.match(/\n((?:[A-Z][\p{L}\-.' ]+(?:\s+(?:and|&)\s+)?){1,8})\n/im);
  if (authorBlock) {
    authors = authorBlock[1].split(/\s+(?:and|&)\s+|\s*,\s*/).map((s) => s.trim()).filter((s) => s.length >= 2).slice(0, 20);
  }
  if (!authors.length) {
    const authorLine = lines.find((l) => /(university|institute|laboratory|department|facebook|google|microsoft|academy|college|school)/i.test(l) && l.length < 140);
    const prev = authorLine ? lines[lines.indexOf(authorLine) - 1] : "";
    if (prev && prev.length < 160 && /[A-Z]/.test(prev)) {
      authors = prev.split(/\s+(?:and|&)\s+|\s*,\s*/).map((s) => s.trim()).filter((s) => s.length >= 2).slice(0, 20);
    }
  }
  const year = Number((clean.match(/\b(19\d{2}|20\d{2})\b/) || [])[0]) || null;
  const doi = (clean.match(/10\.\d{4,9}\/[-._;()/:A-Z0-9]+/i) || [])[0] || "";
  const abstractMatch = clean.match(/\bAbstract\b[\s:]*([\s\S]{100,1200}?)(?=\b(?:Introduction|Keywords|1\.?\s|Index Terms)\b)/i);
  const abstract = abstractMatch ? abstractMatch[1].replace(/\s+/g, " ").trim() : "";
  const kwMatch = clean.match(/\bKeywords?\b[\s:]*([^\n]{5,300})/i);
  const keywords = kwMatch ? kwMatch[1].split(/[,;]/).map((s) => s.trim()).filter(Boolean).slice(0, 10) : [];
  return { title, authors, year, venue: "", doi, abstract, keywords };
}

async function extractPdfMetadataAi(text, config = {}) {
  const baseUrl = String(config.baseUrl || "").trim().replace(/\/+$/, "");
  const apiKey = String(config.apiKey || "").trim();
  const model = String(config.model || "").trim();
  if (!baseUrl || !apiKey || !model || !text.trim()) return null;
  const system = "你是学术文献元数据提取助手。从论文正文中提取结构化信息，只输出一个 JSON 对象，不要输出其他文字。格式：{\"title\":\"论文标题\",\"authors\":[\"作者1\",\"作者2\"],\"year\":2024,\"venue\":\"期刊或会议\",\"doi\":\"\",\"abstract\":\"摘要前 600 字\",\"keywords\":[\"关键词\"]}。不确定的字段填空字符串或空数组。";
  const attempt = async () => {
    const r = await chatgptModelFetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: 5000,
        messages: [
          { role: "system", content: system },
          { role: "user", content: text.slice(0, 10000) }
        ]
      }),
      signal: AbortSignal.timeout(60000)
    });
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    const data = await r.json();
    const content = String(data.choices?.[0]?.message?.content || "").trim();
    const match = content.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]);
    return {
      title: String(parsed.title || "").trim(),
      authors: Array.isArray(parsed.authors) ? parsed.authors.map(String).filter(Boolean).slice(0, 20) : [],
      year: Number(parsed.year) || null,
      venue: String(parsed.venue || "").trim(),
      doi: String(parsed.doi || "").trim(),
      abstract: String(parsed.abstract || "").trim(),
      keywords: Array.isArray(parsed.keywords) ? parsed.keywords.map(String).filter(Boolean).slice(0, 12) : []
    };
  };
  try {
    const result = await attempt();
    if (result) return result;
  } catch {
    /* retry once */
  }
  await new Promise((r) => setTimeout(r, 900));
  try {
    return await attempt();
  } catch {
    return null;
  }
}

loadData();
function publicSettings(settings = {}) {
  const paperSources = {};
  for (const [id, source] of Object.entries(settings.paperSources || {})) {
    const { apiKey: _apiKey, ...safe } = source || {};
    paperSources[id] = { ...safe, configured: Boolean(String(_apiKey || "").trim()) };
  }
  return { ...settings, paperSources };
}

function publicData(data = {}) {
  return { ...data, settings: publicSettings(data.settings || {}) };
}

function searchErrorMessage(error, config = {}) {
  const sourceKeys = Object.values(getSettings().paperSources || {}).map((source) => source?.apiKey);
  return redactSensitiveError(error?.message || error, [...sourceKeys, config?.apiKey]);
}
app.use(express.json({ limit: "50mb" }));
installZoteroRoutes(app);
// OAuth credentials are usable only by the local desktop/browser client.
app.use((req, res, next) => {
  const oauth = req.path.startsWith("/api/chatgpt/")
    || String(req.body?.config?.baseUrl || req.body?.baseUrl || "").startsWith("scholarloop-chatgpt:");
  if (oauth && !isLocalChatGptRequest(req)) return res.status(403).json({ error: "ChatGPT OAuth 仅支持在本机 ScholarLoop 中使用" });
  next();
});
app.get("/api/chatgpt/status", async (_req, res) => { await chatGptAuth.ready; res.set("Cache-Control", "no-store").json(chatGptAuth.status()); });
app.post("/api/chatgpt/login", async (_req, res) => {
  try { res.set("Cache-Control", "no-store").json(await chatGptAuth.login()); }
  catch { res.status(400).json({ error: "无法启动 ChatGPT 登录，请检查本机回调端口和网络" }); }
});
app.post("/api/chatgpt/logout", async (_req, res) => {
  try { res.json(await chatGptAuth.logout()); }
  catch { res.status(500).json({ error: "无法清除本机 ChatGPT 加密凭据，请重试退出登录" }); }
});
app.get("/api/chatgpt/models", async (_req, res) => {
  try {
    const response = await chatgptModelFetch("scholarloop-chatgpt://local/models", { signal: AbortSignal.timeout(25000) });
    if (!response.ok) throw new Error(`ChatGPT 模型列表请求失败（HTTP ${response.status}）`);
    const body = await response.json();
    res.json({ models: (body.data || []).map((item) => item.id).filter(Boolean) });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.get("/api/health", (_req, res) => {
  const pdfMath = getPdfMathTranslateStatus();
  res.json({
    ok: true,
    name: "ScholarLoop",
    version: APP_VERSION,
    serverTime: new Date().toISOString(),
    data: {
      store: fs.existsSync(DATA_FILE)
    },
    capabilities: {
      pdfReader: true,
      ocr: true,
      ai: true,
      pdfMathTranslate: pdfMath.available
    }
  });
});

app.get("/api/sources", (_req, res) => {
  res.json({
    sources: [
      { id: "arxiv", label: "arXiv", home: "https://arxiv.org", desc: "预印本与计算机/物理前沿", enabled: true },
      { id: "openalex", label: "OpenAlex", home: "https://openalex.org", desc: "全球学术文献开放索引", enabled: true },
      { id: "semanticscholar", label: "Semantic Scholar", home: "https://www.semanticscholar.org", desc: "AI 语义检索与引用数据", enabled: true },
      { id: "pubmed", label: "PubMed", home: "https://pubmed.ncbi.nlm.nih.gov", desc: "生物医学文献", enabled: true },
      { id: "crossref", label: "Crossref", home: "https://search.crossref.org", desc: "期刊与 DOI 元数据", enabled: true },
      { id: "cnki", label: "知网 CNKI", home: "https://www.cnki.net", desc: "中文期刊/学位论文/会议/报纸", enabled: true }
      ,...getPaperSourceInfo(getSettings()).map((source) => ({ ...source, portal: source.home }))
    ],
    chinesePortals: [
      { id: "cnki", label: "知网 CNKI", home: "https://www.cnki.net" },
      { id: "wanfang", label: "万方", home: "https://www.wanfangdata.com.cn" },
      { id: "baidu", label: "百度学术", home: "https://xueshu.baidu.com" },
      { id: "googlescholar", label: "Google Scholar", home: "https://scholar.google.com" }
    ],
    hasOpenAI: Boolean(process.env.OPENAI_API_KEY),
    paperPortals: Object.values(PAPER_SOURCE_PORTALS).map((source) => ({ id: source.id, label: source.label, home: source.home }))
  });
});

app.post("/api/sources/:id/check", async (req, res) => {
  const id = String(req.params.id || "").trim();
  const result = await checkPaperSource(id, getSettings().paperSources?.[id] || {});
  res.json(result);
});
app.get("/api/search", async (req, res) => {
  const q = String(req.query.q || "").trim();
  if (!q) return res.status(400).json({ error: "请输入搜索关键词" });
  try {
    const result = await searchPapers(q, {
      sources: String(req.query.sources || "").split(",").filter(Boolean),
      fromYear: req.query.fromYear || "",
      toYear: req.query.toYear || "",
      sort: req.query.sort || "relevance",
      limit: Number(req.query.limit) || 15,
      sourceCredentials: getSettings().paperSources || {}
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: searchErrorMessage(err) });
  }
});

app.post("/api/search", async (req, res) => {
  const q = String(req.body?.q || "").trim();
  if (!q) return res.status(400).json({ error: "请输入搜索关键词" });
  try {
    const result = await searchPapers(q, {
      sources: Array.isArray(req.body?.sources) ? req.body.sources : [],
      fromYear: req.body?.fromYear || "",
      toYear: req.body?.toYear || "",
      sort: req.body?.sort || "relevance",
      limit: Number(req.body?.limit) || 15,
      queries: req.body?.queries,
      config: req.body?.config,
      sourceCredentials: getSettings().paperSources || {}
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: searchErrorMessage(err, req.body?.config) });
  }
});

app.post("/api/search/plan", async (req, res) => {
  const q = String(req.body?.q || "").trim();
  if (!q) return res.status(400).json({ error: "请输入搜索关键词" });
  try {
    const plan = await buildAiSearchPlan(q, {
      field: req.body?.field || "",
      goal: req.body?.goal || "",
      instruction: req.body?.instruction || "",
      config: req.body?.config
    });
    res.json(plan);
  } catch (err) {
    res.status(500).json({ error: searchErrorMessage(err, req.body?.config) });
  }
});

app.get("/api/pdf", async (req, res) => {
  const url = String(req.query.url || "").trim();
  const doi = String(req.query.doi || "").trim();
  if (!/^https?:\/\//i.test(url) && !doi) return res.status(400).json({ error: "PDF 链接不合法，且缺少 DOI" });
  try {
    const result = await fetchPdfWithOpenAccessFallback({
      url,
      doi,
      proxy: getProxyUrl(String(req.query.proxy || ""))
    });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", "inline");
    res.setHeader("X-ScholarLoop-PDF-Source", result.source);
    if (result.pmcid) res.setHeader("X-ScholarLoop-PMCID", result.pmcid);
    res.send(result.buffer);
  } catch (err) {
    res.status(502).json({ error: `PDF 下载失败：${err.message}`, kind: err.kind || "network", status: err.status || 0 });
  }
});

app.get("/api/pdf/file/:name", (req, res) => {
  const name = String(req.params.name || "");
  if (!/^[a-f0-9-]+\.pdf$/i.test(name)) return res.status(400).json({ error: "文件名不合法" });
  const file = path.join(__dirname, "..", "data", "pdfs", name);
  if (!fs.existsSync(file)) return res.status(404).json({ error: "PDF 文件不存在" });
  // Do not serve stale/corrupt files as PDFs; every local source must pass the same magic check.
  let valid = false;
  try {
    const fd = fs.openSync(file, "r");
    const header = Buffer.alloc(5);
    fs.readSync(fd, header, 0, 5, 0);
    fs.closeSync(fd);
    valid = isPdfBuffer(header);
  } catch {
    valid = false;
  }
  if (!valid) return res.status(422).json({ error: "本地文件不是有效的 PDF 文件" });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", "inline");
  fs.createReadStream(file).pipe(res);
});

app.get("/api/pdf/translate-layout/status", (_req, res) => {
  res.json({
    ...getPdfMathTranslateStatus(getSettings().pdfMathTranslateBin || ""),
    install: getPdfMathInstallState()
  });
});

app.post("/api/pdf/translate-layout/install", async (req, res) => {
  try {
    const result = await installPdfMathTranslate({ proxy: getSettings().proxy || "" });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message || "安装失败", install: getPdfMathInstallState() });
  }
});

function decoratePdfMathJob(job) {
  if (!job) return null;
  const result = job.result;
  const pages = (job.pages || []).map((page) => ({
    ...page,
    monoUrl: page.monoFile ? `/api/pdf/translated/${job.jobId}/${encodeURIComponent(page.monoFile)}` : "",
    dualUrl: page.dualFile ? `/api/pdf/translated/${job.jobId}/${encodeURIComponent(page.dualFile)}` : ""
  }));
  return {
    ...job,
    pages,
    monoUrl: result?.monoFile ? `/api/pdf/translated/${result.jobId || job.jobId}/${encodeURIComponent(result.monoFile)}` : "",
    dualUrl: result?.dualFile ? `/api/pdf/translated/${result.jobId || job.jobId}/${encodeURIComponent(result.dualFile)}` : ""
  };
}

app.post(
  [
    "/api/internal/pdf-math-llm/:token/chat/completions",
    "/api/internal/pdf-math-llm/:token/v1/chat/completions"
  ],
  async (req, res) => {
    try {
      await handlePdfMathLlmProxy(req, res);
    } catch (err) {
      if (!res.headersSent) res.status(502).json({ error: err.message || "翻译代理失败" });
    }
  }
);

app.get("/api/pdf/translate-layout/:job", (req, res) => {
  const job = getPdfMathTranslationJob(req.params.job);
  if (!job) return res.status(404).json({ error: "排版翻译任务不存在或已失效" });
  if (job.status === "completed" && !hasUsablePdfMathOutput(job)) {
    return res.status(409).json({ error: "排版翻译任务已完成但没有可用的译文 PDF，请重新翻译" });
  }
  if (req.query?.validateEngine === "true") {
    const settings = getSettings();
    const currentEngine = createPdfMathTranslationIdentity({
      config: settings,
      binary: settings.pdfMathTranslateBin || ""
    }).identity.engine;
    if (JSON.stringify(job.identity?.engine || null) !== JSON.stringify(currentEngine)) {
      return res.status(409).json({ error: "本地版式译文与当前翻译引擎不匹配" });
    }
  }
  res.json(decoratePdfMathJob(job));
});

app.post("/api/pdf/translate-layout/:job/cancel", (req, res) => {
  const job = cancelPdfMathTranslation(req.params.job);
  if (!job) return res.status(404).json({ error: "排版翻译任务不存在或已失效" });
  res.json(decoratePdfMathJob(job));
});

app.post("/api/pdf/translate-layout/:job/priority", (req, res) => {
  const prioritySeq = Number(req.body?.prioritySeq);
  const priorityKey = String(req.params.job || "");
  if (Number.isFinite(prioritySeq)) {
    const latest = Number(latestPdfMathPriorities.get(priorityKey));
    if (Number.isFinite(latest) && prioritySeq < latest) {
      const current = getPdfMathTranslationJob(req.params.job);
      if (!current) return res.status(404).json({ error: "排版翻译任务不存在或已失效" });
      return res.json(decoratePdfMathJob(current));
    }
    latestPdfMathPriorities.set(priorityKey, prioritySeq);
  }
  const page = Number(req.body?.page || req.body?.priorityPage || 1);
  const job = setPdfMathTranslationPriority(req.params.job, page, {
    continueAll: Boolean(req.body?.continueAll || req.body?.translateMode === "all-remaining")
  });
  if (!job) return res.status(404).json({ error: "排版翻译任务不存在或已失效" });
  res.json(decoratePdfMathJob(job));
});

app.get("/api/pdf/translated/:job/:file", (req, res) => {
  const file = getPdfMathTranslateFile(req.params.job, req.params.file);
  if (!file) return res.status(404).json({ error: "译文 PDF 不存在或已失效" });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", "inline");
  fs.createReadStream(file).pipe(res);
});

app.post("/api/pdf/translate-layout", async (req, res) => {
  try {
    const settings = getSettings();
    const bodyConfig = req.body?.config && typeof req.body.config === "object" ? req.body.config : {};
    // 合并设置页 / 环境默认的速度参数，避免前端遗漏导致仍走慢速默认
    const config = {
      ...bodyConfig,
      pdfMathQps: bodyConfig.pdfMathQps ?? settings.pdfMathQps,
      pdfMathWorkers: bodyConfig.pdfMathWorkers ?? settings.pdfMathWorkers,
      pdfMathPageWorkers: bodyConfig.pdfMathPageWorkers ?? settings.pdfMathPageWorkers,
      pdfMathNoDual: bodyConfig.pdfMathNoDual ?? settings.pdfMathNoDual
    };
    const job = startPdfMathTranslation({
      data: req.body?.data,
      config,
      sourceLang: req.body?.sourceLang || "en",
      targetLang: req.body?.targetLang || "zh",
      pageCount: req.body?.pageCount,
      progressive: req.body?.progressive,
      priorityPage: req.body?.priorityPage || req.body?.page || 1,
      paperId: req.body?.paperId || "",
      jobId: req.body?.jobId || "",
      force: Boolean(req.body?.force),
      retranslatePage: Number(req.body?.retranslatePage) || 0,
      // 续译未完成页（跳过已完成）；与 force 互斥
      continueAll: Boolean(req.body?.continueAll || req.body?.translateMode === "all-remaining"),
      layoutAssist: req.body?.layoutAssist,
      configFingerprint: String(req.body?.configFingerprint || "").trim(),
      binary: settings.pdfMathTranslateBin || ""
    });
    // 复用已完成本地任务时直接 200；新建任务仍返回 202
    const reused = Boolean(job?.persisted && ["completed", "failed", "canceled"].includes(job.status) && job.completedPages > 0)
      || (job?.status === "completed");
    res.status(reused && job.status === "completed" ? 200 : 202).json(decoratePdfMathJob(job));
  } catch (err) {
    const message = err.message || "PDF 排版翻译失败";
    const status = /API Key|地址和模型|只能对 PDF|请安装 PDFMathTranslate|源文件已丢失/.test(message) ? 400 : 502;
    res.status(status).json({ error: message });
  }
});

app.post("/api/pdf/vision-translate", handlePdfVisionTranslation);

app.post("/api/translate", async (req, res) => {
  const text = String(req.body?.text || "").trim();
  const config = req.body?.config || {};
  if (!text) return res.status(400).json({ error: "翻译内容不能为空" });
  const baseUrl = String(config.baseUrl || "").trim().replace(/\/+$/, "");
  const apiKey = String(config.apiKey || "").trim();
  const model = String(config.model || "").trim();
  const preserveTokens = Boolean(req.body?.preserveTokens);
  if (!baseUrl || !apiKey || !model) {
    return res.status(400).json({ error: "请先在设置中配置 API Key" });
  }

  // 通顺优先：学术中文 system + 本段命中的术语对照；网址占位保护后还原
  const systemBase = buildTextTranslateSystemPrompt({ preserveTokens: true });

  async function callModel(chunk) {
    const { text: protectedChunk, urls } = protectUrls(chunk);
    const system = systemBase + buildGlossaryHintForText(protectedChunk);
    const r = await chatgptModelFetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        temperature: 0.1,
        max_tokens: Math.min(8000, Math.max(4000, protectedChunk.length * 4 + 500)),
        messages: [
          { role: "system", content: system },
          { role: "user", content: `原文：\n${protectedChunk}` }
        ]
      }),
      signal: AbortSignal.timeout(45000)
    });
    if (!r.ok) {
      const detail = await r.text().catch(() => "");
      throw new Error(`${r.status} ${detail.slice(0, 200)}`);
    }
    const data = await r.json();
    const content = sanitizeTranslationModelOutput(extractModelText(data));
    if (!content) throw new Error(modelResponseError(data));
    return { text: restoreUrls(content, urls), usage: parseChatUsage(data) };
  }

  function splitChunks(input, maxLen = 1000) {
    const clean = String(input || "").trim();
    if (clean.length <= maxLen) return [clean];
    const chunks = [];
    let current = "";
    const blocks = clean.split(/\n{2,}/);
    const push = (part) => {
      if (current && (current + "\n\n" + part).length > maxLen) {
        chunks.push(current);
        current = "";
      }
      current = current ? `${current}\n\n${part}` : part;
    };
    for (const block of blocks) {
      if (block.length <= maxLen) {
        push(block);
        continue;
      }
      const sentences = block.split(/(?<=[.!?。！？])\s+/);
      let part = "";
      for (const sentence of sentences) {
        const candidate = part ? `${part} ${sentence}` : sentence;
        if (candidate.length > maxLen && part) {
          push(part);
          part = sentence;
        } else {
          part = candidate;
        }
      }
      if (part) push(part);
    }
    if (current) chunks.push(current);
    return chunks.filter(Boolean);
  }

  try {
    // 按页全力：page / page-layout 尽量整页一次译完，避免 1000 字切碎丢上下文
    const mode = String(req.body?.mode || "").trim();
    const pageMode = mode === "page" || mode === "page-layout";
    const maxLen = pageMode ? 8000 : 1000;
    const maxChunks = pageMode ? 8 : 25;
    const chunks = splitChunks(text, maxLen).slice(0, maxChunks);
    const translated = [];
    const usages = [];
    for (const chunk of chunks) {
      try {
        const out = await callModel(chunk);
        translated.push(out.text);
        usages.push(out.usage);
      } catch (err) {
        if (isChatGptModelUrl(baseUrl)) throw err;
        await new Promise((r) => setTimeout(r, 1200));
        const out = await callModel(chunk);
        translated.push(out.text);
        usages.push(out.usage);
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    res.json({ text: translated.join("\n\n"), usage: mergeUsages(usages) });
  } catch (err) {
    res.status(502).json({ error: `翻译失败：${err.message}` });
  }
});

app.post("/api/pdf/interpret", async (req, res) => {
  try {
    const result = await interpretPdf({
      title: req.body?.title || "",
      mode: req.body?.mode === "full" ? "full" : "quick",
      config: req.body?.config || {},
      pages: Array.isArray(req.body?.pages) ? req.body.pages : [],
      question: req.body?.question || "",
      prior: req.body?.prior || null
    });
    res.json(result);
  } catch (err) {
    const msg = err.message || "解读失败";
    const status = /API Key|配置/.test(msg) ? 400 : /扫描版|无可提取/.test(msg) ? 422 : 502;
    res.status(status).json({ error: msg });
  }
});

app.post("/api/pdf/interpret/guide", async (req, res) => {
  try {
    const result = await reviewGuidedAnswer({
      title: req.body?.title || "",
      mode: req.body?.mode === "full" ? "full" : "quick",
      config: req.body?.config || {},
      pages: Array.isArray(req.body?.pages) ? req.body.pages : [],
      step: req.body?.step || {},
      userAnswer: req.body?.userAnswer || "",
      prior: req.body?.prior || null
    });
    res.json(result);
  } catch (err) {
    const msg = err.message || "批改失败";
    const status = /API Key|配置/.test(msg) ? 400 : /扫描版|无可提取/.test(msg) ? 422 : 502;
    res.status(status).json({ error: msg });
  }
});

// 引导式精读：某一步批改完成后的持续追问（多轮对话）
app.post("/api/pdf/interpret/guide/dialog", async (req, res) => {
  try {
    const result = await guideDialogTurn({
      title: req.body?.title || "",
      mode: req.body?.mode === "full" ? "full" : "quick",
      config: req.body?.config || {},
      pages: Array.isArray(req.body?.pages) ? req.body.pages : [],
      step: req.body?.step || {},
      record: req.body?.record || {},
      messages: Array.isArray(req.body?.messages) ? req.body.messages : [],
      prior: req.body?.prior || null
    });
    res.json(result);
  } catch (err) {
    const msg = err.message || "回复失败";
    const status = /API Key|配置/.test(msg) ? 400 : /扫描版|无可提取/.test(msg) ? 422 : 502;
    res.status(status).json({ error: msg });
  }
});

app.post("/api/analyze", (req, res) => {
  try {
    res.json(analyzePaper(req.body || {}));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/analyze/deep", async (req, res) => {
  try {
    res.json(await deepAnalyze(req.body || {}));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/agent/chat", async (req, res) => {
  try {
    const result = await agentChat(req.body || {});
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/agent/models", async (req, res) => {
  try {
    const baseUrl = String(req.body?.baseUrl || "").trim().replace(/\/+$/, "");
    const apiKey = String(req.body?.apiKey || "").trim();
    if (!baseUrl || !apiKey) {
      return res.status(400).json({ error: "请先填写接口地址与 API Key" });
    }
    const r = await chatgptModelFetch(`${baseUrl}/models`, {
      method: "GET",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15000)
    });
    if (!r.ok) {
      const text = await r.text().catch(() => "");
      let detail = "";
      try {
        detail = JSON.parse(text)?.error?.message || "";
      } catch {
        detail = text.slice(0, 300);
      }
      throw new Error(`模型接口错误 ${r.status}: ${detail}`);
    }
    const json = await r.json();
    const raw = Array.isArray(json?.data) ? json.data : Array.isArray(json?.models) ? json.models : [];
    const models = [...new Set(raw
      .map((m) => (m && typeof m === "object" ? String(m.id || "") : String(m || "")))
      .map((id) => id.trim())
      .filter(Boolean))]
      .sort((a, b) => a.localeCompare(b));
    res.json({ models });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get("/api/library", (_req, res) => res.json(getData().library));

app.get("/api/reading-notes", (_req, res) => {
  const library = getData().library || [];
  const byId = Object.fromEntries(library.map((paper) => [paper.id, paper]));
  const items = listPdfCaches()
    .filter((cache) => String(cache.readingNotes || "").trim())
    .map((cache) => {
      const paper = byId[cache.paperId] || {};
      return {
        paperId: cache.paperId,
        title: paper.title || cache.paperId,
        authors: paper.authors || [],
        year: paper.year || "",
        doi: paper.doi || "",
        pdfUrl: paper.pdfUrl || cache.pdfUrl || "",
        localPdf: Boolean(paper.localPdf || cache.pdfUrl),
        savedAt: cache.savedAt || "",
        notes: cache.readingNotes,
        segments: parseReadingNotes(cache.readingNotes)
      };
    })
    .sort((a, b) => String(b.savedAt || "").localeCompare(String(a.savedAt || "")));
  res.json(items);
});

app.get("/api/memories", (_req, res) => res.json(getMemories()));

app.post("/api/memories", (req, res) => {
  try {
    res.json(upsertMemory(req.body || {}));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put("/api/memories/:id", (req, res) => {
  try {
    const memory = updateMemory(req.params.id, req.body || {});
    if (!memory) return res.status(404).json({ error: "记忆不存在" });
    res.json(memory);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete("/api/memories/:id", (req, res) => {
  removeMemory(req.params.id);
  res.json({ ok: true });
});

app.get("/api/library/:id/interpretation", (req, res) => {
  const interpretation = getPaperInterpretation(req.params.id);
  if (!interpretation) return res.status(404).json({ error: "该论文还没有保存的 AI 解读" });
  res.json({ interpretation });
});

app.put("/api/library/:id/interpretation", (req, res) => {
  try {
    const paper = savePaperInterpretation(req.params.id, req.body || {});
    if (!paper) return res.status(404).json({ error: "文献不存在" });
    res.json(paper.aiInterpretation);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get("/api/library/:id/pdf-cache", (req, res) => {
  const paper = getData().library.find((item) => item.id === req.params.id);
  if (!paper) return res.status(404).json({ error: "文献不存在" });
  res.json({ cache: getPdfCache(req.params.id) });
});

// 恢复该文献已持久化的版式翻译任务（重启后可直接打开，无需重译）
function normalizePdfMathBaseUrl(value) {
  const input = String(value || "").trim().replace(/\/+$/, "");
  if (!input) return "";
  try {
    const url = new URL(input);
    url.protocol = url.protocol.toLowerCase();
    url.hostname = url.hostname.toLowerCase();
    if ((url.protocol === "https:" && url.port === "443") || (url.protocol === "http:" && url.port === "80")) url.port = "";
    url.pathname = url.pathname.replace(/\/+$/, "");
    return url.toString().replace(/\/+$/, "");
  } catch {
    return input.toLowerCase();
  }
}

function pdfMathJobMatchesRequestedConfig(job, { model = "", baseUrl = "", sourceSha256 = "", layoutAssist, identityHash = "", configFingerprint = "", engine = null } = {}) {
  const identity = job?.identity && typeof job.identity === "object" ? job.identity : {};
  if ((model || baseUrl || identityHash) && !job?.identity) return false;
  return (!model || String(identity.model || "").trim() === model)
    && (!baseUrl || normalizePdfMathBaseUrl(identity.baseUrl) === normalizePdfMathBaseUrl(baseUrl))
    && (!sourceSha256 || String(job.sourceSha256 || "").trim() === sourceSha256)
    && (layoutAssist === undefined || job.layoutAssist?.enabled === layoutAssist)
    && (!identityHash || String(job.identityHash || "").trim() === identityHash)
    && (!configFingerprint || String(identity.configFingerprint || "").trim() === configFingerprint)
    && (!engine || JSON.stringify(identity.engine || null) === JSON.stringify(engine));
}

app.get("/api/library/:id/pdf-layout-translation", (req, res) => {
  const paper = getData().library.find((item) => item.id === req.params.id);
  if (!paper) return res.status(404).json({ error: "文献不存在" });
  // 只接受非敏感任务身份字段，绝不从恢复请求读取或回显 API Key。
  const requestedConfig = {
    model: String(req.query?.model || "").trim().slice(0, 300),
    baseUrl: String(req.query?.baseUrl || "").trim().slice(0, 1000),
    sourceSha256: String(req.query?.sourceSha256 || "").trim().slice(0, 128),
    identityHash: String(req.query?.identityHash || "").trim().slice(0, 128),
    configFingerprint: String(req.query?.configFingerprint || "").trim().slice(0, 128),
    layoutAssist: typeof req.query?.layoutAssist === "string" && req.query.layoutAssist !== ""
      ? req.query.layoutAssist === "true"
      : undefined
  };
  if (req.query?.restoreOnly === "true") {
    const restoreRequest = {
      paperId: req.params.id,
      sourceSha256: requestedConfig.sourceSha256,
      layoutAssist: requestedConfig.layoutAssist,
      sourceLang: String(req.query?.sourceLang || "en").trim(),
      targetLang: String(req.query?.targetLang || "zh").trim()
    };
    if (!restoreRequest.sourceSha256 || restoreRequest.layoutAssist === undefined) {
      return res.status(400).json({ error: "恢复版式译文需要模式和 PDF 指纹" });
    }
    const cache = getPdfCache(req.params.id);
    const mode = restoreRequest.layoutAssist ? "assisted" : "normal";
    const ids = [cache?.layoutTranslationJobs?.[mode]?.jobId, cache?.layoutTranslationJobId].filter(Boolean);
    let job = getPdfMathTranslationForPaper(req.params.id, { ...restoreRequest, requireOutput: true });
    for (const id of [...new Set(ids)]) {
      const candidate = getPdfMathTranslationJob(id);
      if (pdfLayoutJobMatchesRestore(candidate, restoreRequest) && hasUsablePdfMathOutput(candidate)) {
        if (!job || getPdfMathCompletedOutputCount(candidate) > getPdfMathCompletedOutputCount(job)
          || (getPdfMathCompletedOutputCount(candidate) === getPdfMathCompletedOutputCount(job)
            && Number(candidate.updatedAt) > Number(job.updatedAt))) job = candidate;
      }
    }
    if (!pdfLayoutJobMatchesRestore(job, restoreRequest) || !hasUsablePdfMathOutput(job)) {
      return res.status(404).json({ error: "该文献还没有本地版式译文" });
    }
    return res.json(decoratePdfMathJob(job));
  }
  requestedConfig.engine = createPdfMathTranslationIdentity({
    config: { ...getSettings(), model: requestedConfig.model, baseUrl: requestedConfig.baseUrl },
    sourceSha256: requestedConfig.sourceSha256,
    layoutAssist: requestedConfig.layoutAssist,
    binary: getSettings().pdfMathTranslateBin || ""
  }).identity.engine;
  if (!requestedConfig.model || !requestedConfig.baseUrl || !requestedConfig.sourceSha256 || requestedConfig.layoutAssist === undefined) {
    return res.status(400).json({ error: "恢复版式译文需要当前模型、接口地址、模式和 PDF 指纹" });
  }
  const cache = getPdfCache(req.params.id);
  let job = null;
  const preferredMode = requestedConfig.layoutAssist === true ? "assisted" : "normal";
  const preferredCacheJobId = cache?.layoutTranslationJobs?.[preferredMode]?.jobId || "";
  const cacheJobIds = [preferredCacheJobId, cache?.layoutTranslationJobId].filter(Boolean);
  for (const jobId of [...new Set(cacheJobIds)]) {
    const candidate = getPdfMathTranslationJob(jobId);
    if (candidate
      && candidate.paperId === req.params.id
      && pdfMathJobMatchesRequestedConfig(candidate, requestedConfig)
      && (candidate.status !== "completed" || hasUsablePdfMathOutput(candidate))) {
      job = candidate;
      break;
    }
  }
  if (!job) {
    job = getPdfMathTranslationForPaper(req.params.id, {
      sourceLang: req.query?.sourceLang || "",
      targetLang: req.query?.targetLang || "",
      sourceSha256: requestedConfig.sourceSha256,
      layoutAssist: requestedConfig.layoutAssist,
      identityHash: requestedConfig.identityHash,
      configFingerprint: requestedConfig.configFingerprint,
      model: requestedConfig.model,
      baseUrl: requestedConfig.baseUrl
    });
  }
  if (!job) return res.status(404).json({ error: "该文献还没有本地版式译文" });
  if (!pdfMathJobMatchesRequestedConfig(job, requestedConfig)) {
    return res.status(409).json({ error: "本地版式译文与当前模型配置不匹配" });
  }
  res.json(decoratePdfMathJob(job));
});

app.put("/api/library/:id/pdf-cache", (req, res) => {
  const paper = getData().library.find((item) => item.id === req.params.id);
  if (!paper) return res.status(404).json({ error: "文献不存在" });
  if (!acceptsLatestWrite(latestPdfCacheWrites, req.params.id, req.body?.cacheWriteKey, req.body?.cacheWriteSeq)) {
    return res.status(409).json({ error: "已忽略过期的 PDF 缓存保存请求" });
  }
  try {
    res.json({ cache: savePdfCache(req.params.id, req.body || {}) });
  } catch (err) {
    res.status(400).json({ error: `保存 PDF 缓存失败：${err.message}` });
  }
});

app.delete("/api/library/:id/pdf-cache", async (req, res) => {
  const paper = getData().library.find((item) => item.id === req.params.id);
  if (!paper) return res.status(404).json({ error: "文献不存在" });
  if (!acceptsLatestWrite(latestPdfCacheWrites, req.params.id, req.query?.cacheWriteKey, req.query?.cacheWriteSeq)) {
    return res.status(409).json({ error: "已忽略过期的 PDF 缓存清理请求" });
  }
  try {
    clearPdfCache(req.params.id);
    await clearPdfMathTranslationsForPaper(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: `清除版式翻译缓存失败：${err.message}` });
  }
});

app.post("/api/library/:id/pdf-source", (req, res) => {
  const paper = getData().library.find((item) => item.id === req.params.id);
  if (!paper) return res.status(404).json({ error: "文献不存在" });
  const encoded = String(req.body?.data || "").trim();
  if (!encoded) return res.status(400).json({ error: "PDF 数据不能为空" });
  if (!acceptsLatestWrite(latestPaperSourceWrites, req.params.id, req.body?.sourceWriteKey, req.body?.sourceWriteSeq)) {
    return res.status(409).json({ error: "已忽略过期的 PDF 保存请求" });
  }
  try {
    const source = savePdfSource(Buffer.from(encoded, "base64"), req.body?.sourceUrl || "");
    const updated = updatePaper(req.params.id, {
      pdfUrl: source.pdfUrl,
      localPdf: true,
      pdfSourceUrl: source.sourceUrl,
      pdfSha256: source.sourceSha256,
      pdfBytes: source.bytes,
      pdfCachedAt: new Date().toISOString()
    });
    res.json({ paper: updated, source });
  } catch (err) {
    res.status(400).json({ error: `保存 PDF 失败：${err.message}` });
  }
});

/** 返回文献本地 PDF 的绝对路径，供桌面端用系统/自选程序打开 */
app.get("/api/library/:id/pdf-local-path", (req, res) => {
  const paper = getData().library.find((item) => item.id === req.params.id);
  if (!paper) return res.status(404).json({ error: "文献不存在" });
  const filePath = resolvePaperPdfPath(paper);
  if (!filePath) {
    return res.status(404).json({
      error: "该文献还没有本地 PDF。请先用内置阅读器打开一次，或导入/缓存 PDF 后再用外部软件打开。"
    });
  }
  res.json({
    path: filePath,
    pdfUrl: paper.pdfUrl || "",
    title: paper.title || ""
  });
});

/** 将 base64 PDF 落到 data/pdfs，返回可给外部程序打开的绝对路径 */
app.post("/api/pdf/materialize", (req, res) => {
  try {
    const encoded = String(req.body?.data || "").trim();
    if (!encoded) return res.status(400).json({ error: "PDF 数据不能为空" });
    const source = savePdfSource(Buffer.from(encoded, "base64"), req.body?.sourceUrl || "");
    const filePath = resolveLocalPdfPath(source.pdfUrl);
    if (!filePath) return res.status(500).json({ error: "PDF 已写入但无法解析本地路径" });
    res.json({ path: filePath, pdfUrl: source.pdfUrl, bytes: source.bytes });
  } catch (err) {
    res.status(400).json({ error: `准备 PDF 文件失败：${err.message}` });
  }
});

app.post("/api/library", (req, res) => {
  try {
    const paper = req.body || {};
    if (!paper.title) return res.status(400).json({ error: "文献标题不能为空" });
    res.json(upsertPaper(paper));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put("/api/library/*", (req, res) => {
  const paper = updatePaper(req.params[0], req.body || {});
  if (!paper) return res.status(404).json({ error: "文献不存在" });
  res.json(paper);
});

app.delete("/api/library/*", async (req, res) => {
  setPdfMathPaperDeleting(req.params[0], true);
  try {
    await clearPdfMathTranslationsForPaper(req.params[0]);
    removePaper(req.params[0]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: `删除文献失败：${err.message}` });
  } finally {
    setPdfMathPaperDeleting(req.params[0], false);
  }
});

app.post("/api/import", async (req, res) => {
  try {
    const { type, data } = req.body || {};
    let paper;
    if (type === "doi") paper = await resolveByDoi(data);
    else if (type === "bibtex") paper = parseBibtex(data);
    else paper = makeManualPaper(data || {});
    res.json(paper);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/import/pdf", async (req, res) => {
  const data = String(req.body?.data || "");
  const config = req.body?.config || {};
  const pdfName = String(req.body?.pdfName || "").trim();
  // 可选元数据参数：显式传入的 title/authors/doi 优先于 PDF 提取值（authors 兼容数组或逗号分隔字符串）
  const explicit = {
    title: String(req.body?.title || "").trim(),
    doi: normalizeDoi(req.body?.doi || ""),
    authors: normalizeAuthorsInput(req.body?.authors)
  };
  if (!data) return res.status(400).json({ error: "PDF 数据不能为空" });
  try {
    const buffer = Buffer.from(data, "base64");
    if (!isPdfBuffer(buffer)) throw new Error("上传内容不是有效的 PDF 文件（缺少 %PDF- 文件头）");
    // 落盘 data/pdfs（复用 savePdfSource 的命名/哈希逻辑），pdfUrl 形如 /api/pdf/file/<uuid>.pdf
    const source = savePdfSource(buffer);
    // 与 /api/import/pdf-from-url 共用同一条提取→合并→DOI 反查流水线
    const paper = await buildImportedPdfPaper(buffer, {
      pdfName,
      config,
      explicit,
      pdfUrl: source.pdfUrl,
      resolveByDoi,
      extractText: extractPdfText,
      guessMetadata: guessPdfMetadata,
      extractAi: extractPdfMetadataAi
    });
    // 库内查重：构建出的记录带 DOI 时，附加到同 DOI 的已有记录而不是新建
    if (paper.doi) {
      const duplicate = findByDoi(paper.doi);
      if (duplicate) {
        const attachedPaper = attachPdfToPaper(duplicate, paper, source.pdfUrl);
        // 响应保持裸 paper 形状（LibraryPage 直接 upsert 该对象），attached 作为标记字段附在记录上
        return res.json({ ...attachedPaper, attached: true });
      }
    }
    res.json(paper);
  } catch (err) {
    res.status(400).json({ error: `PDF 解析失败：${err.message}` });
  }
});

// 服务端下载 URL 指向的 PDF 并导入：可附加到已有文献（paperId）或新建记录
app.post("/api/import/pdf-from-url", async (req, res) => {
  const url = String(req.body?.url || "").trim();
  if (!url) return res.status(400).json({ ok: false, error: "缺少 PDF 下载链接（url）" });
  const cookie = String(req.body?.cookie || "").trim();
  const sourceUrl = String(req.body?.sourceUrl || "").trim();
  const paperId = String(req.body?.paperId || "").trim();
  const explicit = {
    title: String(req.body?.title || "").trim(),
    doi: normalizeDoi(req.body?.doi || ""),
    authors: normalizeAuthorsInput(req.body?.authors)
  };
  try {
    // 服务端下载：带 Cookie/浏览器 UA/Referer，跟随重定向，100MB 上限，校验 %PDF- 头
    const { buffer } = await downloadPdf(url, { cookie, sourceUrl });
    // 与 /api/import/pdf 相同的落盘与元数据流水线
    const source = savePdfSource(buffer, sourceUrl);
    const paper = await buildImportedPdfPaper(buffer, {
      pdfName: guessPdfNameFromUrl(url),
      explicit,
      pdfUrl: source.pdfUrl,
      // 记录来源页：优先 sourceUrl（文章页），否则记下载地址
      url: sourceUrl || url,
      resolveByDoi,
      extractText: extractPdfText,
      guessMetadata: guessPdfMetadata,
      extractAi: extractPdfMetadataAi
    });
    // 附加模式：仅填空缺字段，不覆盖已有元数据
    if (paperId) {
      const existing = getData().library.find((p) => p.id === paperId);
      if (!existing) return res.status(404).json({ ok: false, error: "未找到要附加 PDF 的文献记录" });
      return res.json({ ok: true, paper: attachPdfToPaper(existing, paper, source.pdfUrl), attached: true });
    }
    // 库内查重：构建出的记录带 DOI 时，附加到同 DOI 的已有记录而不是新建——
    // 用户在文献库点开原搜索记录即可直接读到新落盘的 PDF，避免两条记录脱节
    if (paper.doi) {
      const duplicate = findByDoi(paper.doi);
      if (duplicate) {
        return res.json({ ok: true, paper: attachPdfToPaper(duplicate, paper, source.pdfUrl), attached: true });
      }
    }
    res.json({ ok: true, paper, attached: false });
  } catch (err) {
    // 错误统一 { ok:false, error } 形状；not-pdf → 422，其余按错误类别给状态码
    const status = err?.kind === "not-pdf" ? 422 : err?.kind === "too-large" ? 413 : err?.kind === "network" ? 502 : 500;
    res.status(status).json({ ok: false, error: err?.message || "导入 PDF 失败" });
  }
});

/**
 * 把导入的 PDF 附加到已有文献记录：pdfUrl 与 localPdf 必写，
 * 其余字段（title/authors/year/venue/doi/abstract/keywords）只填空缺值，不覆盖已有元数据。
 * /api/import/pdf 与 /api/import/pdf-from-url 的查重附加共用此函数，保证口径一致。
 */
function attachPdfToPaper(existing, paper, pdfUrl) {
  const patch = { pdfUrl, localPdf: true };
  for (const field of ["title", "authors", "year", "venue", "doi", "abstract", "keywords"]) {
    if (paper[field] !== undefined && paper[field] !== null && !filledField(existing[field])) {
      patch[field] = paper[field];
    }
  }
  return updatePaper(existing.id, patch);
}

/** 判断文献记录里的字段是否为"空缺"（用于附加 PDF 时仅填空字段） */
function filledField(value) {
  if (Array.isArray(value)) return value.filter(Boolean).length > 0;
  return String(value ?? "").trim().length > 0;
}

app.get("/api/path", (_req, res) => res.json(syncPathEvidence(getData().path, getData())));

app.post("/api/path/generate", (req, res) => {
  const p = generatePath(req.body || {});
  setPath(p);
  res.json(syncPathEvidence(p, getData()));
});

app.put("/api/path", (req, res) => {
  const p = setPath(req.body || {});
  res.json(syncPathEvidence(p, getData()));
});

app.post("/api/path/tasks", (req, res) => {
  const stageId = String(req.body?.stageId || "").trim();
  const title = String(req.body?.title || "").trim();
  if (!stageId || !title) return res.status(400).json({ error: "阶段与任务标题不能为空" });
  const p = addPathTask(stageId, title);
  res.json(syncPathEvidence(p, getData()));
});

app.put("/api/path/tasks", (req, res) => {
  const { stageId, index, status, splitTitles } = req.body || {};
  let p = getData().path;
  if (Array.isArray(splitTitles)) {
    p = splitPathTask(String(stageId || ""), Number(index), splitTitles);
  } else if (status) {
    p = updatePathTaskStatus(String(stageId || ""), Number(index), String(status));
  } else {
    return res.status(400).json({ error: "需要 status 或 splitTitles" });
  }
  res.json(syncPathEvidence(p, getData()));
});

app.post("/api/path/session", (req, res) => {
  const p = appendPathLog(req.body || {});
  res.json(syncPathEvidence(p, getData()));
});

app.get("/api/settings", (_req, res) => res.json(publicSettings(getSettings())));

app.put("/api/settings", (req, res) => {
  res.json(publicSettings(updateSettings(req.body || {})));
});

app.get("/api/drafts", (_req, res) => res.json(getDrafts()));

app.post("/api/drafts", (req, res) => res.json(upsertDraft(req.body || {})));

app.put("/api/drafts/:id", (req, res) => res.json(upsertDraft({ ...req.body, id: req.params.id })));

app.delete("/api/drafts/:id", (req, res) => {
  removeDraft(req.params.id);
  res.json({ ok: true });
});

app.get("/api/journals", (_req, res) => res.json(getJournals()));

app.post("/api/journals", async (req, res) => {
  try {
    const messages = req.body?.messages;
    let journal = buildJournal(messages, { title: req.body?.title });
    if (req.body?.id) journal.id = String(req.body.id);
    if (req.body?.config) {
      try {
        const refined = await refineJournal(messages, req.body.config);
        if (refined) journal = { ...refined, id: journal.id };
      } catch {
        /* 精炼失败时保留本地生成结果 */
      }
    }
    const saved = upsertJournal(journal);
    res.json(saved);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/journals/import", async (req, res) => {
  try {
    const imported = await importChatGptShare(req.body?.url);
    let journal = buildJournal(imported.messages, { title: imported.title });
    if (req.body?.config) {
      try {
        const refined = await refineJournal(imported.messages, req.body.config);
        if (refined) journal = refined;
      } catch {
        /* 精炼失败时保留本地生成结果 */
      }
    }
    journal.source = {
      provider: "chatgpt",
      label: "ChatGPT",
      url: imported.url,
      shareId: imported.shareId,
      importedAt: new Date().toISOString()
    };
    res.json(upsertJournal(journal));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete("/api/journals/:id", (req, res) => {
  removeJournal(req.params.id);
  res.json({ ok: true });
});

app.get("/api/notes", (_req, res) => res.json(getNotes()));

app.post("/api/notes", (req, res) => {
  try {
    res.json(upsertNote(req.body || {}));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put("/api/notes/:id", (req, res) => {
  try {
    const note = updateNote(req.params.id, req.body || {});
    if (!note) return res.status(404).json({ error: "手记不存在" });
    res.json(note);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete("/api/notes/:id", (req, res) => {
  removeNote(req.params.id);
  res.json({ ok: true });
});

app.post("/api/note-files", (req, res) => {
  try {
    res.json(saveNoteFile(req.body || {}));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get("/api/note-files/:id", (req, res) => {
  const file = getNoteFile(req.params.id);
  if (!file) return res.status(404).json({ error: "附件不存在" });
  res.setHeader("Content-Type", file.mime || "application/octet-stream");
  const mode = file.kind === "image" ? "inline" : "attachment";
  res.setHeader("Content-Disposition", `${mode}; filename*=UTF-8''${encodeURIComponent(file.name || "file")}`);
  res.sendFile(file.path);
});

app.post("/api/drafts/:id/export", (req, res) => {
  const draft = getDrafts().find((d) => d.id === req.params.id);
  if (!draft) return res.status(404).json({ error: "草稿不存在" });
  const lib = getData().library;
  const lines = [];
  lines.push(`# ${draft.title}`);
  lines.push("");
  lines.push(`> 类型：${draft.type === "review" ? "综述" : draft.type === "thesis" ? "学位论文" : "研究论文"}`);
  lines.push("");
  lines.push("## 摘要");
  lines.push("");
  lines.push(draft.abstract || "（待补充）");
  lines.push("");
  for (const section of draft.sections || []) {
    lines.push(`## ${section.title}`);
    lines.push("");
    lines.push(section.content || "（待补充）");
    lines.push("");
  }
  lines.push("## 参考文献");
  lines.push("");
  const refs = (draft.citations || [])
    .map((c) => {
      const p = lib.find((x) => x.id === c.paperId);
      if (!p) return null;
      const authors = (p.authors || []).slice(0, 3).join(", ");
      return `[${c.marker}] ${authors ? authors + ". " : ""}${p.title}. ${p.venue ? p.venue + ". " : ""}${p.year || ""}${p.doi ? ` DOI: ${p.doi}` : ""}${p.url ? ` ${p.url}` : ""}`;
    })
    .filter(Boolean);
  if (!refs.length) lines.push("（暂无引用）");
  refs.forEach((r) => lines.push(r));
  res.type("text/markdown").send(lines.join("\n"));
});

app.get("/api/stats", (_req, res) => {
  const data = getData();
  const syncedPath = syncPathEvidence(data.path, data);
  const lib = data.library;
  const dueToday = lib.filter((p) => p.reviewDue && p.reviewDue <= new Date().toISOString().slice(0, 10)).length;
  const byStatus = {
    todo: lib.filter((p) => p.status === "todo").length,
    reading: lib.filter((p) => p.status === "reading").length,
    understood: lib.filter((p) => p.status === "understood").length,
    retold: lib.filter((p) => p.status === "retold").length
  };
  const tags = new Map();
  lib.forEach((p) => (p.tags || []).forEach((t) => tags.set(t, (tags.get(t) || 0) + 1)));
  res.json({
    libraryCount: lib.length,
    byStatus,
    dueToday,
    avgUnderstanding: lib.length ? Math.round((lib.reduce((a, p) => a + (Number(p.understanding) || 1), 0) / lib.length) * 10) / 10 : 0,
    pathProgress: pathProgress(syncedPath.stages),
    drafts: data.drafts.length,
    recent: lib.slice(0, 6),
    topTags: [...tags.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([name, count]) => ({ name, count }))
  });
});

app.post("/api/data/export", (_req, res) => {
  res.type("application/json").send(JSON.stringify(publicData(getData()), null, 2));
});

app.post("/api/data/import", (req, res) => {
  try {
    res.json(publicData(importAll(req.body)));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

const distDir = path.join(__dirname, "..", "dist");
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir));
  app.get("*", (_req, res) => res.sendFile(path.join(distDir, "index.html")));
}

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: err.message || "服务器内部错误" });
});

const server = app.listen(PORT, "127.0.0.1", () => {
  const actualPort = server.address().port;
  setPdfMathLlmProxyPort(actualPort);
  console.log(`ScholarLoop server: http://127.0.0.1:${actualPort}`);
  console.log(`SCHOLARLOOP_PORT=${actualPort}`);
});
