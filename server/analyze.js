const STOP = new Set([
  "the", "a", "an", "of", "in", "on", "for", "and", "or", "to", "with", "at", "by", "from", "as",
  "is", "are", "was", "were", "be", "been", "being", "this", "that", "these", "those", "it",
  "we", "our", "their", "its", "his", "her", "you", "they", "them", "he", "she", "not", "but",
  "however", "while", "which", "who", "whom", "whose", "than", "then", "so", "such", "can",
  "could", "may", "might", "will", "would", "shall", "should", "has", "have", "had", "do",
  "does", "did", "into", "over", "under", "between", "through", "during", "before", "after",
  "about", "against", "within", "without", "also", "only", "both", "each", "other", "some",
  "more", "most", "much", "many", "very", "often", "using", "used", "use", "based", "paper",
  "study", "work", "results", "result", "show", "shows", "shown", "found", "find", "findings",
  "method", "methods", "approach", "model", "data", "our", "new", "propose", "proposed",
  "present", "presents", "introduce", "introduces", "experiment", "experiments", "performance",
  "however", "well", "due", "two", "three", "one", "first", "second", "et", "al", "via",
  "across", "including", "include", "among", "under", "different", "various", "significant",
  "state", "states", "need", "needs", "problem", "problems", "task", "tasks", "existing"
]);

const RULES = {
  problem: [
    "challenge", "problem", "gap", "limitation", "however", "but", "remains", "difficult",
    "unexplored", "under-explored", "unclear", "lack", "limited", "scarce", "hard to",
    "bottleneck", "obstacle", "still", "question", "issue", "shortcoming", "drawback",
    "challenging", "inefficient", "expensive", "costly", "问题", "挑战", "难点", "不足",
    "缺陷", "困难", "尚未", "难以", "仍然", "差距", "瓶颈", "局限", "低效", "成本高", "欠"
  ],
  method: [
    "we propose", "we introduce", "we present", "we develop", "we design", "we build",
    "we describe", "we demonstrate", "this paper proposes", "this paper introduces",
    "this paper presents", "this paper develops", "we leverage", "we adopt", "we use",
    "our method", "our approach", "our framework", "our model", "we formulate", "we combine",
    "we propose a", "method", "approach", "framework", "architecture", "algorithm",
    "model", "strategy", "module", "technique", "pipeline", "system", "based on", "利用",
    "提出", "设计了", "开发", "构建", "采用", "基于", "方法", "模型", "框架", "算法",
    "架构", "模块", "策略", "流程", "技术", "方案", "实现", "结合", "引入", "针对"
  ],
  results: [
    "results show", "results demonstrate", "experiments show", "experiments demonstrate",
    "we show", "we demonstrate", "we observe", "our results", "experimental results",
    "evaluation shows", "outperform", "achieves", "achieve", "improve", "improves",
    "improvement", "state-of-the-art", "sota", "accuracy", "f1", "reduces", "significantly",
    "evidence", "validated", "evaluate", "evaluation", "benchmark", "实验", "实验表明",
    "结果表明", "结果显示", "相比", "提升", "提高", "优于", "达到", "验证", "评估",
    "评测", "准确率", "效果", "显著", "优于", "优势", "取得了", "展示", "证明"
  ],
  conclusion: [
    "we conclude", "in conclusion", "in summary", "overall", "we summarize", "implications",
    "our findings suggest", "we argue", "we believe", "we hope", "contribution",
    "contributes", "finally", "综上", "总之", "结论", "表明", "这意味着", "贡献",
    "本文提出", "本文贡献", "最后", "总结", "展望"
  ],
  limitation: [
    "limitation", "limited", "future work", "future direction", "we did not", "we do not",
    "caveat", "potential concern", "not evaluated", "outside the scope", "further research",
    "局限", "不足", "未来工作", "未来研究方向", "尚未验证", "有待", "进一步", "未考虑",
    "仍待", "后续"
  ]
};

