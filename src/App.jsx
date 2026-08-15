import { useCallback, useState } from "react";
import Shell from "./components/Shell.jsx";
import Dashboard from "./pages/Dashboard.jsx";
import SearchPage from "./pages/SearchPage.jsx";
import LibraryPage from "./pages/LibraryPage.jsx";
import PathPage from "./pages/PathPage.jsx";
import JournalsPage from "./pages/JournalsPage.jsx";
import WriterPage from "./pages/WriterPage.jsx";
import SettingsPage from "./pages/SettingsPage.jsx";
import AgentFocusPage from "./pages/AgentFocusPage.jsx";
import MemoryPage from "./pages/MemoryPage.jsx";
import PdfReader from "./components/PdfReader.jsx";

export default function App() {
  const [view, setView] = useState({ page: "dashboard", subtitle: "" });
  const [focusPaper, setFocusPaper] = useState(null);
  const [searchSession, setSearchSession] = useState(null);
  const [quickAgentOpen, setQuickAgentOpen] = useState(false);
  const [reader, setReader] = useState(null);

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

  const openReader = (pdfUrl, title, doi, paperId) => setReader({ url: pdfUrl, title: title || "PDF 文档", doi, paperId });

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
        />
      ) : null}
      {view.page === "library" ? (
        <LibraryPage focusPaper={focusPaper} onFocusCleared={() => setFocusPaper(null)} onReadPdf={openReader} />
      ) : null}
      {view.page === "memory" ? <MemoryPage /> : null}
      {view.page === "path" ? <PathPage onNavigate={navigate} /> : null}
      {view.page === "journals" ? <JournalsPage /> : null}
      {view.page === "writer" ? <WriterPage /> : null}
      {view.page === "agent" ? <AgentFocusPage onOpenQuick={() => setQuickAgentOpen(true)} onNavigate={navigate} /> : null}
      {view.page === "settings" ? <SettingsPage onNavigate={navigate} /> : null}
      {reader ? <PdfReader url={reader.url} title={reader.title} doi={reader.doi} paperId={reader.paperId} onClose={() => setReader(null)} /> : null}
    </Shell>
  );
}
