export function generatePath({ field = "", goal = "", level = "beginner" } = {}) {
  const domain = field.trim() || "你的研究领域";
  const stages = [
    {
      id: "map",
      title: "领域地图",
      subtitle: "先知道有什么，再决定学什么",
      description: `用一周建立「${domain}」的整体认知：核心问题、主要分支、关键期刊/会议与代表人物。`,
      tasks: [
        { title: `写下你理解的「${domain}」是什么，以及你最想解决的一个问题`, done: false },
        { title: "搜索并保存 3 篇该领域综述或入门讲义", done: false },
        { title: "列出 10 个高频术语，逐个写下你自己的解释", done: false },
        { title: "找到 3-5 个代表性团队或实验室，关注其最新工作", done: false }
      ]
    },
    {
      id: "foundation",
      title: "基础学习",
      subtitle: "补齐读懂论文所需的背景知识",
      description: "按领域地图中的概念清单，先补数学/编程/学科基础，再接触研究级内容。",
      tasks: [
        { title: "选择 1 门系统课程或教材，制定 4 周学习计划", done: false },
        { title: "掌握 3 个最核心概念的符号、直觉与例子", done: false },
        { title: "每天用 20 分钟做一次主动回忆或小练习", done: false },
        { title: "写一篇 300 字的领域入门笔记", done: false }
      ]
    },
    {
      id: "literature",
      title: "文献检索与精读",
      subtitle: "从搜索到读懂一篇论文的完整方法",
      description: "用聚合搜索找到代表论文，用论文解读器拆解摘要与结构，把被动阅读变成主动提问。",
      tasks: [
        { title: "用 3 组关键词在聚合搜索中检索，收藏至少 10 篇论文", done: false },
        { title: "精读 2 篇论文，完成五问解读并保存笔记", done: false },
        { title: "为每篇精读论文标注理解等级与复习日期", done: false },
        { title: "画一张引用关系草图，找出研究的演进脉络", done: false }
      ]
    },
    {
      id: "method",
      title: "方法理解",
      subtitle: "把摘要里的方法还原成可解释的设计",
      description: "对比多篇论文的方法、数据集和指标，理解为什么这样设计，以及方法的适用边界。",
      tasks: [
        { title: "整理 3 种主流方法，各写一段“它解决了什么/代价是什么”", done: false },
        { title: "列出常用数据集与评价指标，记录它们各自的偏向", done: false },
        { title: "找 1 篇论文的补充材料或开源代码，通读核心实现", done: false },
        { title: "写一篇 500 字方法对比笔记", done: false }
      ]
    },
    {
      id: "reproduce",
      title: "复现与实验",
      subtitle: "动手是理解的唯一捷径",
      description: "选择一个小而完整的开源项目复现，记录实验配置、失败原因和结果差异。",
      tasks: [
        { title: "选择一个有开源代码和公开数据的论文项目", done: false },
        { title: "复现主要实验，记录运行时间、资源与关键参数", done: false },
        { title: "做 1 组消融实验或参数敏感性实验", done: false },
        { title: "撰写复现报告：结论、差异、原因与启发", done: false }
      ]
    },
    {
      id: "writing",
      title: "综述与写作",
      subtitle: "把理解转化为可发表的表达",
      description: "从研究问题出发搭建论文骨架，把文献库中的引用编织进引言与相关工作，逐步完成初稿。",
      tasks: [
        { title: "用写作页创建论文，选择模板并写出大纲", done: false },
        { title: "写出一版研究问题、动机与贡献列表", done: false },
        { title: "完成引言与相关工作初稿，插入文献引用", done: false },
        { title: "完成方法与实验章节，导出 Markdown 存档", done: false }
      ]
    },
    {
      id: "polish",
      title: "打磨与发表",
      subtitle: "从初稿到可提交的研究成果",
      description: "按目标期刊/会议要求修改结构、图表、语言和参考文献，并请他人审阅。",
      tasks: [
        { title: "对照目标期刊/会议模板检查格式", done: false },
        { title: "请 1-2 位同行阅读并给出修改意见", done: false },
        { title: "逐条回复审阅意见，记录修改版本", done: false },
        { title: "完成投稿材料与补充材料", done: false }
      ]
    }
  ];
  return {
    field: domain,
    goal: goal.trim() || `在 6 个月内从零基础掌握「${domain}」，完成一篇可投稿论文`,
    level,
    createdAt: new Date().toISOString(),
    stages
  };
}

