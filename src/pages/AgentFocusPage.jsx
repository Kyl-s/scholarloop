import { useEffect, useRef, useState } from "react";
import {
  Bot,
  Send,
  KeyRound,
  Trash2,
  Settings2,
  Sparkles,
  Search,
  Route,
  BookOpen,
  Loader2,
  Target,
  Play,
  BookmarkPlus,
  CheckCircle2,
  Circle,
  ArrowRight,
  MessageSquarePlus
} from "lucide-react";
import { api } from "../api.js";
import { Button, IconButton } from "../components/ui.jsx";
import { useData } from "../store.jsx";
import { renderMarkdown } from "../components/markdown.jsx";
import { useAgentConfig } from "../agentConfig.js";
import { clearJournalLink, persistAgentJournal } from "../agentJournal.js";

const CHAT_KEY = "scholarloop.agent.chat";

const QUICK_ACTIONS = [
  { label: "制定学习计划", prompt: "帮我制定一个 3 个月掌握大语言模型的完整学习计划" },
  { label: "检索最新文献", prompt: "帮我检索 2024 年以后关于大语言模型推理优化的最新论文" },
  { label: "解释领域概念", prompt: "用适合小白的语言解释什么是注意力机制，并推荐入门论文" },
  { label: "搭建论文大纲", prompt: "我要写一篇关于大语言模型推理效率的综述，帮我搭建论文大纲" }
];

const TOOL_LABELS = {
  search_papers: { icon: Search, label: "检索论文" },
  plan_study: { icon: Route, label: "生成学习计划" },
  analyze_paper: { icon: BookOpen, label: "拆解论文" },
  get_library: { icon: Sparkles, label: "查看文献库" },
  get_path: { icon: Route, label: "查看学习路径" },
  complete_task: { icon: CheckCircle2, label: "标记任务完成" }
};

const STATUS_LABELS = { todo: "未开始", inprogress: "进行中", review: "待回顾", done: "已完成", skipped: "已跳过" };

function loadJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function asText(text) {
  if (typeof text === "string") return text;
  if (Array.isArray(text)) {
    return text
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object") return part.text || part.content || JSON.stringify(part);
        return String(part || "");
      })
      .join("\n");
  }
  return text ? String(text) : "";
}

function sanitizeMessage(m) {
  if (!m || typeof m !== "object") return m;
  const content = asText(m.content);
  return content === m.content ? m : { ...m, content };
}

