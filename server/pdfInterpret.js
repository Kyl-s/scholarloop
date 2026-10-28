import { chatgptModelFetch, isChatGptModelUrl } from "./chatgptModel.js";
/**
 * PDF 正文 AI 解读：快速 / 完全 双模式
 * 使用用户 Agent 配置（baseUrl/apiKey/model），与 /api/translate 一致
 */

import { mergeUsages, parseChatUsage } from "../src/llmUsage.js";

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

function normalizeGuidedSteps(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((step) => {
      if (typeof step === "string") {
        return { stage: "", title: "", goal: "", question: step.trim(), hint: "", pages: [] };
      }
      const pages = (Array.isArray(step?.pages) ? step.pages : [step?.page])
        .map((p) => Number(p) || 0)
        .filter((p) => p > 0)
        .slice(0, 6);
      return {
        stage: String(step?.stage || "").trim(),
        title: String(step?.title || step?.name || "").trim(),
        goal: String(step?.goal || step?.aim || "").trim(),
        question: String(step?.question || step?.ask || "").trim(),
        hint: String(step?.hint || step?.tip || "").trim(),
        pages
      };
    })
    .filter((step) => step.question)
    .slice(0, 8);
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
    evidence: normalizeEvidence(obj.evidence),
    guidedSteps: normalizeGuidedSteps(obj.guidedSteps)
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
  const r = await chatgptModelFetch(`${baseUrl}/chat/completions`, {
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
  return { content, usage: parseChatUsage(data) };
}

function systemPrompt(mode) {
  const guidedStepsSpec = `  "guidedSteps": [
    {"stage":"阶段标签(如:整体印象)","title":"步骤标题(简短)","goal":"这一步帮读者建立什么理解(一句话)","pages":[1,2],"question":"抛给读者的引导问题","hint":"阅读提示:先读哪里、关注什么"}
  ]`;

  const guidedStepsRules = `5) guidedSteps 是「引导式精读计划」，5-7 步，按「整体印象 → 核心问题 → 方法思路 → 关键细节 → 实验证据 → 结论与自己的判断」由浅入深设计：
   - 第一步必须简单热身：凭摘要就能答出，帮读者建立信心；最后一步引导读者给出自己的评价、质疑或收获；
   - question 必须具体、能从正文中找到依据，用开放式提问，不要是非题；一次只问一个点；
   - hint 面向零基础读者，语气友好，告诉TA先读哪里、关注什么、暂时可以跳过什么；
   - pages 只能使用正文摘录标题「[第 N 页]」中出现的页码，没有合适页码时给空数组。`;

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
  ],
${guidedStepsSpec}
}

规则：
1) 必须先基于正文理解，再列基础知识；prerequisites 至少 5 条，区分必备/加分。
2) 文中未明确的内容写「文中未明确」，不要编造实验数字。
3) 专有名词可保留英文。
4) evidence 最多 8 条；page 必须是正文摘录标题「[第 N 页]」中出现的页码；quote 不超过 80 字，不要编造原文。
${guidedStepsRules}
6) 只输出 JSON。`;
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
  ],
${guidedStepsSpec}
}

规则：
1) prerequisites 4-8 条，优先「必备」。
2) 不确定处标明「文中未明确」。
3) evidence 最多 8 条；page 必须是正文摘录标题「[第 N 页]」中出现的页码；quote 不超过 80 字，不要编造原文。
${guidedStepsRules}
5) 只输出 JSON。`;
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

