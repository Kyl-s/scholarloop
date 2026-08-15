import { useEffect, useState } from "react";
import { GraduationCap, Target, Check, ChevronDown, RotateCcw, Sparkles, BookOpen, ListChecks, ArrowRight, Plus, SkipForward, Scissors, Clock3 } from "lucide-react";
import { useData } from "../store.jsx";
import { Badge, Button, EmptyState, Field, ProgressBar, ProgressRing, SectionHead, TextArea } from "../components/ui.jsx";
import { api } from "../api.js";

const STATUS_LABELS = { todo: "未开始", inprogress: "进行中", review: "待回顾", done: "已完成", skipped: "已跳过" };

const LEVELS = [
  { value: "beginner", label: "完全小白", desc: "还没系统学过该领域" },
  { value: "foundation", label: "有基础", desc: "掌握基础概念，想深入" },
  { value: "intermediate", label: "进阶者", desc: "能读论文，准备做研究" }
];

export default function PathPage({ onNavigate }) {
  const { path, library, generatePath, updatePath, refresh } = useData();
  const [field, setField] = useState("");
  const [goal, setGoal] = useState("");
  const [level, setLevel] = useState("beginner");
  const [openStage, setOpenStage] = useState(null);
  const [busy, setBusy] = useState(false);
  const [hoursDraft, setHoursDraft] = useState(() => String(path?.weeklyHours || 5));
  const [addTask, setAddTask] = useState({ stageId: "", title: "" });
  const [split, setSplit] = useState(null);

  useEffect(() => {
    setHoursDraft(String(path?.weeklyHours || 5));
  }, [path?.weeklyHours]);

  const submit = async () => {
    if (!field.trim()) return;
    setBusy(true);
    try {
      await generatePath({ field, goal, level });
    } finally {
      setBusy(false);
    }
  };

  const toggleTask = async (stageId, taskIndex) => {
    const stages = path.stages.map((s) => {
      if (s.id !== stageId) return s;
      const tasks = s.tasks.map((t, i) => (i === taskIndex ? { ...t, done: !t.done, status: !t.done ? "done" : "todo" } : t));
      return { ...s, tasks };
    });
    await updatePath({ stages });
  };

  const saveHours = async () => {
    const n = Math.max(1, Math.min(40, Number(hoursDraft) || 5));
    setHoursDraft(String(n));
    await updatePath({ weeklyHours: n });
  };

  const addCustomTask = async (stageId) => {
    const title = addTask.title.trim();
    if (!title) return;
    await api.post("/api/path/tasks", { stageId, title });
    setAddTask({ stageId: "", title: "" });
    refresh();
  };

  const updateTaskStatus = async (stageId, index, status) => {
    await api.put("/api/path/tasks", { stageId, index, status });
    refresh();
  };

  const confirmSplit = async () => {
    if (!split) return;
    const titles = split.titles.split("\n").map((t) => t.trim()).filter(Boolean);
    if (!titles.length) return;
    await api.put("/api/path/tasks", { stageId: split.stageId, index: split.index, splitTitles: titles });
    setSplit(null);
    refresh();
  };

  if (!path?.stages?.length) {
    return (
      <div className="page path-setup-page">
        <section className="setup-panel">
          <div className="setup-icon"><GraduationCap size={28} /></div>
          <h2>生成你的科研学习路径</h2>
          <p>告诉我你想进入的领域和目标，应用会生成从零基础到完成论文的七阶段路线：领域地图、基础学习、文献检索、方法理解、复现实验、综述写作、打磨发表。</p>
          <div className="setup-form">
            <Field label="研究领域">
              <input className="input" value={field} onChange={(e) => setField(e.target.value)} placeholder="例如：大语言模型、计算机视觉、材料科学、临床医学" />
            </Field>
            <Field label="学习目标">
              <TextArea rows={3} value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="例如：6 个月内能独立读懂该领域论文，并完成一篇可投稿的综述" />
            </Field>
            <div className="level-picker">
              <span className="field-label">当前水平</span>
              <div className="level-options">
                {LEVELS.map((l) => (
                  <button key={l.value} className={level === l.value ? "on" : ""} onClick={() => setLevel(l.value)}>
                    <strong>{l.label}</strong>
                    <span>{l.desc}</span>
                  </button>
                ))}
              </div>
            </div>
            <Button size="lg" icon={Sparkles} onClick={submit} disabled={busy || !field.trim()}>{busy ? "生成中..." : "生成学习路径"}</Button>
          </div>
        </section>
      </div>
    );
  }

  const tasks = path.stages.flatMap((s) => s.tasks || []);
  const done = tasks.filter((t) => t.done).length;
  const pct = tasks.length ? Math.round((done / tasks.length) * 100) : 0;
  const next = path.stages.flatMap((s) => (s.tasks || []).map((t) => ({ ...t, stage: s }))).find((t) => !t.done && t.status !== "skipped");
  const dueCount = (library || []).filter((p) => p.reviewDue && p.reviewDue <= new Date().toISOString().slice(0, 10)).length;

  return (
    <div className="page path-page">
      <section className="path-hero">
        <div className="path-hero-copy">
          <Badge tone="ok">学习路径已生成</Badge>
          <h2>{path.field}</h2>
          <p>{path.goal}</p>
          <div className="path-actions">
            <Button variant="ghost" size="sm" icon={RotateCcw} onClick={() => updatePath({ stages: [] })}>重新规划</Button>
            <Button variant="ghost" size="sm" onClick={() => onNavigate({ page: "search" })}>去检索论文 <ArrowRight size={14} /></Button>
          </div>
        </div>
        <div className="path-ring">
          <ProgressRing value={pct} size={104} label={`${pct}%`} sublabel={`${done}/${tasks.length} 任务`} />
        </div>
      </section>

      <div className="path-layout">
        <section className="panel stage-panel">
          <SectionHead title="阶段任务" desc="按顺序完成；有真实产出的任务（文献、笔记、草稿）会自动推进进度" />
          <div className="stage-list">
            {path.stages.map((stage, si) => {
              const stageDone = stage.tasks.every((t) => t.done);
              const stagePct = stage.tasks.filter((t) => t.done).length / stage.tasks.length;
              const open = openStage === stage.id;
              return (
                <div className={`stage ${stageDone ? "done" : ""} ${open ? "open" : ""}`} key={stage.id}>
                  <button className="stage-head" onClick={() => setOpenStage(open ? null : stage.id)}>
                    <span className="stage-num">{si + 1}</span>
                    <div className="stage-title">
                      <strong>{stage.title}</strong>
                      <span>{stage.subtitle}</span>
                    </div>
                    <ProgressBar value={stage.tasks.filter((t) => t.done).length} max={stage.tasks.length} className="stage-bar" />
                    <ChevronDown size={16} className="stage-chevron" />
                  </button>
                  {open ? (
                    <div className="stage-body">
                      <p className="stage-desc">{stage.description}</p>
                      <div className="task-list">
                        {stage.tasks.map((task, ti) => (
                          <div key={ti}>
                            {task.progressTarget != null ? (
                              <div className={`task-item task-evidence-item ${task.done ? "done" : ""} status-${task.status || "todo"}`}>
                                <span className={`fake-check ${task.done ? "on" : ""}`}>{task.done ? <Check size={12} /> : null}</span>
                                <div className="task-evidence-main">
                                  <div className="task-title-row">
                                    <span>{task.title}</span>
                                    {task.status && task.status !== "todo" && !task.done ? <em className={`task-status status-${task.status}`}>{STATUS_LABELS[task.status]}</em> : null}
                                  </div>
                                  <div className="task-evidence-row">
                                    <span className="task-evidence-label">由真实产出自动推进</span>
                                    <em>{task.progressCount}/{task.progressTarget}</em>
                                  </div>
                                  <div className="task-evidence-bar"><i style={{ width: `${Math.round(task.progress * 100)}%` }} /></div>
                                  {task.status !== "skipped" ? (
                                    <div className="task-actions">
                                      <button onClick={() => updateTaskStatus(stage.id, ti, "skipped")}><SkipForward size={12} /> 跳过</button>
                                    </div>
                                  ) : null}
                                </div>
                              </div>
                            ) : (
                              <div className={`task-item ${task.done ? "done" : ""} status-${task.status || "todo"}`}>
                                <label className="task-check">
                                  <input type="checkbox" checked={task.done} onChange={() => toggleTask(stage.id, ti)} />
                                  <span className="fake-check"><Check size={12} /></span>
                                </label>
                                <div className="task-main">
                                  <div className="task-title-row">
                                    <span>{task.title}</span>
                                    {task.status && task.status !== "todo" && !task.done ? <em className={`task-status status-${task.status}`}>{STATUS_LABELS[task.status]}</em> : null}
                                  </div>
                                  {task.status !== "skipped" ? (
                                    <div className="task-actions">
                                      <button onClick={() => updateTaskStatus(stage.id, ti, task.status === "inprogress" ? "todo" : "inprogress")}>进行中</button>
                                      <button onClick={() => updateTaskStatus(stage.id, ti, "review")}>待回顾</button>
                                      <button onClick={() => updateTaskStatus(stage.id, ti, "skipped")}><SkipForward size={12} /> 跳过</button>
                                      <button onClick={() => setSplit({ stageId: stage.id, index: ti, titles: "" })}><Scissors size={12} /> 拆分</button>
                                    </div>
                                  ) : null}
                                </div>
                              </div>
                            )}
                            {split && split.stageId === stage.id && split.index === ti ? (
                              <div className="task-split-editor">
                                <textarea rows={3} value={split.titles} onChange={(e) => setSplit({ ...split, titles: e.target.value })} placeholder="每行一个子任务" />
                                <div>
                                  <Button size="sm" onClick={confirmSplit}>确认拆分</Button>
                                  <Button variant="ghost" size="sm" onClick={() => setSplit(null)}>取消</Button>
                                </div>
                              </div>
                            ) : null}
                          </div>
                        ))}
                      </div>
                      <div className="stage-add-task">
                        <input
                          value={addTask.stageId === stage.id ? addTask.title : ""}
                          onChange={(e) => setAddTask({ stageId: stage.id, title: e.target.value })}
                          placeholder="添加自定义任务，例如：读某某论文并复述"
                        />
                        <button onClick={() => addCustomTask(stage.id)} disabled={!addTask.title.trim()}><Plus size={14} /> 添加</button>
                      </div>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </section>

        <aside className="path-side">
          <section className="panel next-panel">
            <div className="next-head"><ListChecks size={16} /> 下一步任务</div>
            {next ? (
              <>
                <Badge tone="section">{next.stage.title}</Badge>
                <p>{next.title}</p>
                <Button size="sm" onClick={() => setOpenStage(next.stage.id)}>定位到该阶段</Button>
                <p className="path-agent-hint">也可以打开右侧 Agent 助手，让它带你完成并自动勾选。</p>
              </>
            ) : (
              <EmptyState icon={Sparkles} title="全部完成" desc="恭喜，你已经走完整个学习路径，接下来去写论文吧。" />
            )}
          </section>
          {path.progressLog?.[0] ? (
            <section className="panel session-panel">
              <div className="next-head"><Clock3 size={16} /> 上次学习进展</div>
              <p>{path.progressLog[0].summary}</p>
              {path.progressLog[0].blocker ? <p className="session-blocker">卡点：{path.progressLog[0].blocker}</p> : null}
              {path.progressLog[0].next ? <p className="session-next"><strong>下次：</strong>{path.progressLog[0].next}</p> : null}
              <em className="session-date">{path.progressLog[0].date}</em>
            </section>
          ) : null}
          <section className="panel resource-panel">
            <div className="next-head"><BookOpen size={16} /> 配套方法</div>
            <ul>
              <li>用聚合搜索时，先搜综述，再按被引和年份追前沿。</li>
              <li>读每篇论文都回答“五问”，答案写进笔记。</li>
              <li>理解等级达到 4 级后，用写作页做一次复述输出。</li>
              <li>复习日到了先花 5 分钟回忆，再打开原文核对。</li>
            </ul>
          </section>
          <section className="panel milestone-panel">
            <div className="next-head"><Target size={16} /> 学习节奏</div>
            <label className="hours-field">
              每周可投入（小时）
              <div>
                <input type="number" min="1" max="40" value={hoursDraft} onChange={(e) => setHoursDraft(e.target.value)} />
                <Button size="sm" onClick={saveHours}>保存</Button>
              </div>
            </label>
            <p>今日建议：<strong>{next ? `${next.stage.title} · ${next.title}` : "路径已完成"}</strong></p>
            <p>待回顾：<strong>{dueCount}</strong> 篇论文到了复习日</p>
          </section>
        </aside>
      </div>
    </div>
  );
}