const EVIDENCE_RULES = {
  "map:2": { type: "library", target: 3 },
  "foundation:4": { type: "journals", target: 1, minLength: 300, anyOf: ["入门", "领域", "概念", "地图", "理解"] },
  "literature:1": { type: "library", target: 10 },
  "literature:2": { type: "journals", target: 2, anyOf: ["五问"] },
  "literature:3": { type: "library", target: 2, filter: "understood" },
  "method:1": { type: "journals", target: 3, allOf: ["方法", "解决"] },
  "method:4": { type: "textLength", target: 500, allOf: ["方法", "对比"] },
  "reproduce:2": { type: "journals", target: 1, anyOf: ["复现"] },
  "reproduce:4": { type: "textLength", target: 300, anyOf: ["复现"] },
  "writing:1": { type: "drafts", target: 1 },
  "writing:2": { type: "drafts", target: 1, minSections: 2 },
  "writing:3": { type: "drafts", target: 1, minCitations: 1 },
  "writing:4": { type: "drafts", target: 1, minSections: 5 }
};

function journalLength(journal) {
  const core = String(journal?.summary || journal?.core || "").length;
  const takeaways = (journal?.takeaways || []).join("").length;
  const insights = (journal?.insights || []).join("").length;
  return core + takeaways + insights;
}

function journalText(journal) {
  return [journal?.summary, journal?.core, ...(journal?.takeaways || []), ...(journal?.insights || [])].filter(Boolean).join(" ");
}

function matchesKeywords(text, rule) {
  if (!rule) return true;
  if (Array.isArray(rule.allOf) && rule.allOf.length && !rule.allOf.every((k) => String(text || "").includes(k))) return false;
  if (Array.isArray(rule.anyOf) && rule.anyOf.length && !rule.anyOf.some((k) => String(text || "").includes(k))) return false;
  return true;
}

export function evaluateTask(task, stageId, index, data = {}) {
  const rule = EVIDENCE_RULES[`${stageId}:${index + 1}`];
  if (!rule || task.custom) return null;
  const library = Array.isArray(data.library) ? data.library : [];
  const journals = Array.isArray(data.journals) ? data.journals : [];
  const drafts = Array.isArray(data.drafts) ? data.drafts : [];
  let count = 0;

  if (rule.type === "library") {
    count = library.filter((p) => {
      if (rule.filter === "understood" && (Number(p.understanding) || 1) < 2) return false;
      if (rule.filter === "notes" && !String(p.notes || "").trim()) return false;
      if (rule.filter === "pdf" && !String(p.pdfUrl || "").trim()) return false;
      return true;
    }).length;
  } else if (rule.type === "journals") {
    count = journals.filter((j) => {
      if (rule.minLength && journalLength(j) < rule.minLength) return false;
      if (!matchesKeywords(journalText(j), rule)) return false;
      return true;
    }).length;
  } else if (rule.type === "textLength") {
    count = journals.filter((j) => matchesKeywords(journalText(j), rule)).reduce((sum, j) => sum + journalLength(j), 0);
  } else if (rule.type === "drafts") {
    count = drafts.filter((d) => {
      if (rule.minSections && (d.sections || []).length < rule.minSections) return false;
      if (rule.minCitations && (d.citations || []).length < rule.minCitations) return false;
      return true;
    }).length;
  }

  const target = Number(rule.target) || 1;
  const progress = Math.min(1, count / target);
  return {
    count,
    target,
    progress,
    done: count >= target
  };
}