function guideSystem() {
  return `你是耐心的论文精读导师，正在带一位科研新手一步一步读论文。学员刚回答了其中一个引导问题，请批改这份回答。
只输出一个 JSON 对象，不要 Markdown，不要输出 JSON 以外的解释，格式：
{
  "verdict": "good 或 partial 或 off",
  "strengths": ["学员答对或想到的点，可为空数组"],
  "feedback": "先肯定做得好的地方，再指出偏差或遗漏，最后用一个追问引导继续思考",
  "reference": "参考答案要点，2-4 句，具体可对照原文",
  "evidence": [
    {"page": 2, "label": "第 2 页", "reason": "该页有支持参考答案的内容", "quote": "正文中的短语，可为空"}
  ]
}
要求：
1) verdict 口径：good=抓住了问题核心，partial=部分正确但遗漏关键，off=理解偏差较大或答非所问。
2) feedback 语气友好鼓励，绝不居高临下；学员回答很简短或只是尝试时，也要先肯定其投入，再温和补充。
3) 学员回答为空时，feedback 直接给出这一步该怎么读的建议。
4) 不要编造正文没有的数字；evidence 只能引用正文摘录标题「[第 N 页]」中出现的页码，最多 3 条；quote 不超过 80 字。
5) 只输出 JSON。`;
}

function normalizeGuideReview(parsed, fallbackText) {
  if (!parsed || typeof parsed !== "object") {
    return {
      verdict: "partial",
      strengths: [],
      feedback: String(fallbackText || "").trim(),
      reference: "",
      evidence: []
    };
  }
  const verdict = ["good", "partial", "off"].includes(parsed.verdict) ? parsed.verdict : "partial";
  const strengths = (Array.isArray(parsed.strengths) ? parsed.strengths : [])
    .map((s) => String(s || "").trim())
    .filter(Boolean)
    .slice(0, 5);
  return {
    verdict,
    strengths,
    feedback: String(parsed.feedback || "").trim(),
    reference: String(parsed.reference || parsed.answer || "").trim(),
    evidence: normalizeEvidence(parsed.evidence)
  };
}

/**
 * 引导式精读：批改学员对某一步引导问题的回答
 */
export async function reviewGuidedAnswer({
  title = "",
  mode = "quick",
  config = {},
  pages = [],
  step = {},
  userAnswer = "",
  prior = null
} = {}) {
  const baseUrl = String(config.baseUrl || "").trim().replace(/\/+$/, "");
  const apiKey = String(config.apiKey || "").trim();
  const model = String(config.model || "").trim();
  if (!baseUrl || (!apiKey && !isChatGptModelUrl(baseUrl)) || !model) {
    throw new Error("请先在设置中配置 API Key");
  }

  const resolvedMode = mode === "full" ? "full" : "quick";
  const { corpus, pageCoverage, pageNums } = buildPdfCorpus(pages, resolvedMode);
  if (!corpus.trim()) {
    throw new Error("扫描版 PDF 无可提取文字，暂不支持 OCR");
  }

  const stepIndex = Number(step?.index);
  const stepTotal = Number(step?.total);
  const stepLabel = [
    Number.isInteger(stepIndex) && stepIndex >= 0 ? `第 ${stepIndex + 1} 步` : "",
    Number.isInteger(stepTotal) && stepTotal > 0 ? `共 ${stepTotal} 步` : ""
  ].filter(Boolean).join(" / ");
  const priorText = prior ? JSON.stringify(prior).slice(0, 6000) : "";
  const answer = String(userAnswer || "").trim();

  const user = [
    `论文标题：${title || "（未知）"}`,
    `解读模式：${resolvedMode}`,
    priorText ? `已有结构化解读：\n${priorText}` : "",
    `正文摘录（页码 ${pageCoverage}）：\n${corpus.slice(0, resolvedMode === "full" ? 20000 : 10000)}`,
    `当前引导步骤：${stepLabel}${step?.title ? ` · ${step.title}` : ""}`,
    step?.goal ? `这一步的目标：${step.goal}` : "",
    `引导问题：${step?.question || "（缺失）"}`,
    answer ? `学员的回答：\n${answer}` : "学员的回答：（空，学员跳过了本步）"
  ]
    .filter(Boolean)
    .join("\n\n");

  const usages = [];
  const attempt = async () => {
    const out = await callChat({
      baseUrl,
      apiKey,
      model,
      system: guideSystem(),
      user,
      maxTokens: 3000,
      temperature: 0.3
    });
    if (out?.usage) usages.push(out.usage);
    return out.content;
  };

  let content;
  try {
    content = await attempt();
  } catch (error) {
    if (isChatGptModelUrl(baseUrl)) throw error;
    await new Promise((r) => setTimeout(r, 800));
    content = await attempt();
  }

  const review = normalizeGuideReview(extractJsonObject(content), content);
  return {
    ...review,
    evidence: review.evidence.filter((item) => pageNums.includes(item.page)),
    usage: mergeUsages(usages),
    model
  };
}