export function analyzePaper({ title = "", abstract = "", keywords = [] } = {}) {
  const text = `${title}. ${abstract}`.trim();
  const sentences = splitSentences(abstract || title || "");
  const lang = detectLang(text);
  const extracted = extractKeywords(`${title} ${abstract}`, lang, keywords);
  const grouped = classifySentences(sentences, lang);
  const keySentences = rankSentences(sentences, text, lang).slice(0, 5).map((s) => s.text);
  const difficulty = estimateDifficulty(text, sentences, lang);
  const fiveQuestions = buildQuestions(title, lang);
  const conceptPath = buildConceptPath(extracted, lang);
  return {
    language: lang,
    keywords: extracted,
    sections: grouped,
    keySentences,
    difficulty,
    fiveQuestions,
    conceptPath,
    abstractLength: (abstract || "").length,
    sentenceCount: sentences.length
  };
}

export async function deepAnalyze({ title = "", abstract = "" } = {}) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("未配置 OPENAI_API_KEY，无法使用深度解读");
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || "gpt-4o-mini",
      temperature: 0.3,
      messages: [
        {
          role: "system",
          content:
            "你是一名科研导师，用简洁中文输出论文解读。只输出 JSON，不要 Markdown。字段：oneSentence（一句话概括）、problem、method、findings、limitations、takeaways（数组，最多5条）、questions（数组，最多4个启发问题）。"
        },
        { role: "user", content: `标题：${title}\n摘要：${abstract}` }
      ]
    })
  });
  if (!res.ok) throw new Error(`深度解读失败：${res.status} ${res.statusText}`);
  const json = await res.json();
  const content = json.choices?.[0]?.message?.content || "{}";
  try {
    return JSON.parse(content.replace(/```json|```/g, ""));
  } catch {
    return { oneSentence: content };
  }
}

function splitSentences(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?。！？；;])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 8);
}

function detectLang(text) {
  const cjk = (text.match(/[\u3400-\u9fff]/g) || []).length;
  const total = text.replace(/\s/g, "").length || 1;
  return cjk / total > 0.25 ? "zh" : "en";
}

function tokenize(text, lang) {
  if (lang === "zh") {
    const chars = (text.match(/[\u3400-\u9fff]/g) || []).join("");
    const bigrams = new Map();
    for (let i = 0; i < chars.length - 1; i++) {
      const bg = chars.slice(i, i + 2);
      bigrams.set(bg, (bigrams.get(bg) || 0) + 1);
    }
    return [...bigrams.entries()].map(([w, c]) => ({ word: w, count: c, len: 2 }));
  }
  const words = String(text).toLowerCase().match(/[a-z][a-z0-9-]{2,}/g) || [];
  const counts = new Map();
  for (const w of words) {
    if (STOP.has(w) || w.length < 3) continue;
    counts.set(w, (counts.get(w) || 0) + 1);
  }
  return [...counts.entries()].map(([w, c]) => ({ word: w, count: c, len: w.length }));
}

function extractKeywords(text, lang, seed) {
  const tokens = tokenize(text, lang);
  const seedSet = new Set(seed.map((s) => s.toLowerCase()));
  const scored = tokens
    .map((t) => ({
      ...t,
      score: t.count * (t.len >= 6 ? 1.25 : 1) + (seedSet.has(t.word.toLowerCase()) ? 2 : 0)
    }))
    .sort((a, b) => b.score - a.score);
  const out = [];
  const used = new Set();
  for (const t of scored) {
    if (used.has(t.word)) continue;
    if (out.some((o) => o.includes(t.word) || t.word.includes(o))) continue;
    used.add(t.word);
    out.push(t.word);
    if (out.length >= 12) break;
  }
  return out;
}

function classifySentences(sentences, lang) {
  const groups = {
    problem: [],
    method: [],
    results: [],
    conclusion: [],
    limitation: [],
    other: []
  };
  for (const s of sentences) {
    const lower = s.toLowerCase();
    const scores = Object.entries(RULES).map(([k, words]) => ({
      k,
      v: words.reduce((acc, w) => acc + (lower.includes(w) ? 1 : 0), 0)
    }));
    const best = scores.sort((a, b) => b.v - a.v)[0];
    if (best.v > 0) groups[best.k].push(s);
    else groups.other.push(s);
  }
  for (const key of Object.keys(groups)) groups[key] = groups[key].slice(0, 6);
  return groups;
}

