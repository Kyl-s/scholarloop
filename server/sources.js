import { XMLParser } from "fast-xml-parser";
import { getSearchCache, setSearchCache } from "./store.js";
import { getProxyUrl, fetchWithFallback } from "./proxy.js";

const TIMEOUT = 15000;
const AGENT = "ScholarLoop/0.1 (research desktop app; mailto:local@scholarloop.app)";

async function fetchJson(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeout || TIMEOUT);
  try {
    const res = await fetchWithFallback(url, {
      headers: { "User-Agent": AGENT, Accept: "application/json", ...(options.headers || {}) },
      method: options.method || "GET",
      body: options.body,
      signal: controller.signal
    }, getProxyUrl());
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchText(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeout || TIMEOUT);
  try {
    const res = await fetchWithFallback(url, {
      headers: { "User-Agent": AGENT, ...(options.headers || {}) },
      method: options.method || "GET",
      body: options.body,
      signal: controller.signal
    }, getProxyUrl());
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

const SEARCH_CACHE_TTL = 7 * 24 * 60 * 60 * 1000;

function readSearchCache(key) {
  const entry = getSearchCache()[key];
  if (entry && Date.now() - entry.time < SEARCH_CACHE_TTL) return entry.value;
  return null;
}

function writeSearchCache(key, value) {
  setSearchCache(key, { value, time: Date.now() });
  return value;
}

function parseJsonArray(content) {
  const text = String(content || "").replace(/```json/gi, "").replace(/```/g, "").trim();
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function mapWithConcurrency(items, concurrency, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

function hasCjk(text) {
  return /[\u3400-\u9fff]/.test(String(text || ""));
}

function tokenize(text) {
  return String(text || "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

function queryTerms(query) {
  const q = String(query || "").toLowerCase().trim();
  if (!q) return [];
  const terms = new Set(tokenize(q).filter((t) => t.length >= 2));
  if (hasCjk(q)) {
    for (let i = 0; i < q.length - 1; i++) {
      const bigram = q.slice(i, i + 2);
      if (hasCjk(bigram[0]) && hasCjk(bigram[1])) terms.add(bigram);
    }
  }
  return [...terms];
}

function localRelevance(paper, query) {
  const q = String(query || "").trim();
  if (!q) return 0;
  const title = String(paper.title || "").toLowerCase();
  const abstract = String(paper.abstract || "").toLowerCase();
  const keywords = (paper.keywords || []).join(" ").toLowerCase();
  const ql = q.toLowerCase();
  const terms = queryTerms(ql);
  if (!terms.length) return 0;

  const titleHits = terms.filter((t) => title.includes(t)).length;
  const absHits = terms.filter((t) => abstract.includes(t)).length;
  const kwHits = terms.filter((t) => keywords.includes(t)).length;
  const n = terms.length;
  const titleCover = titleHits / n;
  const absCover = absHits / n;
  const kwCover = kwHits / n;

  let score = 0;
  score += titleCover * titleCover * 9;
  score += absCover * absCover * 4;
  score += kwCover * kwCover * 2;
  if (title.includes(ql)) score += 3.5;
  if (abstract.includes(ql)) score += 1.5;
  if (titleHits === n) score += 1.5;
  score += (Number(paper.relevance) || 0) * 0.25;
  return score;
}

function scoreMergedPapers(papers, queries) {
  const queryList = (queries || []).filter(Boolean);
  const scored = papers.map((paper) => {
    let best = { score: 0, query: "" };
    for (const query of queryList) {
      const s = localRelevance(paper, query);
      if (s > best.score) best = { score: s, query };
    }
    return { ...paper, relevance: best.score, matchQuery: best.query };
  });

  const bestRaw = Math.max(0, ...scored.map((p) => p.relevance));
  const cutoff = Math.max(1.4, bestRaw * 0.3);
  let kept = scored.filter((p) => p.relevance >= cutoff);
  if (!kept.length) {
    kept = [...scored].sort((a, b) => b.relevance - a.relevance).slice(0, 8);
  }

  const max = Math.max(0, ...kept.map((p) => p.relevance));
  if (max > 0) {
    for (const paper of kept) paper.relevance = paper.relevance / max;
  }
  return kept;
}

async function callChatCompletion(baseUrl, apiKey, model, system, user, opts = {}) {
  const attempt = async () => {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        temperature: opts.temperature ?? 0.2,
        max_tokens: opts.maxTokens ?? 320,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user }
        ]
      }),
      signal: AbortSignal.timeout(opts.timeout ?? 15000)
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const data = await res.json();
    const content = String(data.choices?.[0]?.message?.content || "").trim();
    if (!content) throw new Error("模型返回为空");
    return content;
  };
  try {
    return await attempt();
  } catch (err) {
    console.error(`[scholarloop] 模型调用失败，重试一次: ${err?.name || "Error"} ${err?.message || err}`);
    await sleep(700);
    return await attempt();
  }
}

async function addMissingLanguageQueries(queries, clean, baseUrl, apiKey, model) {
  const list = [...queries];
  const hasChinese = list.some(hasCjk);
  const hasEnglish = list.some((q) => !hasCjk(q));
  if (!hasEnglish && hasCjk(clean)) {
    const content = await callChatCompletion(
      baseUrl,
      apiKey,
      model,
      "把下面的中文查询翻译成适合英文学术数据库检索的关键词。每行输出一个英文关键词短语，最多 3 行，不要编号，不要解释。",
      clean,
      { temperature: 0.1, maxTokens: 200, timeout: 12000 }
    ).catch(() => "");
    const extra = String(content || "")
      .split("\n")
      .map((l) => l.replace(/^[-*\d.、\s]+/, "").trim())
      .filter((l) => l && !hasCjk(l))
      .slice(0, 3);
    list.push(...extra);
  }
  if (!hasChinese && !hasCjk(clean)) {
    const content = await callChatCompletion(
      baseUrl,
      apiKey,
      model,
      "把下面的英文查询翻译成适合中文学术数据库检索的关键词。每行输出一个中文关键词短语，最多 3 行，不要编号，不要解释。",
      clean,
      { temperature: 0.1, maxTokens: 200, timeout: 12000 }
    ).catch(() => "");
    const extra = String(content || "")
      .split("\n")
      .map((l) => l.replace(/^[-*\d.、\s]+/, "").trim())
      .filter((l) => l && hasCjk(l))
      .slice(0, 3);
    list.push(...extra);
  }
  return [...new Set(list)].slice(0, 6);
}

export async function expandQuery(q, config = {}) {
  const clean = String(q || "").trim();
  if (!clean) return [clean];
  const baseUrl = String(config?.baseUrl || "").trim().replace(/\/+$/, "");
  const apiKey = String(config?.apiKey || "").trim();
  const model = String(config?.model || "").trim();
  if (!baseUrl || !apiKey || !model) return [clean];
  const cacheKey = `${model}:${clean}`;
  const cached = readSearchCache(`query:${cacheKey}`);
  if (cached) return cached;

  const callModel = async (system) => {
    const content = await callChatCompletion(baseUrl, apiKey, model, system, clean, {
      temperature: 0.2,
      maxTokens: 200,
      timeout: 12000
    });
    const lines = content
      .split("\n")
      .map((l) => l.replace(/^[-*\d.、\s]+/, "").trim())
      .filter(Boolean)
      .slice(0, 3);
    const parsed = parseJsonArray(content);
    return lines.length ? lines : parsed ? parsed.map((s) => String(s).trim()).filter(Boolean).slice(0, 4) : [];
  };

  try {
    const firstSystem = `你是学术检索助手。把用户的查询翻译成适合学术数据库检索的关键词：如果查询是中文，翻译成英文；如果查询是英文，翻译成中文。
每行输出一个关键词短语，最多 4 行，不要编号，不要解释。`;
    let queries = await callModel(firstSystem);
    if (!queries.length) {
      const hasCJK = /[\u3400-\u9fff]/.test(clean);
      const retrySystem = hasCJK
        ? "把下面的中文查询翻译成适合英文检索的关键词。每行输出一个英文关键词短语，最多 3 行，不要编号，不要解释。"
        : "把下面的英文查询翻译成适合中文检索的关键词。每行输出一个中文关键词短语，最多 3 行，不要编号，不要解释。";
      queries = await callModel(retrySystem);
    }
    const result = queries.length ? [...new Set([clean, ...queries])].slice(0, 4) : [clean];
    writeSearchCache(`query:${cacheKey}`, result);
    return result;
  } catch {
    return [clean];
  }
}

export async function buildAiSearchPlan(q, opts = {}) {
  const clean = String(q || "").trim();
  const field = String(opts.field || "").trim();
  const goal = String(opts.goal || "").trim();
  const instruction = String(opts.instruction || "").trim();
  const baseUrl = String(opts.config?.baseUrl || "").trim().replace(/\/+$/, "");
  const apiKey = String(opts.config?.apiKey || "").trim();
  const model = String(opts.config?.model || "").trim();
  if (!clean || !baseUrl || !apiKey || !model) {
    return {
      queries: [clean],
      rationale: field || goal ? "已读取你的研究领域，但还没有配置 AI 模型，先用关键词直搜。" : "",
      mode: "keyword"
    };
  }

  const cacheKey = `${model}|${field}|${goal}|${instruction}|${clean}`;
  const cachedPlan = readSearchCache(`plan:${cacheKey}`);
  if (cachedPlan) return cachedPlan;

  const system = `你是学术检索规划助手。用户正在做研究，请根据他的研究领域、目标和本次搜索意图，生成适合学术数据库的检索关键词。
要求：
1. 生成 4-6 个关键词短语，必须同时覆盖中文和英文，至少 2 个中文短语、2 个英文短语，按重要程度排列。
2. 不要直接复制用户原话，要转换成数据库能命中的主题词、方法词和场景词。
3. 如果用户提供了纠正要求，必须优先满足纠正要求，而不是沿用原来的理解。
4. 关键词写在 JSON 的 queries 数组里，每个短语是数组中的一个字符串。
5. 优先考虑高被引、主流期刊/顶会、综述或经典工作的检索词，避免只指向小众冷门论文。
6. 中英文检索词都要给，中文短语用于中文数据库（知网），英文短语用于国际数据库（arXiv、OpenAlex 等）。
7. 最后只输出一个 JSON 对象，不要输出任何其他文字，格式：{"queries":["..."],"rationale":"一句话说明你理解的检索意图"}。`;

  try {
    const content = await callChatCompletion(
      baseUrl,
      apiKey,
      model,
      system,
      JSON.stringify({
        搜索意图: clean,
        研究领域: field || "未设置",
        研究目标: goal || "未设置",
        纠正要求: instruction || "无"
      }),
      { temperature: 0.2, maxTokens: 420, timeout: 15000 }
    );
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    let jsonPlan = null;
    if (jsonMatch) {
      try {
        jsonPlan = JSON.parse(jsonMatch[0]);
      } catch {
        jsonPlan = null;
      }
    }
    let aiQueries = Array.isArray(jsonPlan?.queries)
      ? jsonPlan.queries.map((q) => String(q).trim()).filter((q) => q && q.length >= 2)
      : [];
    let rationale = jsonPlan?.rationale ? String(jsonPlan.rationale).trim() : "";
    if (!aiQueries.length) {
      const lines = content
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);
      const rationaleIndex = lines.findIndex((l) => l.startsWith("说明") || l.startsWith("意图"));
      const rawQueries = rationaleIndex >= 0 ? lines.slice(0, rationaleIndex) : lines;
      aiQueries = rawQueries
        .map((l) => l.replace(/^[-*\d.、\s]+/, "").trim())
        .filter((l) => l && l.length >= 2 && !l.startsWith("说明") && !l.startsWith("意图"))
        .slice(0, 6);
      if (!rationale && rationaleIndex >= 0) {
        rationale = lines[rationaleIndex].replace(/^说明[:：]?\s*/, "");
      }
    }
    if (!rationale) {
      rationale = field || goal
        ? `结合研究领域${field ? `「${field}」` : ""}${goal ? `与目标「${goal}」` : ""}理解你的搜索意图。`
        : "已根据你的搜索意图生成中英文检索词。";
    }
    const translated = await expandQuery(clean, opts.config).catch(() => []);
    const queries = await addMissingLanguageQueries(
      [...new Set([clean, ...aiQueries, ...translated])].filter(Boolean),
      clean,
      baseUrl,
      apiKey,
      model
    );
    const plan = {
      queries: queries.length ? queries : [clean],
      rationale,
      mode: "ai"
    };
    writeSearchCache(`plan:${cacheKey}`, plan);
    return plan;
  } catch {
    const translated = await expandQuery(clean, opts.config).catch(() => []);
    const queries = await addMissingLanguageQueries(
      [...new Set([clean, ...translated])].filter(Boolean),
      clean,
      baseUrl,
      apiKey,
      model
    );
    return {
      queries: queries.length ? queries : [clean],
      rationale: "AI 规划暂时不可用，已退回关键词翻译扩展。",
      mode: "keyword"
    };
  }
}

function normId(str) {
  return String(str || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[^\p{L}\p{N}]/gu, "")
    .slice(0, 120);
}

function paperId(source, doi, title) {
  if (doi) return `${source}:${doi.toLowerCase()}`;
  return `${source}:${normId(title) || Math.random().toString(36).slice(2, 10)}`;
}

function toPaper({ source, sourceLabel, sourceId, doi, title, year, authors, venue, abstract, url, pdfUrl, keywords, citations, relevance, type, tldr }) {
  return {
    id: paperId(source, doi, title),
    source,
    sourceLabel,
    sourceId,
    doi: doi || null,
    title: String(title || "").trim().replace(/\s+/g, " "),
    year: year || null,
    authors: Array.isArray(authors) ? authors.filter(Boolean).slice(0, 20) : [],
    venue: venue || "",
    abstract: String(abstract || "").trim(),
    url: url || "",
    pdfUrl: pdfUrl || "",
    keywords: Array.isArray(keywords) ? keywords.filter(Boolean).slice(0, 12) : [],
    citations: Number(citations) || 0,
    relevance: Number(relevance) || 0,
    type: type || "paper",
    tldr: tldr || "",
    lang: /[\u3400-\u9fff]/.test(String(title || "") + String(abstract || "")) ? "zh" : "en"
  };
}

async function searchArxiv(q, limit) {
  const url = `https://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(q)}&start=0&max_results=${limit}&sortBy=relevance`;
  const xml = await fetchText(url, { headers: { Accept: "application/atom+xml" } });
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });
  const json = parser.parse(xml);
  let entries = json?.feed?.entry;
  if (!entries) return [];
  if (!Array.isArray(entries)) entries = [entries];
  return entries.map((entry) => {
    const title = String(entry.title || "").replace(/\s+/g, " ").trim();
    const abstract = String(entry.summary || "").replace(/\s+/g, " ").trim();
    const authors = (Array.isArray(entry.author) ? entry.author : entry.author ? [entry.author] : []).map((a) => String(a.name || "").trim()).filter(Boolean);
    const links = Array.isArray(entry.link) ? entry.link : entry.link ? [entry.link] : [];
    const pdf = links.find((l) => typeof l === "object" && l["@_title"] === "pdf") || links.find((l) => typeof l === "object" && String(l["@_href"]).endsWith(".pdf"));
    const abs = links.find((l) => typeof l === "object" && l["@_rel"] === "alternate");
    const year = new Date(entry.published || entry.updated || "").getFullYear() || null;
    const arxivId = String(entry.id || "").split("/abs/").pop();
    return toPaper({
      source: "arxiv",
      sourceLabel: "arXiv",
      sourceId: arxivId,
      doi: null,
      title,
      year,
      authors,
      venue: entry["arxiv:journal_ref"] ? String(entry["arxiv:journal_ref"]).trim() : "arXiv preprint",
      abstract,
      url: abs ? String(abs["@_href"] || "") : String(entry.id || ""),
      pdfUrl: pdf ? String(pdf["@_href"] || "") : "",
      keywords: [],
      citations: 0,
      relevance: 0.9,
      type: "preprint",
      tldr: ""
    });
  });
}

