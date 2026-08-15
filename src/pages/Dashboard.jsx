import { GraduationCap, Search, BookOpen, Brain, MessageSquareText, PenLine, ChevronRight, CalendarClock, Tag, Sparkles, Library } from "lucide-react";
import { useData } from "../store.jsx";
import { Badge, Button, EmptyState, ProgressRing, SectionHead, SourceTag } from "../components/ui.jsx";

const LOOP = [
  { key: "path", label: "学基础", desc: "建立领域地图", icon: GraduationCap },
  { key: "search", label: "找文献", desc: "聚合检索论文", icon: Search },
  { key: "library", label: "读摘要", desc: "五问拆解", icon: BookOpen },
  { key: "library", label: "深理解", desc: "笔记与复习", icon: Brain },
  { key: "writer", label: "复述输出", desc: "写综述与笔记", icon: MessageSquareText },
  { key: "writer", label: "写论文", desc: "产出研究论文", icon: PenLine }
];

export default function Dashboard({ onNavigate, onOpenPaper }) {
  const { stats, library, path } = useData();
  const nextTask = (path?.stages || []).flatMap((s) => (s.tasks || []).map((t) => ({ ...t, stage: s.title }))).find((t) => !t.done);
  const loopActive = library.filter((p) => p.status === "understood" || p.status === "retold").length > 0;

  return (
    <div className="dashboard page">
      <section className="welcome-band">
        <div className="welcome-copy">
          <h2>{path?.field || "从零基础到科研高手"}</h2>
          <p>
            {path?.goal
              ? `目标：${path.goal}`
              : "先设置研究领域与目标，生成你的个性化学习路径；之后就能聚合搜索、拆解摘要、管理笔记并最终写出论文。"}
          </p>
          <div className="welcome-actions">
            {!path?.goal ? (
              <Button icon={GraduationCap} onClick={() => onNavigate({ page: "path" })}>设置学习目标</Button>
            ) : (
              <Button icon={Search} onClick={() => onNavigate({ page: "search" })}>搜索论文</Button>
            )}
            <Button variant="ghost" icon={Library} onClick={() => onNavigate({ page: "library" })}>查看文献库</Button>
          </div>
        </div>
        <div className="welcome-ring">
          <ProgressRing value={stats?.pathProgress?.percent || 0} size={104} stroke={8} label={`${stats?.pathProgress?.percent || 0}%`} sublabel="路径进度" />
        </div>
      </section>

      <section className="loop-rail">
        <div className="rail-head">
          <div>
            <h3>科研学习闭环</h3>
            <p>学 → 找 → 读 → 懂 → 讲 → 写，每一步都留下痕迹</p>
          </div>
          {loopActive ? <Badge tone="ok">闭环已启动</Badge> : <Badge tone="neutral">等待第一步</Badge>}
        </div>
        <div className="loop-steps">
          {LOOP.map((step, i) => {
            const Icon = step.icon;
            return (
              <button className="loop-step" key={i} onClick={() => onNavigate({ page: step.key })}>
                <span className="loop-icon"><Icon size={19} /></span>
                <strong>{step.label}</strong>
                <em>{step.desc}</em>
                {i < LOOP.length - 1 ? <ChevronRight className="loop-arrow" size={15} /> : null}
              </button>
            );
          })}
        </div>
      </section>

      <section className="stats-grid">
        <div className="stat-cell">
          <span className="stat-label">文献总数</span>
          <strong>{stats?.libraryCount ?? 0}</strong>
          <em>已收藏论文</em>
        </div>
        <div className="stat-cell">
          <span className="stat-label">今日复习</span>
          <strong className={stats?.dueToday > 0 ? "warn" : ""}>{stats?.dueToday ?? 0}</strong>
          <em>到期需要回顾</em>
        </div>
        <div className="stat-cell">
          <span className="stat-label">平均理解</span>
          <strong>{stats?.avgUnderstanding ?? 0}</strong>
          <em>1-5 级理解度</em>
        </div>
        <div className="stat-cell">
          <span className="stat-label">写作进度</span>
          <strong>{stats?.drafts ?? 0}</strong>
          <em>篇论文草稿</em>
        </div>
      </section>

      <div className="dashboard-columns">
        <section className="panel">
          <SectionHead title="最近文献" desc="你最近收藏与阅读的论文" action={
            <Button variant="ghost" size="sm" onClick={() => onNavigate({ page: "library" })}>全部</Button>
          } />
          {library.length ? (
            <div className="recent-list">
              {library.slice(0, 5).map((p) => (
                <button className="recent-row" key={p.id} onClick={() => onOpenPaper(p)}>
                  <SourceTag source={p.source} label={p.sourceLabel} />
                  <div className="recent-main">
                    <strong>{p.title}</strong>
                    <span>{(p.authors || []).slice(0, 3).join(" · ") || "作者未知"} · {p.year || "年份未知"}</span>
                  </div>
                  <Badge tone={p.status}>{({ todo: "待读", reading: "在读", understood: "已懂", retold: "已复述" })[p.status] || "待读"}</Badge>
                </button>
              ))}
            </div>
          ) : (
            <EmptyState
              icon={BookOpen}
              title="文献库还是空的"
              desc="去聚合搜索找第一篇论文，收藏后它会出现在这里。"
              action={<Button size="sm" icon={Search} onClick={() => onNavigate({ page: "search" })}>开始检索</Button>}
            />
          )}
        </section>

        <section className="panel">
          <SectionHead title="下一步学习" desc={path?.goal ? "来自你的学习路径" : "先设置学习目标"} action={
            <Button variant="ghost" size="sm" onClick={() => onNavigate({ page: "path" })}>路径</Button>
          } />
          {nextTask ? (
            <div className="next-task">
              <div className="task-stage">{nextTask.stage}</div>
              <p>{nextTask.title}</p>
              <Button size="sm" icon={ChevronRight} onClick={() => onNavigate({ page: "path" })}>去做</Button>
            </div>
          ) : path?.goal ? (
            <EmptyState icon={Sparkles} title="路径全部完成" desc="你已经完成当前学习路径，可以更新目标或开始写论文。" />
          ) : (
            <EmptyState icon={GraduationCap} title="还没有学习路径" desc="设定领域和目标，应用会为你生成 7 个阶段的成长计划。" action={<Button size="sm" onClick={() => onNavigate({ page: "path" })}>生成路径</Button>} />
          )}
          {stats?.topTags?.length ? (
            <div className="tag-cloud">
              <span className="tag-cloud-label"><Tag size={13} /> 高频标签</span>
              <div className="tag-row">
                {stats.topTags.map((t) => <Badge key={t.name} tone="tag">{t.name} <em>{t.count}</em></Badge>)}
              </div>
            </div>
          ) : null}
          <div className="review-note">
            <CalendarClock size={15} />
            <span>{stats?.dueToday > 0 ? `今天有 ${stats.dueToday} 篇论文进入复习，5 分钟回顾能显著巩固记忆。` : "今天没有到期复习，保持节奏。"}</span>
          </div>
        </section>
      </div>
    </div>
  );
}