function guideDialogSystem() {
  return `你是耐心的论文精读导师。学员已完成某一步引导问题并得到你的批改，现在想就这一步继续和你讨论。请结合学员最初的回答、你此前的批改与参考答案、以及你们已经聊过的内容，回应学员的新消息。
只输出一个 JSON 对象，不要 Markdown，不要输出 JSON 以外的解释，格式：
{
  "reply": "直接回应学员的新消息，简洁友好，可用短段落和列表",
  "evidence": [
    {"page": 2, "label": "第 2 页", "reason": "该页支持本条回应", "quote": "正文中的短语，可为空"}
  ]
}
要求：
1) 围绕这一步的引导问题和论文正文展开；学员问到正文摘录之外的内容时，明确说明材料不足，不要编造。
2) 语气友好鼓励，把概念讲透，但不直接替学员完成后续步骤的思考。
3) evidence 只能引用正文摘录标题「[第 N 页]」中出现的页码，最多 3 条；quote 不超过 80 字，不要编造原文。
4) 只输出 JSON。`;
}

function normalizeDialogTurnMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages
    .map((m) => ({
      role: m?.role === "assistant" ? "assistant" : "user",
      text: String(m?.text || "").trim()
    }))
    .filter((m) => m.text);
}

/**
 * 引导式精读：某一步批改完成后的持续追问（多轮对话，聊天记录随解读持久化）
 */