async function searchOpenAlex(q, limit, fromYear, toYear) {
  const params = new URLSearchParams({
    search: q,
    "per-page": String(limit),
    select: "id,doi,title,display_name,publication_year,authorships,abstract_inverted_index,primary_location,open_access,cited_by_count,relevance_score,type,concepts"
  });
  if (fromYear) params.set("filter", `from_publication_date:${fromYear}-01-01`);
  if (toYear) {
    const existing = params.get("filter");
    params.set("filter", existing ? `${existing},to_publication_date:${toYear}-12-31` : `to_publication_date:${toYear}-12-31`);
  }
  const json = await fetchJson(`https://api.openalex.org/works?${params.toString()}`);
  const results = json.results || [];
  const maxRelevance = Math.max(0, ...results.map((w) => Number(w.relevance_score) || 0));
  return results.map((w) => {
    const abstract = reconstructAbstract(w.abstract_inverted_index);
    return toPaper({
      source: "openalex",
      sourceLabel: "OpenAlex",
      sourceId: String(w.id || "").split("/").pop(),
      doi: w.doi ? w.doi.replace("https://doi.org/", "") : null,
      title: w.display_name || w.title,
      year: w.publication_year,
      authors: (w.authorships || []).map((a) => a.author?.display_name).filter(Boolean),
      venue: w.primary_location?.source?.display_name || "",
      abstract,
      url: w.primary_location?.landing_page_url || (w.doi ? w.doi : ""),
      pdfUrl: w.primary_location?.pdf_url || w.open_access?.oa_url || "",
      keywords: (w.concepts || []).slice(0, 10).map((c) => c.display_name),
      citations: w.cited_by_count,
      relevance: maxRelevance ? (Number(w.relevance_score) || 0) / maxRelevance : 0,
      type: w.type || "article",
      tldr: ""
    });
  });
}

