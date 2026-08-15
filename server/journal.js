function clip(text, max = 320) {
  const t = String(text || "").trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

function clipTitle(text) {
  return clip(String(text || "").replace(/\s+/g, " ").trim(), 30);
}

function extractLines(text) {
  return String(text || "").split("\n").map((l) => l.trim()).filter(Boolean);
}

function extractCorrections(messages) {
  const hits = [];
  for (const m of messages) {
    if (m.role !== "agent") continue;
    for (const line of extractLines(m.content)) {
      const clean = line.replace(/^[-*•\d.、\s]+/, "");
      if (/纠正|误区|注意|错误|不要|应该|关键|重点|建议|下一步|补充|本质|区别/.test(clean)) {
        hits.push(clip(clean, 120));
      }
    }
  }
  return [...new Set(hits)].slice(0, 6);
}

function toList(value, max, fallback = []) {
  const arr = Array.isArray(value) ? value.filter((x) => typeof x === "string" && x.trim()) : [];
  return (arr.length ? arr : fallback).slice(0, max).map((s) => clip(s, 80));
}

function parseJson(content) {
  const text = String(content || "").replace(/```json/gi, "").replace(/```/g, "").trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

function buildMindmap({ title, userMessages, corrections, nextSteps }) {
  return {
    label: "核心主题",
    note: title,
    children: [
      { label: "核心问题", note: clip(userMessages[0] || "我提出的问题", 40) },
      {
        label: "我的理解",
        children: (userMessages.length ? userMessages : ["用自己的话表达理解"]).slice(0, 3).map((u) => ({
          label: "理解",
          note: clip(u, 40)
        }))
      },
      {
        label: "关键纠正",
        children: (corrections.length ? corrections : ["继续追问"]).slice(0, 4).map((c) => ({
          label: "要点",
          note: clip(c, 40)
        }))
      },
      {
        label: "行动",
        children: nextSteps.slice(0, 4).map((s) => ({
          label: "下一步",
          note: clip(s, 40)
        }))
      }
    ]
  };
}

function buildSummary({ title, core, takeaways, corrections, nextSteps }) {
  return [
    `# 核心手记：${title}`,
    "",
    "## 核心理解",
    core,
    "",
    "## 要点",
    ...takeaways.map((t) => `- ${t}`),
    "",
    "## 关键纠正",
    ...corrections.map((c) => `- ${c}`),
    "",
    "## 下一步",
    ...nextSteps.map((s) => `- ${s}`)
  ].join("\n");
}

export function buildJournal(messages = [], options = {}) {
  const clean = (messages || []).filter((m) => m && typeof m.content === "string" && m.content.trim());
  if (!clean.length) throw new Error("没有可保存的对话内容");

  const userMessages = clean.filter((m) => m.role === "user").map((m) => clip(m.content, 300));
  const firstUser = userMessages[0] || "未命名思考";
  const title = options.title?.trim() || clipTitle(firstUser);
  const corrections = extractCorrections(clean);
  const insights = userMessages.slice(1).length ? userMessages.slice(1) : [];
  const nextSteps = [
    "把关键点用自己的话再讲一遍",
    "回到学习路径完成下一个任务",
    "三天后回看这份手记"
  ];
  const takeaways = [...insights.slice(0, 3), ...corrections.slice(0, 3)].slice(0, 6);
  const core = `围绕「${title}」，我在对话中先给出自己的理解，再通过追问修正了关键概念。最核心的收获：${corrections[0] || "需要继续用自己的话复述和实践检验。"}`;

  return {
    title,
    core,
    takeaways,
    corrections,
    nextSteps,
    mindmap: buildMindmap({ title, userMessages, corrections, nextSteps }),
    summary: buildSummary({ title, core, takeaways, corrections, nextSteps }),
    messages: clean.map((m) => ({
      role: m.role,
      content: clip(m.content, 800),
      toolCalls: m.toolCalls || []
    })),
    turnCount: clean.filter((m) => m.role === "user").length
  };
}

export async function refineJournal(messages = [], config = {}) {
  const fallback = buildJournal(messages);
  const baseUrl = String(config?.baseUrl || "").trim().replace(/\/+$/, "");
  const apiKey = String(config?.apiKey || "").trim();
  const model = String(config?.model || "").trim();
  if (!baseUrl || !apiKey || !model) return null;

  const transcript = fallback.messages
    .map((m) => `${m.role === "user" ? "用户" : "Agent"}：${m.content}`)
    .join("\n\n---\n\n");

  const system = `你是严谨的科研学习教练。请把对话提炼成高质量学习手记，而不是流水账。
要求：
1. 只输出一个 JSON 对象，不要 Markdown 代码块，不要任何解释。
2. JSON 结构：
{
  "title": "不超过 24 字的主题标题",
  "core": "3-5 句话的核心理解总结",
  "takeaways": ["3-6 条精炼要点，每条不超过 30 字"],
  "corrections": ["2-5 条关键纠正或认知升级，每条不超过 30 字"],
  "nextSteps": ["3-4 条可执行下一步，每条不超过 24 字"],
  "mindmap": {
    "label": "主题",
    "note": "一句话核心",
    "children": [
      {"label": "核心问题", "note": "一句话"},
      {"label": "我的理解", "children": [{"label": "理解", "note": "一句话"}]},
      {"label": "关键纠正", "children": [{"label": "要点", "note": "一句话"}]},
      {"label": "行动", "children": [{"label": "下一步", "note": "一句话"}]}
    ]
  }
}
3. mindmap 最多三层，每个 label 不超过 10 个字，note 不超过 40 个字。
4. 保留用户真正的认知变化，去掉寒暄、客套和重复内容。`;

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      temperature: 0.3,
      max_tokens: 1400,
      messages: [
        { role: "system", content: system },
        { role: "user", content: transcript }
      ]
    }),
    signal: AbortSignal.timeout(60000)
  });
  if (!res.ok) return null;

  const data = await res.json();
  const parsed = parseJson(data.choices?.[0]?.message?.content);
  if (!parsed) return null;

  const title = clipTitle(parsed.title || fallback.title);
  const corrections = toList(parsed.corrections, 5, fallback.corrections);
  const nextSteps = toList(parsed.nextSteps, 4, fallback.nextSteps);
  const takeaways = toList(parsed.takeaways, 6, fallback.takeaways);
  const core = clip(parsed.core || fallback.core, 500);
  const mindmap = parsed.mindmap && typeof parsed.mindmap === "object" ? parsed.mindmap : fallback.mindmap;

  return {
    ...fallback,
    title,
    core,
    takeaways,
    corrections,
    nextSteps,
    mindmap,
    summary: buildSummary({ title, core, takeaways, corrections, nextSteps })
  };
}
