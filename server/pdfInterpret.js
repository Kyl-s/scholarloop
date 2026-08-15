/**
 * PDF 正文 AI 解读：快速 / 完全 双模式
 * 使用用户 Agent 配置（baseUrl/apiKey/model），与 /api/translate 一致
 */

const SECTION_RE =
  /\b(abstract|introduction|background|related\s+work|method|methods|methodology|approach|experiment|experiments|evaluation|results?|discussion|conclusion|conclusions|limitation|limitations|future\s+work|summary|贡献|摘要|引言|背景|相关工作|方法|实验|结果|讨论|结论|局限|未来工作)\b/i;

function normalizePages(pages) {
  if (!Array.isArray(pages)) return [];
  return pages
    .map((p) => ({
      page: Number(p?.page) || 0,
      text: String(p?.text || "").replace(/\r/g, "").trim()
    }))
    .filter((p) => p.page > 0 && p.text)
    .sort((a, b) => a.page - b.page);
}

function scorePage(text) {
  let score = 0;
  const lower = text.toLowerCase();
  if (SECTION_RE.test(text)) score += 8;
  if (/\babstract\b|摘要/.test(lower)) score += 12;
  if (/\bintroduction\b|引言|背景/.test(lower)) score += 6;
  if (/\bconclusion|讨论|结论|limitation/.test(lower)) score += 7;
  if (/\bmethod|approach|framework|算法|方法/.test(lower)) score += 5;
  if (/\bexperiment|evaluation|results?|实验|结果/.test(lower)) score += 4;
  // 参考文献页权重降低
  if (/^references\b|^bibliography\b|^参考文献/im.test(text.slice(0, 200))) score -= 10;
  score += Math.min(3, Math.floor(text.length / 1500));
  return score;
}

function compactJoin(parts, maxLen) {
  const out = [];
  let used = 0;
  for (const part of parts) {
    if (!part?.text) continue;
    const header = `[第 ${part.page} 页]\n`;
    const body = part.text;
    const room = maxLen - used - header.length;
    if (room <= 80) break;
    const slice = body.length > room ? `${body.slice(0, room)}\n…(截断)` : body;
    out.push(`${header}${slice}`);
    used += header.length + slice.length + 2;
  }
  return out.join("\n\n");
}

/**
 * 按模式从分页文字构建模型语料
 * @returns {{ corpus: string, usedChars: number, pageCoverage: string, pageNums: number[] }}
 */
export function buildPdfCorpus(pagesInput, mode = "quick") {
  const pages = normalizePages(pagesInput);
  if (!pages.length) {
    return { corpus: "", usedChars: 0, pageCoverage: "", pageNums: [] };
  }

  const isFull = mode === "full";
  const maxLen = isFull ? 28000 : 12000;
  const scored = pages.map((p) => ({ ...p, score: scorePage(p.text) }));

  // 结构优先：高分页
  const byScore = [...scored].sort((a, b) => b.score - a.score || a.page - b.page);
  const selected = new Map();

  const take = (list, n) => {
    for (const p of list) {
      if (selected.size >= n && n > 0) break;
      if (!selected.has(p.page)) selected.set(p.page, p);
    }
  };

  if (isFull) {
    take(byScore, Math.min(pages.length, 18));
    // 均匀补中间页
    const step = Math.max(1, Math.floor(pages.length / 10));
    for (let i = 0; i < pages.length; i += step) {
      const p = pages[i];
      if (!selected.has(p.page)) selected.set(p.page, { ...p, score: scorePage(p.text) });
    }
    // 保证首尾
    take(pages.slice(0, 2), 2);
    take(pages.slice(-2), 2);
  } else {
    take(byScore.filter((p) => p.score >= 6), 8);
    take(pages.slice(0, 3), 3);
    take(pages.slice(-2), 2);
    if (selected.size < 4) take(byScore, 6);
  }

  const ordered = [...selected.values()].sort((a, b) => a.page - b.page);
  const corpus = compactJoin(ordered, maxLen);
  const pageNums = ordered.map((p) => p.page);
  return {
    corpus,
    usedChars: corpus.length,
    pageCoverage: formatCoverage(pageNums),
    pageNums
  };
}