function rankSentences(sentences, fullText, lang) {
  const lowerAll = fullText.toLowerCase();
  return sentences.map((text, i) => {
    const lower = text.toLowerCase();
    let score = 0;
    if (i === 0) score += 3;
    if (i === sentences.length - 1) score += 2;
    score += Object.values(RULES).flat().reduce((acc, w) => acc + (lower.includes(w) ? 1 : 0), 0) * 1.4;
    const words = tokenize(text, lang);
    score += Math.min(3, words.length * 0.2);
    score += text.length > 140 ? 1 : text.length > 70 ? 0.7 : 0;
    if (lower.includes(lowerAll.split(" ")[1]?.replace(/[^\w]/g, "")?.toLowerCase() || "____")) score += 0.5;
    return { text, score };
  }).sort((a, b) => b.score - a.score);
}

function estimateDifficulty(text, sentences, lang) {
  const words = lang === "zh" ? (text.match(/[\u3400-\u9fff]/g) || []) : (text.match(/[a-z][a-z0-9-]{2,}/g) || []);
  const avgLen = words.length / Math.max(1, sentences.length);
  const longWords = words.filter((w) => w.length > 8).length;
  const score = Math.min(5, Math.max(1, Math.round(1 + avgLen * 0.12 + longWords * 0.06)));
  return {
    score,
    label: ["入门", "基础", "进阶", "深入", "前沿"][score - 1],
    factors: [
      avgLen > 18 ? "句子偏长" : "句子长度适中",
      longWords > 6 ? "专业术语密集" : "术语密度适中",
      sentences.length > 8 ? "信息密度较高" : "结构清晰"
    ]
  };
}

function buildQuestions(title, lang) {
  if (lang === "zh") {
    return [
      `这篇论文试图解决什么问题？`,
      `为什么这个问题重要？现有方法哪里不够好？`,
      `作者提出了什么方法？核心思路和关键设计是什么？`,
      `有哪些实验或证据支持结论？结果有多大提升？`,
      `论文的局限在哪里？你能想到什么延伸方向？`
    ];
  }
  return [
    `What problem does this paper address and why does it matter?`,
    `What is the key idea and how does it differ from prior work?`,
    `What evidence supports the claims, and how strong is it?`,
    `What are the limitations and open questions?`,
    `How would you apply or extend this work in your own research?`
  ];
}

function buildConceptPath(keywords, lang) {
  const top = keywords.slice(0, 5);
  const base = lang === "zh"
    ? [
        { stage: "入门", action: `先找 1-2 篇与「${top[0] || "该主题"}」相关的综述或入门讲义，建立概念地图` },
        { stage: "基础", action: `掌握关键词背后的基础理论：${top.slice(1, 3).join("、") || "核心概念、常用符号与评价指标"}` },
        { stage: "方法", action: `精读 3-5 篇提出核心方法的代表论文，对比方法差异与适用条件` },
        { stage: "复现", action: `选择一篇数据公开的论文尝试复现，记录实验设计与消融设置` },
        { stage: "延伸", action: `针对「${top[0] || "当前主题"}」的局限设计小实验，形成自己的研究问题` }
      ]
    : [
        { stage: "Orientation", action: `Read 1-2 surveys around "${top[0] || "this topic"}" to map the field` },
        { stage: "Foundations", action: `Build intuition for core concepts: ${top.slice(1, 3).join(", ") || "notation, baselines, and metrics"}` },
        { stage: "Methods", action: `Deep-read 3-5 representative papers and compare method designs` },
        { stage: "Reproduce", action: `Reproduce an open-source paper and log ablations and failure modes` },
        { stage: "Extend", action: `Turn limitations of "${top[0] || "the topic"}" into a small experiment and research question` }
      ];
  return base;
}
