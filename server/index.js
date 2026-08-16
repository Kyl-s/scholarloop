import express from "express";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { searchPapers, buildAiSearchPlan, resolveByDoi, parseBibtex, makeManualPaper } from "./sources.js";
import { analyzePaper, deepAnalyze } from "./analyze.js";
import { generatePath, pathProgress, syncPathEvidence } from "./path.js";
import { agentChat } from "./agent.js";
import { buildJournal, refineJournal } from "./journal.js";
import {
  getData,
  loadData,
  getMemories,
  upsertMemory,
  updateMemory,
  removeMemory,
  upsertPaper,
  updatePaper,
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
  getSettings,
  updateSettings,
  importAll,
  addPathTask,
  splitPathTask,
  updatePathTaskStatus,
  appendPathLog
} from "./store.js";
import { getProxyUrl, fetchWithFallback } from "./proxy.js";
import { interpretPdf } from "./pdfInterpret.js";
import { mergeUsages, parseChatUsage } from "../src/llmUsage.js";
import { clearPdfCache, getPdfCache, listPdfCaches, resolveLocalPdfPath, resolvePaperPdfPath, savePdfCache, savePdfSource } from "./pdfCache.js";
import { parseReadingNotes } from "../src/readingNotes.js";
import { fetchPdfWithOpenAccessFallback } from "./pdfResolve.js";
import {
  cancelPdfMathTranslation,
  getPdfMathTranslateFile,
  getPdfMathTranslationForPaper,
  getPdfMathTranslationJob,
  getPdfMathInstallState,
  getPdfMathTranslateStatus,
  installPdfMathTranslate,
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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { PDFParse } = require("pdf-parse");
const app = express();
const PORT = process.env.PORT || 8787;

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

function normalizeModelContent(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object") {
          return normalizeModelContent(part.text ?? part.content ?? part.value ?? "");
        }
        return "";
      })
      .filter(Boolean)
      .join("");
  }
  if (value && typeof value === "object") {
    return normalizeModelContent(value.text ?? value.content ?? value.value ?? "");
  }
  return value == null ? "" : String(value);
}

function extractModelText(data) {
  const choice = data?.choices?.[0];
  const candidates = [choice?.message?.content, choice?.text, data?.output_text];
  for (const candidate of candidates) {
    const text = normalizeModelContent(candidate).trim();
    if (text) return text;
  }
  return "";
}

function modelResponseError(data) {
  const message = data?.choices?.[0]?.message;
  const reasoning = normalizeModelContent(message?.reasoning_content ?? message?.reasoning).trim();
  if (reasoning) return "模型只返回了思考过程，没有最终译文；请提高输出上限或更换翻译模型";
  return "模型返回为空：接口没有返回最终译文";
}

