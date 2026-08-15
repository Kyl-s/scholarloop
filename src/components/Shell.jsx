import { useState } from "react";
import {
  LayoutDashboard,
  Search,
  Library,
  Route,
  PenLine,
  Settings,
  Menu,
  X,
  BookOpenCheck,
  Bot,
  Brain,
  Bookmark
} from "lucide-react";
import { useData } from "../store.jsx";
import AgentDrawer from "./AgentDrawer.jsx";
import { loadAgentConfig } from "../agentConfig.js";

const NAV = [
  { id: "dashboard", label: "总览", icon: LayoutDashboard },
  { id: "search", label: "论文搜索", icon: Search },
  { id: "library", label: "文献库", icon: Library },
  { id: "memory", label: "我的记忆", icon: Bookmark },
  { id: "path", label: "学习路径", icon: Route },
  { id: "journals", label: "思考记录", icon: Brain },
  { id: "writer", label: "论文写作", icon: PenLine },
  { id: "agent", label: "Agent 专注", icon: Bot },
  { id: "settings", label: "设置", icon: Settings }
];

export default function Shell({ view, onNavigate, onSearch, children, quickAgentOpen, onQuickAgentChange }) {
  const { stats, path, library, memories } = useData();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [quick, setQuick] = useState("");
  const current = NAV.find((n) => n.id === view.page) || NAV[0];

  const submitQuick = (e) => {
    e.preventDefault();
    if (quick.trim()) {
      onSearch(quick.trim());
      setQuick("");
      setMobileOpen(false);
    }
  };

  const nav = (
    <>
      <div className="brand">
        <div className="brand-mark"><img src="/app-icon-loop.png" alt="" className="brand-logo" /></div>
        <div className="brand-text">
          <strong>ScholarLoop</strong>
          <span>Research Loop</span>
        </div>
      </div>
      <nav className="nav-list">
        {NAV.map((item) => {
          const Icon = item.icon;
          return (
            <button
              key={item.id}
              className={`nav-item ${view.page === item.id ? "active" : ""}`}
              onClick={() => {
                onNavigate({ page: item.id });
                setMobileOpen(false);
                onQuickAgentChange?.(false);
              }}
            >
              <Icon size={18} strokeWidth={2} />
              <span>{item.label}</span>
              {item.id === "library" && library.length > 0 ? <em>{library.length}</em> : null}
              {item.id === "memory" && memories?.filter((memory) => memory.enabled).length > 0 ? <em>{memories.filter((memory) => memory.enabled).length}</em> : null}
              {item.id === "agent" && !loadAgentConfig()?.apiKey ? <em className="agent-dot">新</em> : null}
            </button>
          );
        })}
      </nav>
      <div className="sidebar-foot">
        <div className="foot-progress">
          <span>科研成长</span>
          <strong>{stats?.pathProgress?.percent ?? 0}%</strong>
        </div>
        <div className="foot-track">
          <i style={{ width: `${stats?.pathProgress?.percent ?? 0}%` }} />
        </div>
        <p>
          <BookOpenCheck size={14} />
          {path?.goal ? "当前学习目标已生成" : "先设置你的学习目标"}
        </p>
      </div>
    </>
  );

  return (
    <div className="app-shell">
      <aside className={`sidebar ${mobileOpen ? "open" : ""}`}>{nav}</aside>
      {mobileOpen ? <div className="sidebar-scrim" onClick={() => setMobileOpen(false)} /> : null}
      <AgentDrawer open={quickAgentOpen} onClose={() => onQuickAgentChange?.(false)} onNavigate={onNavigate} />
      <button className="agent-fab" onClick={() => onQuickAgentChange?.(true)} aria-label="快速提问 Agent" title="快速提问 Agent">
        <Bot size={19} />
        <span>快速提问</span>
      </button>
      <div className="main">
        <header className="topbar">
          <button className="hamburger" onClick={() => setMobileOpen(true)} aria-label="打开导航">
            <Menu size={20} />
          </button>
          <div className="topbar-title">
            <h1>{current.label}</h1>
            <span>{view.subtitle || "从零基础到科研高手"}</span>
          </div>
          <form className="quick-search" onSubmit={submitQuick}>
            <Search size={16} />
            <input value={quick} onChange={(e) => setQuick(e.target.value)} placeholder="搜索论文、关键词或领域..." />
            <button type="submit">搜索</button>
          </form>
          <button className="icon-btn close-mobile" onClick={() => setMobileOpen(false)} aria-label="关闭导航">
            <X size={18} />
          </button>
        </header>
        <main className="content">{children}</main>
      </div>
    </div>
  );
}
