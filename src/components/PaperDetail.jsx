import { useMemo, useState } from "react";
import {
  BookOpen,
  Sparkles,
  Save,
  ExternalLink,
  AppWindow,
  FileText,
  Lightbulb,
  ListChecks,
  Loader2,
  Check,
  Quote,
  Target,
  Map,
  Gauge,
  Wand2
} from "lucide-react";
import { api } from "../api.js";
import { useData } from "../store.jsx";
import { Badge, Button, IconButton, Modal, Segmented, SourceTag, Stars, TextArea } from "./ui.jsx";

const STATUS = [
  { value: "todo", label: "待读" },
  { value: "reading", label: "在读" },
  { value: "understood", label: "已懂" },
  { value: "retold", label: "已复述" }
];

const SECTION_LABELS = {
  problem: "研究问题",
  method: "方法设计",
  results: "结果与证据",
  conclusion: "结论与贡献",
  limitation: "局限与开放问题",
  other: "其他要点"
};

export default function PaperDetail({ paper: initialPaper, onClose, onSave, saved, onUpdate, onReadPdf, onOpenPdfExternal }) {
  const { meta, updatePaper } = useData();
  const [paper, setPaper] = useState(initialPaper);
  const [tab, setTab] = useState(saved ? "notes" : "abstract");
  const [analysis, setAnalysis] = useState(null);
  const [deep, setDeep] = useState(null);
  const [deepLoading, setDeepLoading] = useState(false);
  const [deepError, setDeepError] = useState("");
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState({
    status: paper.status || "todo",
    understanding: paper.understanding || 1,
    tags: (paper.tags || []).join(", "),
    notes: paper.notes || ""
  });
  const [toast, setToast] = useState("");

  const abstract = paper.abstract || "";

  useMemo(() => {
    let alive = true;
    if (abstract || paper.title) {
      api.analyze({ title: paper.title, abstract, keywords: paper.keywords })
        .then((a) => alive && setAnalysis(a))
        .catch(() => {});
    }
    return () => {
      alive = false;
    };
  }, [abstract, paper.title, paper.keywords]);

  const openUrl = (url) => {
    if (!url) return;
    window.open(url, meta?.settings?.openLinksInNewTab === false ? "_self" : "_blank", "noopener");
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const payload = {
        ...paper,
        status: note.status,
        understanding: note.understanding,
        tags: note.tags.split(/[,，]/).map((t) => t.trim()).filter(Boolean),
        notes: note.notes,
        reviewDue: paper.reviewDue
      };
      const saved = await onSave(payload);
      setPaper(saved);
      showToast("已保存到文献库");
      onUpdate?.(saved);
    } catch (err) {
      showToast(err.message, true);
    } finally {
      setSaving(false);
    }
  };

  const handleStatus = async (value) => {
    setNote((n) => ({ ...n, status: value }));
    if (saved) {
      try {
        await updatePaper(paper.id, { status: value });
      } catch {
        /* ignore */
      }
    }
  };

  const runDeep = async () => {
    setDeepLoading(true);
    setDeepError("");
    try {
      const result = await api.deepAnalyze({ title: paper.title, abstract });
      setDeep(result);
    } catch (err) {
      setDeepError(err.message);
    } finally {
      setDeepLoading(false);
    }
  };

  const showToast = (msg, isError = false) => {
    setToast(msg);
    setTimeout(() => setToast(""), 2400);
  };

  const tags = (paper.tags || []).slice(0, 8);

  return (
    <Modal title={paper.title || "论文详情"} onClose={onClose} width="880px">
      <div className="paper-detail">
        <div className="detail-meta">
          <div className="detail-meta-top">
            <SourceTag source={paper.source} label={paper.sourceLabel} />
            {paper.year ? <Badge tone="year">{paper.year}</Badge> : null}
            {paper.citations > 0 ? <Badge tone="cite">被引 {paper.citations}</Badge> : null}
            {paper.type ? <Badge tone="type">{paper.type}</Badge> : null}
          </div>
          <h2>{paper.title}</h2>
          <p className="detail-authors">
            {(paper.authors || []).slice(0, 12).join(" · ") || "作者信息暂无"}
            {paper.venue ? <span className="venue">｜{paper.venue}</span> : null}
          </p>
          <div className="detail-links">
            {paper.url ? (
              <Button variant="ghost" size="sm" icon={ExternalLink} onClick={() => openUrl(paper.url)}>原文页面</Button>
            ) : null}
            {(paper.pdfUrl || paper.localPdf) ? (
              <Button variant="ghost" size="sm" icon={FileText} onClick={() => onReadPdf?.(paper.pdfUrl, paper.title, paper.doi, paper.id)}>内置阅读器</Button>
            ) : null}
            {(paper.pdfUrl || paper.localPdf) ? (
              <Button
                variant="ghost"
                size="sm"
                icon={AppWindow}
                onClick={() => onOpenPdfExternal?.(paper)}
                title="弹出系统「打开方式」，自选 PDF 软件"
              >
                用其他软件打开
              </Button>
            ) : null}
            {paper.doi ? (
              <Button variant="ghost" size="sm" onClick={() => openUrl(`https://doi.org/${paper.doi}`)}>DOI</Button>
            ) : null}
          </div>
        </div>

        <Segmented
          className="detail-tabs"
          value={tab}
          onChange={setTab}
          options={[
            { value: "abstract", label: "摘要" },
            { value: "analysis", label: "论文解读" },
            { value: "notes", label: "笔记与复习" }
          ]}
        />

        {tab === "abstract" ? (
          <div className="detail-pane">
            <p className="abstract-text">{abstract || "该来源未提供摘要。你可以通过原文链接查看摘要，或使用论文解读中的五问引导。"}</p>
            {tags.length ? (
              <div className="tag-row">
                {tags.map((t) => <Badge key={t} tone="tag">{t}</Badge>)}
              </div>
            ) : null}
          </div>
        ) : null}

        {tab === "analysis" ? (
          <div className="detail-pane analysis-pane">
            <div className="analysis-toolbar">
              <div>
                <strong>本地启发式解读</strong>
                <span>无需联网，基于摘要的结构化拆解</span>
              </div>
              {meta?.hasOpenAI ? (
                <Button size="sm" icon={deepLoading ? Loader2 : Wand2} onClick={runDeep} disabled={deepLoading}>
                  {deepLoading ? "解读中" : deep ? "重新深度解读" : "深度 AI 解读"}
                </Button>
              ) : null}
            </div>

            {deep ? (
              <div className="deep-box">
                <div className="deep-line">
                  <Lightbulb size={16} />
                  <span><strong>一句话概括：</strong>{deep.oneSentence}</span>
                </div>
                <div className="deep-grid">
                  <div><strong>问题</strong><p>{deep.problem}</p></div>
                  <div><strong>方法</strong><p>{deep.method}</p></div>
                  <div><strong>发现</strong><p>{deep.findings}</p></div>
                  <div><strong>局限</strong><p>{deep.limitations}</p></div>
                </div>
                {deep.takeaways?.length ? (
                  <div className="deep-list">
                    <strong>核心要点</strong>
                    <ul>{deep.takeaways.map((t, i) => <li key={i}>{t}</li>)}</ul>
                  </div>
                ) : null}
              </div>
            ) : null}

            {deepError ? <p className="error-text">{deepError}</p> : null}

            {analysis ? (
              <>
                <div className="analysis-cards">
                  <div className="a-card">
                    <Target size={17} />
                    <div>
                      <span>理解难度</span>
                      <strong>{analysis.difficulty.label}</strong>
                      <em>{analysis.difficulty.score}/5</em>
                    </div>
                  </div>
                  <div className="a-card">
                    <ListChecks size={17} />
                    <div>
                      <span>摘要句子</span>
                      <strong>{analysis.sentenceCount}</strong>
                      <em>已拆解 {analysis.keySentences.length} 句重点</em>
                    </div>
                  </div>
                  <div className="a-card">
                    <Gauge size={17} />
                    <div>
                      <span>语言</span>
                      <strong>{analysis.language === "zh" ? "中文" : "英文"}</strong>
                      <em>{analysis.keywords.slice(0, 3).join(" · ")}</em>
                    </div>
                  </div>
                </div>

                <div className="section-block">
                  <h4><Sparkles size={16} /> 摘要结构拆解</h4>
                  <div className="section-list">
                    {Object.entries(analysis.sections).filter(([, v]) => v.length).map(([key, sentences]) => (
                      <div className="section-item" key={key}>
                        <Badge tone="section">{SECTION_LABELS[key]}</Badge>
                        <p>{sentences.map((s) => `“${s}”`).join(" ")}</p>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="section-block">
                  <h4><Quote size={16} /> 关键句速览</h4>
                  <ol className="key-sentences">
                    {analysis.keySentences.map((s, i) => <li key={i}>{s}</li>)}
                  </ol>
                </div>

                <div className="section-block">
                  <h4><Lightbulb size={16} /> 阅读五问</h4>
                  <ol className="five-questions">
                    {analysis.fiveQuestions.map((q, i) => <li key={i}>{q}</li>)}
                  </ol>
                </div>

                <div className="section-block">
                  <h4><Map size={16} /> 建议学习路径</h4>
                  <div className="concept-path">
                    {analysis.conceptPath.map((step, i) => (
                      <div className="path-step" key={i}>
                        <span className="step-index">{i + 1}</span>
                        <div>
                          <strong>{step.stage}</strong>
                          <p>{step.action}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </>
            ) : (
              <div className="loading-line"><Loader2 size={16} className="spin" /> 正在拆解摘要...</div>
            )}
          </div>
        ) : null}

        {tab === "notes" ? (
          <div className="detail-pane notes-pane">
            <div className="notes-row">
              <div>
                <span className="notes-label">阅读状态</span>
                <Segmented options={STATUS} value={note.status} onChange={handleStatus} />
              </div>
              <div>
                <span className="notes-label">理解等级</span>
                <Stars value={note.understanding} onChange={(v) => setNote((n) => ({ ...n, understanding: v }))} />
                <p className="notes-hint">{["刚接触", "读了摘要", "懂了核心", "能讲给别人", "可复现延伸"][note.understanding - 1]}</p>
              </div>
            </div>
            <div className="notes-fields">
              <TextArea label="我的笔记" rows={6} value={note.notes} onChange={(e) => setNote((n) => ({ ...n, notes: e.target.value }))} placeholder="用 Feynman 技巧写下：这篇论文在解决什么问题？方法的关键是什么？证据是否支撑结论？" />
              <TextArea label="标签（用逗号分隔）" rows={2} value={note.tags} onChange={(e) => setNote((n) => ({ ...n, tags: e.target.value }))} placeholder="例如：综述, 方法基础, 复现候选" />
            </div>
            <div className="notes-actions">
              <span className="save-hint"><Check size={14} /> 保存后会自动安排复习时间</span>
              <Button icon={saving ? Loader2 : Save} onClick={handleSave} disabled={saving}>
                {saving ? "保存中" : saved ? "更新笔记" : "收藏到文献库"}
              </Button>
            </div>
          </div>
        ) : null}
      </div>
      {toast ? <div className={`toast ${toast.includes("失败") ? "error" : ""}`}>{toast}</div> : null}
    </Modal>
  );
}