export async function guideDialogTurn({
  title = "",
  mode = "quick",
  config = {},
  pages = [],
  step = {},
  record = {},
  messages = [],
  prior = null
} = {}) {
  const baseUrl = String(config.baseUrl || "").trim().replace(/\/+$/, "");
  const apiKey = String(config.apiKey || "").trim();
  const model = String(config.model || "").trim();
  if (!baseUrl || (!apiKey && !isChatGptModelUrl(baseUrl)) || !model) {
    throw new Error("请先在设置中配置 API Key");
  }

  const resolvedMode = mode === "full" ? "full" : "quick";
  const { corpus, pageCoverage, pageNums } = buildPdfCorpus(pages, resolvedMode);
  if (!corpus.trim()) {
    throw new Error("扫描版 PDF 无可提取文字，暂不支持 OCR");
  }

  const dialog = normalizeDialogTurnMessages(messages);
  const lastUser = [...dialog].reverse().find((m) => m.role === "user");
  const newMessage = String(lastUser?.text || "").trim();
  if (!newMessage) {
    throw new Error("缺少要回复的消息");
  }

  const stepIndex = Number(step?.index);
  const stepTotal = Number(step?.total);
  const stepLabel = [
    Number.isInteger(stepIndex) && stepIndex >= 0 ? `第 ${stepIndex + 1} 步` : "",
    Number.isInteger(stepTotal) && stepTotal > 0 ? `共 ${stepTotal} 步` : ""
  ].filter(Boolean).join(" / ");
  const priorText = prior ? JSON.stringify(prior).slice(0, 6000) : "";
  const originalAnswer = String(record?.answer || "").trim();
  const transcript = dialog
    .slice(-12)
    .map((m) => `${m.role === "user" ? "学员" : "导师"}：${m.text}`)
    .join("\n\n");

  const user = [
    `论文标题：${title || "（未知）"}`,
    `解读模式：${resolvedMode}`,
    priorText ? `已有结构化解读：\n${priorText}` : "",
    `正文摘录（页码 ${pageCoverage}）：\n${corpus.slice(0, resolvedMode === "full" ? 20000 : 10000)}`,
    `当前引导步骤：${stepLabel}${step?.title ? ` · ${step.title}` : ""}`,
    step?.goal ? `这一步的目标：${step.goal}` : "",
    `引导问题：${step?.question || "（缺失）"}`,
    `学员最初的回答：\n${originalAnswer || "（空，学员跳过了本步）"}`,
    record?.feedback ? `导师的批改：\n${String(record.feedback).slice(0, 3000)}` : "",
    record?.reference ? `参考答案：\n${String(record.reference).slice(0, 3000)}` : "",
    transcript ? `到目前为止的对话：\n${transcript}` : "",
    `学员的新消息：\n${newMessage}`
  ]
    .filter(Boolean)
    .join("\n\n");

  const usages = [];
  const attempt = async () => {
    const out = await callChat({
      baseUrl,
      apiKey,
      model,
      system: guideDialogSystem(),
      user,
      maxTokens: 3000,
      temperature: 0.3
    });
    if (out?.usage) usages.push(out.usage);
    return out.content;
  };

  let content;
  try {
    content = await attempt();
  } catch (error) {
    if (isChatGptModelUrl(baseUrl)) throw error;
    await new Promise((r) => setTimeout(r, 800));
    content = await attempt();
  }

  const parsed = extractJsonObject(content);
  const reply = parsed && typeof parsed.reply === "string" && parsed.reply.trim()
    ? parsed.reply.trim()
    : content.trim();
  const evidence = parsed ? normalizeEvidence(parsed.evidence) : [];
  return {
    reply,
    evidence: evidence.filter((item) => pageNums.includes(item.page)).slice(0, 4),
    usage: mergeUsages(usages),
    model
  };
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
  if (!baseUrl || (!apiKey && !isChatGptModelUrl(baseUrl)) || !model) {
    throw new Error("请先在设置中配置 API Key");
  }

  const resolvedMode = mode === "full" ? "full" : "quick";
  const { corpus, usedChars, pageCoverage, pageNums } = buildPdfCorpus(pages, resolvedMode);
  if (!corpus.trim()) {
    throw new Error("扫描版 PDF 无可提取文字，暂不支持 OCR");
  }

  const q = String(question || "").trim();
  const usages = [];

  const runChat = async (opts) => {
    const out = await callChat(opts);
    if (out?.usage) usages.push(out.usage);
    return out.content;
  };

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
      runChat({
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
    } catch (error) {
      if (isChatGptModelUrl(baseUrl)) throw error;
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
      evidence: evidence.filter((item) => pageNums.includes(item.page)),
      usage: mergeUsages(usages),
      model
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
        return await runChat({
          baseUrl,
          apiKey,
          model,
          system: noteSys,
          user: `片段${tag}：\n${part}`,
          maxTokens: 2000,
          temperature: 0.1
        });
      } catch (error) {
        if (isChatGptModelUrl(baseUrl)) throw error;
        return part.slice(0, 1500);
      }
    };
    const [n1, n2] = await Promise.all([note(partA, "A"), note(partB, "B")]);
    userCorpus = `【分段笔记 A】\n${n1}\n\n【分段笔记 B】\n${n2}\n\n【正文抽样】\n${corpus.slice(0, 10000)}`;
  }

  const user = `论文标题：${title || "（未知）"}\n覆盖页：${pageCoverage}\n\n正文摘录：\n${userCorpus}`;
  const attempt = () =>
    runChat({
      baseUrl,
      apiKey,
      model,
      system: systemPrompt(resolvedMode),
      user,
      maxTokens: resolvedMode === "full" ? 8000 : 6000,
      temperature: 0.2
    });

  let content;
  try {
    content = await attempt();
  } catch (error) {
    if (isChatGptModelUrl(baseUrl)) throw error;
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
    usage: mergeUsages(usages),
    model,
    result: {
      ...normalized,
      evidence: normalized.evidence.filter((item) => pageNums.includes(item.page)),
      // 引导步骤的建议页码只保留真实出现在语料中的页，避免跳转到不存在的页
      guidedSteps: normalized.guidedSteps.map((step) => ({
        ...step,
        pages: step.pages.filter((page) => pageNums.includes(page))
      }))
    }
  };
}
