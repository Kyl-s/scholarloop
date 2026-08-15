import { useEffect, useMemo, useRef, useState } from "react";
import { Brain, Trash2, ChevronDown, MessageSquareText, Sparkles, ArrowLeft, ListChecks, Check, Lightbulb, Target, Download, Maximize2, ZoomIn, ZoomOut, RotateCcw, X } from "lucide-react";
import { useData } from "../store.jsx";
import { Badge, Button, EmptyState, SectionHead } from "../components/ui.jsx";
import { renderMarkdown } from "../components/markdown.jsx";

const MM_COLORS = ["#2456e6", "#4b7bec", "#18a187", "#e2a13b"];
const MM_FILLS = ["#eef3ff", "#f2f6ff", "#e9f8f2", "#fdf5e7"];

function clip(text, max = 80) {
  const t = String(text || "").trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

function layoutMindMap(root) {
  const W = 178;
  const H = 60;
  const nodes = [];
  let leafY = 40;
  const GAP_X = 250;
  const GAP_Y = 76;

  function walk(node, depth, parentId) {
    const children = node.children || [];
    const x = 70 + depth * GAP_X;
    let y;
    if (!children.length) {
      y = leafY;
      leafY += GAP_Y;
    } else {
      const childIds = children.map((c) => walk(c, depth + 1, null));
      const ys = childIds.map((id) => nodes.find((n) => n.id === id).y);
      y = (Math.min(...ys) + Math.max(...ys)) / 2;
    }
    const id = nodes.length;
    nodes.push({ id, parentId, label: node.label || "", note: node.note || "", x, y, depth });
    return id;
  }

  walk(root, 0, null);
  const minX = Math.min(...nodes.map((n) => n.x - W / 2));
  const minY = Math.min(...nodes.map((n) => n.y - H / 2));
  const maxX = Math.max(...nodes.map((n) => n.x + W / 2));
  const maxY = Math.max(...nodes.map((n) => n.y + H / 2));
  const pad = 24;
  return {
    nodes,
    viewBox: [minX - pad, minY - pad, maxX - minX + pad * 2, maxY - minY + pad * 2]
  };
}

function MindMapSvg({ root }) {
  const { nodes, viewBox } = useMemo(() => layoutMindMap(root || { label: "无内容", children: [] }), [root]);
  const W = 178;
  const H = 60;

  return (
    <svg className="mindmap-svg" viewBox={viewBox.join(" ")} role="img" aria-label="思维导图">
      {nodes.map((n) => {
        if (n.parentId === null) return null;
        const p = nodes[n.parentId];
        const x1 = p.x + W / 2;
        const y1 = p.y;
        const x2 = n.x - W / 2;
        const y2 = n.y;
        return (
          <path
            key={`line-${n.id}`}
            d={`M ${x1} ${y1} C ${x1 + 90} ${y1}, ${x2 - 90} ${y2}, ${x2} ${y2}`}
            fill="none"
            stroke="#b9c9f7"
            strokeWidth={2}
          />
        );
      })}
      {nodes.map((n) => {
        const color = MM_COLORS[Math.min(n.depth, MM_COLORS.length - 1)];
        const fill = MM_FILLS[Math.min(n.depth, MM_FILLS.length - 1)];
        return (
          <g key={`node-${n.id}`}>
            <rect x={n.x - W / 2} y={n.y - H / 2} width={W} height={H} rx={16} fill={fill} stroke={color} strokeWidth={1.5} />
            <foreignObject x={n.x - W / 2 + 9} y={n.y - H / 2 + 6} width={W - 18} height={H - 12}>
              <div className={`mm-node-box depth-${n.depth}`}>
                <strong>{n.label}</strong>
                {n.note ? <span>{n.note}</span> : null}
              </div>
            </foreignObject>
          </g>
        );
      })}
    </svg>
  );
}

function MindMapModal({ root, onClose }) {
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const dragRef = useRef(null);
  const bodyRef = useRef(null);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") onClose();
      if (e.key === "+" || e.key === "=") setZoom((z) => Math.min(3, z + 0.25));
      if (e.key === "-") setZoom((z) => Math.max(0.5, z - 0.25));
      if (e.key === "0") {
        setZoom(1);
        setPan({ x: 0, y: 0 });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const onWheel = (e) => {
      e.preventDefault();
      setZoom((z) => Math.min(3, Math.max(0.5, z - e.deltaY * 0.0015)));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const startDrag = (e) => {
    dragRef.current = { startX: e.clientX - pan.x, startY: e.clientY - pan.y };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };

  const onDrag = (e) => {
    if (!dragRef.current) return;
    setPan({ x: e.clientX - dragRef.current.startX, y: e.clientY - dragRef.current.startY });
  };

  const endDrag = () => {
    dragRef.current = null;
  };

  const resetView = () => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  };

  return (
    <div className="mindmap-modal" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="mindmap-modal-panel">
        <div className="mindmap-modal-head">
          <div>
            <strong>思维导图</strong>
            <span>按住鼠标拖动查看，滚轮缩放，按 0 重置</span>
          </div>
          <div className="mindmap-zoom-controls">
            <button title="缩小" onClick={() => setZoom((z) => Math.max(0.5, z - 0.25))}><ZoomOut size={16} /></button>
            <span>{Math.round(zoom * 100)}%</span>
            <button title="放大" onClick={() => setZoom((z) => Math.min(3, z + 0.25))}><ZoomIn size={16} /></button>
            <button title="重置视图" onClick={resetView}><RotateCcw size={16} /></button>
            <button title="关闭" onClick={onClose}><X size={16} /></button>
          </div>
        </div>
        <div className="mindmap-modal-body" ref={bodyRef}>
          <div
            className="mindmap-zoom-wrap"
            style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}
            onPointerDown={startDrag}
            onPointerMove={onDrag}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
          >
            <MindMapSvg root={root} />
          </div>
        </div>
      </div>
    </div>
  );
}

function deriveCorrections(messages) {
  const hits = [];
  for (const m of messages || []) {
    if (m.role !== "agent") continue;
    for (const line of String(m.content || "").split("\n")) {
      const clean = line.trim().replace(/^[-*•\d.、\s]+/, "");
      if (/纠正|误区|注意|错误|不要|应该|关键|重点|建议|下一步|补充|本质|区别/.test(clean)) {
        hits.push(clip(clean, 80));
      }
    }
  }
  return [...new Set(hits)].slice(0, 6);
}

function deriveTakeaways(messages) {
  const userMsgs = (messages || []).filter((m) => m.role === "user").map((m) => m.content);
  const hits = userMsgs.slice(1).map((u) => clip(u, 80));
  return [...new Set(hits)].slice(0, 6);
}

function formatDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return isNaN(d) ? iso : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function safeFileName(text) {
  return String(text || "思考记录").replace(/[\\/:*?"<>|]/g, "").slice(0, 40) || "思考记录";
}

function downloadText(filename, text, type = "text/plain;charset=utf-8") {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function exportJournalMarkdown(journal) {
  const messages = (journal.messages || []).map((m) => `**${m.role === "user" ? "我" : "Agent"}**：${m.content}`).join("\n\n");
  const lines = [
    `# 思考手记：${journal.title}`,
    "",
    `- 时间：${formatDate(journal.createdAt)}`,
    `- 交流轮数：${journal.turnCount || 0}`,
    "",
    "## 核心理解",
    journal.core || "",
    "",
    "## 精炼要点",
    ...(journal.takeaways || []).map((t) => `- ${t}`),
    "",
    "## 关键纠正",
    ...(journal.corrections || []).map((c) => `- ${c}`),
    "",
    "## 下一步",
    ...(journal.nextSteps || []).map((s) => `- ${s}`),
    "",
    "## 完整手记",
    journal.summary || "",
    "",
    "## 对话原文",
    messages
  ];
  downloadText(`${safeFileName(journal.title)}.md`, lines.join("\n"), "text/markdown;charset=utf-8");
}

function exportMindmapSvg(title) {
  const svg = document.querySelector(".mindmap-svg");
  if (!svg) return;
  const xml = new XMLSerializer().serializeToString(svg);
  downloadText(`${safeFileName(title)}-思维导图.svg`, xml, "image/svg+xml;charset=utf-8");
}

export default function JournalsPage() {
  const { journals, deleteJournal } = useData();
  const [openId, setOpenId] = useState(null);
  const [mindOpen, setMindOpen] = useState(false);
  const open = journals.find((j) => j.id === openId) || null;

  useEffect(() => {
    setMindOpen(false);
  }, [openId]);

  const remove = async (id) => {
    if (!window.confirm("确定删除这份思考记录吗？删除后无法恢复。")) return;
    await deleteJournal(id);
    if (id === openId) setOpenId(null);
  };

  const core = open?.core || `围绕「${open?.title || "本次讨论"}」，我用自己的话表达理解，并通过追问修正了关键概念。`;
  const takeaways = open?.takeaways?.length ? open.takeaways : deriveTakeaways(open?.messages);
  const corrections = open?.corrections?.length ? open.corrections : deriveCorrections(open?.messages);
  const nextSteps = open?.nextSteps?.length
    ? open.nextSteps
    : ["把关键点用自己的话再讲一遍", "回到学习路径完成下一个任务", "三天后回看这份手记"];

  return (
    <div className="page journals-page">
      <section className="journal-hero">
        <div className="journal-hero-copy">
          <Badge tone="ok">思考留痕</Badge>
          <h2>思考记录</h2>
          <p>每一次讨论都会被提炼成核心手记：你的理解、AI 的纠正、可执行的下一步，以及一张真正浓缩过的思维导图。</p>
        </div>
        <div className="journal-hero-icon"><Brain size={30} /></div>
      </section>

      {open ? (
        <section className="journal-detail panel">
          <div className="journal-detail-head">
            <div>
              <h3>{open.title}</h3>
              <span>{formatDate(open.createdAt)} · {open.turnCount || 0} 轮交流 · {open.messages?.length || 0} 条消息</span>
            </div>
            <div className="journal-detail-actions">
              <Button variant="ghost" size="sm" icon={ArrowLeft} onClick={() => setOpenId(null)}>返回列表</Button>
              <Button variant="ghost" size="sm" icon={Download} onClick={() => exportJournalMarkdown(open)}>导出 .md</Button>
              <Button variant="ghost" size="sm" icon={Download} onClick={() => exportMindmapSvg(open.title)}>导出导图</Button>
              <Button variant="ghost" size="sm" icon={Trash2} onClick={() => remove(open.id)}>删除</Button>
            </div>
          </div>

          <div className="journal-body">
            <section className="journal-core-block">
              <div className="journal-section-head"><Sparkles size={16} /> 核心理解</div>
              <p>{core}</p>
            </section>

            <section className="journal-section">
              <div className="journal-section-head"><ListChecks size={16} /> 精炼要点</div>
              <ul className="journal-takeaways">
                {takeaways.length ? takeaways.map((t, i) => <li key={i}><Check size={14} />{t}</li>) : <li><Check size={14} />用自己的话复述核心结论</li>}
              </ul>
            </section>

            <section className="journal-section">
              <div className="journal-section-head"><Lightbulb size={16} /> 关键纠正</div>
              <div className="journal-chips">
                {corrections.length ? corrections.map((c, i) => <span className="journal-chip" key={i}>{c}</span>) : <p className="journal-empty-text">本次对话没有明显的纠错点，继续保持追问。</p>}
              </div>
            </section>

            <section className="journal-section">
              <div className="journal-section-head"><Target size={16} /> 下一步</div>
              <ul className="journal-next">
                {nextSteps.map((s, i) => <li key={i}><Check size={14} />{s}</li>)}
              </ul>
            </section>

            <section className="journal-section">
              <div className="journal-section-head journal-section-head-action">
                <Brain size={16} /> 思维导图
                <Button variant="ghost" size="sm" icon={Maximize2} onClick={() => setMindOpen(true)}>放大查看</Button>
              </div>
              <div className="mind-map">
                {open.mindmap ? <MindMapSvg root={open.mindmap} /> : <p className="journal-empty-text">暂无思维导图</p>}
              </div>
            </section>

            <details className="journal-fullnote">
              <summary>查看完整手记</summary>
              <div className="journal-markdown">{renderMarkdown(open.summary || "")}</div>
            </details>

            <div className="journal-chat">
              <div className="journal-chat-head"><MessageSquareText size={15} /> 对话原文</div>
              <div className="journal-chat-list">
                {(open.messages || []).map((m, i) => (
                  <div className={`journal-msg ${m.role}`} key={i}>
                    <strong>{m.role === "user" ? "我" : "Agent"}</strong>
                    <p>{m.content}</p>
                  </div>
                ))}
              </div>
            </div>

            {mindOpen && open?.mindmap ? <MindMapModal root={open.mindmap} onClose={() => setMindOpen(false)} /> : null}
          </div>
        </section>
      ) : (
        <>
          <section className="panel journal-list-panel">
            <SectionHead
              title="已保存的思考"
              desc={`共 ${journals.length} 份，每一份都是被提炼过的理解历程`}
              action={<Badge tone="neutral"><ListChecks size={13} /> {journals.length} 份</Badge>}
            />
            {journals.length ? (
              <div className="journal-list">
                {journals.map((j) => (
                  <button className="journal-card" key={j.id} onClick={() => setOpenId(j.id)}>
                    <div className="journal-card-main">
                      <strong>{j.title}</strong>
                      <span>{j.turnCount || 0} 轮交流 · {formatDate(j.createdAt)}</span>
                    </div>
                    <ChevronDown size={16} />
                  </button>
                ))}
              </div>
            ) : (
              <EmptyState
                icon={Sparkles}
                title="还没有思考记录"
                desc="打开 Agent 讨论后，点“保存思考记录”才会写入。关闭抽屉或切到设置不会自动保存。"
              />
            )}
          </section>
        </>
      )}
    </div>
  );
}
