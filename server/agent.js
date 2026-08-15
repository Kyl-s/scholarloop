import { searchPapers } from "./sources.js";
import { analyzePaper } from "./analyze.js";
import {
  addPathTask as addPathTaskToPath,
  flattenPath,
  generatePath,
  pathProgress,
  setTaskStatus as setPathTaskStatus,
  splitPathTask as splitPathTaskInPath,
  syncPathEvidence
} from "./path.js";
import {
  addPathTask,
  appendPathLog,
  completePathTask,
  getData,
  getMemories,
  setPath,
  splitPathTask,
  updatePathTaskStatus
} from "./store.js";

const SYSTEM_PROMPT = `你是一名严谨、耐心的科研导师，名字叫 ScholarLoop Agent。
你的职责是帮助用户从零基础成长为能独立做研究的人，并在合适时调用工具。

规则：
1. 默认使用中文回答，除非用户明确要求其他语言。
2. 用户需要检索论文时，调用 search_papers；需要制定学习路径时，调用 plan_study；需要拆解摘要或论文时，调用 analyze_paper；需要了解文献库时，调用 get_library。
3. 回答要具体、可执行，避免空泛鼓励。给出下一步建议和可检验的小任务。
4. 涉及论文时，注明来源、年份与链接，并区分“已核实事实”与“建议进一步查阅”的内容。
5. 如果工具返回为空或出错，如实告诉用户，并给出替代建议。
6. 当用户表示想开始学习、继续学习或询问学习进度时，先调用 get_path 获取当前路径，找到第一个未完成任务。
7. 学习互动采用“一任务一问答”模式：先让用户用自己的话解释、复述或给出实际产出；不要直接替用户完成任务。
8. 判断用户回答是否真正理解：理解正确或有实质进展，再调用 complete_task 标记完成；理解有误时先纠正、补充解释，再让用户重新回答，不轻易打勾。
9. 对检索、阅读、写作、复现等实操任务，要求用户提供具体产出（论文标题、链接、笔记要点、代码结果等），并追问关键点验证，而不是仅凭“我完成了”就通过。
10. 每次标记任务完成后，告诉用户已完成的阶段和下一步任务，继续保持一问一答。
11. 当一段学习互动结束（用户完成一个任务、表示告一段落，或本次问答达到自然终点）时，调用 save_progress 记录本次进展、卡点和下一步。
12. 用户想调整学习路径时，调用 update_path：可以添加新任务、把大任务拆成小任务，或把某个任务标记为跳过。`;

function normalizeContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object") return part.text || part.content || JSON.stringify(part);
        return String(part || "");
      })
      .filter(Boolean)
      .join("\n");
  }
  return content ? String(content) : "";
}

