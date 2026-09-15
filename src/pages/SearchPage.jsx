import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Search, SlidersHorizontal, ExternalLink, AppWindow, BookmarkPlus, Loader2, Globe2, FileText, ChevronRight, RotateCw, Trash2, Sparkles, ArrowLeft, ArrowRight, RefreshCw, KeyRound, LogIn, X } from "lucide-react";
import { api } from "../api.js";
import { useData } from "../store.jsx";
import PaperDetail from "../components/PaperDetail.jsx";
import { webviewFailureMessage } from "../webview.js";
import { Badge, Button, EmptyState, IconButton, SourceTag, Spinner } from "../components/ui.jsx";
import { loadAgentConfig } from "../agentConfig.js";
import { isSafeBrowserUrl, normalizeBrowserUrl, createBrowserTab, createBlankBrowserTab, getBrowserTabLabel } from "../browserTabs.js";
import { isDirectPdfUrl } from "../pdfSource.js";

const SOURCE_OPTIONS = [
  { id: "arxiv", label: "arXiv" },
  { id: "openalex", label: "OpenAlex" },
  { id: "semanticscholar", label: "Semantic Scholar" },
  { id: "pubmed", label: "PubMed" },
  { id: "crossref", label: "Crossref" },
  { id: "cnki", label: "知网 CNKI" }
  ,{ id: "ieee", label: "IEEE Xplore" }
  ,{ id: "wos", label: "Web of Science" }
];

const DEFAULT_SOURCES = SOURCE_OPTIONS.filter((s) => !["ieee", "wos"].includes(s.id)).map((s) => s.id);
const PAGE_SIZE = 20;

const SAMPLE_QUERIES = ["transformer attention", "multimodal learning", "protein structure prediction", "强化学习 机器人", "large language models"];

function buildPageNumbers(current, total) {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const wanted = new Set([1, 2, current - 1, current, current + 1, total - 1, total]);
  const numbers = [...wanted].filter((n) => n >= 1 && n <= total).sort((a, b) => a - b);
  const out = [];
  let prev = 0;
  for (const n of numbers) {
    if (n - prev > 1) out.push("...");
    out.push(n);
    prev = n;
  }
  return out;
}

const BROWSER_SITES = [
  { id: "cnki", label: "知网", home: "https://www.cnki.net", url: (q) => `https://kns.cnki.net/kns8s/defaultresult/index?kw=${encodeURIComponent(q)}` },
  { id: "wanfang", label: "万方", home: "https://www.wanfangdata.com.cn", url: (q) => `https://s.wanfangdata.com.cn/paper?q=${encodeURIComponent(q)}` },
  { id: "baidu", label: "百度学术", home: "https://xueshu.baidu.com", url: (q) => `https://xueshu.baidu.com/s?wd=${encodeURIComponent(q)}` },
  { id: "googlescholar", label: "Google Scholar", home: "https://scholar.google.com", url: (q) => `https://scholar.google.com/scholar?q=${encodeURIComponent(q)}` },
  { id: "arxiv", label: "arXiv", home: "https://arxiv.org", url: (q) => `https://arxiv.org/search/?query=${encodeURIComponent(q)}&searchtype=all` },
  { id: "openalex", label: "OpenAlex", home: "https://openalex.org", url: (q) => `https://openalex.org/search?q=${encodeURIComponent(q)}` },
  { id: "pubmed", label: "PubMed", home: "https://pubmed.ncbi.nlm.nih.gov", url: (q) => `https://pubmed.ncbi.nlm.nih.gov/?term=${encodeURIComponent(q)}` },
  { id: "semanticscholar", label: "Semantic Scholar", home: "https://www.semanticscholar.org", url: (q) => `https://www.semanticscholar.org/search?q=${encodeURIComponent(q)}` }
  ,{ id: "ieee", label: "IEEE Xplore", home: "https://ieeexplore.ieee.org", url: (q) => `https://ieeexplore.ieee.org/search/searchresult.jsp?newsearch=true&queryText=${encodeURIComponent(q)}` }
  ,{ id: "wos", label: "Web of Science", home: "https://www.webofscience.com", url: (q) => `https://www.webofscience.com/wos/woscc/basic-search?query=${encodeURIComponent(q)}` }
];