async function searchSemanticScholar(q, limit) {
  const url = `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(q)}&limit=${Math.min(limit, 100)}&fields=title,abstract,year,venue,citationCount,authors,url,externalIds,openAccessPdf,publicationTypes,tldr,paperId`;
  let json;
  try {
    json = await fetchJson(url);
  } catch (err) {
    if (String(err.message).includes("429")) {
      await new Promise((r) => setTimeout(r, 1200));
      json = await fetchJson(url);
    } else {
      throw err;
    }
  }
  return (json.data || []).map((p) =>
    toPaper({
      source: "semanticscholar",
      sourceLabel: "Semantic Scholar",
      sourceId: p.paperId,
      doi: p.externalIds?.DOI || null,
      title: p.title,
      year: p.year,
      authors: (p.authors || []).map((a) => a.name),
      venue: p.venue || "",
      abstract: p.abstract || "",
      url: p.url || "",
      pdfUrl: p.openAccessPdf?.url || "",
      keywords: [],
      citations: p.citationCount,
      relevance: p.score || 0,
      type: (p.publicationTypes || ["article"])[0],
      tldr: p.tldr?.text || ""
    })
  );
}

async function searchPubMed(q, limit, fromYear, toYear) {
  let term = q;
  if (fromYear) term += ` AND ${fromYear}:9999[dp]`;
  if (toYear) term += ` AND 0001:${toYear}[dp]`;
  const esearchUrl = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=${encodeURIComponent(term)}&retmode=json&retmax=${Math.min(limit, 50)}&sort=relevance&tool=scholarloop&email=local@scholarloop.app`;
  const search = await fetchJson(esearchUrl);
  const ids = search?.esearchresult?.idlist || [];
  if (!ids.length) return [];
  const esummaryUrl = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&retmode=json&id=${ids.join(",")}&tool=scholarloop&email=local@scholarloop.app`;
  const summary = await fetchJson(esummaryUrl);
  const result = summary?.result || {};
  return ids.map((id, i) => {
    const item = result[id];
    return toPaper({
      source: "pubmed",
      sourceLabel: "PubMed",
      sourceId: id,
      doi: item?.elocationid?.startsWith("doi:") ? item.elocationid.slice(4) : null,
      title: item?.title || "",
      year: Number(String(item?.pubdate || "").slice(0, 4)) || null,
      authors: (item?.authors || []).map((a) => a.name),
      venue: item?.fulljournalname || item?.source || "",
      abstract: "",
      url: `https://pubmed.ncbi.nlm.nih.gov/${id}/`,
      pdfUrl: "",
      keywords: [],
      citations: 0,
      relevance: Math.max(0, 1 - i / ids.length),
      type: "article",
      tldr: ""
    });
  });
}