const TOOLS = [
  {
    type: "function",
    function: {
      name: "search_papers",
      description: "跨源检索论文，可指定来源、年份范围、排序方式与数量。用于用户需要查找特定领域、主题或问题的文献时。",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "检索关键词或研究方向，例如 transformer attention 或 大语言模型 推理" },
          sources: {
            type: "array",
            items: { type: "string", enum: ["arxiv", "openalex", "semanticscholar", "pubmed", "crossref", "cnki"] },
            description: "可选数据源，默认全部"
          },
          fromYear: { type: "string", description: "起始年份，如 2020" },
          toYear: { type: "string", description: "结束年份，如 2026" },
          sort: { type: "string", enum: ["authority", "relevance", "cited", "year"], description: "排序方式：authority 按权威度（被引、年限、文献类型加权）" },
          limit: { type: "number", description: "返回数量，1-20" }
        },
        required: ["query"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "plan_study",
      description: "根据用户的研究领域、目标与当前水平，生成一个包含领域地图、基础学习、文献检索、方法理解、复现实验、综述写作、打磨发表的七阶段学习路径。",
      parameters: {
        type: "object",
        properties: {
          field: { type: "string", description: "研究领域，例如 大语言模型、计算机视觉、材料科学" },
          goal: { type: "string", description: "用户的学习目标" },
          level: { type: "string", enum: ["beginner", "foundation", "intermediate"], description: "当前水平" }
        },
        required: ["field", "goal"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "analyze_paper",
      description: "对论文标题与摘要进行结构化解读，输出研究问题、方法、结果、结论、局限、关键句、阅读五问与建议学习路径。",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "论文标题" },
          abstract: { type: "string", description: "论文摘要" },
          keywords: { type: "array", items: { type: "string" }, description: "可选关键词列表" }
        },
        required: ["title"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_library",
      description: "查看用户文献库中的论文、阅读状态与理解等级，用于规划学习或回顾。",
      parameters: { type: "object", properties: {} }
    }
  },
  {
    type: "function",
    function: {
      name: "get_path",
      description: "查看用户当前学习路径、阶段进度、已完成任务与下一步任务。用户表示要继续学习、开始学习或询问学习进度时调用。",
      parameters: { type: "object", properties: {} }
    }
  },
  {
    type: "function",
    function: {
      name: "complete_task",
      description: "用户通过互动验证真正完成某个学习任务后，标记该任务为已完成。参数为任务标题或任务 id。",
      parameters: {
        type: "object",
        properties: {
          taskTitle: { type: "string", description: "要标记完成的任务标题或任务 id" }
        },
        required: ["taskTitle"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "update_path",
      description: "根据用户实际学习情况调整学习路径：添加自定义任务、把大任务拆成小任务、或把任务标记为跳过。",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["add", "split", "skip", "status"], description: "add 添加任务；split 拆分任务；skip 跳过任务；status 设置任务状态" },
          stageTitle: { type: "string", description: "阶段标题，例如 文献检索与精读" },
          taskTitle: { type: "string", description: "要处理的任务标题" },
          title: { type: "string", description: "action=add 时的新任务标题" },
          newTasks: { type: "array", items: { type: "string" }, description: "action=split 时拆成的小任务列表" },
          status: { type: "string", enum: ["todo", "inprogress", "review", "done", "skipped"], description: "action=status 时要设置的状态" }
        },
        required: ["action"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "save_progress",
      description: "一段学习互动结束后，记录本次学习进展、卡点和下一步，供下次继续学习时恢复上下文。",
      parameters: {
        type: "object",
        properties: {
          summary: { type: "string", description: "本次学到的内容或完成的事情" },
          blocker: { type: "string", description: "遇到的卡点，没有则留空" },
          next: { type: "string", description: "下次继续学习的起点" }
        },
        required: ["summary"]
      }
    }
  }
];

function summarizePapers(result) {
  const papers = result.papers || [];
  return {
    total: result.total,
    sourceStatus: result.sourceStatus,
    papers: papers.map((p) => ({
      title: p.title,
      year: p.year,
      venue: p.venue,
      authors: (p.authors || []).slice(0, 6),
      source: p.sourceLabel,
      citations: p.citations,
      url: p.url,
      pdfUrl: p.pdfUrl,
      abstract: p.abstract ? p.abstract.slice(0, 320) : ""
    }))
  };
}

function summarizePath(path) {
  return {
    field: path.field,
    goal: path.goal,
    stages: path.stages.map((s) => ({
      title: s.title,
      subtitle: s.subtitle,
      description: s.description,
      tasks: s.tasks.map((t) => t.title)
    }))
  };
}

export function buildAgentMemoryContext(memories) {
  return (Array.isArray(memories) ? memories : [])
    .filter((memory) => memory?.enabled !== false && memory.content)
    .slice(0, 30)
    .map((memory) => `- ${memory.title || "未命名记忆"}：${memory.content}`)
    .join("\n")
    .slice(0, 6000);
}

async function runTool(name, args) {
  try {
    switch (name) {
      case "search_papers":
        return summarizePapers(
          await searchPapers(String(args.query || "").trim(), {
            sources: Array.isArray(args.sources) ? args.sources : undefined,
            fromYear: args.fromYear || "",
            toYear: args.toYear || "",
            sort: args.sort || "relevance",
            limit: Number(args.limit) || 10
          })
        );
      case "plan_study":
        return summarizePath(generatePath({ field: args.field, goal: args.goal, level: args.level || "beginner" }));
      case "analyze_paper":
        return analyzePaper({ title: args.title, abstract: args.abstract || "", keywords: args.keywords || [] });
      case "get_library":
        return getData().library.map((p) => ({
          title: p.title,
          year: p.year,
          source: p.sourceLabel,
          status: p.status,
          understanding: p.understanding,
          tags: p.tags,
          reviewDue: p.reviewDue
        }));
      case "get_path": {
        const p = syncPathEvidence(getData().path, getData());
        const tasks = flattenPath(p);
        const next = tasks.find((t) => !t.done && t.status !== "skipped") || null;
        return {
          field: p.field,
          goal: p.goal,
          progress: pathProgress(p.stages),
          next,
          recentLog: Array.isArray(p.progressLog) ? p.progressLog[0] || null : null,
          stages: (p.stages || []).map((s) => ({
            id: s.id,
            title: s.title,
            subtitle: s.subtitle,
            tasks: (s.tasks || []).map((t, i) => ({ id: `${s.id}-${i + 1}`, title: t.title, done: Boolean(t.done), status: t.status || "todo" }))
          }))
        };
      }
      case "complete_task":
        return completePathTask(args.taskTitle);
      case "update_path": {
        const current = getData().path;
        const stageTitle = String(args.stageTitle || "").trim();
        const taskTitle = String(args.taskTitle || "").trim();
        const action = String(args.action || "status");
        const stage = (current.stages || []).find((s) => !stageTitle || s.title.includes(stageTitle)) || (current.stages || [])[0];
        if (!stage) return { error: "学习路径为空，请先生成学习路径" };
        const taskIndex = (stage.tasks || []).findIndex((t) => t.title === taskTitle || t.title.includes(taskTitle));
        let updated = current;
        if (action === "add") {
          updated = addPathTaskToPath(current, stage.id, args.title || taskTitle);
        } else if (action === "split") {
          if (taskIndex < 0) return { error: `未找到任务：${taskTitle}` };
          updated = splitPathTaskInPath(current, stage.id, taskIndex, args.newTasks || []);
        } else if (action === "skip") {
          if (taskIndex < 0) return { error: `未找到任务：${taskTitle}` };
          updated = setPathTaskStatus(current, stage.id, taskIndex, "skipped");
        } else {
          if (taskIndex < 0) return { error: `未找到任务：${taskTitle}` };
          updated = setPathTaskStatus(current, stage.id, taskIndex, args.status || "inprogress");
        }
        setPath(updated);
        return summarizePath(syncPathEvidence(updated, getData()));
      }
      case "save_progress": {
        appendPathLog(args);
        return { ok: true, message: "已记录本次学习进展" };
      }
      default:
        return { error: `未知工具 ${name}` };
    }
  } catch (err) {
    return { error: err.message };
  }
}

export async function agentChat({ messages = [], config = {} }) {
  const apiKey = String(config.apiKey || "").trim();
  if (!apiKey) throw new Error("请先配置 API Key");
  const baseUrl = String(config.baseUrl || "https://api.openai.com/v1").replace(/\/+$/, "");
  const model = String(config.model || "gpt-4o-mini").trim() || "gpt-4o-mini";
  const history = Array.isArray(messages) ? messages.slice(-24) : [];
  const memoryContext = buildAgentMemoryContext(getMemories());
  const systemContent = memoryContext
    ? `${SYSTEM_PROMPT}\n\n用户已启用的 ScholarLoop 独立记忆（只作为辅助背景，不要把它当成论文事实）：\n${memoryContext}`
    : SYSTEM_PROMPT;
  const apiMessages = [{ role: "system", content: systemContent }, ...history.map((m) => ({
    role: m.role === "agent" ? "assistant" : "user",
    content: normalizeContent(m.content || "")
  }))];
  const toolCalls = [];

  for (let round = 0; round < 6; round++) {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        temperature: 0.4,
        max_tokens: 1800,
        messages: apiMessages,
        tools: TOOLS,
        tool_choice: "auto"
      }),
      signal: AbortSignal.timeout(90000)
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      let detail = "";
      try {
        detail = JSON.parse(text)?.error?.message || "";
      } catch {
        detail = text.slice(0, 300);
      }
      throw new Error(`模型接口错误 ${res.status}: ${detail}`);
    }
    const json = await res.json();
    const message = json.choices?.[0]?.message;
    if (!message) throw new Error("模型未返回有效消息");

    if (message.tool_calls?.length) {
      apiMessages.push({ role: "assistant", content: normalizeContent(message.content), tool_calls: message.tool_calls });
      for (const call of message.tool_calls) {
        let args = {};
        try {
          args = JSON.parse(call.function.arguments || "{}");
        } catch {
          args = {};
        }
        const result = await runTool(call.function.name, args);
        toolCalls.push({ name: call.function.name, args, result });
        apiMessages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
      }
      continue;
    }

    return { content: normalizeContent(message.content), toolCalls };
  }

  const last = apiMessages.filter((m) => m.role === "assistant").pop();
  return { content: normalizeContent(last?.content) || "Agent 已完成处理，但未能生成最终回答。", toolCalls };
}
