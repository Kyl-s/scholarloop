import { useEffect, useRef, useState } from "react";
import { Download, Upload, Database, Trash2, Server, KeyRound, ShieldCheck, Info, ExternalLink, Minimize2, Globe2, School, LogIn, Languages, RefreshCw, Route } from "lucide-react";
import { api } from "../api.js";
import { useData } from "../store.jsx";
import { Badge, Button, SectionHead } from "../components/ui.jsx";
import ApiConfigForm from "../components/ApiConfigForm.jsx";
import UsageStats from "../components/UsageStats.jsx";

export default function SettingsPage({ onNavigate }) {
  const { meta, library, path, drafts, refresh, updatePath, settings, updateSettings } = useData();
  const fileRef = useRef(null);
  const [msg, setMsg] = useState("");
  const [pdfMathStatus, setPdfMathStatus] = useState({ loading: true, available: false, command: "", installHint: "", install: null });
  const [pdfMathInstalling, setPdfMathInstalling] = useState(false);
  const [institutionDraft, setInstitutionDraft] = useState({ enabled: false, name: "", type: "webvpn", portalUrl: "" });
  const [paperSourceDraft, setPaperSourceDraft] = useState({ ieee: { enabled: true, apiKey: "" }, wos: { enabled: true, apiKey: "", database: "WOS" } });
  const [paperSourceChecks, setPaperSourceChecks] = useState({});
  const [learningPathSaving, setLearningPathSaving] = useState(false);

  const refreshPdfMathStatus = async () => {
    setPdfMathStatus((previous) => ({ ...previous, loading: true }));
    try {
      setPdfMathStatus({ loading: false, ...(await api.pdfMathTranslateStatus()) });
    } catch (err) {
      setPdfMathStatus({ loading: false, available: false, command: "", installHint: err.message || "排版翻译引擎状态读取失败", install: null });
    }
  };

  useEffect(() => {
    setPaperSourceDraft({ ieee: { enabled: true, apiKey: "", ...(settings?.paperSources?.ieee || {}) }, wos: { enabled: true, apiKey: "", database: "WOS", ...(settings?.paperSources?.wos || {}) } });
  }, [settings?.paperSources]);

  const savePaperSources = async () => {
    await updateSettings({ paperSources: paperSourceDraft });
    setMsg("IEEE / Web of Science 配置已保存到本机");
  };
  const checkPaperSource = async (id) => {
    setPaperSourceChecks((current) => ({ ...current, [id]: { loading: true, message: "" } }));
    try {
      const result = await api.checkPaperSource(id);
      setPaperSourceChecks((current) => ({ ...current, [id]: { loading: false, ok: result.ok, message: result.ok ? `连接正常（返回 ${result.count || 0} 条）` : (result.error || "连接失败") } }));
    } catch (err) {
      setPaperSourceChecks((current) => ({ ...current, [id]: { loading: false, ok: false, message: err.message || "连接失败" } }));
    }
  };

  useEffect(() => {
    refreshPdfMathStatus();
  }, [settings?.pdfMathTranslateBin]);

  const installPdfMath = async () => {
    if (pdfMathInstalling) return;
    if (pdfMathStatus.available && !window.confirm("将下载官方 Windows 包并覆盖本机 tools/pdf2zh，确定吗？")) return;
    setPdfMathInstalling(true);
    setMsg("");
    const timer = setInterval(() => {
      refreshPdfMathStatus();
    }, 1200);
    try {
      await api.installPdfMathTranslate();
      await refreshPdfMathStatus();
      setMsg("排版翻译引擎已安装到本机 tools/pdf2zh");
    } catch (err) {
      await refreshPdfMathStatus();
      setMsg(err.message || "安装失败");
    } finally {
      clearInterval(timer);
      setPdfMathInstalling(false);
    }
  };

  useEffect(() => {
    if (!settings?.institutionAccess) return;
    setInstitutionDraft({
      enabled: Boolean(settings.institutionAccess.enabled),
      name: settings.institutionAccess.name || "",
      type: settings.institutionAccess.type || "webvpn",
      portalUrl: settings.institutionAccess.portalUrl || ""
    });
  }, [settings?.institutionAccess]);

  const saveInstitution = async (openAfterSave = false) => {
    const name = institutionDraft.name.trim();
    const portalUrl = institutionDraft.portalUrl.trim();
    if (!name) return setMsg("请填写学校或机构名称");
    if (!/^https:\/\//i.test(portalUrl)) return setMsg("机构入口必须是 HTTPS 地址");
    await updateSettings({ institutionAccess: { ...institutionDraft, enabled: true, name, portalUrl } });
    setMsg("机构资源入口已保存；登录凭据只保存在本机浏览器会话中");
    if (openAfterSave) onNavigate?.({ page: "search", subtitle: "机构资源", openInstitution: true });
  };

  const exportData = async () => {
    const data = await api.exportData();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `scholarloop-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    setMsg("数据已导出");
  };

  const importFile = async (file) => {
    const text = await file.text();
    const data = JSON.parse(text);
    await api.post("/api/data/import", data);
    await refresh();
    setMsg("数据已导入");
  };

  const clearAll = async () => {
    if (!window.confirm("确定清空所有文献、路径与草稿吗？建议先导出备份。")) return;
    await api.post("/api/data/import", { library: [], path: { goal: null, stages: [] }, drafts: [], settings: {} });
    await refresh();
    setMsg("已清空本地数据");
  };

  const toggleLearningPath = async (event) => {
    if (learningPathSaving) return;
    setLearningPathSaving(true);
    setMsg("");
    try {
      await updateSettings({ learningPathEnabled: event.target.checked });
      setMsg(event.target.checked ? "学习路径已开启" : "学习路径已关闭");
    } catch (err) {
      setMsg(`学习路径设置失败：${err.message || "请稍后重试"}`);
    } finally {
      setLearningPathSaving(false);
    }
  };

  return (
    <div className="page settings-page">
      <SectionHead title="设置" desc="配置 API、管理数据、查看数据源与了解使用限制" />

      <div className="settings-grid">
        <section className="panel settings-panel api-settings-panel">
          <div className="settings-head"><KeyRound size={17} /> API 配置</div>
          <p className="institution-intro">可添加多个 OpenAI 兼容供应商（DeepSeek、Kimi、通义等），随时切换当前启用的一套。Agent、PDF 翻译与解读、AI 检索都使用当前启用的配置。</p>
          <ApiConfigForm />
          <UsageStats />
          <div className="settings-note">
            <Info size={15} />
            <p>{meta?.hasOpenAI
              ? "服务端另外已配置 OPENAI_API_KEY，论文解读页的“深度 AI 解读”可用。"
              : "论文解读页的“深度 AI 解读”仍依赖启动时的 OPENAI_API_KEY；上面这份配置已覆盖 Agent、翻译和 PDF 解读。"}</p>
          </div>
        </section>

        <section className="panel settings-panel">
          <div className="settings-head"><Server size={17} /> 数据源状态</div>
          <div className="source-table">
            {(meta?.sources || []).map((s) => (
              <div className="source-line" key={s.id}>
                <div>
                  <strong>{s.label}</strong>
                  <span>{s.desc}</span>
                </div>
                <Badge tone={s.authRequired && !s.configured ? "neutral" : "ok"}>{s.authRequired && !s.configured ? "需授权" : "可用"}</Badge>
              </div>
            ))}
          </div>
          <div className="settings-note">
            <Info size={15} />
            <p>知网已直接接入聚合搜索；万方、百度学术等暂以门户跳转与手动导入（DOI / BibTeX / 手动录入）补全。</p>
          </div>
        </section>

        <section className="panel settings-panel source-auth-panel">
          <div className="settings-head"><KeyRound size={17} /> IEEE / Web of Science 授权</div>
          <p className="settings-note-text">仅在本机保存 API Key，用于官方 API 聚合；未填写时仍可从论文搜索页打开门户登录。</p>
          <label className="proxy-field"><span><strong>IEEE Xplore API Key</strong><em>需 IEEE 审核通过；留空则仅门户访问。</em></span><input type="password" value={paperSourceDraft.ieee.apiKey} onChange={(e) => setPaperSourceDraft((v) => ({ ...v, ieee: { ...v.ieee, apiKey: e.target.value } }))} placeholder="已配置则留空以保留；输入新 Key 覆盖" /><Button size="sm" variant="secondary" onClick={() => checkPaperSource("ieee")} disabled={paperSourceChecks.ieee?.loading}>{paperSourceChecks.ieee?.loading ? "检测中…" : "检测连接"}</Button>{paperSourceChecks.ieee?.message ? <em className={paperSourceChecks.ieee.ok ? "source-check-ok" : "source-check-error"}>{paperSourceChecks.ieee.message}</em> : null}</label>
          <label className="proxy-field"><span><strong>Web of Science API Key</strong><em>需 Clarivate / 机构授权；留空则仅门户访问。</em></span><input type="password" value={paperSourceDraft.wos.apiKey} onChange={(e) => setPaperSourceDraft((v) => ({ ...v, wos: { ...v.wos, apiKey: e.target.value } }))} placeholder="已配置则留空以保留；输入新 Key 覆盖" /><Button size="sm" variant="secondary" onClick={() => checkPaperSource("wos")} disabled={paperSourceChecks.wos?.loading}>{paperSourceChecks.wos?.loading ? "检测中…" : "检测连接"}</Button>{paperSourceChecks.wos?.message ? <em className={paperSourceChecks.wos.ok ? "source-check-ok" : "source-check-error"}>{paperSourceChecks.wos.message}</em> : null}</label>
          <div className="institution-actions"><Button variant="secondary" icon={ShieldCheck} onClick={savePaperSources}>保存本机配置</Button></div>
        </section>

        <section className="panel settings-panel pdfmath-settings-panel">
          <div className="settings-head"><Languages size={17} /> PDFMathTranslate 排版翻译</div>
          <div className="pdfmath-status-row">
            <span className={pdfMathStatus.available ? "ready" : "missing"}>
              {pdfMathStatus.loading ? "检测中…" : pdfMathStatus.available ? "已连接" : "未安装"}
            </span>
            {pdfMathStatus.command ? <code>{pdfMathStatus.command}</code> : null}
            <button type="button" className="settings-refresh-btn" onClick={refreshPdfMathStatus} title="重新检测">
              <RefreshCw size={13} />
            </button>
          </div>
          <div className="pdfmath-install-row">
            <Button
              size="sm"
              icon={Download}
              onClick={installPdfMath}
              disabled={pdfMathInstalling}
            >
              {pdfMathInstalling ? "安装中…" : pdfMathStatus.available ? "重新安装到本机" : "安装到本机"}
            </Button>
            {pdfMathStatus.install?.progress ? <em>{pdfMathStatus.install.progress}</em> : null}
          </div>
          {pdfMathInstalling && pdfMathStatus.install?.percent ? (
            <div className="pdfmath-install-track" aria-hidden="true">
              <i style={{ width: `${Math.max(4, pdfMathStatus.install.percent)}%` }} />
            </div>
          ) : null}
          <label className="proxy-field pdfmath-bin-field">
            <span>
              <strong>pdf2zh 可执行文件（可选）</strong>
              <em>一键安装会放到项目 tools/pdf2zh/。已有路径可继续手动填写。</em>
            </span>
            <input
              value={settings?.pdfMathTranslateBin || ""}
              onChange={(e) => updateSettings({ pdfMathTranslateBin: e.target.value })}
              placeholder="例如 C:\\Tools\\pdf2zh\\pdf2zh.exe"
            />
          </label>
          <div className="settings-note pdfmath-note">
            <Info size={15} />
            <p>
              安装包来自 <a href="https://github.com/PDFMathTranslate/PDFMathTranslate-next/releases" target="_blank" rel="noreferrer">PDFMathTranslate-next Releases</a>，约 240MB，只留在本机，不会提交到 git。生成译文时使用临时配置，API Key 不写入数据文件。
            </p>
          </div>
        </section>

        <section className="panel settings-panel">
          <div className="settings-head"><Minimize2 size={17} /> 系统托盘</div>
          <label className="settings-toggle-row">
            <span>
              <strong>关闭窗口时最小化到系统托盘</strong>
              <em>关闭后应用继续在后台运行，可从托盘图标恢复或彻底退出。</em>
            </span>
            <input
              type="checkbox"
              checked={settings?.minimizeToTray !== false}
              onChange={(e) => updateSettings({ minimizeToTray: e.target.checked })}
            />
            <i className="toggle-track" />
          </label>
        </section>

        <section className="panel settings-panel">
          <div className="settings-head"><Route size={17} /> 学习路径</div>
          <label className="settings-toggle-row">
            <span>
              <strong>启用学习路径</strong>
              <em>关闭后隐藏路径入口、进度和 Agent 路径引导；已有路径数据会保留。</em>
            </span>
            <input
              type="checkbox"
              checked={settings?.learningPathEnabled !== false}
              onChange={toggleLearningPath}
              disabled={learningPathSaving}
            />
            <i className="toggle-track" />
          </label>
        </section>

        <section className="panel settings-panel">
          <div className="settings-head"><Globe2 size={17} /> 网络代理</div>
          <label className="proxy-field">
            <span>
              <strong>代理地址（可选）</strong>
              <em>用于加载外刊 PDF 和检索接口；留空时自动尝试系统代理。</em>
            </span>
            <input
              value={settings?.proxy || ""}
              onChange={(e) => updateSettings({ proxy: e.target.value.trim() })}
              placeholder="例如 http://127.0.0.1:7890"
            />
          </label>
        </section>

        <section className="panel settings-panel institution-settings-panel">
          <div className="settings-head"><School size={17} /> 机构资源访问</div>
          <p className="institution-intro">配置学校图书馆、研究机构或医院的统一认证入口。适用于 WebVPN、CARSI、EZproxy 及自定义数据库门户。</p>
          <div className="institution-form-grid">
            <label>
              <span>学校 / 机构名称</span>
              <input
                value={institutionDraft.name}
                onChange={(e) => setInstitutionDraft((v) => ({ ...v, name: e.target.value }))}
                placeholder="例如：某某大学图书馆"
              />
            </label>
            <label>
              <span>接入类型</span>
              <select value={institutionDraft.type} onChange={(e) => setInstitutionDraft((v) => ({ ...v, type: e.target.value }))}>
                <option value="webvpn">WebVPN / 统一认证</option>
                <option value="carsi">CARSI</option>
                <option value="ezproxy">EZproxy</option>
                <option value="custom">自定义数据库门户</option>
              </select>
            </label>
            <label className="institution-url-field">
              <span>机构入口网址</span>
              <input
                value={institutionDraft.portalUrl}
                onChange={(e) => setInstitutionDraft((v) => ({ ...v, portalUrl: e.target.value }))}
                placeholder="https://webvpn.example.edu.cn/"
              />
            </label>
          </div>
          <div className="institution-actions">
            <Button variant="secondary" icon={ShieldCheck} onClick={() => saveInstitution(false)}>保存配置</Button>
            <Button icon={LogIn} onClick={() => saveInstitution(true)}>保存并打开机构入口</Button>
          </div>
          <div className="settings-note institution-note">
            <ShieldCheck size={15} />
            <p>ScholarLoop 不保存学校账号、密码或验证码。请在机构内嵌页面中登录；Electron 桌面版会把登录 Cookie 保存在独立的本机会话中。</p>
          </div>
        </section>

        <section className="panel settings-panel">
          <div className="settings-head"><Database size={17} /> 数据管理</div>
          <div className="data-actions">
            <Button icon={Download} onClick={exportData}>导出备份</Button>
            <Button variant="secondary" icon={Upload} onClick={() => fileRef.current?.click()}>导入备份</Button>
            <input ref={fileRef} type="file" accept="application/json" style={{ display: "none" }} onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) importFile(file).catch((err) => setMsg(err.message));
            }} />
            <Button variant="danger" icon={Trash2} onClick={clearAll}>清空数据</Button>
          </div>
          {msg ? <p className="settings-msg">{msg}</p> : null}
        </section>

        <section className="panel settings-panel">
          <div className="settings-head"><ShieldCheck size={17} /> 本地优先</div>
          <p className="privacy-text">所有文献、笔记、学习路径和论文草稿都保存在本机 <code>data/store.json</code>，不会上传到任何服务器。聚合检索只在点击搜索时访问公开学术 API。</p>
        </section>
      </div>

      <section className="panel about-panel">
        <div className="settings-head"><Info size={17} /> 关于 ScholarLoop</div>
        <p>ScholarLoop V1.1 帮助你把“学基础 → 找文献 → 读摘要 → 深理解 → 复述输出 → 写论文”串成一条可追踪的闭环。当前版本包含：六源聚合检索、摘要结构化解读、版式对照翻译、阅读手记与独立手记、五问阅读法、理解等级与复习安排、七阶段学习路径、论文草稿与引用管理。</p>
        <div className="about-counts">
          <span><strong>{library.length}</strong> 篇文献</span>
          <span><strong>{path?.stages?.length || 0}</strong> 个学习阶段</span>
          <span><strong>{drafts.length}</strong> 篇草稿</span>
        </div>
        <a className="external-link" href="https://api.semanticscholar.org" target="_blank" rel="noreferrer">Semantic Scholar API 偶尔限流，重试即可 <ExternalLink size={13} /></a>
      </section>
    </div>
  );
}