async function searchCrossref(q, limit, fromYear, toYear) {
  const params = new URLSearchParams({
    query: q,
    rows: String(limit),
    select: "DOI,title,author,issued,container-title,abstract,URL,is-referenced-by-count,type,publisher,link"
  });
  if (fromYear) params.set("filter", `from-pub-date:${fromYear}-01-01`);
  if (toYear) {
    const existing = params.get("filter");
    params.set("filter", existing ? `${existing},until-pub-date:${toYear}-12-31` : `until-pub-date:${toYear}-12-31`);
  }
  const json = await fetchJson(`https://api.crossref.org/works?${params.toString()}`);
  return (json.message?.items || []).map((w) => {
    const year = w.issued?.["date-parts"]?.[0]?.[0] || null;
    const link = (w.link || []).find((l) => l["content-type"]?.includes("pdf"));
    return toPaper({
      source: "crossref",
      sourceLabel: "Crossref",
      sourceId: w.DOI,
      doi: w.DOI,
      title: (w.title || [""])[0],
      year,
      authors: (w.author || []).map((a) => [a.given, a.family].filter(Boolean).join(" ")),
      venue: (w["container-title"] || [""])[0],
      abstract: stripTags(w.abstract || ""),
      url: w.URL || `https://doi.org/${w.DOI}`,
      pdfUrl: link?.URL || "",
      keywords: [],
      citations: w["is-referenced-by-count"] || 0,
      relevance: 0.5,
      type: w.type || "article",
      tldr: ""
    });
  });
}