export function syncPathEvidence(path, data = {}) {
  if (!path?.stages) return path;
  const stages = path.stages.map((stage, si) => ({
    ...stage,
    tasks: (stage.tasks || []).map((task, ti) => {
      const evidence = evaluateTask(task, stage.id || `s${si}`, ti, data);
      const status = task.status === "skipped"
        ? "skipped"
        : task.status === "review"
          ? "review"
          : Boolean(task.done) || evidence?.done
            ? "done"
            : task.status === "inprogress" || (evidence && evidence.progress > 0)
              ? "inprogress"
              : "todo";
      if (!evidence) {
        return {
          ...task,
          status,
          done: Boolean(task.done),
          progressNote: task.progressNote || ""
        };
      }
      return {
        ...task,
        done: Boolean(task.done) || evidence.done,
        status,
        evidenceDone: evidence.done,
        progress: evidence.progress,
        progressCount: evidence.count,
        progressTarget: evidence.target,
        progressNote: task.progressNote || ""
      };
    })
  }));
  return { ...path, stages };
}

export function addPathTask(path, stageId, title) {
  const clean = String(title || "").trim();
  if (!clean) return path;
  const stages = (path?.stages || []).map((stage) => {
    if (stage.id !== stageId) return stage;
    return {
      ...stage,
      tasks: [...(stage.tasks || []), { title: clean, done: false, status: "todo", custom: true }]
    };
  });
  return { ...path, stages };
}

export function splitPathTask(path, stageId, index, titles = []) {
  const list = (Array.isArray(titles) ? titles : []).map((t) => String(t).trim()).filter(Boolean);
  if (!list.length) return path;
  const stages = (path?.stages || []).map((stage) => {
    if (stage.id !== stageId) return stage;
    const tasks = stage.tasks || [];
    const next = [...tasks];
    next.splice(index, 1, ...list.map((title) => ({ title, done: false, status: "todo", custom: true })));
    return { ...stage, tasks: next };
  });
  return { ...path, stages };
}

export function setTaskStatus(path, stageId, index, status = "todo") {
  const allowed = ["todo", "inprogress", "review", "done", "skipped"];
  const nextStatus = allowed.includes(status) ? status : "todo";
  const stages = (path?.stages || []).map((stage) => {
    if (stage.id !== stageId) return stage;
    return {
      ...stage,
      tasks: (stage.tasks || []).map((task, i) => (
        i === index
          ? {
              ...task,
              status: nextStatus,
              done: nextStatus === "done" ? true : task.done,
              progressNote: task.progressNote || ""
            }
          : task
      ))
    };
  });
  return { ...path, stages };
}

export function appendPathLog(path, entry = {}) {
  const clean = {
    date: new Date().toISOString().slice(0, 10),
    summary: String(entry.summary || "").trim(),
    blocker: String(entry.blocker || "").trim(),
    next: String(entry.next || "").trim()
  };
  if (!clean.summary && !clean.next) return path;
  const log = Array.isArray(path?.progressLog) ? path.progressLog : [];
  return { ...path, progressLog: [clean, ...log].slice(0, 30) };
}

export function pathProgress(stages) {
  const tasks = (stages || []).flatMap((s) => s.tasks || []);
  const done = tasks.filter((t) => t.done).length;
  return {
    total: tasks.length,
    done,
    percent: tasks.length ? Math.round((done / tasks.length) * 100) : 0
  };
}

export function flattenPath(path) {
  return (path?.stages || []).flatMap((s) =>
    (s.tasks || []).map((t, i) => ({
      id: `${s.id}-${i + 1}`,
      stageId: s.id,
      stageTitle: s.title,
      index: i,
      title: t.title,
      done: Boolean(t.done),
      status: t.status || "todo"
    }))
  );
}

export function findPathTask(path, query = "") {
  const tasks = flattenPath(path);
  const q = String(query || "").trim().toLowerCase();
  if (!q) return tasks.find((t) => !t.done && t.status !== "skipped") || null;
  return tasks.find((t) => t.id.toLowerCase() === q || t.title.toLowerCase().includes(q)) || null;
}