function formatCoverage(nums) {
  if (!nums.length) return "";
  const sorted = [...new Set(nums)].sort((a, b) => a - b);
  const ranges = [];
  let start = sorted[0];
  let prev = sorted[0];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] === prev + 1) {
      prev = sorted[i];
      continue;
    }
    ranges.push(start === prev ? `${start}` : `${start}-${prev}`);
    start = prev = sorted[i];
  }
  ranges.push(start === prev ? `${start}` : `${start}-${prev}`);
  return ranges.join(",");
}

function extractJsonObject(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw.replace(/```json|```/g, "").trim());
  } catch {
    /* fallthrough */
  }
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

function normalizeEvidence(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (typeof item === "number" || /^\d+$/.test(String(item || "").trim())) {
        const page = Number(item);
        return { page, label: `第 ${page} 页`, reason: "", quote: "" };
      }
      const page = Number(item?.page || item?.pageNumber || item?.p) || 0;
      return {
        page,
        label: String(item?.label || item?.title || (page ? `第 ${page} 页` : "")).trim(),
        reason: String(item?.reason || item?.why || "").trim(),
        quote: String(item?.quote || item?.text || "").trim()
      };
    })
    .filter((item) => item.page > 0 && item.label)
    .slice(0, 12);
}

function evidenceFromText(text) {
  const pages = [];
  const seen = new Set();
  const source = String(text || "");
  const re = /(?:第\s*(\d+)\s*页|\bpage\s*(\d+)\b|\bp\.?\s*(\d+)\b)/gi;
  let match;
  while ((match = re.exec(source))) {
    const page = Number(match[1] || match[2] || match[3]);
    if (!page || seen.has(page)) continue;
    seen.add(page);
    pages.push({ page, label: `第 ${page} 页`, reason: "", quote: "" });
  }
  return pages.slice(0, 12);
}

function normalizeResult(parsed, mode) {
  const obj = parsed && typeof parsed === "object" ? parsed : {};
  const list = (v) => (Array.isArray(v) ? v.map(String).map((s) => s.trim()).filter(Boolean) : []);
  const prereq = Array.isArray(obj.prerequisites)
    ? obj.prerequisites
        .map((p) => {
          if (typeof p === "string") {
            return { name: p, level: "必备", why: "", hint: "" };
          }
          return {
            name: String(p?.name || p?.concept || "").trim(),
            level: /加分|optional|advanced/i.test(String(p?.level || "")) ? "加分" : "必备",
            why: String(p?.why || p?.reason || "").trim(),
            hint: String(p?.hint || p?.how || "").trim()
          };
        })
        .filter((p) => p.name)
    : [];

  const base = {
    oneSentence: String(obj.oneSentence || obj.summary || "").trim(),
    problem: String(obj.problem || "").trim(),
    method: String(obj.method || "").trim(),
    findings: String(obj.findings || obj.results || "").trim(),
    limitations: String(obj.limitations || "").trim(),
    prerequisites: prereq,
    conceptPath: list(obj.conceptPath),
    takeaways: list(obj.takeaways),
    questions: list(obj.questions),
    readingTips: String(obj.readingTips || "").trim(),
    evidence: normalizeEvidence(obj.evidence)
  };

  if (mode === "full") {
    return {
      ...base,
      background: String(obj.background || "").trim(),
      contributions: list(obj.contributions),
      experiments: String(obj.experiments || "").trim()
    };
  }
  return base;
}

async function callChat({ baseUrl, apiKey, model, system, user, maxTokens = 5000, temperature = 0.2 }) {
  const r = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      temperature,
      max_tokens: maxTokens,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user }
      ]
    }),
    signal: AbortSignal.timeout(90000)
  });
  if (!r.ok) {
    const detail = await r.text().catch(() => "");
    throw new Error(`${r.status} ${detail.slice(0, 220)}`);
  }
  const data = await r.json();
  const content = String(data.choices?.[0]?.message?.content || "").trim();
  if (!content) throw new Error("模型返回为空");
  return content;
}