async function runSources(q, sources, perSource, fromYear, toYear) {
  const jobs = {
    arxiv: () => searchArxiv(q, perSource),
    openalex: () => searchOpenAlex(q, perSource, fromYear, toYear),
    semanticscholar: () => searchSemanticScholar(q, perSource),
    pubmed: () => searchPubMed(q, perSource, fromYear, toYear),
    crossref: () => searchCrossref(q, perSource, fromYear, toYear),
    cnki: () => searchCnki(q, perSource, fromYear, toYear)
  };
  const settled = await Promise.allSettled(sources.map((s) => jobs[s]()));
  const papers = [];
  const seen = new Set();
  settled.forEach((res, i) => {
    if (res.status === "rejected") {
      console.warn(`[${sources[i]}] ${res.reason?.message || res.reason}`);
      return;
    }
    for (const paper of res.value) {
      const key = paper.doi || normId(paper.title);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      papers.push(paper);
    }
  });
  return { papers, settled };
}

export async function searchPapers(q, opts = {}) {
  const limit = Math.max(5, Math.min(100, Number(opts.limit) || 30));
  const sources = (opts.sources || ["arxiv", "openalex", "semanticscholar", "pubmed", "crossref", "cnki"])
    .filter((s) => ["arxiv", "openalex", "semanticscholar", "pubmed", "crossref", "cnki"].includes(s));
  const perSource = Math.max(5, Math.min(16, Math.ceil((limit + 5) / Math.max(1, sources.length)) + 2));
  let queries = Array.isArray(opts.queries) && opts.queries.length
    ? [...new Set(opts.queries.map((x) => String(x).trim()).filter(Boolean))].slice(0, 6)
    : await expandQuery(q, opts.config);
  if (!queries.length) queries = [q];
  const merged = [];
  const seen = new Set();
  const status = sources.map((s) => ({ id: s, ok: false, count: 0, error: null }));
  const statusIndex = new Map(sources.map((s, i) => [s, i]));
  const cjkQueries = queries.filter(hasCjk);
  const latinQueries = queries.filter((query) => !hasCjk(query));

  await mapWithConcurrency(queries, 2, async (query) => {
    const querySources = sources.filter((source) => {
      if (source === "cnki") {
        return cjkQueries.length ? cjkQueries.includes(query) : query === queries[0];
      }
      return latinQueries.length ? latinQueries.includes(query) : query === queries[0];
    });
    if (!querySources.length) return;

    const { papers, settled } = await runSources(query, querySources, perSource, opts.fromYear, opts.toYear);
    settled.forEach((res, i) => {
      const st = status[statusIndex.get(querySources[i])];
      if (res.status === "fulfilled") {
        st.ok = true;
        st.count += (res.value || []).length;
      } else if (!st.error) {
        st.error = String(res.reason?.message || res.reason);
      }
    });
    for (const paper of papers) {
      const key = paper.doi || normId(paper.title);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      merged.push(paper);
    }
  });

  const scored = scoreMergedPapers(merged, queries);
  const sort = opts.sort || "relevance";
  let ordered;
  if (sort === "authority") {
    ordered = diversifyBySource(scored);
  } else {
    ordered = [...scored];
    ordered.sort((a, b) => {
      if (sort === "cited") return b.citations - a.citations || b.year - a.year;
      if (sort === "year") return b.year - a.year || b.citations - a.citations;
      return b.relevance - a.relevance || b.year - a.year;
    });
  }
  return { query: q, queries, total: scored.length, papers: ordered.slice(0, limit), sourceStatus: status };
}