export default function AgentFocusPage({ onOpenQuick, onNavigate }) {
  const { path, stats, refresh, saveJournal } = useData();
  const config = useAgentConfig();
  const [messages, setMessages] = useState(() => (loadJSON(CHAT_KEY, []) || []).map(sanitizeMessage));
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [savedNote, setSavedNote] = useState("");
  const [saving, setSaving] = useState(false);
  const listRef = useRef(null);
  const inputRef = useRef(null);

  const pathStages = path?.stages || [];
  const allTasks = pathStages.flatMap((s) => (s.tasks || []).map((t) => ({ ...t, stage: s })));
  const nextTask = allTasks.find((t) => !t.done && t.status !== "skipped");
  const doneCount = allTasks.filter((t) => t.done).length;
  const percent = stats?.pathProgress?.percent ?? (allTasks.length ? Math.round((doneCount / allTasks.length) * 100) : 0);
  const recentLog = Array.isArray(path?.progressLog) ? path.progressLog[0] || null : null;

  const learnPrompt = nextTask
    ? `继续学习我的学习路径。当前阶段「${nextTask.stage.title}」，当前任务：「${nextTask.title}」。上次学习进展：${recentLog?.summary || "无"}；上次卡点：${recentLog?.blocker || "无"}；上次说的下一步：${recentLog?.next || "无"}。请先调用 get_path 确认进度，然后引导我完成这个任务：一次只问一个问题，检查我的理解；我回答后判断是否正确，错了就纠正并让我重新回答；确认达标后再调用 complete_task 标记完成，并告诉我下一步任务。`
    : `我的学习路径已经全部完成，请调用 get_path 确认后，帮我总结这七阶段的收获，并给出下一步研究建议。`;

  const configured = Boolean(config?.apiKey);
  const canSave = messages.some((m) => m.role === "agent" && typeof m.content === "string" && m.content.trim() && !m.content.startsWith("出错了"));

  useEffect(() => {
    localStorage.setItem(CHAT_KEY, JSON.stringify(messages));
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    if (configured) inputRef.current?.focus();
  }, [configured]);

  const goSettings = () => onNavigate?.({ page: "settings" });

  const send = async (text) => {
    const content = (text ?? input).trim();
    if (!content || busy) return;
    if (!config) {
      goSettings();
      return;
    }
    setInput("");
    setError("");
    setSavedNote("");
    const history = [...messages.map(sanitizeMessage), { role: "user", content }];
    setMessages(history);
    setBusy(true);
    try {
      const result = await api.post("/api/agent/chat", { messages: history, config });
      setMessages([...history, { role: "agent", content: asText(result.content) || "Agent 没有返回内容。", toolCalls: result.toolCalls || [] }]);
      if (result.toolCalls?.some((t) => t.name === "complete_task")) refresh();
    } catch (err) {
      setMessages([...history, { role: "agent", content: `出错了：${err.message}`, toolCalls: [] }]);
    } finally {
      setBusy(false);
    }
  };

  const clearChat = () => {
    setMessages([]);
    localStorage.removeItem(CHAT_KEY);
    clearJournalLink();
  };

  const saveDiscussion = async () => {
    if (!canSave || saving) return;
    setSaving(true);
    try {
      const result = await persistAgentJournal({
        messages: messages.map(sanitizeMessage),
        config,
        saveJournal
      });
      setSavedNote(result.reused ? "这份对话已经保存过" : "已保存到思考记录");
    } catch (err) {
      setSavedNote(`保存失败：${err.message}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="agent-focus-page">
      <aside className="agent-focus-side">
        <div className="focus-goal-card">
          <div className="focus-goal-icon"><Target size={18} /></div>
          <div>
            <span>当前研究目标</span>
            <strong>{path?.goal || "还没有设置学习目标"}</strong>
          </div>
        </div>

        <div className="focus-path">
          <div className="focus-path-head">
            <span><Route size={15} /> 学习路径</span>
            <strong>{percent}%</strong>
          </div>
          <div className="focus-progress-track"><i style={{ width: `${percent}%` }} /></div>
          {pathStages.length ? (
            <div className="focus-stage-list">
              {pathStages.map((stage, si) => {
                const tasks = stage.tasks || [];
                const done = tasks.filter((t) => t.done).length;
                const active = nextTask?.stage?.id === stage.id;
                return (
                  <div className={`focus-stage ${active ? "active" : ""}`} key={stage.id || si}>
                    <div className="focus-stage-title">
                      <span>{si + 1}</span>
                      <strong>{stage.title}</strong>
                      <em>{done}/{tasks.length}</em>
                    </div>
                    <div className="focus-task-list">
                      {tasks.map((t, ti) => (
                        <div className={`focus-task ${t.done ? "done" : ""} ${nextTask?.title === t.title && nextTask?.stage?.id === stage.id ? "next" : ""} status-${t.status || "todo"}`} key={ti}>
                          {t.done ? <CheckCircle2 size={14} /> : <Circle size={14} />}
                          <span>{t.title}</span>
                          {t.progressTarget != null ? <em className="focus-task-evidence">{t.progressCount}/{t.progressTarget}</em> : null}
                          {t.status && t.status !== "todo" && !t.done ? <em className={`focus-task-status status-${t.status}`}>{STATUS_LABELS[t.status]}</em> : null}
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="focus-path-empty">先到「学习路径」设置研究领域和目标，Agent 会帮你规划七阶段学习。</p>
          )}
        </div>
      </aside>

      <section className="agent-focus-main">
        <div className="agent-focus-head">
          <div className="agent-focus-title">
            <span className="agent-avatar"><Bot size={19} /></span>
            <div>
              <strong>Agent 专注学习</strong>
              <em>{configured ? `已启用 · ${config.model}` : "未启用 · 需 API Key"}</em>
            </div>
          </div>
          <div className="agent-focus-actions">
            <IconButton icon={Settings2} label="API 设置" onClick={goSettings} />
            <Button size="sm" icon={BookmarkPlus} onClick={saveDiscussion} disabled={!canSave || saving}>
              {saving ? "保存中…" : "保存记录"}
            </Button>
            <span className="agent-focus-actions-split" aria-hidden="true" />
            <Button size="sm" variant="ghost" icon={Trash2} className="agent-focus-clear" onClick={clearChat} disabled={!messages.length}>
              清空对话
            </Button>
          </div>
        </div>

        {!configured ? (
          <div className="agent-focus-config">
            <div className="config-hero">
              <KeyRound size={22} />
              <div>
                <strong>尚未配置 API</strong>
                <p>请先到设置中填写 OpenAI 兼容的 API Key、接口地址和模型。Key 只保存在本机浏览器。</p>
              </div>
            </div>
            {error ? <p className="agent-error">{error}</p> : null}
            <div className="config-actions">
              <Button icon={Settings2} onClick={goSettings}>前往设置</Button>
            </div>
          </div>
        ) : (
          <>
            <div className="agent-focus-chat" ref={listRef}>
              {!messages.length ? (
                <div className="agent-focus-empty">
                  <Bot size={34} />
                  <h4>今天想研究点什么？</h4>
                  <p>让 Agent 带你走学习路径：一次一个任务、先讲再问、答对才打勾。也可以让它检索文献、拆解论文或搭大纲。</p>
                </div>
              ) : null}
              {messages.map((m, i) => (
                <div className={`agent-msg ${m.role}`} key={i}>
                  {m.role === "agent" && m.toolCalls?.length ? (
                    <div className="agent-tools">
                      {m.toolCalls.map((t, ti) => {
                        const meta = TOOL_LABELS[t.name] || { icon: Sparkles, label: t.name };
                        const Icon = meta.icon;
                        return <span key={ti}><Icon size={12} /> {meta.label}</span>;
                      })}
                    </div>
                  ) : null}
                  <div className="agent-bubble">{m.role === "agent" ? renderMarkdown(m.content) : m.content}</div>
                </div>
              ))}
              {busy ? (
                <div className="agent-msg agent">
                  <div className="agent-tools"><span><Loader2 size={12} className="spin" /> Agent 正在思考并调用工具...</span></div>
                  <div className="agent-bubble typing"><i /><i /><i /></div>
                </div>
              ) : null}
            </div>

            {savedNote ? <div className={`agent-saved-note ${savedNote.startsWith("保存失败") ? "error" : ""}`}>{savedNote}</div> : null}

            <div className="agent-focus-input">
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  send();
                }}
              >
                <input
                  ref={inputRef}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  placeholder="和 Agent 讨论你的研究方向，或直接说「继续学习」..."
                  disabled={busy}
                />
                <button type="submit" disabled={busy || !input.trim()} aria-label="发送">
                  {busy ? <Loader2 size={17} className="spin" /> : <Send size={17} />}
                </button>
              </form>
            </div>
          </>
        )}
      </section>

      <aside className="agent-focus-rail">
        {pathStages.length ? (
          <div className="focus-continue">
            <span className="learn-icon"><Target size={16} /></span>
            <div className="learn-copy">
              <strong>{nextTask ? "继续学习" : "路径已完成"}</strong>
              <span>{nextTask ? `${nextTask.stage.title} · ${nextTask.title}` : "让 Agent 帮你总结收获"}</span>
            </div>
            <Button size="sm" icon={Play} onClick={() => send(learnPrompt)} disabled={busy}>{nextTask ? "开始互动" : "总结收获"}</Button>
          </div>
        ) : null}

        {recentLog ? (
          <div className="focus-tools">
            <div className="focus-tools-head"><BookOpen size={14} /> 上次学习进展</div>
            <p className="focus-tools-note">{recentLog.summary}</p>
            {recentLog.blocker ? <p className="focus-tools-note session-blocker">卡点：{recentLog.blocker}</p> : null}
            {recentLog.next ? <p className="focus-tools-note session-next"><strong>下次：</strong>{recentLog.next}</p> : null}
            <em className="session-date">{recentLog.date}</em>
          </div>
        ) : null}

        <div className="focus-tools">
          <div className="focus-tools-head"><Sparkles size={14} /> 快捷指令</div>
          <div className="focus-tool-list">
            {QUICK_ACTIONS.map((a) => (
              <button key={a.label} onClick={() => send(a.prompt)}>
                <ArrowRight size={13} />
                {a.label}
              </button>
            ))}
          </div>
        </div>

        <div className="focus-tools">
          <div className="focus-tools-head"><MessageSquarePlus size={14} /> 交互方式</div>
          <p className="focus-tools-note">侧边栏原来的 Agent 抽屉保留为右下角「快速提问」，随时提问不会打断当前页面。</p>
          <Button variant="ghost" size="sm" icon={MessageSquarePlus} onClick={onOpenQuick}>打开快速提问</Button>
        </div>
      </aside>
    </div>
  );
}