function systemPrompt(mode) {
  if (mode === "full") {
    return `你是面向科研新手的论文导师。请仔细阅读用户提供的论文正文摘录（可能不完整），用简洁中文输出一个 JSON 对象，不要 Markdown，不要解释。

字段要求：
{
  "oneSentence": "一句话概括论文",
  "background": "研究背景与动机",
  "problem": "要解决的核心问题",
  "method": "方法与关键设计（尽量具体）",
  "contributions": ["贡献1","贡献2"],
  "experiments": "实验设置与主要证据",
  "findings": "主要发现/结果",
  "limitations": "局限与未决问题",
  "prerequisites": [
    {"name":"概念名（可中英并列）","level":"必备或加分","why":"为什么读本文需要它","hint":"如何快速补齐"}
  ],
  "conceptPath": ["学习步骤1","学习步骤2","学习步骤3"],
  "takeaways": ["要点1","要点2"],
  "questions": ["精读引导问题1","问题2","问题3","问题4","问题5"],
  "readingTips": "给新手的阅读顺序建议",
  "evidence": [
    {"page": 3, "label": "第 3 页", "reason": "该页支持某个关键判断", "quote": "正文中的短语，可为空"}
  ]
}

规则：
1) 必须先基于正文理解，再列基础知识；prerequisites 至少 5 条，区分必备/加分。
2) 文中未明确的内容写「文中未明确」，不要编造实验数字。
3) 专有名词可保留英文。
4) evidence 最多 8 条；page 必须是正文摘录标题「[第 N 页]」中出现的页码；quote 不超过 80 字，不要编造原文。
5) 只输出 JSON。`;
  }

  return `你是面向科研新手的论文导师。请阅读用户提供的论文正文摘录，用简洁中文输出一个 JSON 对象，不要 Markdown，不要解释。

字段要求：
{
  "oneSentence": "一句话概括",
  "problem": "核心问题",
  "method": "方法要点",
  "findings": "主要结论",
  "limitations": "局限（可短）",
  "prerequisites": [
    {"name":"概念名","level":"必备","why":"为何需要","hint":"怎么补"}
  ],
  "conceptPath": ["建议学习顺序1","2","3"],
  "takeaways": ["要点1","要点2","要点3"],
  "questions": ["引导问题1","问题2","问题3"],
  "readingTips": "阅读建议",
  "evidence": [
    {"page": 1, "label": "第 1 页", "reason": "该页支持某个关键判断", "quote": "正文中的短语，可为空"}
  ]
}

规则：
1) prerequisites 4-8 条，优先「必备」。
2) 不确定处标明「文中未明确」。
3) evidence 最多 8 条；page 必须是正文摘录标题「[第 N 页]」中出现的页码；quote 不超过 80 字，不要编造原文。
4) 只输出 JSON。`;
}

function followupSystem() {
  return `你是科研导师。根据已有论文解读摘要和正文摘录，用简洁中文回答用户关于这篇论文的问题。
只输出一个 JSON 对象，不要 Markdown，不要输出 JSON 以外的解释，格式：
{
  "answer": "直接回答用户的问题，可用短段落和列表",
  "evidence": [
    {"page": 3, "label": "第 3 页", "reason": "该页展示了支持答案的实验结果", "quote": "正文中能定位到的短语，可为空"}
  ]
}
要求：1) 优先依据提供的材料；2) 材料不足时明确说明；3) evidence 只能引用正文摘录中明确出现的页码；4) 最多给 4 条证据；5) quote 不超过 80 字，不要编造原文。`;
}

/**
 * 主入口：解读或追问
 */