function sourceStatus(settled, sources) {
  return sources.map((s, i) => ({
    id: s,
    ok: settled[i].status === "fulfilled",
    count: settled[i].status === "fulfilled" ? (settled[i].value || []).length : 0,
    error: settled[i].status === "rejected" ? String(settled[i].reason?.message || settled[i].reason) : null
  }));
}

const SOURCE_AUTHORITY = {
  arxiv: 0.6,
  openalex: 1.0,
  semanticscholar: 1.0,
  pubmed: 1.0,
  crossref: 1.0,
  cnki: 1.0,
  manual: 0.7
};

const TYPE_AUTHORITY = {
  article: 1.0,
  review: 1.2,
  conference: 0.8,
  thesis: 0.7,
  preprint: 0.5,
  newspaper: 0.4,
  reference: 0.5,
  patent: 0.6
};

function authorityScore(paper) {
  const currentYear = new Date().getFullYear();
  const age = Math.max(1, currentYear - (paper.year || currentYear));
  const citations = Number(paper.citations) || 0;
  const citationsPerYear = citations / age;
  const rel = Math.max(0, Math.min(1, Number(paper.relevance) || 0));
  const citationWeight = Math.log1p(citations) * 2.2 + Math.log1p(citationsPerYear) * 1.8;
  return (
    rel * citationWeight +
    (1 - rel) * 0.5 +
    (SOURCE_AUTHORITY[paper.source] || 0.8) +
    (TYPE_AUTHORITY[paper.type] || 0.8) +
    rel * 0.3
  );
}

