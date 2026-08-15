import { useEffect, useRef, useState } from "react";
import { Bot, X, Send, KeyRound, Trash2, Settings2, Sparkles, Search, Route, BookOpen, Loader2, Target, Play, BookmarkPlus } from "lucide-react";
import { api } from "../api.js";
import { Button, IconButton } from "./ui.jsx";
import { useData } from "../store.jsx";
import { renderMarkdown } from "./markdown.jsx";
import { useAgentConfig } from "../agentConfig.js";
import { clearJournalLink, persistAgentJournal } from "../agentJournal.js";

const CHAT_KEY = "scholarloop.agent.chat";

const QUICK_ACTIONS = [
  { label: "制定学习计划", prompt: "帮我制定一个 3 个月掌握大语言模型的完整学习计划" },
  { label: "检索最新文献", prompt: "帮我检索 2024 年以后关于大语言模型推理优化的最新论文" },
  { label: "解释领域概念", prompt: "用适合小白的语言解释什么是注意力机制，并推荐入门论文" },
  { label: "帮我写论文", prompt: "我要写一篇关于大语言模型推理效率的综述，帮我搭建论文大纲" }
];

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

const TOOL_LABELS = {
  search_papers: { icon: Search, label: "检索论文" },
  plan_study: { icon: Route, label: "生成学习计划" },
  analyze_paper: { icon: BookOpen, label: "拆解论文" },
  get_library: { icon: Sparkles, label: "查看文献库" }
};

export default function AgentDrawer({ open, onClose, onNavigate }) {
  const { path, refresh, saveJournal } = useData();
  const config = useAgentConfig();
  const [messages, setMessages] = useState(() => (loadJSON(CHAT_KEY, []) || []).map(sanitizeMessage));
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [savedNote, setSavedNote] = useState("");
  const [saving, setSaving] = useState(false);
  const listRef = useRef(null);

  const pathStages = path?.stages || [];
  const nextTask = pathStages.flatMap((s) => (s.tasks || []).map((t) => ({ ...t, stage: s }))).find((t) => !t.done && t.status !== "skipped");
  const recentLog = Array.isArray(path?.progressLog) ? path.progressLog[0] || null : null;
  const learnPrompt = nextTask
    ? `继续学习我的学习路径。当前阶段「${nextTask.stage.title}」，当前任务：「${nextTask.title}」。上次学习进展：${recentLog?.summary || "无"}；上次卡点：${recentLog?.blocker || "无"}；上次说的下一步：${recentLog?.next || "无"}。请先调用 get_path 确认进度，然后引导我完成这个任务：一次只问一个问题，检查我的理解；我回答后判断是否正确，错了就纠正并让我重新回答；确认达标后再调用 complete_task 标记完成，并告诉我下一步任务。`
    : `我的学习路径已经全部完成，请调用 get_path 确认后，帮我总结这七阶段的收获，并给出下一步研究建议。`;

  const canSave = messages.some((m) => m.role === "agent" && typeof m.content === "string" && m.content.trim() && !m.content.startsWith("出错了"));

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

  const goSettings = () => {
    onNavigate?.({ page: "settings" });
    onClose?.();
  };

  useEffect(() => {
    if (open) {
      setMessages((loadJSON(CHAT_KEY, []) || []).map(sanitizeMessage));
      setError("");
    }
  }, [open]);

  useEffect(() => {
    localStorage.setItem(CHAT_KEY, JSON.stringify(messages));
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

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

  const configured = Boolean(config?.apiKey);

  return (
    <aside className={`agent-drawer ${open ? "open" : ""}`} aria-hidden={!open}>
      <div className="agent-head">
        <div className="agent-title">
          <span className="agent-avatar"><Bot size={18} /></span>
          <div>
            <strong>Agent 助手</strong>
            <em>{configured ? `已启用 · ${config.model}` : "未启用 · 需 API Key"}</em>
          </div>
        </div>
        <div className="agent-head-actions">
          <IconButton icon={Settings2} label="API 设置" onClick={goSettings} />
          <IconButton icon={BookmarkPlus} label="保存思考记录" onClick={saveDiscussion} disabled={!canSave || saving} />
          <IconButton icon={Trash2} label="清空对话" onClick={clearChat} />
          <IconButton icon={X} label="关闭" onClick={onClose} />
        </div>
      </div>

      {!configured ? (
        <div className="agent-config">
          <div className="config-hero">
            <KeyRound size={22} />
            <div>
              <strong>尚未配置 API</strong>
              <p>请先到设置中填写 OpenAI 兼容的 API Key、接口地址和模型，即可解锁计划制定、文献检索与领域讨论。</p>
            </div>
          </div>
          {error ? <p className="agent-error">{error}</p> : null}
          <div className="config-actions">
            <Button icon={Settings2} onClick={goSettings}>前往设置</Button>
          </div>
        </div>
      ) : (
        <>
          <div className="agent-messages" ref={listRef}>
            {!messages.length ? (
              <div className="agent-empty">
                <Bot size={30} />
                <h4>今天想研究点什么？</h4>
                <p>可以让 Agent 制定学习计划、检索特定文献、拆解论文，或和你讨论任意科研主题。</p>
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

          {pathStages.length ? (
            <div className="agent-learn">
              <span className="learn-icon"><Target size={16} /></span>
              <div className="learn-copy">
                <strong>{nextTask ? "继续学习" : "路径已完成"}</strong>
                <span>{nextTask ? `${nextTask.stage.title} · ${nextTask.title}` : "七阶段全部完成，让 Agent 帮你总结"}</span>
              </div>
              <Button size="sm" icon={Play} onClick={() => send(learnPrompt)} disabled={busy}>{nextTask ? "开始互动" : "总结收获"}</Button>
            </div>
          ) : null}

          <div className="agent-quick">
            {QUICK_ACTIONS.map((a) => (
              <button key={a.label} onClick={() => send(a.prompt)}>{a.label}</button>
            ))}
          </div>

          <form
            className="agent-input"
            onSubmit={(e) => {
              e.preventDefault();
              send();
            }}
          >
            <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="和 Agent 讨论你的研究方向..." disabled={busy} />
            <button type="submit" disabled={busy || !input.trim()} aria-label="发送">
              {busy ? <Loader2 size={16} className="spin" /> : <Send size={16} />}
            </button>
          </form>
        </>
      )}
    </aside>
  );
}