async function extractPdfText(buffer, maxPages = 15) {
  const parser = new PDFParse({ data: buffer });
  const parsed = await parser.getText();
  return String(parsed?.text || "").replace(/[ \t]+/g, " ").trim().slice(0, 30000);
}

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
    const r = await fetch(`${baseUrl}/chat/completions`, {
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
app.use(express.json({ limit: "50mb" }));

app.get("/api/health", (_req, res) => res.json({ ok: true, name: "ScholarLoop" }));

app.get("/api/sources", (_req, res) => {
  res.json({
    sources: [
      { id: "arxiv", label: "arXiv", home: "https://arxiv.org", desc: "预印本与计算机/物理前沿", enabled: true },
      { id: "openalex", label: "OpenAlex", home: "https://openalex.org", desc: "全球学术文献开放索引", enabled: true },
      { id: "semanticscholar", label: "Semantic Scholar", home: "https://www.semanticscholar.org", desc: "AI 语义检索与引用数据", enabled: true },
      { id: "pubmed", label: "PubMed", home: "https://pubmed.ncbi.nlm.nih.gov", desc: "生物医学文献", enabled: true },
      { id: "crossref", label: "Crossref", home: "https://search.crossref.org", desc: "期刊与 DOI 元数据", enabled: true },
      { id: "cnki", label: "知网 CNKI", home: "https://www.cnki.net", desc: "中文期刊/学位论文/会议/报纸", enabled: true }
    ],
    chinesePortals: [
      { id: "cnki", label: "知网 CNKI", home: "https://www.cnki.net" },
      { id: "wanfang", label: "万方", home: "https://www.wanfangdata.com.cn" },
      { id: "baidu", label: "百度学术", home: "https://xueshu.baidu.com" },
      { id: "googlescholar", label: "Google Scholar", home: "https://scholar.google.com" }
    ],
    hasOpenAI: Boolean(process.env.OPENAI_API_KEY)
  });
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
      limit: Number(req.query.limit) || 15
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
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
      config: req.body?.config
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
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
    res.status(500).json({ error: err.message });
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
    res.status(502).json({ error: `PDF 下载失败：${err.message}` });
  }
});

app.get("/api/pdf/file/:name", (req, res) => {
  const name = String(req.params.name || "");
  if (!/^[a-f0-9-]+\.pdf$/i.test(name)) return res.status(400).json({ error: "文件名不合法" });
  const file = path.join(__dirname, "..", "data", "pdfs", name);
  if (!fs.existsSync(file)) return res.status(404).json({ error: "PDF 文件不存在" });
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
  res.json(decoratePdfMathJob(job));
});

app.post("/api/pdf/translate-layout/:job/cancel", (req, res) => {
  const job = cancelPdfMathTranslation(req.params.job);
  if (!job) return res.status(404).json({ error: "排版翻译任务不存在或已失效" });
  res.json(decoratePdfMathJob(job));
});

app.post("/api/pdf/translate-layout/:job/priority", (req, res) => {
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
      // 续译未完成页（跳过已完成）；与 force 互斥
      continueAll: Boolean(req.body?.continueAll || req.body?.translateMode === "all-remaining"),
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
    const r = await fetch(`${baseUrl}/chat/completions`, {
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
      } catch {
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
    const r = await fetch(`${baseUrl}/models`, {
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
app.get("/api/library/:id/pdf-layout-translation", (req, res) => {
  const paper = getData().library.find((item) => item.id === req.params.id);
  if (!paper) return res.status(404).json({ error: "文献不存在" });
  const cache = getPdfCache(req.params.id);
  let job = null;
  if (cache?.layoutTranslationJobId) {
    job = getPdfMathTranslationJob(cache.layoutTranslationJobId);
  }
  if (!job) {
    job = getPdfMathTranslationForPaper(req.params.id, {
      sourceLang: req.query?.sourceLang || "",
      targetLang: req.query?.targetLang || ""
    });
  }
  if (!job) return res.status(404).json({ error: "该文献还没有本地版式译文" });
  res.json(decoratePdfMathJob(job));
});

app.put("/api/library/:id/pdf-cache", (req, res) => {
  const paper = getData().library.find((item) => item.id === req.params.id);
  if (!paper) return res.status(404).json({ error: "文献不存在" });
  try {
    res.json({ cache: savePdfCache(req.params.id, req.body || {}) });
  } catch (err) {
    res.status(400).json({ error: `保存 PDF 缓存失败：${err.message}` });
  }
});

app.delete("/api/library/:id/pdf-cache", (req, res) => {
  const paper = getData().library.find((item) => item.id === req.params.id);
  if (!paper) return res.status(404).json({ error: "文献不存在" });
  clearPdfCache(req.params.id);
  res.json({ ok: true });
});

app.post("/api/library/:id/pdf-source", (req, res) => {
  const paper = getData().library.find((item) => item.id === req.params.id);
  if (!paper) return res.status(404).json({ error: "文献不存在" });
  const encoded = String(req.body?.data || "").trim();
  if (!encoded) return res.status(400).json({ error: "PDF 数据不能为空" });
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

app.delete("/api/library/*", (req, res) => {
  removePaper(req.params[0]);
  res.json({ ok: true });
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
  if (!data) return res.status(400).json({ error: "PDF 数据不能为空" });
  try {
    const buffer = Buffer.from(data, "base64");
    const text = await extractPdfText(buffer);
    const base = guessPdfMetadata(text);
    const ai = await extractPdfMetadataAi(text, config);
    const pdfsDir = path.join(__dirname, "..", "data", "pdfs");
    if (!fs.existsSync(pdfsDir)) fs.mkdirSync(pdfsDir, { recursive: true });
    const fileName = `${randomUUID()}.pdf`;
    fs.writeFileSync(path.join(pdfsDir, fileName), buffer);
    let title = (base.title || ai?.title || "").trim();
    if (!title && pdfName) title = pdfName.replace(/\.pdf$/i, "").trim().slice(0, 300);
    if (!title) title = `未命名文献（${new Date().toISOString().slice(0, 10)}）`;
    const paper = makeManualPaper({
      ...base,
      ...(ai || {}),
      title,
      source: "manual",
      url: "",
      pdfUrl: `/api/pdf/file/${fileName}`
    });
    paper.aiExtracted = Boolean(ai);
    paper.localPdf = true;
    res.json(paper);
  } catch (err) {
    res.status(400).json({ error: `PDF 解析失败：${err.message}` });
  }
});

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

app.get("/api/settings", (_req, res) => res.json(getSettings()));

app.put("/api/settings", (req, res) => {
  res.json(updateSettings(req.body || {}));
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

app.delete("/api/journals/:id", (req, res) => {
  removeJournal(req.params.id);
  res.json({ ok: true });
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
  res.type("application/json").send(JSON.stringify(getData(), null, 2));
});

app.post("/api/data/import", (req, res) => {
  try {
    res.json(importAll(req.body));
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

const server = app.listen(PORT, () => {
  const actualPort = server.address().port;
  setPdfMathLlmProxyPort(actualPort);
  console.log(`ScholarLoop server: http://127.0.0.1:${actualPort}`);
  console.log(`SCHOLARLOOP_PORT=${actualPort}`);
});