function diversifyBySource(papers) {
  const sorted = [...papers].sort((a, b) => authorityScore(b) - authorityScore(a) || b.year - a.year || b.citations - a.citations);
  const head = sorted.slice(0, 5);
  const rest = sorted.slice(5);
  const groups = new Map();
  for (const paper of rest) {
    if (!groups.has(paper.source)) groups.set(paper.source, []);
    groups.get(paper.source).push(paper);
  }
  const order = [...groups.entries()]
    .map(([source, list]) => ({ source, list, best: authorityScore(list[0]) }))
    .sort((a, b) => b.best - a.best || b.list.length - a.list.length);
  const output = [];
  let hasMore = true;
  while (hasMore && output.length < papers.length) {
    hasMore = false;
    for (const group of order) {
      if (!group.list.length) continue;
      output.push(group.list.shift());
      hasMore = true;
    }
  }
  return [...head, ...output];
}

export async function resolveByDoi(doi) {
  const clean = String(doi || "").replace(/^https?:\/\/doi\.org\//i, "").trim();
  if (!clean) throw new Error("DOI 不能为空");
  const json = await fetchJson(`https://api.crossref.org/works/${encodeURIComponent(clean)}`);
  const w = json.message;
  const year = w.issued?.["date-parts"]?.[0]?.[0] || null;
  const link = (w.link || []).find((l) => l["content-type"]?.includes("pdf"));
  return toPaper({
    source: "crossref",
    sourceLabel: "Crossref",
    sourceId: w.DOI,
    doi: w.DOI,
    title: (w.title || [""])[0],
    year,
    authors: (w.author || []).map((a) => [a.given, a.family].filter(Boolean).join(" ")),
    venue: (w["container-title"] || [""])[0],
    abstract: stripTags(w.abstract || ""),
    url: w.URL || `https://doi.org/${w.DOI}`,
    pdfUrl: link?.URL || "",
    keywords: [],
    citations: w["is-referenced-by-count"] || 0,
    relevance: 1,
    type: w.type || "article",
    tldr: ""
  });
}

export function parseBibtex(text) {
  const match = String(text || "").match(/@\w+\s*\{\s*([^,]+),([\s\S]*?)\s*\}/);
  if (!match) throw new Error("无法解析 BibTeX，请检查格式");
  const fields = {};
  const body = match[2];
  const fieldRe = /(\w+)\s*=\s*[{"']([\s\S]*?)[}"']\s*,?/g;
  let m;
  while ((m = fieldRe.exec(body))) fields[m[1].toLowerCase()] = m[2].replace(/\s+/g, " ").trim();
  return toPaper({
    source: "manual",
    sourceLabel: "手动导入",
    sourceId: match[1].trim(),
    doi: fields.doi || null,
    title: fields.title || fields.booktitle || "未命名文献",
    year: Number(fields.year) || null,
    authors: String(fields.author || "").split(/\s+and\s+/i).map((a) => a.trim()).filter(Boolean),
    venue: fields.journal || fields.booktitle || fields.publisher || "",
    abstract: fields.abstract || "",
    url: fields.url || fields.eprint || "",
    pdfUrl: fields.file ? String(fields.file).split(";")[0].trim() : "",
    keywords: String(fields.keywords || "").split(",").map((k) => k.trim()).filter(Boolean),
    citations: 0,
    relevance: 1,
    type: "article",
    tldr: ""
  });
}

export function makeManualPaper(data) {
  return toPaper({
    source: "manual",
    sourceLabel: "手动导入",
    sourceId: normId(data.title),
    doi: data.doi || null,
    title: data.title,
    year: Number(data.year) || null,
    authors: String(data.authors || "").split(/[,;，；]/).map((a) => a.trim()).filter(Boolean),
    venue: data.venue || "",
    abstract: data.abstract || "",
    url: data.url || "",
    pdfUrl: data.pdfUrl || "",
    keywords: String(data.keywords || "").split(",").map((k) => k.trim()).filter(Boolean),
    citations: 0,
    relevance: 1,
    type: "article",
    tldr: ""
  });
}

function reconstructAbstract(inverted) {
  if (!inverted) return "";
  const positions = [];
  for (const [word, idxs] of Object.entries(inverted)) {
    for (const i of idxs) positions[i] = word;
  }
  return positions.join(" ").trim();
}

function stripTags(html) {
  return String(html || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanCnkiMarkup(text) {
  return String(text || "")
    .replace(/[~#@]+([^@#~]+)[@#~]+/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function cnkiArticleUrl(item) {
  const dbType = String(item.dbType || "");
  const fileName = String(item.fileName || "");
  const dbName = String(item.dbName || "");
  if (dbType === "CJFD") {
    if (fileName.length > 13 || dbName.toUpperCase() === "CJFDPREP") {
      return `https://kns.cnki.net/KCMS/detail/detail.aspx?dbname=${encodeURIComponent(dbName)}&filename=${encodeURIComponent(fileName)}`;
    }
    return `https://www.cnki.com.cn/Article/CJFDTOTAL-${encodeURIComponent(fileName)}.htm`;
  }
  if (dbType === "CCND") {
    return `https://mall.cnki.net/magazine/article/CCND/${encodeURIComponent(fileName)}.htm`;
  }
  return `https://kns.cnki.net/KCMS/detail/detail.aspx?dbname=${encodeURIComponent(dbName)}&filename=${encodeURIComponent(fileName)}`;
}

const CNKI_TYPE_MAP = {
  "期刊": "article",
  "期刊论文": "article",
  "博士": "thesis",
  "博士学位论文": "thesis",
  "硕士": "thesis",
  "硕士学位论文": "thesis",
  "会议": "conference",
  "报纸": "newspaper",
  "年鉴": "reference",
  "专利": "patent"
};

const cnkiCache = new Map();
const CNKI_CACHE_TTL = 10 * 60 * 1000;

async function searchCnki(q, limit, fromYear, toYear) {
  const cacheKey = `${q}|${fromYear || ""}|${toYear || ""}`;
  const hit = cnkiCache.get(cacheKey);
  if (hit && Date.now() - hit.time < CNKI_CACHE_TTL) return hit.data;
  try {
    const data = await fetchCnki(q, limit, fromYear, toYear);
    cnkiCache.set(cacheKey, { data, time: Date.now() });
    return data;
  } catch (err) {
    await sleep(800);
    const data = await fetchCnki(q, limit, fromYear, toYear);
    cnkiCache.set(cacheKey, { data, time: Date.now() });
    return data;
  }
}

async function fetchCnki(q, limit, fromYear, toYear) {
  const form = new URLSearchParams({
    searchType: "MulityTermsSearch",
    Content: q,
    Theme: "",
    Title: "",
    KeyWd: "",
    Author: "",
    ArticleType: "0",
    Type: "",
    Year: fromYear || toYear ? `${fromYear || "0001"}-${toYear || "9999"}` : "",
    Order: "1",
    Page: "1",
    ExcludeField: ""
  });
  const json = await fetchJson("https://search.cnki.com.cn/api/search/listresult", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      Accept: "application/json, text/javascript, */*; q=0.01",
      Referer: `https://search.cnki.com.cn/Search/Result?content=${encodeURIComponent(q)}`,
      "X-Requested-With": "XMLHttpRequest"
    },
    body: form.toString()
  });
  const items = Array.isArray(json?.articleList) ? json.articleList : [];
  return items
    .map((item, i) => {
      const year = Number(item.year) || Number(String(item.publishTime || "").slice(0, 4)) || null;
      const rawType = String(item.arcitleType || "").trim();
      if (fromYear && year && year < Number(fromYear)) return null;
      if (toYear && year && year > Number(toYear)) return null;
      return toPaper({
        source: "cnki",
        sourceLabel: "知网 CNKI",
        sourceId: `${item.dbType || "CNKI"}:${item.fileName || ""}`,
        doi: null,
        title: cleanCnkiMarkup(item.title),
        year,
        authors: String(item.author || "").split(/[;；]/).map((a) => a.trim()).filter(Boolean),
        venue: cleanCnkiMarkup(item.originate),
        abstract: cleanCnkiMarkup(item.summary || item.content),
        url: cnkiArticleUrl(item),
        pdfUrl: "",
        keywords: String(item.keyWord || "").split(/[;；,，]/).map((k) => cleanCnkiMarkup(k)).filter(Boolean).slice(0, 12),
        citations: Number(item.quoteCount) || 0,
        relevance: Math.max(0, 0.98 - i * 0.025),
        type: CNKI_TYPE_MAP[rawType] || (rawType.includes("学位") ? "thesis" : "article"),
        tldr: ""
      });
    })
    .filter(Boolean)
    .slice(0, Math.max(1, Math.min(limit, 20)));
}
