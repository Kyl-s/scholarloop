import { useCallback, useEffect, useState } from "react";
import Shell from "./components/Shell.jsx";
import Dashboard from "./pages/Dashboard.jsx";
import SearchPage from "./pages/SearchPage.jsx";
import LibraryPage from "./pages/LibraryPage.jsx";
import PathPage from "./pages/PathPage.jsx";
import JournalsPage from "./pages/JournalsPage.jsx";
import WriterPage from "./pages/WriterPage.jsx";
import NotesPage from "./pages/NotesPage.jsx";
import SettingsPage from "./pages/SettingsPage.jsx";
import AgentFocusPage from "./pages/AgentFocusPage.jsx";
import MemoryPage from "./pages/MemoryPage.jsx";
import PdfReader from "./components/PdfReader.jsx";
import PdfReaderBoundary from "./components/PdfReaderBoundary.jsx";
import PdfIngestDialog from "./components/PdfIngestDialog.jsx";

export default function App() {
  const [view, setView] = useState({ page: "dashboard", subtitle: "" });
  const [focusPaper, setFocusPaper] = useState(null);
  const [searchSession, setSearchSession] = useState(null);
  const [quickAgentOpen, setQuickAgentOpen] = useState(false);
  const [reader, setReader] = useState(null);
  // 捕获到的 PDF 下载（preload 拦截），非空时弹出入库确认对话框
  const [pdfDownload, setPdfDownload] = useState(null);
  const [toast, setToast] = useState("");

  // 订阅 preload 的 PDF 下载拦截；API 尚未就绪时静默不启用拦截功能
  useEffect(() => {
    const off = window.scholarloopDownloads?.onPdfDownload?.((info) => {
      if (info) setPdfDownload(info);
    });
    return () => {
      if (typeof off === "function") off();
    };
  }, []);

  const showToast = (msg) => {
    setToast(msg);
    setTimeout(() => setToast(""), 3000);
  };


  const navigate = useCallback((next) => {
    setView((prev) => ({
      ...prev,
      ...next,
      query: Object.prototype.hasOwnProperty.call(next, "query") ? next.query : ""
    }));
  }, []);

  const updateSearchSession = useCallback((session) => setSearchSession(session), []);

  const search = (query) => {
    setView({ page: "search", subtitle: "", query });
    window.scrollTo(0, 0);
  };

  const openPaper = (paper) => {
    setFocusPaper(paper);
    setView((prev) => ({ ...prev, page: "library", subtitle: "文献库" }));
  };

  const openReader = (pdfUrl, title, doi, paperId, options = {}) => setReader({
    url: pdfUrl,
    title: title || "PDF 文档",
    doi,
    paperId,
    page: Number(options.page) > 0 ? Number(options.page) : null,
    tab: options.tab || null
  });

  return (
    <Shell
      view={view}
      onNavigate={navigate}
      onSearch={search}
      quickAgentOpen={quickAgentOpen}
      onQuickAgentChange={setQuickAgentOpen}
    >
      {view.page === "dashboard" ? <Dashboard onNavigate={navigate} onOpenPaper={openPaper} /> : null}
      {view.page === "search" ? (
        <SearchPage
          initialQuery={view.query || ""}
          savedSession={searchSession}
          onSessionChange={updateSearchSession}
          onPaperSaved={() => {}}
          onReadPdf={openReader}
          initialInstitutionOpen={Boolean(view.openInstitution)}
          initialPortalUrl={view.initialPortalUrl || ""}
          initialPortalTitle={view.initialPortalTitle || ""}
        />
      ) : null}
      {view.page === "library" ? (
        <LibraryPage focusPaper={focusPaper} onFocusCleared={() => setFocusPaper(null)} onReadPdf={openReader} />
      ) : null}
      {view.page === "memory" ? <MemoryPage /> : null}
      {view.page === "path" ? <PathPage onNavigate={navigate} /> : null}
      {view.page === "journals" ? <JournalsPage /> : null}
      {view.page === "notes" ? <NotesPage onReadPdf={openReader} /> : null}
      {view.page === "writer" ? <WriterPage onReadPdf={openReader} /> : null}
      {view.page === "agent" ? <AgentFocusPage onOpenQuick={() => setQuickAgentOpen(true)} onNavigate={navigate} /> : null}
      {view.page === "settings" ? <SettingsPage onNavigate={navigate} /> : null}
      {reader ? (
        <PdfReaderBoundary onClose={() => setReader(null)}>
          <PdfReader
            url={reader.url}
            title={reader.title}
            doi={reader.doi}
            paperId={reader.paperId}
            initialPage={reader.page}
            initialTab={reader.tab}
            onOpenPortal={(context = {}) => {
              setReader(null);
              navigate({
                page: "search",
                subtitle: "论文搜索",
                openInstitution: true,
                initialPortalUrl: context?.url || reader.url || "",
                initialPortalTitle: context?.title || reader.title || ""
              });
            }}
          onClose={() => setReader(null)}
        />
        </PdfReaderBoundary>
      ) : null}
      {/* PDF 下载入库确认对话框（顶层挂载，任何页面捕获到下载都可弹出） */}
      {pdfDownload ? (
        <PdfIngestDialog
          download={pdfDownload}
          onClose={() => setPdfDownload(null)}
          onIngested={(paper) => {
            setPdfDownload(null);
            showToast(`已入库：${paper?.title || "文献"}`);
          }}
        />
      ) : null}
      {toast ? <div className="toast">{toast}</div> : null}
    </Shell>
  );
}