export default function SearchPage({ initialQuery = "", savedSession = null, onSessionChange, onPaperSaved, onReadPdf, initialInstitutionOpen = false, initialPortalUrl = "", initialPortalTitle = "" }) {
  const { library, savePaper, path, settings } = useData();
  const institutionSite = useMemo(() => {
    const access = settings?.institutionAccess;
    if (!access?.enabled || !/^https:\/\//i.test(access.portalUrl || "")) return null;
    return {
      id: "institution",
      label: access.name || "图书馆门户",
      home: access.portalUrl,
      url: () => access.portalUrl,
      type: access.type || "custom"
    };
  }, [settings?.institutionAccess]);
  const initialPortalSite = useMemo(() => {
    const home = normalizeBrowserUrl(initialPortalUrl);
    if (!home) return null;
    return {
      id: "reader-portal",
      label: initialPortalTitle || "PDF 来源门户",
      home,
      url: () => home,
      type: "reader"
    };
  }, [initialPortalTitle, initialPortalUrl]);
  const browserSites = useMemo(() => {
    const sites = institutionSite ? [institutionSite, ...BROWSER_SITES] : BROWSER_SITES;
    return initialPortalSite ? [initialPortalSite, ...sites] : sites;
  }, [initialPortalSite, institutionSite]);
  const [query, setQuery] = useState(initialQuery);
  const [activeQuery, setActiveQuery] = useState("");
  const [sources, setSources] = useState(DEFAULT_SOURCES);
  const [fromYear, setFromYear] = useState("");
  const [toYear, setToYear] = useState("");
  const [sort, setSort] = useState("authority");
  const [results, setResults] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState([]);
  const [queries, setQueries] = useState([]);
  const [selected, setSelected] = useState(null);
  const [showFilters, setShowFilters] = useState(false);
  const [aiSearch, setAiSearch] = useState(() => Boolean(loadAgentConfig()?.apiKey));
  const [aiInstruction, setAiInstruction] = useState("");
  const [aiPlan, setAiPlan] = useState(null);
  const [browserOpen, setBrowserOpen] = useState(false);
  const [browserTabs, setBrowserTabs] = useState([]);
  const [activeBrowserTabId, setActiveBrowserTabId] = useState("");
  const [tabLoading, setTabLoading] = useState({});
  const [tabErrors, setTabErrors] = useState({});
  const [tabTitles, setTabTitles] = useState({});
  const [browserAddress, setBrowserAddress] = useState("");
  const [aiPlanning, setAiPlanning] = useState(false);
  const [resultFilter, setResultFilter] = useState("all");
  const [page, setPage] = useState(1);
  const webviewRefs = useRef(new Map());
  const browserRef = useRef(null);
  const institutionOpenedRef = useRef(false);
  const isElectron = typeof navigator !== "undefined" && navigator.userAgent.includes("Electron");
  const firstRun = useRef(true);
  const [hydrated, setHydrated] = useState(false);
  const lastInitialQuery = useRef(initialQuery);
  const defaultsAppliedRef = useRef(false);

  useEffect(() => {
    if (defaultsAppliedRef.current || savedSession || !settings?.paperSources) return;
    defaultsAppliedRef.current = true;
    const configured = Object.entries(settings.paperSources)
      .filter(([id, source]) => ["ieee", "wos"].includes(id) && source?.enabled !== false && (source?.configured || String(source?.apiKey || "").trim()))
      .map(([id]) => id);
    if (configured.length) setSources((current) => [...new Set([...current, ...configured])]);
  }, [settings?.paperSources, savedSession]);
  const runSearch = useCallback(async (q, opts = {}) => {
    const term = (q ?? query).trim();
    if (!term) return;
    setQuery(term);
    const sessionSources = opts.sources || sources;
    const sessionFromYear = opts.fromYear !== undefined ? opts.fromYear : fromYear;
    const sessionToYear = opts.toYear !== undefined ? opts.toYear : toYear;
    const sessionSort = opts.sort || sort;
    const sessionInstruction = opts.instruction !== undefined ? opts.instruction : aiInstruction;
    const useAi = opts.aiSearch !== undefined ? opts.aiSearch : aiSearch;
    setLoading(true);
    setError("");
    setActiveQuery(term);
    setResultFilter("all");
    setPage(1);
    if (useAi) setAiPlanning(true);
    try {
      let plan = null;
      if (useAi) {
        try {
          plan = await api.searchPlan({
            q: term,
            field: path?.field || "",
            goal: path?.goal || "",
            instruction: sessionInstruction
          });
        } catch (planErr) {
          plan = { queries: [term], rationale: "AI 规划暂时不可用，已退回关键词直搜。", mode: "keyword" };
        }
      }
      setAiPlan(plan);
      const data = await api.search({
        q: term,
        queries: plan?.queries,
        sources: sessionSources,
        sourceCredentials: settings?.paperSources || {},
        fromYear: sessionFromYear,
        toYear: sessionToYear,
        sort: sessionSort,
        limit: 100
      });
      const session = {
        query: term,
        activeQuery: term,
        sources: sessionSources,
        fromYear: sessionFromYear,
        toYear: sessionToYear,
        sort: sessionSort,
        aiSearch: useAi,
        aiInstruction: sessionInstruction,
        aiPlan: plan,
        results: data.papers,
        status: data.sourceStatus || [],
        queries: data.queries || [],
        resultFilter: "all",
        browserOpen,
        browserTabs,
        activeBrowserTabId,
        page
      };
      setResults(session.results);
      setStatus(session.status);
      setQueries(session.queries);
      onSessionChange?.(session);
    } catch (err) {
      setError(err.message);
      setResults([]);
      setQueries([]);
      onSessionChange?.({
        query: term,
        activeQuery: term,
        sources: sessionSources,
        fromYear: sessionFromYear,
        toYear: sessionToYear,
        sort: sessionSort,
        aiSearch: useAi,
        aiInstruction: sessionInstruction,
        aiPlan: plan,
        results: [],
        status: [],
        queries: [],
        resultFilter: "all",
        browserOpen,
        browserTabs,
        activeBrowserTabId,
        page
      });
    } finally {
      setLoading(false);
      setAiPlanning(false);
    }
  }, [query, sources, fromYear, toYear, sort, aiSearch, aiInstruction, path?.field, path?.goal, browserOpen, browserTabs, activeBrowserTabId, page, onSessionChange]);

  const restoreSession = (session) => {
    if (!session) return;
    setQuery(session.query || "");
    setActiveQuery(session.activeQuery || "");
    setSources(Array.isArray(session.sources) && session.sources.length ? session.sources : DEFAULT_SOURCES);
    setFromYear(session.fromYear || "");
    setToYear(session.toYear || "");
    setSort(session.sort || "authority");
    setResults(Array.isArray(session.results) ? session.results : null);
    setStatus(Array.isArray(session.status) ? session.status : []);
    setQueries(Array.isArray(session.queries) ? session.queries : []);
    setShowFilters(Boolean(session.showFilters));
    setAiSearch(Boolean(session.aiSearch));
    setAiInstruction(session.aiInstruction || "");
    setAiPlan(session.aiPlan || null);
    setResultFilter(session.resultFilter || "all");
    setPage(Number(session.page) > 0 ? Number(session.page) : 1);

    // Keep the embedded browser alongside the search session so sidebar navigation
    // does not reset the visible tabs or the active institutional page.
    if (Array.isArray(session.browserTabs)) {
      const restoredTabs = session.browserTabs.map((candidate) => candidate?.blank
        ? createBlankBrowserTab(candidate)
        : createBrowserTab(candidate)).filter(Boolean);
      setBrowserTabs(restoredTabs);
      const requestedTabId = String(session.activeBrowserTabId || "");
      setActiveBrowserTabId(restoredTabs.some((tab) => tab.id === requestedTabId)
        ? requestedTabId
        : (restoredTabs[0]?.id || ""));
      setBrowserOpen(Boolean(session.browserOpen));
      setTabLoading({});
      setTabErrors({});
      setTabTitles({});
    }
  };

  useEffect(() => {
    if (!firstRun.current) return;
    firstRun.current = false;
    if (initialQuery && (!savedSession || savedSession.query !== initialQuery)) {
      runSearch(initialQuery, {
        sources: savedSession?.sources,
        fromYear: savedSession?.fromYear,
        toYear: savedSession?.toYear,
        sort: savedSession?.sort
      });
    } else if (savedSession) {
      restoreSession(savedSession);
    }
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (lastInitialQuery.current === initialQuery) return;
    lastInitialQuery.current = initialQuery;
    if (!initialQuery) return;
    setQuery(initialQuery);
    runSearch(initialQuery, {
      sources: savedSession?.sources,
      fromYear: savedSession?.fromYear,
      toYear: savedSession?.toYear,
      sort: savedSession?.sort
    });
  }, [initialQuery, savedSession, runSearch]);

  useEffect(() => {
    if (!hydrated) return;
    onSessionChange?.({
      query,
      activeQuery,
      sources,
      fromYear,
      toYear,
      sort,
      results,
      status,
      queries,
      showFilters,
      aiSearch,
      aiInstruction,
      aiPlan,
      resultFilter,
      browserOpen,
      browserTabs,
      activeBrowserTabId,
      page
    });
  }, [hydrated, query, activeQuery, sources, fromYear, toYear, sort, results, status, queries, showFilters, aiSearch, aiInstruction, aiPlan, resultFilter, page, browserOpen, browserTabs, activeBrowserTabId, onSessionChange]);

  const clearSession = () => {
    setQuery("");
    setActiveQuery("");
    setSources(DEFAULT_SOURCES);
    setFromYear("");
    setToYear("");
    setSort("authority");
    setResults(null);
    setStatus([]);
    setQueries([]);
    setSelected(null);
    setShowFilters(false);
    setAiInstruction("");
    setAiPlan(null);
    setResultFilter("all");
    setPage(1);
    onSessionChange?.(null);
  };

  const toggleSource = (id) => {
    setSources((prev) => (prev.includes(id) ? prev.filter((s) => s !== id) : [...prev, id]));
  };

  const activeBrowserTab = browserTabs.find((tab) => tab.id === activeBrowserTabId) || browserTabs[0] || null;
  const browserSite = browserSites.find((site) => site.id === activeBrowserTab?.siteId) || activeBrowserTab?.site || (activeBrowserTab?.blank ? { id: "blank", label: activeBrowserTab.title || "新标签", home: "", url: () => "" } : (activeBrowserTab ? { id: "popup", label: activeBrowserTab.title || activeBrowserTab.label || "新标签", home: activeBrowserTab.url, url: () => activeBrowserTab.url } : BROWSER_SITES[0]));
  const browserUrl = activeBrowserTab ? (activeBrowserTab.url || "") : (browserSite.home || "");
  const browserLoading = Boolean(activeBrowserTab && tabLoading[activeBrowserTab.id]);
  const browserError = activeBrowserTab ? (tabErrors[activeBrowserTab.id] || "") : "";

  useEffect(() => {
    setBrowserAddress(browserUrl);
  }, [activeBrowserTabId, browserUrl]);

  const scrollToBrowser = () => {
    const el = browserRef.current;
    if (!el) return;
    const scroller = el.closest(".content") || document.scrollingElement;
    const top = el.getBoundingClientRect().top + scroller.scrollTop;
    scroller.scrollTo({ top: top - 8, behavior: "auto" });
  };

  const selectBrowserSite = (site) => {
    if (!site || !isSafeBrowserUrl(site.home)) return;
    const tabId = "site:" + site.id;
    setBrowserTabs((prev) => prev.some((tab) => tab.id === tabId)
      ? prev.map((tab) => tab.id === tabId ? { ...tab, site, siteId: site.id } : tab)
      : [...prev, createBrowserTab({ id: tabId, siteId: site.id, title: site.label, url: site.home, site })]);
    setActiveBrowserTabId(tabId);
    setTabErrors((prev) => ({ ...prev, [tabId]: "" }));
    setTabLoading((prev) => ({ ...prev, [tabId]: true }));
    setBrowserOpen(true);
    setTimeout(scrollToBrowser, 120);
  };

  const openBrowserPopup = useCallback((url) => {
    if (!isSafeBrowserUrl(url)) {
      if (activeBrowserTabId) setTabErrors((prev) => ({ ...prev, [activeBrowserTabId]: "该链接协议不受支持，已阻止打开。" }));
      return;
    }
    const existing = browserTabs.find((tab) => tab.url === url);
    if (existing) {
      setActiveBrowserTabId(existing.id);
      setBrowserOpen(true);
      return;
    }
    const tab = createBrowserTab({ url, title: getBrowserTabLabel({ url }), siteId: "popup", dynamic: true });
    setBrowserTabs((prev) => [...prev, tab]);
    setActiveBrowserTabId(tab.id);
    setTabLoading((prev) => ({ ...prev, [tab.id]: true }));
    setTabErrors((prev) => ({ ...prev, [tab.id]: "" }));
    setBrowserOpen(true);
    setTimeout(scrollToBrowser, 120);
  }, [activeBrowserTabId, browserTabs]);

  const openBlankBrowserTab = () => {
    const tab = createBlankBrowserTab({ id: "blank-" + Date.now() });
    setBrowserTabs((prev) => [...prev, tab]);
    setActiveBrowserTabId(tab.id);
    setTabLoading((prev) => ({ ...prev, [tab.id]: false }));
    setTabErrors((prev) => ({ ...prev, [tab.id]: "" }));
    setBrowserOpen(true);
    setTimeout(scrollToBrowser, 120);
  };

  const closeBrowserTab = (tabId) => {
    setBrowserTabs((prev) => {
      const index = prev.findIndex((tab) => tab.id === tabId);
      if (index < 0) return prev;
      if (prev[index].closable === false) return prev;
      let next = prev.filter((tab) => tab.id !== tabId);
      if (!next.length) next = [createBlankBrowserTab({ id: "blank-" + Date.now() })];
      if (tabId === activeBrowserTabId) {
        const fallback = next[Math.min(index, Math.max(0, next.length - 1))];
        setActiveBrowserTabId(fallback?.id || "");
      }
      return next;
    });
    setTabLoading((prev) => { const next = { ...prev }; delete next[tabId]; return next; });
    setTabErrors((prev) => { const next = { ...prev }; delete next[tabId]; return next; });
    setTabTitles((prev) => { const next = { ...prev }; delete next[tabId]; return next; });
    webviewRefs.current.delete(tabId);
  };

  const updateBrowserTab = (tabId, patch) => {
    setBrowserTabs((prev) => prev.map((tab) => tab.id === tabId ? { ...tab, ...patch } : tab));
  };

  const searchCurrentSite = () => {
    const term = activeQuery || query || "论文";
    const target = browserSite.id === "institution" ? browserSite.home : browserSite.url(term);
    if (!isSafeBrowserUrl(target) || !activeBrowserTabId) return;
    updateBrowserTab(activeBrowserTabId, { url: target });
    setTabErrors((prev) => ({ ...prev, [activeBrowserTabId]: "" }));
    setTabLoading((prev) => ({ ...prev, [activeBrowserTabId]: true }));
  };

  const toggleBrowserPanel = () => {
    const next = !browserOpen;
    setBrowserOpen(next);
    if (next && !browserTabs.length && browserSites[0]) selectBrowserSite(browserSites[0]);
    if (next) setTimeout(scrollToBrowser, 120);
  };

  const activeWebview = activeBrowserTabId ? webviewRefs.current.get(activeBrowserTabId) : null;
  const openCurrentPageInReader = () => {
    const currentUrl = isElectron ? (activeWebview?.getURL?.() || browserUrl) : browserUrl;
    if (!isSafeBrowserUrl(currentUrl)) return;
    if (!isDirectPdfUrl(currentUrl)) {
      setTabErrors((prev) => ({
        ...prev,
        [activeBrowserTabId]: "当前页不是可直接打开的 PDF。请打开 PDF 链接后再点「阅读当前 PDF」，或继续在门户中访问。"
      }));
      return;
    }
    const currentTitle = isElectron ? (activeWebview?.getTitle?.() || tabTitles[activeBrowserTabId] || browserSite.label) : browserSite.label;
    onReadPdf?.(currentUrl, currentTitle || "机构资源 PDF");
  };

  const openCurrentPageInNewTab = () => {
    const currentUrl = isElectron ? (activeWebview?.getURL?.() || browserUrl) : browserUrl;
    if (!isSafeBrowserUrl(currentUrl)) return;
    const currentTitle = isElectron ? (activeWebview?.getTitle?.() || tabTitles[activeBrowserTabId] || getBrowserTabLabel(activeBrowserTab)) : getBrowserTabLabel(activeBrowserTab);
    const tab = createBrowserTab({ id: "popup-" + Date.now(), url: currentUrl, title: currentTitle, siteId: "popup", dynamic: true });
    if (!tab) return;
    setBrowserTabs((prev) => [...prev, tab]);
    setActiveBrowserTabId(tab.id);
    setTabLoading((prev) => ({ ...prev, [tab.id]: true }));
    setTabErrors((prev) => ({ ...prev, [tab.id]: "" }));
  };

  const openInstitutionLogin = async () => {
    try {
      await window.scholarloop?.openInstitution?.(browserSite.home || browserUrl);
      setTabErrors((prev) => ({ ...prev, [activeBrowserTabId]: "" }));
    } catch (err) {
      setTabErrors((prev) => ({ ...prev, [activeBrowserTabId]: err.message || "无法打开机构登录窗口" }));
    }
  };

  useEffect(() => {
    if (!initialInstitutionOpen || institutionOpenedRef.current) return;
    const site = initialPortalSite || institutionSite;
    if (!site) return;
    institutionOpenedRef.current = true;
    selectBrowserSite(site);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialInstitutionOpen, initialPortalSite, institutionSite]);

  useEffect(() => {
    if (!isElectron || typeof window.scholarloop?.onInstitutionPopup !== "function") return undefined;
    return window.scholarloop.onInstitutionPopup((url) => openBrowserPopup(url));
  }, [isElectron, openBrowserPopup]);

  useEffect(() => {
    if (!isElectron || !browserOpen) return undefined;
    const cleanups = [];
    browserTabs.forEach((tab) => {
      const wv = webviewRefs.current.get(tab.id);
      if (!wv || typeof wv.addEventListener !== "function") return;
      const onStart = () => {
        setTabLoading((prev) => ({ ...prev, [tab.id]: true }));
        setTabErrors((prev) => ({ ...prev, [tab.id]: "" }));
      };
      const syncLocation = () => {
        const current = wv.getURL?.();
        const title = wv.getTitle?.();
        const patch = {};
        if (current && isSafeBrowserUrl(current)) patch.url = current;
        if (title) patch.title = title;
        if (Object.keys(patch).length) updateBrowserTab(tab.id, patch);
      };
      const onStop = () => {
        setTabLoading((prev) => ({ ...prev, [tab.id]: false }));
        syncLocation();
        const title = wv.getTitle?.();
        if (title) {
          setTabTitles((prev) => ({ ...prev, [tab.id]: title }));
          updateBrowserTab(tab.id, { title });
        }
      };
      const onFail = (event) => {
        const message = webviewFailureMessage(event);
        if (!message) return;
        setTabLoading((prev) => ({ ...prev, [tab.id]: false }));
        setTabErrors((prev) => ({ ...prev, [tab.id]: message }));
      };
      wv.addEventListener("did-start-loading", onStart);
      wv.addEventListener("did-stop-loading", onStop);
      wv.addEventListener("did-fail-load", onFail);
      wv.addEventListener("did-navigate", syncLocation);
      wv.addEventListener("did-navigate-in-page", syncLocation);
      wv.addEventListener("page-title-updated", syncLocation);
      cleanups.push(() => {
        wv.removeEventListener("did-start-loading", onStart);
        wv.removeEventListener("did-stop-loading", onStop);
        wv.removeEventListener("did-fail-load", onFail);
        wv.removeEventListener("did-navigate", syncLocation);
        wv.removeEventListener("did-navigate-in-page", syncLocation);
        wv.removeEventListener("page-title-updated", syncLocation);
      });
    });
    return () => cleanups.forEach((cleanup) => cleanup());
  }, [isElectron, browserOpen, browserTabs]);
  const saveAndOpen = async (paper) => {
    const saved = await savePaper(paper);
    onPaperSaved?.(saved);
    setSelected(saved);
    return saved;
  };

  const sourceCounts = {};
  for (const paper of results || []) {
    for (const sourceId of (paper.sources || [paper.source])) sourceCounts[sourceId] = (sourceCounts[sourceId] || 0) + 1;
  }
  const filteredResults = resultFilter === "all" ? (results || []) : (results || []).filter((p) => (p.sources || [p.source]).includes(resultFilter));
  const totalPages = Math.max(1, Math.ceil(filteredResults.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const pageResults = filteredResults.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  return (
    <div className="search-page page">
      <section className="search-hero">
        <div className="search-hero-copy">
          <h2>聚合检索全球论文</h2>
          <p>一次输入，同时搜索 arXiv、OpenAlex、Semantic Scholar、PubMed、Crossref、知网，以及已授权的 IEEE Xplore / Web of Science；未授权来源可从门户登录检索。</p>
        </div>
        <form
          className="search-form"
          onSubmit={(e) => {
            e.preventDefault();
            runSearch();
          }}
        >
          <div className="search-input-wrap">
            <Search size={19} />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="输入关键词、标题或研究方向，例如：transformer attention" />
            <button type="submit" disabled={loading}>{loading ? <Loader2 className="spin" size={17} /> : "搜索"}</button>
          </div>
          <div className="source-pills">
            {SOURCE_OPTIONS.map((s) => (
              <button
                key={s.id}
                type="button"
                className={sources.includes(s.id) ? "pill on" : "pill"}
                onClick={() => toggleSource(s.id)}
              >
                <span className={`dot dot-${s.id}`} />
                {s.label}
              </button>
            ))}
            <label className={`ai-search-toggle ${aiSearch ? "on" : ""}`}>
              <Sparkles size={14} />
              AI 搜索
              <input
                type="checkbox"
                checked={aiSearch}
                onChange={(e) => {
                  setAiSearch(e.target.checked);
                  if (!e.target.checked) setAiPlan(null);
                }}
              />
              <i className="toggle-track" />
            </label>
            <button type="button" className={`filter-toggle ${showFilters ? "on" : ""}`} onClick={() => setShowFilters((v) => !v)}>
              <SlidersHorizontal size={14} /> 筛选
            </button>
          </div>
          {showFilters ? (
            <div className="filter-bar">
              <label>年份
                <input type="number" value={fromYear} onChange={(e) => setFromYear(e.target.value)} placeholder="起始" />
                <span>至</span>
                <input type="number" value={toYear} onChange={(e) => setToYear(e.target.value)} placeholder="结束" />
              </label>
              <label>排序
                <select value={sort} onChange={(e) => setSort(e.target.value)}>
                  <option value="authority">权威优先</option>
                  <option value="relevance">相关度</option>
                  <option value="cited">被引次数</option>
                  <option value="year">最新年份</option>
                </select>
              </label>
            </div>
          ) : null}
        </form>
        <div className="sample-row">
          <span>试试：</span>
          {SAMPLE_QUERIES.map((q) => (
            <button key={q} onClick={() => { setQuery(q); runSearch(q); }}>{q}</button>
          ))}
        </div>
      </section>

      <section className="portal-strip">
        <button className={`browser-toggle ${browserOpen ? "on" : ""}`} onClick={toggleBrowserPanel}>
          <Globe2 size={14} /> {browserOpen ? "收起浏览器" : "内嵌浏览器"}
        </button>
        {!browserOpen ? (
          <>
            <span className="portal-title">快速访问</span>
            {browserSites.map((site) => (
              <button key={site.id} onClick={() => selectBrowserSite(site)}>{site.label}</button>
            ))}
          </>
        ) : null}
      </section>

      {browserOpen ? (
        <section ref={browserRef} className="embedded-browser">
          <div className="browser-tabs">
            <span className="browser-tabs-count">标签页 · {browserTabs.length}</span>
            {browserTabs.map((tab) => {
              const label = tabTitles[tab.id] || getBrowserTabLabel(tab);
              return (
                <button type="button" key={tab.id} className={activeBrowserTabId === tab.id ? "active" : ""} onClick={() => setActiveBrowserTabId(tab.id)}>
                  <span>{label}</span>
                  {tab.closable !== false ? (
                    <span className="browser-tab-close" role="button" tabIndex={0} aria-label={"关闭 " + label} onClick={(event) => { event.stopPropagation(); closeBrowserTab(tab.id); }} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); event.stopPropagation(); closeBrowserTab(tab.id); } }}>
                      <X size={12} />
                    </span>
                  ) : null}
                </button>
              );
            })}
            <button type="button" className="browser-new-tab" onClick={openBlankBrowserTab}>+ 新标签</button>
          </div>
          <div className="browser-toolbar">
            {isElectron ? <IconButton icon={ArrowLeft} label="后退" onClick={() => activeWebview?.goBack?.()} /> : null}
            {isElectron ? <IconButton icon={ArrowRight} label="前进" onClick={() => activeWebview?.goForward?.()} /> : null}
            <IconButton icon={RefreshCw} label="刷新" onClick={() => {
              if (!activeBrowserTabId) return;
              setTabErrors((prev) => ({ ...prev, [activeBrowserTabId]: "" }));
              setTabLoading((prev) => ({ ...prev, [activeBrowserTabId]: true }));
              if (isElectron) activeWebview?.reload?.();
              else updateBrowserTab(activeBrowserTabId, { url: browserUrl });
            }} />
            <Button size="sm" icon={Search} onClick={searchCurrentSite} disabled={!activeBrowserTabId || (browserSite.id !== "institution" && !activeQuery && !query)}>
              {browserSite.id === "institution" ? "机构首页" : "站内搜索"}
            </Button>
            <input
              value={browserAddress}
              onChange={(e) => setBrowserAddress(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== "Enter" || !activeBrowserTabId) return;
                const target = e.currentTarget.value.trim();
                if (!isSafeBrowserUrl(target)) {
                  setTabErrors((prev) => ({ ...prev, [activeBrowserTabId]: "请输入 http(s) 网页地址。" }));
                  return;
                }
                updateBrowserTab(activeBrowserTabId, { url: target, ...(activeBrowserTab?.blank ? { blank: false, siteId: "popup", title: "" } : {}) });
                setTabErrors((prev) => ({ ...prev, [activeBrowserTabId]: "" }));
                setTabLoading((prev) => ({ ...prev, [activeBrowserTabId]: true }));
              }}
              placeholder="输入网址或搜索链接"
            />
            <Button size="sm" variant="secondary" icon={ExternalLink} onClick={openCurrentPageInNewTab} disabled={!isSafeBrowserUrl(browserUrl)}>在新标签打开</Button>
            <IconButton icon={ExternalLink} label="用系统浏览器打开" onClick={() => window.open(browserUrl, "_blank", "noopener")} disabled={!isSafeBrowserUrl(browserUrl)} />
            {isElectron && browserSite.id === "institution" ? <Button size="sm" variant="secondary" icon={LogIn} onClick={openInstitutionLogin}>独立登录</Button> : null}
            {isElectron ? <Button size="sm" icon={FileText} onClick={openCurrentPageInReader} disabled={!isDirectPdfUrl(browserUrl)}>阅读当前 PDF</Button> : null}
          </div>
          <div className="browser-guide">
            <KeyRound size={14} />
            {isElectron
              ? browserSite.id === "institution"
                ? "可直接在此登录；站内新窗口会在上方新标签打开，并共享本机登录会话。"
                : "先打开站点主页并登录，登录状态会保存在这个内嵌浏览器；下次打开同一站点会自动恢复。"
              : "网页版无法在应用内保存登录状态，建议用系统浏览器打开。"}
          </div>
          <div className="browser-frame">
            {isElectron ? (
              <>
                {activeBrowserTab?.blank ? (
                  <div className="browser-new-tab-page">
                    <Globe2 size={28} />
                    <strong>新标签页</strong>
                    <span>在上方地址栏输入网址并回车，或从快速访问中选择一个站点。</span>
                  </div>
                ) : null}
                {browserTabs.filter((tab) => !tab.blank).map((tab) => (
                  <webview
                    key={tab.id}
                    ref={(node) => { if (node) webviewRefs.current.set(tab.id, node); else webviewRefs.current.delete(tab.id); }}
                    src={tab.url}
                    allowpopups
                    partition="persist:scholarloop"
                    useragent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
                    webpreferences="contextIsolation=yes, nodeIntegration=no"
                    className={"browser-webview" + (tab.id === activeBrowserTabId ? " active" : "")}
                    style={{ width: "100%", height: "100%", visibility: tab.id === activeBrowserTabId ? "visible" : "hidden", pointerEvents: tab.id === activeBrowserTabId ? "auto" : "none" }}
                  />
                ))}
                {browserLoading && !activeBrowserTab?.blank ? <div className="browser-state"><Loader2 className="spin" size={18} /> 正在加载站点...</div> : null}
                {browserError ? (
                  <div className="browser-state error">
                    <Globe2 size={20} />
                    <strong>页面加载失败或被站点拦截</strong>
                    <span>{browserError}</span>
                    {browserSite.id === "institution" ? (
                      <Button size="sm" icon={LogIn} onClick={openInstitutionLogin}>在独立窗口登录</Button>
                    ) : (
                      <Button size="sm" icon={ExternalLink} onClick={() => window.open(browserUrl, "_blank", "noopener")}>用系统浏览器打开</Button>
                    )}
                  </div>
                ) : null}
              </>
            ) : (
              activeBrowserTab?.blank ? (
                <div className="browser-new-tab-page">
                  <Globe2 size={28} />
                  <strong>新标签页</strong>
                  <span>在上方地址栏输入网址并回车，或从快速访问中选择一个站点。</span>
                </div>
              ) : <div className="browser-web-fallback">
                <Globe2 size={22} />
                <strong>网页版无法内嵌显示论文网站</strong>
                <p>多数论文网站禁止 iframe，请用系统浏览器打开并登录。</p>
                <div>
                  <Button size="sm" icon={ExternalLink} onClick={() => window.open(browserSite.home, "_blank", "noopener")}>打开主页</Button>
                  <Button size="sm" variant="ghost" icon={Search} onClick={() => window.open(browserSite.url(activeQuery || query || "论文"), "_blank", "noopener")}>用系统浏览器搜索</Button>
                </div>
              </div>
            )}
          </div>
        </section>
      ) : null}

      {aiSearch ? (
        <section className="ai-search-panel">
          <div className="ai-search-head">
            <Sparkles size={15} />
            <strong>AI 检索策略</strong>
            <span>{aiPlanning ? "正在规划..." : aiPlan?.mode === "ai" ? "已按领域规划" : aiPlan ? (aiPlan.rationale?.includes("翻译扩展") ? "已退回翻译扩展" : "已退回关键词") : "等待搜索"}</span>
          </div>
          {aiPlanning ? (
            <p className="ai-planning"><Loader2 className="spin" size={14} /> AI 正在根据研究领域和目标生成中英文检索词...</p>
          ) : aiPlan?.rationale ? <p>{aiPlan.rationale}</p> : (
            <p>{path?.field ? `结合领域「${path.field}」理解你的搜索意图。` : "结合你的搜索意图生成中英文检索词。"}</p>
          )}
          {aiPlan?.queries?.length ? (
            <div className="ai-query-chips">
              {aiPlan.queries.map((q) => <span key={q}>{q}</span>)}
            </div>
          ) : null}
          <form
            className="ai-feedback"
            onSubmit={(e) => {
              e.preventDefault();
              runSearch(activeQuery || query, { instruction: aiInstruction });
            }}
          >
            <input
              value={aiInstruction}
              onChange={(e) => setAiInstruction(e.target.value)}
              placeholder="如果搜得不对，告诉 AI 你真正想要的方向"
            />
            <Button type="submit" size="sm" icon={Sparkles} disabled={loading}>按新要求重搜</Button>
          </form>
        </section>
      ) : null}

      <section className="results-section">
        {loading ? <Spinner text={aiPlanning ? "AI 正在规划检索词..." : "正在跨源检索..."} /> : null}
        {error ? <div className="error-banner"><strong>搜索失败</strong><p>{error}</p></div> : null}
        {!loading && !error && results === null ? (
          <EmptyState icon={Search} title="开始你的第一次聚合检索" desc="输入研究方向或论文关键词，选择来源后点击搜索。" />
        ) : null}
        {!loading && results !== null && results.length === 0 ? (
          <EmptyState icon={FileText} title="没有找到结果" desc="换一组关键词，或放宽年份与来源筛选后重试。" action={<Button size="sm" icon={RotateCw} onClick={() => runSearch()}>重新搜索</Button>} />
        ) : null}
        {!loading && results?.length ? (
          <>
            <div className="results-head">
              <div>
                <h3>“{activeQuery}”的结果</h3>
                <span>共 {results.length} 条 · {status.filter((s) => s.ok).length}/{status.length} 个来源可用</span>
                {queries.length > 1 ? <em className="query-expanded">已同时检索：{queries.join(" / ")}</em> : null}
              </div>
              <div className="results-actions">
                <div className="source-status">
                  {status.map((s) => (
                    <span key={s.id} className={s.ok ? "ok" : "fail"} title={s.error || ""}>
                      <i /> {SOURCE_OPTIONS.find((x) => x.id === s.id)?.label.split(" ")[0] || s.id}
                    </span>
                  ))}
                </div>
                <Button variant="ghost" size="sm" icon={Trash2} onClick={clearSession}>清空结果</Button>
              </div>
            </div>
            <div className="result-source-filter">
              <button className={resultFilter === "all" ? "active" : ""} onClick={() => { setResultFilter("all"); setPage(1); }}>
                全部 <em>{results.length}</em>
              </button>
              {SOURCE_OPTIONS.filter((s) => sourceCounts[s.id]).map((s) => (
                <button key={s.id} className={resultFilter === s.id ? "active" : ""} onClick={() => { setResultFilter(s.id); setPage(1); }}>
                  {s.label.split(" ")[0]} <em>{sourceCounts[s.id]}</em>
                </button>
              ))}
            </div>
            {filteredResults.length === 0 ? (
              <EmptyState
                icon={FileText}
                title="该来源暂无论文"
                desc="当前结果里没有来自该来源的论文，换一个来源或查看全部。"
                action={<Button size="sm" icon={RotateCw} onClick={() => { setResultFilter("all"); setPage(1); }}>查看全部</Button>}
              />
            ) : (
              <>
                <div className="result-list">
                  {pageResults.map((paper) => {
                    const saved = library.find((p) => p.doi && p.doi === paper.doi || (p.title && p.title.toLowerCase() === paper.title?.toLowerCase()));
                    return (
                      <article className="result-row" key={paper.id}>
                        <div className="result-rank">
                          {(paper.sources || [paper.source]).map((sourceId) => <SourceTag key={sourceId} source={sourceId} label={sourceId === paper.source ? paper.sourceLabel : undefined} />)}
                          {paper.year ? <span>{paper.year}</span> : null}
                        </div>
                        <div className="result-main">
                          <h4>{paper.title}</h4>
                          <p className="result-authors">{(paper.authors || []).slice(0, 6).join(" · ") || "作者未知"}{paper.venue ? ` · ${paper.venue}` : ""}</p>
                          {paper.abstract ? <p className="result-abstract">{paper.abstract.slice(0, 240)}{paper.abstract.length > 240 ? "…" : ""}</p> : <p className="result-abstract muted">该来源未提供摘要，点击“解读”使用五问引导阅读。</p>}
                          <div className="result-tags">
                            {paper.citations > 0 ? <Badge tone="cite">被引 {paper.citations}</Badge> : null}
                            {(paper.keywords || []).slice(0, 4).map((k) => <Badge key={k} tone="tag">{k}</Badge>)}
                          </div>
                        </div>
                        <div className="result-actions">
                          {saved ? (
                            <Button size="sm" variant="ghost" icon={BookmarkPlus} onClick={() => setSelected(saved)}>已收藏</Button>
                          ) : (
                            <IconButton icon={BookmarkPlus} label="收藏" onClick={() => saveAndOpen(paper)} />
                          )}
                          <Button size="sm" icon={FileText} onClick={() => setSelected(paper)}>解读</Button>
                          {paper.pdfUrl ? <IconButton icon={AppWindow} label="内置阅读器" onClick={() => onReadPdf?.(paper.pdfUrl, paper.title, paper.doi, saved?.id)} /> : null}
                        </div>
                        <ChevronRight className="row-chevron" size={16} />
                      </article>
                    );
                  })}
                </div>
                {totalPages > 1 ? (
                  <div className="pagination">
                    <button className="page-nav" disabled={currentPage <= 1} onClick={() => setPage(currentPage - 1)}>上一页</button>
                    {buildPageNumbers(currentPage, totalPages).map((n, i) =>
                      n === "..." ? <span key={`ellipsis-${i}`} className="page-ellipsis">…</span> : (
                        <button key={n} className={currentPage === n ? "active" : ""} onClick={() => setPage(n)}>{n}</button>
                      )
                    )}
                    <button className="page-nav" disabled={currentPage >= totalPages} onClick={() => setPage(currentPage + 1)}>下一页</button>
                  </div>
                ) : null}
              </>
            )}
          </>
        ) : null}
      </section>

      {selected ? (
        <PaperDetail
          paper={selected}
          saved={Boolean(library.find((p) => p.id === selected.id))}
          onClose={() => setSelected(null)}
          onSave={saveAndOpen}
          onReadPdf={onReadPdf}
        />
      ) : null}
    </div>
  );
}