export async function interpretPdf({
  title = "",
  mode = "quick",
  config = {},
  pages = [],
  question = "",
  prior = null
} = {}) {
  const baseUrl = String(config.baseUrl || "").trim().replace(/\/+$/, "");
  const apiKey = String(config.apiKey || "").trim();
  const model = String(config.model || "").trim();
  if (!baseUrl || !apiKey || !model) {
    throw new Error("请先在设置中配置 API Key");
  }

  const resolvedMode = mode === "full" ? "full" : "quick";
  const { corpus, usedChars, pageCoverage, pageNums } = buildPdfCorpus(pages, resolvedMode);
  if (!corpus.trim()) {
    throw new Error("扫描版 PDF 无可提取文字，暂不支持 OCR");
  }

  const q = String(question || "").trim();

  // 追问模式
  if (q) {
    const priorText = prior
      ? JSON.stringify(prior).slice(0, 6000)
      : "";
    const user = [
      `论文标题：${title || "（未知）"}`,
      `解读模式：${resolvedMode}`,
      priorText ? `已有结构化解读：\n${priorText}` : "",
      `正文摘录（页码 ${pageCoverage}）：\n${corpus.slice(0, resolvedMode === "full" ? 20000 : 10000)}`,
      `用户问题：${q}`
    ]
      .filter(Boolean)
      .join("\n\n");

    const attempt = () =>
      callChat({
        baseUrl,
        apiKey,
        model,
        system: followupSystem(),
        user,
        maxTokens: 3500,
        temperature: 0.3
      });

    let answer;
    try {
      answer = await attempt();
    } catch {
      await new Promise((r) => setTimeout(r, 800));
      answer = await attempt();
    }
    const parsedAnswer = extractJsonObject(answer);
    const answerText = parsedAnswer && typeof parsedAnswer.answer === "string"
      ? parsedAnswer.answer.trim()
      : answer;
    const evidence = parsedAnswer
      ? normalizeEvidence(parsedAnswer.evidence)
      : evidenceFromText(answer);
    return {
      mode: resolvedMode,
      usedChars,
      pageCoverage,
      answer: answerText,
      evidence: evidence.filter((item) => pageNums.includes(item.page))
    };
  }

  // 完全模式且语料很长：简单 map-reduce（两段笔记再合并）
  let userCorpus = corpus;
  if (resolvedMode === "full" && corpus.length > 16000) {
    const mid = Math.floor(corpus.length / 2);
    const splitAt = corpus.lastIndexOf("\n\n[第 ", mid);
    const partA = corpus.slice(0, splitAt > 2000 ? splitAt : mid);
    const partB = corpus.slice(splitAt > 2000 ? splitAt : mid);
    const noteSys =
      "你是论文阅读助手。根据正文片段用中文写简洁要点笔记（问题/方法/实验/结论/术语），不超过 800 字，不要 JSON。";
    const note = async (part, tag) => {
      try {
        return await callChat({
          baseUrl,
          apiKey,
          model,
          system: noteSys,
          user: `片段${tag}：\n${part}`,
          maxTokens: 2000,
          temperature: 0.1
        });
      } catch {
        return part.slice(0, 1500);
      }
    };
    const [n1, n2] = await Promise.all([note(partA, "A"), note(partB, "B")]);
    userCorpus = `【分段笔记 A】\n${n1}\n\n【分段笔记 B】\n${n2}\n\n【正文抽样】\n${corpus.slice(0, 10000)}`;
  }

  const user = `论文标题：${title || "（未知）"}\n覆盖页：${pageCoverage}\n\n正文摘录：\n${userCorpus}`;
  const attempt = () =>
    callChat({
      baseUrl,
      apiKey,
      model,
      system: systemPrompt(resolvedMode),
      user,
      maxTokens: resolvedMode === "full" ? 7000 : 4500,
      temperature: 0.2
    });

  let content;
  try {
    content = await attempt();
  } catch {
    await new Promise((r) => setTimeout(r, 900));
    content = await attempt();
  }

  const parsed = extractJsonObject(content);
  if (!parsed) {
    throw new Error(`解读结果无法解析为 JSON：${content.slice(0, 180)}`);
  }

  const normalized = normalizeResult(parsed, resolvedMode);
  return {
    mode: resolvedMode,
    usedChars,
    pageCoverage,
    result: {
      ...normalized,
      evidence: normalized.evidence.filter((item) => pageNums.includes(item.page))
    }
  };
}
