import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  X,
  ZoomIn,
  ZoomOut,
  ChevronLeft,
  ChevronRight,
  FileUp,
  Download,
  AppWindow,
  Scan,
  Languages,
  Loader2,
  BookOpen,
  Link2,
  Check,
  Sparkles,
  Send,
  Maximize2,
  Minimize2,
  Hand,
  MousePointer2,
  PanelRightClose,
  PanelRightOpen,
  StickyNote
} from "lucide-react";
import * as pdfjsLib from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { api } from "../api.js";
import { useData } from "../store.jsx";
import { IconButton, Segmented } from "./ui.jsx";
import { renderMarkdown } from "./markdown.jsx";
import { normalizePdfSelection, normalizedSelectionAnchor } from "../pdfTranslation.js";
import { attachPdfTextLayerSelection, isPdfSelectionOverlayTarget, pickSelectionAnchorRect } from "../pdfTextSelection.js";
import { createPendingFollowup, settleFollowup } from "../pdfChat.js";
import { applySampledLineAppearance, buildPdfTextLayout, extractReadablePdfText, PDF_TEXT_LAYOUT_VERSION } from "../pdfText.js";
import { buildLayoutTranslationPrompt, joinLayoutTranslation, parseLayoutTranslation } from "../pdfLayoutTranslation.js";
import {
  normalizeOcrBox,
  ocrRegionCacheKey,
  protectOcrText,
  recognizeOcrImage,
  restoreProtectedText
} from "../pdfOcr.js";
import { createSavedInterpretation, interpretationStorageKey, normalizeSavedInterpretation } from "../pdfInterpretation.js";
import { openPdfExternal } from "../openPdfExternal.js";
import { caretAfterLeadingMarker, collectNotePages, insertPageMarker, normalizeReadingNotes, parseReadingNotes } from "../readingNotes.js";
import { useAgentConfig } from "../agentConfig.js";
import { estimateTokensFromText } from "../llmUsage.js";
import UsageMeter from "./UsageMeter.jsx";

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

const SCALE_MIN = 0.6;
const SCALE_MAX = 3;
const SCALE_STEP_BTN = 0.15;
const SCALE_STEP_WHEEL = 0.1;
const PDFJS_WASM_URL = "/pdfjs-wasm/";
const PDF_DISPLAY_MODES = [
  { value: "original", label: "原文" },
  { value: "translated", label: "译文" },
  { value: "bilingual", label: "中英对照" }
];

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 版式翻译：显示模式 → 译文 PDF 类型 */
function layoutVariantForDisplayMode(mode) {
  if (mode === "translated") return "mono";
  if (mode === "bilingual") return "dual";
  return "";
}

function findLayoutPageResult(result, pageNumber) {
  return (result?.pages || []).find((page) => Number(page.page) === Number(pageNumber) && page.status === "completed") || null;
}

/** 取本页版式译文 URL；优先目标类型，缺失时回退另一种 */
function resolveLayoutPageUrl(result, pageNumber, variant) {
  const page = findLayoutPageResult(result, pageNumber);
  if (page) {
    if (variant === "mono") {
      if (page.monoUrl) return { url: page.monoUrl, page, variant: "mono", whole: false };
      if (page.dualUrl) return { url: page.dualUrl, page, variant: "dual", whole: false };
    }
    if (variant === "dual") {
      if (page.dualUrl) return { url: page.dualUrl, page, variant: "dual", whole: false };
      if (page.monoUrl) return { url: page.monoUrl, page, variant: "mono", whole: false };
    }
  }
  // 逐页任务：本页未 completed 时绝不回退整本，避免「显示就绪实则仍在译/串页」
  const progressive = Array.isArray(result?.pages) && result.pages.length > 0;
  if (progressive) {
    return { url: "", page: null, variant: "", whole: false };
  }
  // 整本 mono/dual（非逐页任务）：按原文页码渲染
  if (variant === "mono" && result?.monoUrl) {
    return { url: result.monoUrl, page: null, variant: "mono", whole: true };
  }
  if (variant === "dual" && result?.dualUrl) {
    return { url: result.dualUrl, page: null, variant: "dual", whole: true };
  }
  // dual 整本缺失时回退 mono 整本
  if (variant === "dual" && result?.monoUrl) {
    return { url: result.monoUrl, page: null, variant: "mono", whole: true };
  }
  if (variant === "mono" && result?.dualUrl) {
    return { url: result.dualUrl, page: null, variant: "dual", whole: true };
  }
  return { url: "", page: page || null, variant: "", whole: false };
}

function layoutPageStatus(result, pageNumber) {
  const page = (result?.pages || []).find((item) => Number(item.page) === Number(pageNumber));
  if (!page) return { status: "", done: false, running: false, label: "" };
  const done = page.status === "completed" && Boolean(page.monoUrl || page.dualUrl);
  const running = page.status === "running";
  let label = "";
  if (done) label = `第 ${pageNumber} 页已完成`;
  else if (running) label = `第 ${pageNumber} 页翻译中…`;
  else if (page.status === "failed") label = `第 ${pageNumber} 页失败`;
  else if (page.status === "queued") label = `第 ${pageNumber} 页排队中`;
  else label = `第 ${pageNumber} 页${page.status || "未知"}`;
  return { status: page.status || "", done, running, label, page };
}

function layoutViewMatches(meta, { url, pageNum }) {
  if (!meta?.url || !url) return false;
  if (meta.url !== url) return false;
  // 逐页 PDF 必须匹配阅读页码，避免翻页时短暂显示上一页译文
  if (!meta.whole && Number(meta.page) !== Number(pageNum)) return false;
  return true;
}

function arrayBufferToBase64(value) {
  if (typeof value === "string") return value;
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value || []);
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function base64ToArrayBuffer(value) {
  const binary = atob(String(value || ""));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function isTranslationError(value) {
  return /^翻译失败\s*[:：]/.test(String(value || "").trim());
}

function cachedDisplayMode(cache) {
  if (Object.values(cache?.pageTranslations || {}).some((value) => value && !isTranslationError(value))) return "translated";
  if (Object.keys(cache?.paragraphTranslations || {}).length || Object.keys(cache?.selectionTranslations || {}).length) return "bilingual";
  return "original";
}

function clampScale(value) {
  return Math.min(SCALE_MAX, Math.max(SCALE_MIN, +Number(value).toFixed(2)));
}

function loadImageElement(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("图片加载失败"));
    image.src = src;
  });
}

function cropCanvas(source, box) {
  const normalized = normalizeOcrBox(box);
  if (!source || !normalized) return null;
  const sx = Math.max(0, Math.floor(source.width * normalized.left));
  const sy = Math.max(0, Math.floor(source.height * normalized.top));
  const sw = Math.max(1, Math.min(source.width - sx, Math.floor(source.width * normalized.width)));
  const sh = Math.max(1, Math.min(source.height - sy, Math.floor(source.height * normalized.height)));
  const canvas = document.createElement("canvas");
  canvas.width = sw;
  canvas.height = sh;
  canvas.getContext("2d").drawImage(source, sx, sy, sw, sh, 0, 0, sw, sh);
  return canvas;
}

function ocrProgressLabel(message) {
  const status = String(message?.status || "").trim();
  const progress = Number(message?.progress);
  if (!status) return "正在识别…";
  return Number.isFinite(progress) && progress > 0
    ? `OCR：${status} ${Math.round(progress * 100)}%`
    : `OCR：${status}`;
}

function splitParagraphs(text) {
  const raw = String(text || "").trim();
  if (!raw) return [];
  const lines = raw.split(/\r?\n/).map((l) => l.trim());
  const blocks = [];
  let current = [];
  for (const line of lines) {
    if (!line) {
      if (current.length) {
        blocks.push(current.join(" "));
        current = [];
      }
      continue;
    }
    current.push(line);
  }
  if (current.length) blocks.push(current.join(" "));
  const grouped = blocks.map((b) => b.replace(/\s+/g, " ")).filter((b) => b.length >= 2);
  if (grouped.length > 1) {
    const expanded = [];
    for (const block of grouped) {
      if (block.length > 700) expanded.push(...sentenceChunks(block));
      else expanded.push(block);
    }
    return expanded;
  }
  return sentenceChunks(raw.replace(/\s+/g, " "));
}

function sentenceChunks(clean) {
  const sentences = clean.split(/(?<=[.!?。！？])\s+/).map((s) => s.trim()).filter(Boolean);
  const blocks = [];
  let current = "";
  for (const sentence of sentences) {
    current = current ? `${current} ${sentence}` : sentence;
    if (current.length >= 420 || (current.length >= 180 && sentence.length > 60)) {
      blocks.push(current);
      current = "";
    }
  }
  if (current) blocks.push(current);
  return blocks.length ? blocks : [clean];
}

function pagesPayload(textByPage) {
  return Object.entries(textByPage || {})
    .map(([page, text]) => ({ page: Number(page), text: String(text || "") }))
    .filter((p) => p.page > 0 && p.text.trim())
    .sort((a, b) => a.page - b.page);
}

function hasAnyText(textByPage) {
  return pagesPayload(textByPage).some((p) => p.text.trim().length > 20);
}

function PdfLayoutTranslationLine({ line, scale }) {
  const wrapperRef = useRef(null);
  const textRef = useRef(null);
  const [fitScale, setFitScale] = useState(1);

  useLayoutEffect(() => {
    const wrapper = wrapperRef.current;
    const text = textRef.current;
    if (!wrapper || !text) return;
    const available = Math.max(1, wrapper.clientWidth - 2);
    const natural = Math.max(1, text.scrollWidth);
    setFitScale(Math.min(1, available / natural));
  }, [line.text, line.width, scale]);

  return (
    <span
      ref={wrapperRef}
      className="pdf-layout-translation-line"
      style={{
        left: `${line.left}%`,
        top: `${line.top}%`,
        width: `${line.width}%`,
        height: `${Math.max(line.height, 1.2)}%`,
        fontSize: `${Math.max(7, Math.min(22, Number(line.fontSize || 10) * scale * 0.92))}px`,
        color: line.color || undefined,
        background: line.background || undefined,
        fontWeight: line.fontWeight || undefined,
        boxShadow: line.background ? `0 0 0 1px ${line.background}` : undefined
      }}
    >
      <span ref={textRef} style={{ transform: `scaleX(${fitScale})` }}>{line.text}</span>
    </span>
  );
}

function PdfLayoutTranslationLayer({ lines, scale }) {
  if (!Array.isArray(lines) || !lines.length) return null;
  return (
    <div className="pdf-layout-translation-layer" aria-label="原位 PDF 译文文字层">
      {lines.map((line, index) => <PdfLayoutTranslationLine key={`${line.left}-${line.top}-${index}`} line={line} scale={scale} />)}
    </div>
  );
}

function normalizeEvidenceText(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[，。,.!?！？:：;；、"“”‘’'`()（）[\]{}]/g, "");
}

function EvidenceLinks({ items, onJump }) {
  const evidence = (Array.isArray(items) ? items : [])
    .map((item) => ({
      ...item,
      page: Number(item?.page) || 0,
      label: String(item?.label || (item?.page ? `第 ${item.page} 页` : "")).trim()
    }))
    .filter((item) => item.page > 0 && item.label);
  if (!evidence.length) return null;

  return (
    <div className="pdf-evidence-links" aria-label="跳转到论文依据">
      <span className="pdf-evidence-label"><Link2 size={12} /> 文中依据</span>
      <div className="pdf-evidence-buttons">
        {evidence.map((item, index) => (
          <button
            type="button"
            className="pdf-evidence-link"
            key={`${item.page}-${item.label}-${index}`}
            onClick={() => onJump(item)}
            title={[item.reason, item.quote].filter(Boolean).join("：") || `跳转到${item.label}`}
          >
            {item.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export default function PdfReader({ url, title, doi, paperId, onClose, initialPage, initialTab }) {
  const { settings } = useData();
  const canvasRef = useRef(null);
  const canvasWrapRef = useRef(null);
  const pageSurfaceRef = useRef(null);
  const textLayerRef = useRef(null);
  const imageUrlRef = useRef(null);
  const ocrDragRef = useRef({ active: false, start: null, current: null, pointerId: null });
  /** 手型拖拽：在 canvas 容器上平移滚动 */
  const panDragRef = useRef({ active: false, startX: 0, startY: 0, scrollLeft: 0, scrollTop: 0, pointerId: null });
  const panelRef = useRef(null);
  const translateShellRef = useRef(null);
  const askInputRef = useRef(null);
  const aiScrollRef = useRef(null);
  const followupIdRef = useRef(0);
  const followupsRef = useRef([]);
  const evidenceTimerRef = useRef(null);
  const pdfCacheSaveQueueRef = useRef(Promise.resolve());
  const loadedInterpretationRef = useRef("");
  const [doc, setDoc] = useState(null);
  const [imageSource, setImageSource] = useState(null);
  const [pageNum, setPageNum] = useState(1);
  const [numPages, setNumPages] = useState(0);
  const [scale, setScale] = useState(1.15);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [errorIsAuth, setErrorIsAuth] = useState(false);
  const [textByPage, setTextByPage] = useState({});
  const [ocrPageTexts, setOcrPageTexts] = useState({});
  const [urlInput, setUrlInput] = useState(url || "");
  const [translatingPage, setTranslatingPage] = useState(null);
  const [translatingAll, setTranslatingAll] = useState(false);
  const [translateProgress, setTranslateProgress] = useState("");
  const [paragraphTranslations, setParagraphTranslations] = useState({});
  const [pageTranslations, setPageTranslations] = useState({});
  const [pageTextLayouts, setPageTextLayouts] = useState({});
  const [pageTranslationLayouts, setPageTranslationLayouts] = useState({});
  const [displayMode, setDisplayMode] = useState("original");
  const [selectionPopup, setSelectionPopup] = useState(null);
  const [selectionLoading, setSelectionLoading] = useState(false);
  const [selectionTranslations, setSelectionTranslations] = useState({});
  const [ocrSelectionCache, setOcrSelectionCache] = useState({});
  const [ocrSelectMode, setOcrSelectMode] = useState(false);
  const [ocrSelectionBox, setOcrSelectionBox] = useState(null);
  const [ocrDragging, setOcrDragging] = useState(false);
  const [ocrBusy, setOcrBusy] = useState(false);
  const [ocrProgress, setOcrProgress] = useState("");
  const [ocrError, setOcrError] = useState("");
  const [translatingParagraphs, setTranslatingParagraphs] = useState({});
  const [pdfCacheStatus, setPdfCacheStatus] = useState("idle");
  const [pdfCacheError, setPdfCacheError] = useState("");
  const [pdfSourceBase64, setPdfSourceBase64] = useState("");
  const [originalPdfSource, setOriginalPdfSource] = useState(null);
  const [activePdfVariant, setActivePdfVariant] = useState("original");
  const [pdfMathStatus, setPdfMathStatus] = useState({ loading: true, available: false, command: "", installHint: "" });
  const [pdfMathState, setPdfMathState] = useState("idle");
  const [pdfMathError, setPdfMathError] = useState("");
  const [pdfMathResult, setPdfMathResult] = useState(null);
  const [pdfMathJobId, setPdfMathJobId] = useState("");
  const [pdfMathProgress, setPdfMathProgress] = useState("");
  const pdfMathCancelRequested = useRef(false);
  const pdfMathFirstPageOpened = useRef(false);
  /** 版式译文 PDF 缓存：url → pdfjs document，避免每次切换重下 */
  const layoutDocCacheRef = useRef(new Map());
  const layoutViewMetaRef = useRef(null);
  const layoutViewDocRef = useRef(null);
  const layoutLoadSeqRef = useRef(0);
  const [layoutViewDoc, setLayoutViewDoc] = useState(null);
  const [layoutViewLoading, setLayoutViewLoading] = useState(false);
  const [layoutViewError, setLayoutViewError] = useState("");
  const [layoutViewMeta, setLayoutViewMeta] = useState(null); // { url, variant, page, whole }
  /** 点击同一模式时强制重新绑定版式（用于从卡住状态恢复） */
  const [layoutReloadToken, setLayoutReloadToken] = useState(0);
  const [showTextDetails, setShowTextDetails] = useState(false);
  const [showPanel, setShowPanel] = useState(true);
  const [panelTab, setPanelTab] = useState(initialTab === "notes" || initialTab === "ai" ? initialTab : "translate");
  /** 右侧面板放大模式：在翻译与 AI 解读之间切换时保持 */
  const [aiFocus, setAiFocus] = useState(false);
  /** select=选文字复制；hand=拖拽平移 PDF 视图 */
  const [interactionMode, setInteractionMode] = useState("select");
  const [isPanning, setIsPanning] = useState(false);
  /** 阅读随记：想到什么写什么 */
  const [readingNotes, setReadingNotes] = useState("");
  const [notesSaveStatus, setNotesSaveStatus] = useState("idle"); // idle | saving | saved | error | local
  const notesSaveTimerRef = useRef(null);
  const notesTextareaRef = useRef(null);

  // AI 解读
  const [interpretLoading, setInterpretLoading] = useState(false);
  const [interpretProgress, setInterpretProgress] = useState("");
  const [interpretError, setInterpretError] = useState("");
  const [interpretMeta, setInterpretMeta] = useState(null); // { mode, usedChars, pageCoverage }
  const [interpretResult, setInterpretResult] = useState(null);
  const [evidenceHighlight, setEvidenceHighlight] = useState(null);
  const [saveInterpretationStatus, setSaveInterpretationStatus] = useState("idle");
  const [saveInterpretationError, setSaveInterpretationError] = useState("");
  const [followups, setFollowups] = useState([]);
  const [askInput, setAskInput] = useState("");
  const [askLoading, setAskLoading] = useState(false);

  const config = useAgentConfig();
  const proxy = settings?.proxy || "";
  const interpretationKey = useMemo(
    () => interpretationStorageKey({ paperId, doi, url, title }),
    [doi, paperId, title, url]
  );
  const effectiveTextByPage = useMemo(() => ({ ...ocrPageTexts, ...textByPage }), [ocrPageTexts, textByPage]);
  const pageText = effectiveTextByPage[pageNum] || "";
  const pageIsOcr = !textByPage[pageNum] && Boolean(ocrPageTexts[pageNum]);
  const hasPageSource = Boolean(doc || imageSource);
  const paragraphs = useMemo(() => splitParagraphs(pageText), [pageText]);
  const notePages = useMemo(() => collectNotePages(parseReadingNotes(readingNotes)), [readingNotes]);

  // 版式翻译结果：上方「原文/译文/中英对照」直接切换，不走侧栏按钮
  const layoutDisplayVariant = layoutVariantForDisplayMode(displayMode);
  const layoutPageResolved = useMemo(
    () => (layoutDisplayVariant
      ? resolveLayoutPageUrl(pdfMathResult, pageNum, layoutDisplayVariant)
      : { url: "", page: null, variant: "", whole: false }),
    [layoutDisplayVariant, pdfMathResult, pageNum]
  );
  // 仅当缓存文档与当前页/URL 一致时才渲染版式，避免翻页串页
  const layoutViewReady = Boolean(
    layoutDisplayVariant
    && layoutPageResolved.url
    && layoutViewDoc
    && layoutViewMatches(layoutViewMeta, {
      url: layoutPageResolved.url,
      pageNum
    })
  );
  const usingLayoutPdf = layoutViewReady;
  const layoutCompletedCount = useMemo(
    () => (pdfMathResult?.pages || []).filter((page) => page.status === "completed" && (page.monoUrl || page.dualUrl)).length,
    [pdfMathResult]
  );
  const layoutPageCount = useMemo(
    () => Number(pdfMathResult?.pageCount) || (pdfMathResult?.pages || []).length || numPages || 0,
    [pdfMathResult, numPages]
  );
  const layoutIncompleteCount = useMemo(() => {
    const pages = pdfMathResult?.pages || [];
    if (!pages.length) return layoutPageCount > 0 && layoutCompletedCount > 0 ? Math.max(0, layoutPageCount - layoutCompletedCount) : 0;
    return pages.filter((page) => !(page.status === "completed" && (page.monoUrl || page.dualUrl))).length;
  }, [pdfMathResult, layoutPageCount, layoutCompletedCount]);
  const layoutAllDone = layoutPageCount > 0 && layoutCompletedCount >= layoutPageCount && layoutIncompleteCount === 0;
  const hasAnyLayoutResult = layoutCompletedCount > 0 || Boolean(pdfMathResult?.monoUrl || pdfMathResult?.dualUrl);
  const currentLayoutPage = useMemo(() => layoutPageStatus(pdfMathResult, pageNum), [pdfMathResult, pageNum]);

  const persistInterpretation = useCallback(async ({ result, meta, followups }) => {
    const payload = createSavedInterpretation({ result, meta, followups });
    if (!payload) return null;
    setSaveInterpretationStatus("saving");
    setSaveInterpretationError("");
    try {
      if (paperId) {
        await api.savePaperInterpretation(paperId, payload);
      } else {
        localStorage.setItem(interpretationKey, JSON.stringify(payload));
      }
      setSaveInterpretationStatus("saved");
      return payload;
    } catch (err) {
      setSaveInterpretationStatus("error");
      setSaveInterpretationError(`保存解读失败：${err.message}`);
      return null;
    }
  }, [interpretationKey, paperId]);

  const notesStorageKey = useMemo(() => {
    if (paperId) return `scholarloop.pdf.notes.${paperId}`;
    const seed = String(url || title || "anonymous").trim().slice(0, 240);
    return seed ? `scholarloop.pdf.notes.url.${encodeURIComponent(seed)}` : "";
  }, [paperId, title, url]);

  const readLocalNotes = useCallback(() => {
    if (!notesStorageKey || typeof localStorage === "undefined") return "";
    try {
      return String(localStorage.getItem(notesStorageKey) || "");
    } catch {
      return "";
    }
  }, [notesStorageKey]);

  const writeLocalNotes = useCallback((text) => {
    if (!notesStorageKey || typeof localStorage === "undefined") return;
    try {
      localStorage.setItem(notesStorageKey, String(text || ""));
    } catch {
      /* ignore quota */
    }
  }, [notesStorageKey]);

  const persistPdfCache = (patch) => {
    if (!paperId || !patch || typeof patch !== "object") return Promise.resolve(null);
    setPdfCacheStatus("saving");
    setPdfCacheError("");
    const task = pdfCacheSaveQueueRef.current
      .catch(() => null)
      .then(async () => {
        const response = await api.savePdfCache(paperId, patch);
        setPdfCacheStatus("saved");
        return response?.cache || null;
      })
      .catch((err) => {
        setPdfCacheStatus("error");
        setPdfCacheError(`保存阅读缓存失败：${err.message}`);
        return null;
      });
    pdfCacheSaveQueueRef.current = task;
    return task;
  };

  const persistReadingNotes = useCallback((text) => {
    writeLocalNotes(text);
    if (!paperId) {
      setNotesSaveStatus("local");
      return Promise.resolve();
    }
    setNotesSaveStatus("saving");
    return persistPdfCache({ readingNotes: text }).then((cache) => {
      setNotesSaveStatus(cache ? "saved" : "error");
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps -- persistPdfCache 依赖 paperId，与闭包一致
  }, [paperId, writeLocalNotes]);

  const scheduleNotesSave = useCallback((text) => {
    if (notesSaveTimerRef.current) window.clearTimeout(notesSaveTimerRef.current);
    notesSaveTimerRef.current = window.setTimeout(() => {
      void persistReadingNotes(text);
    }, 700);
  }, [persistReadingNotes]);

  const handleNotesChange = (event) => {
    const next = event.target.value;
    setReadingNotes(next);
    setNotesSaveStatus("saving");
    scheduleNotesSave(next);
  };

  const insertNotesPageMarker = () => {
    const stamp = new Date().toLocaleString("zh-CN", { hour12: false });
    setReadingNotes((prev) => {
      const next = insertPageMarker(prev, pageNum, stamp);
      scheduleNotesSave(next);
      return next;
    });
    setNotesSaveStatus("saving");
    requestAnimationFrame(() => {
      const el = notesTextareaRef.current;
      if (!el) return;
      el.focus();
      const caret = caretAfterLeadingMarker(el.value);
      el.selectionStart = el.selectionEnd = caret;
    });
  };

  const clearReadingNotes = () => {
    if (!window.confirm("清空本篇手记？此操作不可撤销。")) return;
    setReadingNotes("");
    setNotesSaveStatus("saving");
    scheduleNotesSave("");
  };

  const clearPdfCache = async () => {
    if (!paperId) return;
    try {
      await api.clearPdfCache(paperId);
      setTextByPage({});
      setOcrPageTexts({});
      setParagraphTranslations({});
      setPageTranslations({});
      setPageTextLayouts({});
      setPageTranslationLayouts({});
      setSelectionTranslations({});
      setOcrSelectionCache({});
      setDisplayMode("original");
      setPdfMathState("idle");
      setPdfMathError("");
      setPdfMathResult(null);
      setPdfMathJobId("");
      setPdfMathProgress("");
      setPdfCacheStatus("idle");
      setPdfCacheError("");
      setReadingNotes("");
      setNotesSaveStatus("idle");
      writeLocalNotes("");
    } catch (err) {
      setPdfCacheStatus("error");
      setPdfCacheError(`清除阅读缓存失败：${err.message}`);
    }
  };

  const applyRestoredPdfMathJob = (job) => {
    if (!job?.jobId) return false;
    const hasCompletedPage = (job.pages || []).some((page) => page.status === "completed" && (page.monoUrl || page.dualUrl));
    const hasWholeFile = Boolean(job.monoUrl || job.dualUrl);
    if (!hasCompletedPage && !hasWholeFile && job.status !== "completed") return false;
    setPdfMathJobId(job.jobId);
    setPdfMathResult(job);
    setPdfMathProgress(job.progress || "已从本地恢复版式译文");
    setPdfMathError(job.status === "failed" && !hasCompletedPage ? (job.error || "版式翻译失败") : "");
    if (["queued", "running", "canceling"].includes(job.status)) {
      setPdfMathState("working");
    } else if (hasCompletedPage || hasWholeFile || job.status === "completed") {
      setPdfMathState("ready");
    } else {
      setPdfMathState("error");
      return false;
    }
    return true;
  };

  const restorePdfMathFromLocal = async (preferredJobId = "") => {
    if (!paperId) return null;
    try {
      if (preferredJobId) {
        try {
          const job = await api.pdfMathTranslateJob(preferredJobId);
          if (applyRestoredPdfMathJob(job)) return job;
        } catch {
          /* 再试 paper 级索引 */
        }
      }
      const job = await api.getPdfLayoutTranslation(paperId);
      if (applyRestoredPdfMathJob(job)) return job;
    } catch {
      /* 无本地版式译文时静默 */
    }
    return null;
  };

  const loadSource = async (source) => {
    const sourceVariant = source.variant === "dual" || source.variant === "mono" ? source.variant : "original";
    const isTranslatedVariant = sourceVariant !== "original";
    const preservePdfMathResult = Boolean(source.preservePdfMathResult);
    setLoading(true);
    setError("");
    setErrorIsAuth(false);
    setActivePdfVariant(sourceVariant);
    setPdfSourceBase64("");
    if (!isTranslatedVariant && !preservePdfMathResult) {
      setPdfMathState("idle");
      setPdfMathError("");
      setPdfMathResult(null);
      setPdfMathJobId("");
      setPdfMathProgress("");
    }
    setDoc(null);
    setImageSource(null);
    if (imageUrlRef.current) {
      URL.revokeObjectURL(imageUrlRef.current);
      imageUrlRef.current = null;
    }
    setTextByPage({});
    setOcrPageTexts({});
    setParagraphTranslations({});
    setPageTranslations({});
    setPageTextLayouts({});
    setPageTranslationLayouts({});
    setDisplayMode("original");
    setSelectionPopup(null);
    setSelectionTranslations({});
    setOcrSelectionCache({});
    setOcrSelectMode(false);
    setOcrSelectionBox(null);
    setOcrError("");
    setOcrProgress("");
    setInterpretResult(null);
    setInterpretMeta(null);
    setInterpretError("");
    setEvidenceHighlight(null);
    setSaveInterpretationStatus("idle");
    setSaveInterpretationError("");
    followupsRef.current = [];
    setFollowups([]);
    setPdfCacheStatus(paperId && !isTranslatedVariant ? "reading" : "idle");
    setPdfCacheError("");
    setReadingNotes("");
    setNotesSaveStatus("idle");

    let cache = null;
    const shouldUseCache = source.useCache !== false;
    const requestedUrl = String(source.url || "").trim();
    if (paperId && shouldUseCache && !isTranslatedVariant) {
      try {
        cache = (await api.getPdfCache(paperId)).cache || null;
      } catch (err) {
        if (!/404|文献不存在/.test(err.message || "")) setPdfCacheError(`读取阅读缓存失败：${err.message}`);
      }
    }
    if (paperId && !isTranslatedVariant) setPdfCacheStatus("loading");

    const cachedPdfUrl = shouldUseCache ? String(cache?.pdfUrl || "").trim() : "";
    const sourceUrl = cachedPdfUrl || requestedUrl;
    const compatibleTextCache = Number(cache?.textLayoutVersion) === PDF_TEXT_LAYOUT_VERSION;
    const cachedTextByPage = compatibleTextCache ? (cache?.textByPage || {}) : {};
    setTextByPage(cachedTextByPage);
    setOcrPageTexts(cache?.ocrPageTexts || {});
    setParagraphTranslations(cache?.paragraphTranslations || {});
    setPageTranslations(compatibleTextCache ? (cache?.pageTranslations || {}) : {});
    setPageTranslationLayouts(compatibleTextCache ? (cache?.pageTranslationLayouts || {}) : {});
    setSelectionTranslations(cache?.selectionTranslations || {});
    setOcrSelectionCache(cache?.ocrSelectionCache || {});
    setDisplayMode(compatibleTextCache ? cachedDisplayMode(cache) : "original");
    // 随记：优先服务端缓存，否则本地 localStorage
    const restoredNotes = String(cache?.readingNotes || "").trim()
      ? String(cache.readingNotes)
      : (() => {
          try {
            const key = paperId
              ? `scholarloop.pdf.notes.${paperId}`
              : `scholarloop.pdf.notes.url.${encodeURIComponent(String(source.url || url || title || "").trim().slice(0, 240))}`;
            return key ? String(localStorage.getItem(key) || "") : "";
          } catch {
            return "";
          }
        })();
    const normalizedNotes = normalizeReadingNotes(restoredNotes);
    setReadingNotes(normalizedNotes);
    setNotesSaveStatus(normalizedNotes ? (paperId && cache?.readingNotes != null ? "saved" : "local") : "idle");
    if (normalizedNotes && normalizedNotes !== restoredNotes) {
      void persistReadingNotes(normalizedNotes);
    }

    try {
      let data;
      let sourceBase64 = "";
      let savedSource = null;
      if (source.data) {
        data = source.data;
        sourceBase64 = arrayBufferToBase64(data);
      } else if (sourceUrl.startsWith("/api/")) {
        const res = await fetch(sourceUrl);
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        data = await res.arrayBuffer();
        sourceBase64 = arrayBufferToBase64(data);
      } else {
        let bridgeErr = null;
        if (typeof window !== "undefined" && window.scholarloop?.pdfFetch) {
          try {
            const result = await window.scholarloop.pdfFetch(sourceUrl);
            sourceBase64 = result.data;
            const binary = atob(result.data);
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
            data = bytes.buffer;
          } catch (err) {
            bridgeErr = err;
          }
        }
        if (!data) {
          try {
            const res = await fetch(api.pdfUrl(sourceUrl, proxy, source.doi));
            if (!res.ok) {
              const body = await res.json().catch(() => ({}));
              throw new Error(body.error || `${res.status} ${res.statusText}`);
            }
            data = await res.arrayBuffer();
            sourceBase64 = arrayBufferToBase64(data);
          } catch (proxyErr) {
            try {
              const res = await fetch(sourceUrl);
              if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
              data = await res.arrayBuffer();
              sourceBase64 = arrayBufferToBase64(data);
            } catch (directErr) {
              const parts = [];
              if (bridgeErr) parts.push(`内置下载失败：${bridgeErr.message}`);
              parts.push(`${proxyErr.message}（直连失败：${directErr.message}）`);
              throw new Error(parts.join("；"));
            }
          }
        }
      }
      const bytes = new Uint8Array(data);
      const magic = String.fromCharCode(...bytes.slice(0, 5));
      if (bytes.length < 5 || magic !== "%PDF-") {
        throw new Error("该链接不是可直接下载的 PDF 文件（可能是网页或需要登录），请用系统浏览器打开");
      }

      setPdfSourceBase64(sourceBase64);
      if (!isTranslatedVariant) {
        if (!preservePdfMathResult) {
          setOriginalPdfSource({ data: sourceBase64, url: requestedUrl || sourceUrl, doi: source.doi || "" });
        }
      }

      if (paperId && !isTranslatedVariant && !cachedPdfUrl && /^https?:\/\//i.test(requestedUrl) && sourceBase64) {
        try {
          savedSource = await api.savePaperPdf(paperId, { data: sourceBase64, sourceUrl: requestedUrl });
        } catch (err) {
          setPdfCacheStatus("error");
          setPdfCacheError(`PDF 已打开，但本地保存失败：${err.message}`);
        }
      }

      const pdf = await pdfjsLib.getDocument({
        data,
        // PDF.js 5+ decodes JPX/JPEG 2000 images through OpenJPEG WASM.
        // Without this resource path, text/vector layers render but JP2 images disappear.
        wasmUrl: PDFJS_WASM_URL
      }).promise;
      setDoc(pdf);
      setNumPages(pdf.numPages);
      const startPage = Number(initialPage) > 0 ? Math.min(Number(initialPage), pdf.numPages) : 1;
      setPageNum(startPage);
      setLoading(false);

      const texts = { ...cachedTextByPage };
      const hasCompleteTextCache = Number(cache?.numPages) === pdf.numPages && Object.keys(texts).length >= pdf.numPages;
      if (!hasCompleteTextCache) {
        for (let i = 1; i <= pdf.numPages; i++) {
          if (texts[i]) continue;
          const page = await pdf.getPage(i);
          const content = await page.getTextContent();
          texts[i] = extractReadablePdfText(content.items).replace(/[ \t]+/g, " ").trim();
        }
      }
      setTextByPage(texts);

      if (paperId && !isTranslatedVariant) {
        const sourceInfo = savedSource?.source || {};
        const cachePatch = {
          numPages: pdf.numPages,
          textLayoutVersion: PDF_TEXT_LAYOUT_VERSION,
          textByPage: texts
        };
        const localPdfUrl = sourceInfo.pdfUrl || (sourceUrl.startsWith("/api/pdf/file/") ? sourceUrl : "");
        if (requestedUrl || cache?.sourceUrl) cachePatch.sourceUrl = requestedUrl || cache.sourceUrl;
        if (localPdfUrl) cachePatch.pdfUrl = localPdfUrl;
        if (sourceInfo.sourceSha256 || cache?.sourceSha256) cachePatch.sourceSha256 = sourceInfo.sourceSha256 || cache.sourceSha256;
        if (sourceInfo.bytes || cache?.bytes || bytes.length) cachePatch.bytes = sourceInfo.bytes || cache?.bytes || bytes.length;
        const cacheNeedsSave = !cache
          || !hasCompleteTextCache
          || Number(cache?.textLayoutVersion) !== PDF_TEXT_LAYOUT_VERSION
          || Boolean(savedSource)
          || (cachePatch.sourceUrl && cachePatch.sourceUrl !== cache.sourceUrl)
          || (cachePatch.pdfUrl && cachePatch.pdfUrl !== cache.pdfUrl)
          || (cachePatch.sourceSha256 && cachePatch.sourceSha256 !== cache.sourceSha256)
          || (cachePatch.bytes && cachePatch.bytes !== cache.bytes);
        const savedCache = cacheNeedsSave ? await persistPdfCache(cachePatch) : cache;
        if (cache && !savedSource && savedCache) setPdfCacheStatus("restored");
        // 恢复本地已完成的版式翻译，避免每次打开重新翻译
        if (!isTranslatedVariant && !preservePdfMathResult) {
          const restored = await restorePdfMathFromLocal(cache?.layoutTranslationJobId || savedCache?.layoutTranslationJobId || "");
          if (restored?.jobId && restored.jobId !== cache?.layoutTranslationJobId) {
            void persistPdfCache({ layoutTranslationJobId: restored.jobId });
          }
        }
      }
    } catch (err) {
      const msg = err.message || "PDF 加载失败";
      setError(msg);
      setErrorIsAuth(/403|401|TOO_MANY_REDIRECTS|需要登录/i.test(msg));
      setLoading(false);
    }
  };

  const loadImageFile = (file) => {
    setLoading(true);
    setError("");
    setErrorIsAuth(false);
    setPdfSourceBase64("");
    setOriginalPdfSource(null);
    setActivePdfVariant("original");
    setPdfMathState("idle");
    setPdfMathError("");
    setPdfMathResult(null);
    setPdfMathJobId("");
    setPdfMathProgress("");
    setDoc(null);
    setTextByPage({});
    setOcrPageTexts({});
    setParagraphTranslations({});
    setPageTranslations({});
    setDisplayMode("original");
    setSelectionPopup(null);
    setSelectionTranslations({});
    setOcrSelectionCache({});
    setOcrSelectMode(false);
    setOcrSelectionBox(null);
    setOcrError("");
    setOcrProgress("");
    if (imageUrlRef.current) URL.revokeObjectURL(imageUrlRef.current);
    const src = URL.createObjectURL(file);
    imageUrlRef.current = src;
    const image = new Image();
    image.onload = () => {
      setImageSource({ src, name: file.name || "图片" });
      setNumPages(1);
      setPageNum(1);
      setLoading(false);
    };
    image.onerror = () => {
      URL.revokeObjectURL(src);
      if (imageUrlRef.current === src) imageUrlRef.current = null;
      setError("图片加载失败");
      setLoading(false);
    };
    image.src = src;
  };

  useEffect(() => {
    if (url || doi) loadSource({ url, doi });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, doi]);

  useEffect(() => {
    if (Number(initialPage) > 0 && numPages) {
      setPageNum(Math.min(Number(initialPage), numPages));
    }
  }, [initialPage, numPages]);

  useEffect(() => {
    if (initialTab === "notes" || initialTab === "ai" || initialTab === "translate") {
      setShowPanel(true);
      setPanelTab(initialTab);
    }
  }, [initialTab]);

  useEffect(() => {
    let cancelled = false;
    api.pdfMathTranslateStatus()
      .then((status) => {
        if (!cancelled) setPdfMathStatus({ loading: false, ...status });
      })
      .catch((err) => {
        if (!cancelled) setPdfMathStatus({ loading: false, available: false, command: "", installHint: err.message || "排版翻译引擎状态读取失败" });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!interpretationKey || loadedInterpretationRef.current === interpretationKey) return undefined;
    loadedInterpretationRef.current = interpretationKey;

    const restore = async () => {
      let value = null;
      if (paperId) {
        try {
          const response = await api.getPaperInterpretation(paperId);
          value = response.interpretation;
        } catch (err) {
          if (!/还没有保存|404/.test(err.message || "")) {
            setSaveInterpretationError(`读取已保存解读失败：${err.message}`);
          }
        }
      } else {
        try {
          value = JSON.parse(localStorage.getItem(interpretationKey) || "null");
        } catch {
          value = null;
        }
      }

      const saved = normalizeSavedInterpretation(value);
      if (cancelled || !saved) return;
      setInterpretResult(saved.result);
      setInterpretMeta({
        mode: saved.mode,
        usedChars: saved.usedChars,
        pageCoverage: saved.pageCoverage,
        usage: saved.usage,
        model: saved.model
      });
      const restoredFollowups = saved.followups || [];
      followupsRef.current = restoredFollowups;
      setFollowups(restoredFollowups);
      setSaveInterpretationStatus("saved");
    };

    restore();
    return () => {
      cancelled = true;
    };
  }, [interpretationKey, paperId]);

  useEffect(() => {
    let cancelled = false;
    let textLayerTask = null;
    let textLayerDoubleClick = null;
    let pageRenderTask = null;
    let detachTextSelection = null;
    if ((!doc && !imageSource) || !canvasRef.current) return undefined;

    if (imageSource) {
      const canvas = canvasRef.current;
      const surface = pageSurfaceRef.current;
      textLayerRef.current?.replaceChildren();
      const image = new Image();
      image.onload = () => {
        if (cancelled) return;
        const dpr = window.devicePixelRatio || 1;
        const cssWidth = Math.max(1, Math.floor(image.naturalWidth * scale));
        const cssHeight = Math.max(1, Math.floor(image.naturalHeight * scale));
        canvas.width = Math.floor(cssWidth * dpr);
        canvas.height = Math.floor(cssHeight * dpr);
        canvas.style.width = `${cssWidth}px`;
        canvas.style.height = `${cssHeight}px`;
        if (surface) {
          surface.style.width = `${cssWidth}px`;
          surface.style.height = `${cssHeight}px`;
        }
        const ctx = canvas.getContext("2d");
        ctx.setTransform(dpr * scale, 0, 0, dpr * scale, 0, 0);
        ctx.drawImage(image, 0, 0);
      };
      image.onerror = () => {
        if (!cancelled) setError("图片渲染失败");
      };
      image.src = imageSource.src;
      return () => {
        cancelled = true;
      };
    }

    (async () => {
      try {
        // 仅当版式文档与当前页匹配时才渲染译文，否则渲染原文（避免翻页串页）
        const renderFromLayout = layoutViewReady;
        const sourceDoc = renderFromLayout ? layoutViewDoc : doc;
        if (!sourceDoc) return;
        // pdf2zh 按 --pages N 生成的 mono/dual 往往仍是「整本 PDF」（仅第 N 页为译文），
        // 不能固定渲染第 1 页，否则会一直看到第一页原文。
        const maxPage = sourceDoc.numPages || 1;
        let sourcePageNum = pageNum;
        if (renderFromLayout) {
          sourcePageNum = maxPage <= 1 ? 1 : pageNum;
        }
        const safePage = Math.max(1, Math.min(maxPage, sourcePageNum));
        const page = await sourceDoc.getPage(safePage);
        if (cancelled) return;
        const viewport = page.getViewport({ scale });
        const canvas = canvasRef.current;
        const surface = pageSurfaceRef.current;
        const textContainer = textLayerRef.current;
        if (!canvas) return;
        const cssWidth = Math.floor(viewport.width);
        const cssHeight = Math.floor(viewport.height);
        const dpr = window.devicePixelRatio || 1;
        canvas.width = Math.floor(viewport.width * dpr);
        canvas.height = Math.floor(viewport.height * dpr);
        canvas.style.width = `${cssWidth}px`;
        canvas.style.height = `${cssHeight}px`;
        if (surface) {
          surface.style.width = `${cssWidth}px`;
          surface.style.height = `${cssHeight}px`;
        }
        const ctx = canvas.getContext("2d");
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        const textContent = await page.getTextContent();
        if (cancelled) return;
        // 仅在原文上建立文本布局缓存，供文字翻译覆盖层使用
        let pageLayout = null;
        if (!renderFromLayout) {
          pageLayout = buildPdfTextLayout(textContent.items, page.getViewport({ scale: 1 }));
          setPageTextLayouts((previous) => previous[pageNum] ? previous : { ...previous, [pageNum]: pageLayout });
          if (displayMode === "translated" && pageTranslations[pageNum] && !isTranslationError(pageTranslations[pageNum]) && !pageTranslationLayouts[pageNum]) {
            setPageTranslationLayouts((previous) => previous[pageNum]
              ? previous
              : { ...previous, [pageNum]: parseLayoutTranslation(pageTranslations[pageNum], pageLayout) });
          }
        }
        pageRenderTask = page.render({ canvasContext: ctx, viewport });
        const renderPromise = pageRenderTask.promise;
        let textPromise = Promise.resolve();
        if (textContainer) {
          textContainer.replaceChildren();
          textContainer.style.setProperty("--total-scale-factor", String(viewport.scale));
          textLayerTask = new pdfjsLib.TextLayer({
            textContentSource: textContent,
            container: textContainer,
            viewport
          });
          textPromise = textLayerTask.render();
          textLayerDoubleClick = (event) => {
            const target = event.target?.closest?.("span");
            if (!target || !textContainer.contains(target)) return;
            const text = normalizePdfSelection(target.textContent);
            const anchor = normalizedSelectionAnchor(target.getBoundingClientRect(), surface?.getBoundingClientRect());
            if (text && anchor) setSelectionPopup({ text, ...anchor, error: "" });
          };
          textContainer.addEventListener("dblclick", textLayerDoubleClick);
        }
        await Promise.all([renderPromise, textPromise]);
        if (cancelled) return;
        // 原页画完后取样颜色/底色，译文覆盖层跟原文走
        if (!renderFromLayout && pageLayout?.length) {
          const painted = applySampledLineAppearance(pageLayout, canvas, cssWidth, cssHeight);
          setPageTextLayouts((previous) => ({ ...previous, [pageNum]: painted }));
          setPageTranslationLayouts((previous) => {
            const current = previous[pageNum];
            if (!Array.isArray(current) || !current.length) return previous;
            return {
              ...previous,
              [pageNum]: current.map((line, index) => ({
                ...line,
                color: painted[index]?.color || line.color,
                background: painted[index]?.background || line.background,
                fontWeight: painted[index]?.fontWeight || line.fontWeight
              }))
            };
          });
        }
        if (textContainer) {
          detachTextSelection = attachPdfTextLayerSelection(textContainer, {
            onSelectionStart: () => setSelectionPopup(null)
          });
          if (cancelled) {
            detachTextSelection?.();
            detachTextSelection = null;
          }
        }
      } catch (err) {
        if (cancelled || err?.name === "RenderingCancelledException" || /cancel/i.test(String(err?.message || ""))) return;
        // 版式页渲染失败：不写全局 error，也不永久锁死；下次切换可重试
        if (renderFromLayout) {
          console.warn("[PdfReader] layout render failed:", err);
          return;
        }
        if (!cancelled) setError(err.message || "页面渲染失败");
      }
    })();
    return () => {
      cancelled = true;
      try {
        pageRenderTask?.cancel?.();
      } catch {
        /* ignore */
      }
      textLayerTask?.cancel?.();
      detachTextSelection?.();
      if (textLayerDoubleClick && textLayerRef.current) {
        textLayerRef.current.removeEventListener("dblclick", textLayerDoubleClick);
      }
    };
  }, [doc, imageSource, pageNum, scale, displayMode, pageTranslations[pageNum], layoutViewReady, layoutViewDoc]);

  useEffect(() => {
    setSelectionPopup(null);
    window.getSelection?.()?.removeAllRanges?.();
  }, [pageNum, scale]);

  const commitLayoutView = (pdf, meta) => {
    layoutViewDocRef.current = pdf;
    layoutViewMetaRef.current = meta;
    setLayoutViewDoc(pdf);
    setLayoutViewMeta(meta);
  };

  // 任务切换时清空版式 PDF 缓存
  useEffect(() => {
    layoutDocCacheRef.current.clear();
    layoutLoadSeqRef.current += 1;
    commitLayoutView(null, null);
    setLayoutViewError("");
    setLayoutViewLoading(false);
  }, [pdfMathJobId]);

  // 按上方显示模式加载本页版式译文 PDF（mono=译文，dual=中英对照）
  useEffect(() => {
    const seq = ++layoutLoadSeqRef.current;
    const isCurrent = () => layoutLoadSeqRef.current === seq;
    const targetUrl = layoutPageResolved.url || "";
    const targetVariant = layoutPageResolved.variant || layoutDisplayVariant || "";
    const targetWhole = Boolean(layoutPageResolved.whole);
    const targetKey = { url: targetUrl, pageNum };

    if (!layoutDisplayVariant) {
      // 切回原文：释放当前绑定（缓存保留，便于再点译文秒开）
      if (layoutViewMetaRef.current || layoutViewDocRef.current) {
        commitLayoutView(null, null);
      }
      setLayoutViewLoading(false);
      setLayoutViewError("");
      return undefined;
    }

    if (!targetUrl) {
      // 本页尚未译完：解除绑定，显示原文 + 提示；不要污染 loading
      if (layoutViewMetaRef.current || layoutViewDocRef.current) {
        commitLayoutView(null, null);
      }
      setLayoutViewLoading(false);
      setLayoutViewError("");
      return undefined;
    }

    const nextMeta = {
      url: targetUrl,
      variant: targetVariant,
      page: pageNum,
      whole: targetWhole
    };

    // 已绑定当前页：直接可用
    if (layoutViewMatches(layoutViewMetaRef.current, targetKey) && layoutViewDocRef.current) {
      setLayoutViewLoading(false);
      setLayoutViewError("");
      return undefined;
    }

    // 同步缓存命中：翻页回来应立即恢复译文，不能闪回英文后卡住
    const cached = layoutDocCacheRef.current.get(targetUrl);
    if (cached) {
      commitLayoutView(cached, nextMeta);
      setLayoutViewLoading(false);
      setLayoutViewError("");
      return undefined;
    }

    setLayoutViewLoading(true);
    setLayoutViewError("");
    // 解除旧页绑定，防止串页；缓存仍在
    if (!layoutViewMatches(layoutViewMetaRef.current, targetKey)) {
      commitLayoutView(null, null);
    }

    (async () => {
      try {
        const res = await fetch(targetUrl);
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        const data = await res.arrayBuffer();
        const pdf = await pdfjsLib.getDocument({ data, wasmUrl: PDFJS_WASM_URL }).promise;
        layoutDocCacheRef.current.set(targetUrl, pdf);
        if (!isCurrent()) return;
        commitLayoutView(pdf, nextMeta);
        setLayoutViewError("");
      } catch (err) {
        if (!isCurrent()) return;
        commitLayoutView(null, null);
        setLayoutViewError(err.message || "版式译文加载失败");
      } finally {
        if (isCurrent()) setLayoutViewLoading(false);
      }
    })();

    return () => {
      // 使进行中的请求失效；loading 由新 effect / finally 收敛
      if (layoutLoadSeqRef.current === seq) {
        // 被同依赖重入时 seq 已自增，这里不必改
      }
    };
  }, [layoutDisplayVariant, layoutPageResolved.url, layoutPageResolved.variant, layoutPageResolved.whole, pageNum, layoutReloadToken]);

  useEffect(() => {
    const item = evidenceHighlight;
    const container = textLayerRef.current;
    if (!item || item.page !== pageNum || !container) return undefined;

    const clearHits = () => {
      container.querySelectorAll(".pdf-evidence-hit").forEach((node) => node.classList.remove("pdf-evidence-hit"));
    };
    const findAndReveal = () => {
      const quote = normalizeEvidenceText(item.quote);
      const spans = [...container.querySelectorAll("span")];
      if (!spans.length) return false;
      clearHits();
      if (!quote) return false;
      const hit = spans.find((span) => {
        const text = normalizeEvidenceText(span.textContent);
        return text && (text.includes(quote) || (text.length >= 12 && quote.includes(text)));
      });
      if (!hit) return false;
      hit.classList.add("pdf-evidence-hit");
      hit.scrollIntoView?.({ behavior: "smooth", block: "center", inline: "center" });
      return true;
    };

    let attempts = 0;
    const interval = window.setInterval(() => {
      attempts += 1;
      if (findAndReveal() || attempts >= 30) window.clearInterval(interval);
    }, 50);
    return () => window.clearInterval(interval);
  }, [evidenceHighlight, pageNum, scale]);

  useEffect(() => () => {
    if (evidenceTimerRef.current) window.clearTimeout(evidenceTimerRef.current);
    if (imageUrlRef.current) URL.revokeObjectURL(imageUrlRef.current);
  }, []);

  useEffect(() => {
    if (panelTab !== "translate") return;
    panelRef.current?.scrollTo({ top: 0 });
    translateShellRef.current?.scrollTo({ top: 0 });
  }, [pageNum, panelTab]);

  // 版式翻译进行中翻页：只通知服务端「当前阅读页」；已译完的页不会重译
  useEffect(() => {
    if (pdfMathState !== "working" || !pdfMathJobId || !pageNum) return undefined;
    // 本页版式已就绪时仍同步优先页，便于后台预取下一页，但不会触发重译
    let cancelled = false;
    void api.prioritizePdfMathTranslate(pdfMathJobId, pageNum)
      .then((job) => {
        if (cancelled || !job) return;
        setPdfMathResult(job);
        if (job.progress) setPdfMathProgress(job.progress);
      })
      .catch(() => {
        /* 任务已结束或不存在时忽略 */
      });
    return () => { cancelled = true; };
  }, [pageNum, pdfMathJobId, pdfMathState]);

  // Ctrl / ⌘ + 滚轮缩放（需 passive:false 才能拦截浏览器默认缩放）
  useEffect(() => {
    const el = canvasWrapRef.current;
    if (!el) return undefined;
    const onWheel = (e) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      e.stopPropagation();
      // 触控板可能给出很小的 delta，按方向步进，避免一次滚太多
      const dir = e.deltaY > 0 ? -1 : e.deltaY < 0 ? 1 : 0;
      if (!dir) return;
      setScale((s) => clampScale(s + dir * SCALE_STEP_WHEEL));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const openFile = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.type.startsWith("image/")) {
      loadImageFile(file);
      e.target.value = "";
      return;
    }
    const reader = new FileReader();
    reader.onload = () => loadSource({ data: reader.result });
    reader.readAsArrayBuffer(file);
    e.target.value = "";
  };

  const getOcrCanvasForPage = async (targetPage) => {
    if (imageSource) {
      const image = await loadImageElement(imageSource.src);
      const renderScale = Math.max(1.5, scale);
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.floor(image.naturalWidth * renderScale));
      canvas.height = Math.max(1, Math.floor(image.naturalHeight * renderScale));
      canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
      return canvas;
    }
    if (!doc) return null;
    const page = await doc.getPage(targetPage);
    const viewport = page.getViewport({ scale: Math.max(1.5, scale) });
    const canvas = document.createElement("canvas");
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
    return canvas;
  };

  const recognizePageText = async (targetPage = pageNum) => {
    if (ocrPageTexts[targetPage]) return ocrPageTexts[targetPage];
    if (!hasPageSource || ocrBusy) return "";
    setOcrBusy(true);
    setOcrError("");
    setOcrProgress("正在加载 OCR 引擎…");
    try {
      const canvas = await getOcrCanvasForPage(targetPage);
      const result = await recognizeOcrImage(canvas, (message) => setOcrProgress(ocrProgressLabel(message)));
      if (!result.text) throw new Error("这一页没有识别到可翻译文字，请尝试放大或框选文字更清晰的区域");
      setOcrPageTexts((prev) => ({ ...prev, [targetPage]: result.text }));
      void persistPdfCache({ ocrPageTexts: { [targetPage]: result.text } });
      return result.text;
    } catch (err) {
      setOcrError(`OCR 识别失败：${err.message || "未知错误"}`);
      return "";
    } finally {
      setOcrBusy(false);
      setOcrProgress("");
    }
  };

  const translateOcrText = async (text, mode) => {
    const protectedText = protectOcrText(text);
    const result = await api.translate({ text: protectedText.text, config, mode, preserveTokens: true });
    return restoreProtectedText(result.text, protectedText.tokens);
  };

  const addOcrSelectionTranslation = (popup, translation) => {
    const item = {
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      cacheKey: popup.regionKey,
      source: "ocr",
      original: popup.text,
      translation,
      x: popup.x,
      y: popup.y
    };
    const nextOcrCache = {
      ...ocrSelectionCache,
      [popup.regionKey]: { ...(ocrSelectionCache[popup.regionKey] || {}), text: popup.text, box: popup.box, translation }
    };
    const nextSelectionTranslations = {
      ...selectionTranslations,
      [pageNum]: (selectionTranslations[pageNum] || []).some((existing) => existing.cacheKey === popup.regionKey)
        ? (selectionTranslations[pageNum] || []).map((existing) => existing.cacheKey === popup.regionKey ? { ...existing, translation } : existing)
        : [...(selectionTranslations[pageNum] || []), item]
    };
    setOcrSelectionCache(nextOcrCache);
    setSelectionTranslations(nextSelectionTranslations);
    void persistPdfCache({
      ocrSelectionCache: { [popup.regionKey]: nextOcrCache[popup.regionKey] },
      selectionTranslations: { [pageNum]: nextSelectionTranslations[pageNum] }
    });
    setSelectionPopup(null);
    setOcrSelectionBox(null);
  };

  const translateOcrSelection = async (popup, text = popup?.text) => {
    if (!popup?.text || !config || selectionLoading) return;
    const cached = ocrSelectionCache[popup.regionKey];
    if (cached?.translation) {
      addOcrSelectionTranslation(popup, cached.translation);
      return;
    }
    setSelectionLoading(true);
    try {
      const translation = await translateOcrText(text, "selection");
      addOcrSelectionTranslation(popup, translation);
    } catch (err) {
      setSelectionPopup((prev) => prev ? { ...prev, error: `翻译失败：${err.message}` } : prev);
    } finally {
      setSelectionLoading(false);
    }
  };

  const runOcrRegion = async (box) => {
    const normalized = normalizeOcrBox(box);
    if (!normalized || ocrBusy) return;
    const regionKey = ocrRegionCacheKey(pageNum, normalized);
    const anchor = {
      x: Math.min(92, Math.max(8, ((normalized.left + normalized.right) / 2) * 100)),
      y: Math.min(94, Math.max(2, normalized.bottom * 100))
    };
    const cached = ocrSelectionCache[regionKey];
    if (cached?.text) {
      const popup = { text: cached.text, box: normalized, regionKey, ...anchor, ocr: true, error: "" };
      setSelectionPopup(popup);
      if (cached.translation && config) addOcrSelectionTranslation(popup, cached.translation);
      else if (config) await translateOcrSelection(popup, cached.text);
      return;
    }

    setOcrBusy(true);
    setOcrError("");
    setOcrProgress("正在识别选区…");
    try {
      const image = cropCanvas(canvasRef.current, normalized);
      const result = await recognizeOcrImage(image, (message) => setOcrProgress(ocrProgressLabel(message)));
      if (!result.text) throw new Error("选区内没有识别到文字，请扩大区域或提高 PDF 清晰度");
      const popup = { text: result.text, box: normalized, regionKey, ...anchor, ocr: true, error: "" };
      setOcrSelectionCache((prev) => ({ ...prev, [regionKey]: { text: result.text, box: normalized } }));
      setSelectionPopup(popup);
      if (config) await translateOcrSelection(popup, result.text);
    } catch (err) {
      setOcrError(`OCR 识别失败：${err.message || "未知错误"}`);
    } finally {
      setOcrBusy(false);
      setOcrProgress("");
    }
  };

  const pointerPosition = (event) => {
    const surface = pageSurfaceRef.current;
    if (!surface) return null;
    const rect = surface.getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)),
      y: Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height))
    };
  };

  const handleOcrPointerDown = (event) => {
    if (!ocrSelectMode || event.button !== 0 || ocrBusy) return;
    const start = pointerPosition(event);
    if (!start) return;
    event.preventDefault();
    ocrDragRef.current = { active: true, start, current: start, pointerId: event.pointerId };
    setOcrSelectionBox({ left: start.x, top: start.y, right: start.x, bottom: start.y, width: 0, height: 0 });
    setOcrDragging(true);
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const handleOcrPointerMove = (event) => {
    if (!ocrDragRef.current.active) return;
    const current = pointerPosition(event);
    if (!current) return;
    ocrDragRef.current.current = current;
    setOcrSelectionBox(normalizeOcrBox({
      left: ocrDragRef.current.start.x,
      top: ocrDragRef.current.start.y,
      right: current.x,
      bottom: current.y
    }));
  };

  const handleOcrPointerUp = (event) => {
    if (!ocrDragRef.current.active) return;
    const current = pointerPosition(event) || ocrDragRef.current.current;
    const start = ocrDragRef.current.start;
    const box = normalizeOcrBox({ left: start.x, top: start.y, right: current.x, bottom: current.y });
    ocrDragRef.current = { active: false, start: null, current: null, pointerId: null };
    setOcrDragging(false);
    setOcrSelectMode(false);
    if (!box || box.width < 0.015 || box.height < 0.015) {
      setOcrSelectionBox(null);
      return;
    }
    setOcrSelectionBox(box);
    void runOcrRegion(box);
  };

  const canUseHandPan = interactionMode === "hand" && !ocrSelectMode && !ocrBusy;

  const handlePanPointerDown = (event) => {
    if (!canUseHandPan || event.button !== 0) return;
    if (event.target?.closest?.("button, a, input, textarea, .pdf-selection-popover, .pdf-selection-translation-card, .pdf-edge-page-btn")) {
      return;
    }
    const wrap = canvasWrapRef.current;
    if (!wrap) return;
    event.preventDefault();
    panDragRef.current = {
      active: true,
      startX: event.clientX,
      startY: event.clientY,
      scrollLeft: wrap.scrollLeft,
      scrollTop: wrap.scrollTop,
      pointerId: event.pointerId
    };
    setIsPanning(true);
    wrap.setPointerCapture?.(event.pointerId);
  };

  const handlePanPointerMove = (event) => {
    if (!panDragRef.current.active) return;
    const wrap = canvasWrapRef.current;
    if (!wrap) return;
    const dx = event.clientX - panDragRef.current.startX;
    const dy = event.clientY - panDragRef.current.startY;
    wrap.scrollLeft = panDragRef.current.scrollLeft - dx;
    wrap.scrollTop = panDragRef.current.scrollTop - dy;
  };

  const handlePanPointerUp = (event) => {
    if (!panDragRef.current.active) return;
    const wrap = canvasWrapRef.current;
    if (wrap && panDragRef.current.pointerId != null) {
      try { wrap.releasePointerCapture?.(panDragRef.current.pointerId); } catch { /* ignore */ }
    }
    panDragRef.current = { active: false, startX: 0, startY: 0, scrollLeft: 0, scrollTop: 0, pointerId: null };
    setIsPanning(false);
  };

  const setPdfInteractionMode = (mode) => {
    const next = mode === "hand" ? "hand" : "select";
    setInteractionMode(next);
    if (next === "hand") {
      setSelectionPopup(null);
      window.getSelection?.()?.removeAllRanges?.();
      // 手型与 OCR 框选互斥
      if (ocrSelectMode) {
        setOcrSelectMode(false);
        setOcrSelectionBox(null);
      }
    }
  };

  const collapseSidePanel = () => {
    setShowPanel(false);
    setAiFocus(false);
  };

  const expandSidePanel = (tab = "translate") => {
    setShowPanel(true);
    if (tab === "ai" || tab === "notes" || tab === "translate") setPanelTab(tab);
    else setPanelTab("translate");
  };

  useEffect(() => () => {
    if (notesSaveTimerRef.current) window.clearTimeout(notesSaveTimerRef.current);
  }, []);

  const captureTextSelection = (event) => {
    if (interactionMode === "hand" || panDragRef.current.active) return;
    if (ocrDragRef.current.active || ocrSelectMode) return;
    if (isPdfSelectionOverlayTarget(event?.target)) return;
    requestAnimationFrame(() => {
      const selection = window.getSelection?.();
      if (!selection || selection.rangeCount < 1 || selection.isCollapsed) {
        return;
      }
      const range = selection.getRangeAt(0);
      const textLayer = textLayerRef.current;
      const surface = pageSurfaceRef.current;
      if (!textLayer || !surface || !textLayer.contains(range.commonAncestorContainer)) {
        return;
      }
      const text = normalizePdfSelection(selection.toString());
      const selectionRect = pickSelectionAnchorRect(range.getClientRects(), range.getBoundingClientRect());
      const anchor = normalizedSelectionAnchor(selectionRect, surface.getBoundingClientRect());
      if (!text || !anchor) {
        setSelectionPopup(null);
        return;
      }
      setSelectionPopup({ text, ...anchor, error: "" });
    });
  };

  const translateSelection = async () => {
    if (!selectionPopup?.text || !config || selectionLoading) return;
    if (selectionPopup.ocr) {
      await translateOcrSelection(selectionPopup);
      return;
    }
    setSelectionLoading(true);
    try {
      const result = await api.translate({ text: selectionPopup.text, config, mode: "selection" });
      const item = {
        id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        original: selectionPopup.text,
        translation: result.text,
        x: selectionPopup.x,
        y: selectionPopup.y
      };
      const nextSelectionTranslations = {
        ...selectionTranslations,
        [pageNum]: [...(selectionTranslations[pageNum] || []), item]
      };
      setSelectionTranslations(nextSelectionTranslations);
      void persistPdfCache({ selectionTranslations: { [pageNum]: nextSelectionTranslations[pageNum] } });
      setSelectionPopup(null);
      window.getSelection?.()?.removeAllRanges?.();
    } catch (err) {
      setSelectionPopup((prev) => prev ? { ...prev, error: `翻译失败：${err.message}` } : prev);
    } finally {
      setSelectionLoading(false);
    }
  };

  const removeSelectionTranslation = (id) => {
    const nextSelectionTranslations = {
      ...selectionTranslations,
      [pageNum]: (selectionTranslations[pageNum] || []).filter((item) => item.id !== id)
    };
    setSelectionTranslations(nextSelectionTranslations);
    void persistPdfCache({ selectionTranslations: { [pageNum]: nextSelectionTranslations[pageNum] } });
  };

  const translateParagraph = async (index) => {
    const text = paragraphs[index];
    if (!text || !config) return;
    const key = `${pageNum}:${index}`;
    setTranslatingParagraphs((prev) => ({ ...prev, [key]: true }));
    try {
      const result = await api.translate({ text, config, mode: "paragraph" });
      setParagraphTranslations((prev) => ({ ...prev, [key]: result.text }));
      void persistPdfCache({ paragraphTranslations: { [key]: result.text } });
      setDisplayMode("bilingual");
    } catch (err) {
      setParagraphTranslations((prev) => ({ ...prev, [key]: `翻译失败：${err.message}` }));
    } finally {
      setTranslatingParagraphs((prev) => ({ ...prev, [key]: false }));
    }
  };

  const getPageTextLayout = async (targetPage) => {
    if (!doc || imageSource) return [];
    if (Array.isArray(pageTextLayouts[targetPage])) return pageTextLayouts[targetPage];
    const page = await doc.getPage(targetPage);
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    const layout = buildPdfTextLayout(content.items, viewport);
    setPageTextLayouts((previous) => previous[targetPage] ? previous : { ...previous, [targetPage]: layout });
    return layout;
  };

  const translatePageWithLayout = async (targetPage, text) => {
    const layout = await getPageTextLayout(targetPage);
    if (!layout.length) return null;
    const result = await api.translate({
      text: buildLayoutTranslationPrompt(layout),
      config,
      mode: "page-layout",
      preserveTokens: true
    });
    const rawText = String(result?.text || "").trim();
    const lines = parseLayoutTranslation(rawText, layout);
    if (!lines.length) return rawText ? { text: rawText, lines: null } : null;
    return { text: joinLayoutTranslation(lines) || String(text || "").trim(), lines };
  };

  const translateCurrentPage = async (force = false) => {
    if (!config || translatingPage || !hasPageSource) return;
    if (!force && pageTranslations[pageNum]) {
      setDisplayMode("translated");
      return;
    }
    setTranslatingPage(pageNum);
    try {
      const text = pageText || await recognizePageText(pageNum);
      if (!text) return;
      const translated = pageIsOcr || !textByPage[pageNum]
        ? { text: await translateOcrText(text, "page"), lines: null }
        : await translatePageWithLayout(pageNum, text) || {
          text: (await api.translate({ text, config, mode: "page" })).text,
          lines: null
        };
      if (!translated?.text) return;
      setPageTranslations((prev) => ({ ...prev, [pageNum]: translated.text }));
      setPageTranslationLayouts((prev) => translated.lines ? ({ ...prev, [pageNum]: translated.lines }) : prev);
      const cachePatch = {
        textLayoutVersion: PDF_TEXT_LAYOUT_VERSION,
        pageTranslations: { [pageNum]: translated.text }
      };
      if (translated.lines) cachePatch.pageTranslationLayouts = { [pageNum]: translated.lines };
      void persistPdfCache(cachePatch);
      setDisplayMode("translated");
    } catch (err) {
      setPageTranslations((prev) => ({ ...prev, [pageNum]: `翻译失败：${err.message}` }));
    } finally {
      setTranslatingPage(null);
    }
  };

  const translateFull = async () => {
    if (!hasPageSource || !config || translatingAll) return;
    setTranslatingAll(true);
    setDisplayMode("translated");
    // 阅读顺序：当前页 → 向后 → 再补前面；一页一页串行全力
    const startPage = Math.min(Math.max(1, pageNum || 1), Math.max(1, numPages));
    const readingOrder = [
      ...Array.from({ length: Math.max(0, numPages - startPage + 1) }, (_, index) => startPage + index),
      ...Array.from({ length: Math.max(0, startPage - 1) }, (_, index) => index + 1)
    ];
    const queue = readingOrder.filter((i) => !pageTranslations[i] || isTranslationError(pageTranslations[i]));
    let completed = 0;
    for (const i of queue) {
      let text = effectiveTextByPage[i];
      let fromOcr = !textByPage[i] && Boolean(text);
      if (!text) {
        setTranslateProgress(`正在识别第 ${i}/${numPages} 页…`);
        text = await recognizePageText(i);
        fromOcr = Boolean(text);
      }
      if (!text) {
        completed += 1;
        continue;
      }
      setTranslateProgress(`正在全力翻译第 ${i} 页（${completed + 1}/${queue.length}）…`);
      try {
        const translated = fromOcr
          ? { text: await translateOcrText(text, "page"), lines: null }
          : await translatePageWithLayout(i, text) || {
            text: (await api.translate({ text, config, mode: "page" })).text,
            lines: null
          };
        if (translated?.text) {
          setPageTranslations((prev) => ({ ...prev, [i]: translated.text }));
          setPageTranslationLayouts((prev) => translated.lines ? ({ ...prev, [i]: translated.lines }) : prev);
          const cachePatch = {
            textLayoutVersion: PDF_TEXT_LAYOUT_VERSION,
            pageTranslations: { [i]: translated.text }
          };
          if (translated.lines) cachePatch.pageTranslationLayouts = { [i]: translated.lines };
          void persistPdfCache(cachePatch);
        }
      } catch (err) {
        setPageTranslations((prev) => ({ ...prev, [i]: `翻译失败：${err.message}` }));
      }
      completed += 1;
      setTranslateProgress(`第 ${i} 页已完成（${completed}/${queue.length}），可继续阅读`);
    }
    setTranslateProgress("");
    setTranslatingAll(false);
  };

  /**
   * 版式翻译：统一心智模型
   * - 默认「译完全部未完成页」，已完成自动跳过
   * - force 才整本重来
   * - 进行中翻页只改优先，不重开任务
   */
  const translateWithPdfMath = async ({ force = false } = {}) => {
    if (!pdfSourceBase64 || !config || !pdfMathStatus.available) return;
    if (pdfMathState === "working") return;
    if (!force && layoutAllDone) {
      setPdfMathProgress(`全部 ${layoutCompletedCount} 页已完成`);
      setPdfMathState("ready");
      return;
    }

    const resuming = !force && hasAnyLayoutResult;
    pdfMathCancelRequested.current = false;
    if (!resuming) pdfMathFirstPageOpened.current = false;
    setPdfMathState("working");
    setPdfMathError("");
    if (force) setPdfMathResult(null);
    setPdfMathProgress(
      force
        ? "正在重新翻译全书…"
        : resuming
          ? `继续翻译，已完成 ${layoutCompletedCount} 页将跳过…`
          : "正在开始版式翻译…"
    );
    const priorityPage = pageNum || 1;
    try {
      const started = await api.pdfMathTranslate({
        data: pdfSourceBase64,
        config,
        sourceLang: "en",
        targetLang: "zh",
        pageCount: numPages,
        progressive: true,
        priorityPage,
        paperId: paperId || "",
        jobId: (!force && pdfMathJobId) ? pdfMathJobId : "",
        force: Boolean(force),
        // 主路径始终续译全部未完成页，避免「译两页就停」让人摸不着头脑
        continueAll: !force
      });
      setPdfMathJobId(started.jobId || "");
      if (paperId && started.jobId) {
        void persistPdfCache({ layoutTranslationJobId: started.jobId });
      }
      const showFirstReadyPdfMathPage = (candidate) => {
        const completed = (candidate.pages || []).filter((page) => page.status === "completed" && (page.dualUrl || page.monoUrl));
        if (!completed.length || pdfMathFirstPageOpened.current) return;
        const preferred = completed.find((page) => page.page === priorityPage) || completed[0];
        pdfMathFirstPageOpened.current = true;
        if (!resuming && preferred.page && preferred.page !== pageNum) setPageNum(preferred.page);
        setDisplayMode(preferred.dualUrl ? "bilingual" : "translated");
      };
      let job = started;
      if (!["queued", "running", "canceling"].includes(job.status)) {
        setPdfMathResult(job);
        showFirstReadyPdfMathPage(job);
        setPdfMathProgress(job.progress || "已从本地恢复版式译文");
        const hasCompletedPage = (job.pages || []).some((page) => page.status === "completed" && (page.monoUrl || page.dualUrl));
        const incomplete = (job.pages || []).filter((page) => !(page.status === "completed" && (page.monoUrl || page.dualUrl))).length;
        if (job.status === "completed" && hasCompletedPage && incomplete === 0) {
          setPdfMathState("ready");
          return;
        }
        if (hasCompletedPage && incomplete > 0 && !force) {
          const resumed = await api.pdfMathTranslate({
            data: pdfSourceBase64,
            config,
            sourceLang: "en",
            targetLang: "zh",
            pageCount: numPages,
            progressive: true,
            priorityPage,
            paperId: paperId || "",
            jobId: started.jobId || pdfMathJobId || "",
            force: false,
            continueAll: true
          });
          job = resumed;
          setPdfMathJobId(resumed.jobId || started.jobId || "");
        } else if (hasCompletedPage || job.monoUrl || job.dualUrl) {
          setPdfMathState("ready");
          return;
        } else {
          throw new Error(job.error || "PDF 排版翻译没有生成译文 PDF");
        }
      }
      while (["queued", "running", "canceling"].includes(job.status)) {
        setPdfMathResult(job);
        showFirstReadyPdfMathPage(job);
        setPdfMathProgress(job.progress || "正在翻译…");
        await wait(1000);
        job = await api.pdfMathTranslateJob(job.jobId || started.jobId);
      }
      setPdfMathResult(job);
      showFirstReadyPdfMathPage(job);
      setPdfMathProgress(job.progress || "");
      if (job.status === "canceled" || pdfMathCancelRequested.current) {
        const hasCompletedPage = (job.pages || []).some((page) => page.status === "completed" && (page.monoUrl || page.dualUrl));
        setPdfMathState(hasCompletedPage ? "ready" : "idle");
        setPdfMathError("");
        setPdfMathProgress(hasCompletedPage ? "已暂停，可随时继续" : "已停止");
        return;
      }
      const hasCompletedPage = (job.pages || []).some((page) => page.status === "completed" && (page.monoUrl || page.dualUrl));
      if (job.status === "failed" && hasCompletedPage) {
        setPdfMathState("ready");
        setPdfMathError(job.error || "有页面失败，已保留完成页，可点继续");
        return;
      }
      if (job.status !== "completed" && !hasCompletedPage && !job.monoUrl && !job.dualUrl) {
        throw new Error(job.error || "PDF 排版翻译没有生成译文 PDF");
      }
      setPdfMathResult(job);
      setPdfMathState("ready");
      if (paperId && job.jobId) {
        void persistPdfCache({ layoutTranslationJobId: job.jobId });
      }
    } catch (err) {
      if (pdfMathCancelRequested.current) {
        setPdfMathState(hasAnyLayoutResult ? "ready" : "idle");
        setPdfMathError("");
        setPdfMathProgress(hasAnyLayoutResult ? "已暂停，可随时继续" : "已停止");
      } else {
        setPdfMathState(hasAnyLayoutResult ? "ready" : "error");
        setPdfMathError(err.message || "PDF 排版翻译失败");
      }
    }
  };

  const layoutPrimaryAction = useMemo(() => {
    if (!pdfMathStatus.available && !pdfMathStatus.loading) {
      return { kind: "blocked", label: "引擎未安装", disabled: true, force: false };
    }
    if (!config) {
      return { kind: "blocked", label: "请先配置 API", disabled: true, force: false };
    }
    if (!pdfSourceBase64) {
      return { kind: "blocked", label: "请先打开 PDF", disabled: true, force: false };
    }
    if (pdfMathState === "working") {
      return { kind: "stop", label: "停止", disabled: false, force: false };
    }
    if (layoutAllDone) {
      return { kind: "done", label: "已全部完成", disabled: true, force: false };
    }
    if (hasAnyLayoutResult) {
      const left = layoutIncompleteCount || Math.max(0, (layoutPageCount || numPages || 0) - layoutCompletedCount);
      return {
        kind: "continue",
        label: left > 0 ? `继续翻译（剩余 ${left} 页）` : "继续翻译",
        disabled: false,
        force: false
      };
    }
    return { kind: "start", label: "开始翻译", disabled: false, force: false };
  }, [
    pdfMathStatus.available,
    pdfMathStatus.loading,
    config,
    pdfSourceBase64,
    pdfMathState,
    layoutAllDone,
    hasAnyLayoutResult,
    layoutIncompleteCount,
    layoutPageCount,
    numPages,
    layoutCompletedCount
  ]);

  const layoutStatusSummary = useMemo(() => {
    const total = layoutPageCount || numPages || 0;
    const done = layoutCompletedCount;
    if (pdfMathState === "working") {
      if (currentLayoutPage.running) return `正在翻译第 ${pageNum} 页 · ${done}/${total || "—"}`;
      if (currentLayoutPage.done) return `第 ${pageNum} 页已完成 · 后台 ${done}/${total || "—"}`;
      return pdfMathProgress || `翻译中 · ${done}/${total || "—"}`;
    }
    if (layoutAllDone) return `全部完成 · ${done}/${total || done} 页`;
    if (hasAnyLayoutResult) {
      if (currentLayoutPage.done) return `第 ${pageNum} 页已完成 · 全书 ${done}/${total || "—"}`;
      return `第 ${pageNum} 页未译 · 全书 ${done}/${total || "—"}`;
    }
    if (pdfMathError) return pdfMathError;
    return "尚未开始。一点开始，已完成的页会自动跳过。";
  }, [
    pdfMathState,
    currentLayoutPage.running,
    currentLayoutPage.done,
    pageNum,
    layoutCompletedCount,
    layoutPageCount,
    numPages,
    pdfMathProgress,
    layoutAllDone,
    hasAnyLayoutResult,
    pdfMathError
  ]);

  const layoutProgressPercent = useMemo(() => {
    const total = layoutPageCount || numPages || 0;
    if (!total) return 0;
    return Math.min(100, Math.round((layoutCompletedCount / total) * 100));
  }, [layoutCompletedCount, layoutPageCount, numPages]);

  const cancelPdfMath = async () => {
    if (!pdfMathJobId) return;
    pdfMathCancelRequested.current = true;
    setPdfMathProgress("正在停止排版翻译");
    try {
      await api.cancelPdfMathTranslate(pdfMathJobId);
    } catch (err) {
      pdfMathCancelRequested.current = false;
      setPdfMathState("error");
      setPdfMathError(err.message || "取消排版翻译失败");
    }
  };

  /** 导出当前打开的原文 PDF 副本到本机下载目录 */
  const exportOriginalPdf = useCallback(() => {
    if (!pdfSourceBase64) {
      setError("当前没有可导出的原文 PDF（请先成功打开 PDF）");
      return;
    }
    try {
      const binary = atob(pdfSourceBase64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
      const blob = new Blob([bytes], { type: "application/pdf" });
      const objectUrl = URL.createObjectURL(blob);
      const rawName = String(title || doi || "paper")
        .replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 80) || "paper";
      const fileName = rawName.toLowerCase().endsWith(".pdf") ? rawName : `${rawName}.pdf`;
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = fileName;
      anchor.rel = "noopener";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 2000);
    } catch (err) {
      setError(`导出原文失败：${err.message || err}`);
    }
  }, [pdfSourceBase64, title, doi]);

  /** 用系统默认 / 自选软件打开当前原文 PDF */
  const openOriginalExternally = useCallback(async (chooseApp = false) => {
    if (!pdfSourceBase64 && !paperId) {
      setError("当前没有可打开的原文 PDF");
      return;
    }
    try {
      await openPdfExternal({
        paperId: paperId || "",
        data: pdfSourceBase64 || "",
        pdfUrl: url || "",
        title: title || doi || "paper",
        chooseApp: Boolean(chooseApp)
      });
    } catch (err) {
      setError(err.message || "无法用外部软件打开 PDF");
    }
  }, [pdfSourceBase64, paperId, url, title, doi]);

  const restoreOriginalPdf = () => {
    // 兼容旧逻辑：若曾整本替换为译文 PDF，回到原始数据
    setDisplayMode("original");
    if (activePdfVariant === "original" || !originalPdfSource?.data) return;
    loadSource({
      data: base64ToArrayBuffer(originalPdfSource.data),
      useCache: false,
      variant: "original",
      preservePdfMathResult: true,
      doi: originalPdfSource.doi || ""
    });
  };

  const handleDisplayModeChange = (mode) => {
    setLayoutViewError("");
    // 再次点击「译文/中英对照」时强制重新绑定，避免卡在英文原文
    if (mode !== "original") {
      setLayoutReloadToken((token) => token + 1);
    }
    setDisplayMode(mode);
    // 若之前误加载了整本译文 PDF，切回原文时恢复源文件
    if (mode === "original" && activePdfVariant !== "original" && originalPdfSource?.data) {
      loadSource({
        data: base64ToArrayBuffer(originalPdfSource.data),
        useCache: false,
        variant: "original",
        preservePdfMathResult: true,
        doi: originalPdfSource.doi || ""
      });
    }
  };

  const runInterpret = useCallback(
    async (mode) => {
      const resolved = mode === "full" ? "full" : "quick";
      setShowPanel(true);
      setPanelTab("ai");
      setInterpretError("");

      if (!config?.apiKey || !config?.baseUrl || !config?.model) {
        setInterpretError("需要先在设置中配置 API Key 才能解读。");
        return;
      }
      if (loading || !hasPageSource) {
        setInterpretError("请等待 PDF 加载完成后再解读。");
        return;
      }
      if (!hasAnyText(effectiveTextByPage)) {
        setInterpretError("当前页面还没有可用文字，请先在翻译面板点击“识别本页 OCR”。");
        return;
      }
      if (interpretLoading) return;

      setInterpretLoading(true);
      setInterpretProgress(resolved === "full" ? "完全解读：正在阅读全文要点…" : "快速解读：正在提取摘要与结论…");
      followupsRef.current = [];
      setFollowups([]);
      try {
        const data = await api.interpretPdf({
          title: title || "",
          mode: resolved,
          config,
          pages: pagesPayload(effectiveTextByPage)
        });
        const nextResult = data.result || null;
        const nextMeta = {
          mode: data.mode || resolved,
          usedChars: data.usedChars,
          pageCoverage: data.pageCoverage,
          usage: data.usage,
          model: data.model || config?.model || ""
        };
        setInterpretResult(nextResult);
        setInterpretMeta(nextMeta);
        await persistInterpretation({ result: nextResult, meta: nextMeta, followups: [] });
        setInterpretProgress("");
      } catch (err) {
        setInterpretError(err.message || "解读失败");
        setInterpretProgress("");
      } finally {
        setInterpretLoading(false);
      }
    },
    [config, effectiveTextByPage, hasPageSource, interpretLoading, loading, persistInterpretation, title]
  );

  const openAiPanel = useCallback(
    (preferMode) => {
      setShowPanel(true);
      setPanelTab("ai");
      if (!interpretResult && !interpretLoading) {
        runInterpret(preferMode || "quick");
      }
    },
    [interpretLoading, interpretResult, runInterpret]
  );

  const askFollowup = async () => {
    const q = askInput.trim();
    if (!q || !config || askLoading) return;
    if (!hasAnyText(effectiveTextByPage)) {
      setInterpretError("当前还没有 OCR 或正文文本，无法追问。");
      return;
    }
    const followupId = `followup-${Date.now()}-${followupIdRef.current++}`;
    const pending = createPendingFollowup(followupId, q);
    const withPending = [...followupsRef.current, pending];
    followupsRef.current = withPending;
    setFollowups(withPending);
    setAskInput("");
    setAskLoading(true);
    setInterpretError("");
    try {
      const data = await api.interpretPdf({
        title: title || "",
        mode: interpretMeta?.mode || "quick",
        config,
        pages: pagesPayload(effectiveTextByPage),
        question: q,
        prior: interpretResult
      });
      const nextFollowups = settleFollowup(followupsRef.current, followupId, data.answer || "", "done", data.evidence || [], { q });
      followupsRef.current = nextFollowups;
      setFollowups(nextFollowups);
      const nextMeta = data.usage
        ? { ...interpretMeta, usage: data.usage, model: data.model || interpretMeta?.model || config?.model || "" }
        : interpretMeta;
      if (nextMeta !== interpretMeta) setInterpretMeta(nextMeta);
      await persistInterpretation({ result: interpretResult, meta: nextMeta, followups: nextFollowups });
    } catch (err) {
      const nextFollowups = settleFollowup(followupsRef.current, followupId, `追问失败：${err.message}`, "error", [], { q });
      followupsRef.current = nextFollowups;
      setFollowups(nextFollowups);
    } finally {
      setAskLoading(false);
    }
  };

  const saveCurrentInterpretation = () => {
    if (!interpretResult) return;
    persistInterpretation({ result: interpretResult, meta: interpretMeta, followups });
  };

  const jumpToEvidence = useCallback((item) => {
    const targetPage = Number(item?.page) || 0;
    if (!targetPage) return;
    const page = Math.max(1, Math.min(numPages || targetPage, targetPage));
    if (evidenceTimerRef.current) window.clearTimeout(evidenceTimerRef.current);
    setDisplayMode("original");
    setAiFocus(false);
    setShowPanel(false);
    setPageNum(page);
    setEvidenceHighlight({ ...item, page, id: Date.now() });
    evidenceTimerRef.current = window.setTimeout(() => setEvidenceHighlight(null), 6000);
  }, [numPages]);

  useEffect(() => {
    const scroll = aiScrollRef.current;
    if (!scroll || panelTab !== "ai" || !followups.length) return;
    scroll.scrollTo({ top: scroll.scrollHeight, behavior: "smooth" });
  }, [followups, panelTab]);

  useEffect(() => {
    const onKey = (e) => {
      const tag = (e.target?.tagName || "").toLowerCase();
      const typing = tag === "input" || tag === "textarea" || e.target?.isContentEditable;
      if (e.key === "Escape") {
        if (!typing) {
          e.preventDefault();
          // 先退出侧栏放大，再关阅读器
          if (aiFocus) {
            setAiFocus(false);
            return;
          }
          onClose?.();
        }
        return;
      }
      if (typing) return;
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        setPageNum((p) => Math.max(1, p - 1));
        return;
      }
      if (e.key === "ArrowRight") {
        e.preventDefault();
        setPageNum((p) => Math.min(numPages || 1, p + 1));
        return;
      }
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      if (e.key === "i" || e.key === "I") {
        e.preventDefault();
        if (e.shiftKey) {
          setShowPanel(true);
          setPanelTab("ai");
          runInterpret("full");
        } else if (interpretResult) {
          openAiPanel("quick");
        } else {
          runInterpret("quick");
        }
      }
      // Ctrl+Shift+F：切换侧栏放大
      if ((e.key === "f" || e.key === "F") && e.shiftKey) {
        e.preventDefault();
        setShowPanel(true);
        setPanelTab("ai");
        setAiFocus((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [aiFocus, interpretResult, numPages, onClose, openAiPanel, runInterpret]);

  const prereqs = interpretResult?.prerequisites || [];
  const currentParagraphTranslations = useMemo(
    () => Object.entries(paragraphTranslations)
      .filter(([key, value]) => key.startsWith(`${pageNum}:`) && value && !value.startsWith("翻译失败"))
      .sort(([a], [b]) => Number(a.split(":")[1]) - Number(b.split(":")[1])),
    [pageNum, paragraphTranslations]
  );
  const currentSelectionTranslations = selectionTranslations[pageNum] || [];
  const currentPageTextLayout = Array.isArray(pageTextLayouts[pageNum]) ? pageTextLayouts[pageNum] : [];
  const currentPageTranslationText = String(pageTranslations[pageNum] || "");
  const pageTranslationFailed = isTranslationError(currentPageTranslationText);
  const currentPageTranslationLayout = pageTranslationFailed
    ? []
    : (Array.isArray(pageTranslationLayouts[pageNum]) ? pageTranslationLayouts[pageNum] : []);
  const hasInlineTranslation = Boolean((currentPageTranslationText && !pageTranslationFailed) || currentParagraphTranslations.length || currentSelectionTranslations.length);
  const pdfCacheLabel = !paperId
    ? ""
    : pdfCacheStatus === "reading"
      ? "读取缓存中"
      : pdfCacheStatus === "loading"
        ? "打开 PDF 中"
      : pdfCacheStatus === "saving"
        ? "保存中"
        : pdfCacheStatus === "error"
          ? "缓存异常"
          : pdfCacheStatus === "restored"
            ? "已恢复缓存"
            : pdfCacheStatus === "saved"
              ? "已保存"
              : "可保存";

  return (
    <div className="pdf-reader">
      <div className="pdf-toolbar">
        <div className="pdf-toolbar-title">
          <BookOpen size={17} />
          <div>
            <strong>文献阅读器</strong>
            <span>{title || "PDF 文档"}</span>
          </div>
        </div>

        <div className="pdf-toolbar-actions">
          <label className="pdf-file-btn" title="打开本地 PDF 或图片">
            <FileUp size={15} />
            打开文件
            <input type="file" accept="application/pdf,.pdf,image/*" onChange={openFile} hidden />
          </label>
          <div className="pdf-url-input">
            <Link2 size={13} />
            <input value={urlInput} onChange={(e) => setUrlInput(e.target.value)} placeholder="输入 PDF 链接" />
            <button onClick={() => { if (urlInput.trim()) loadSource({ url: urlInput.trim(), useCache: false }); }}>加载</button>
          </div>
          <div className="pdf-display-switch" aria-label="PDF 显示模式">
            {PDF_DISPLAY_MODES.map((mode) => {
              const layoutVariant = layoutVariantForDisplayMode(mode.value);
              const layoutReady = layoutVariant
                ? Boolean(resolveLayoutPageUrl(pdfMathResult, pageNum, layoutVariant).url)
                : hasAnyLayoutResult;
              return (
                <button
                  type="button"
                  key={mode.value}
                  className={`${displayMode === mode.value ? "active" : ""}${mode.value !== "original" && hasAnyLayoutResult && layoutReady ? " has-layout" : ""}`}
                  onClick={() => handleDisplayModeChange(mode.value)}
                  title={
                    mode.value === "original"
                      ? "显示原始 PDF"
                      : mode.value === "translated"
                        ? (layoutReady ? "显示本页纯中文版式译文" : "本页版式译文尚未就绪")
                        : (layoutReady ? "显示本页中英对照版式译文" : "本页版式译文尚未就绪")
                  }
                >
                  {mode.label}
                </button>
              );
            })}
          </div>
          <IconButton icon={ZoomOut} label="缩小" onClick={() => setScale((s) => clampScale(s - SCALE_STEP_BTN))} />
          <span className="pdf-zoom-label" title="Ctrl + 滚轮缩放">{Math.round(scale * 100)}%</span>
          <IconButton icon={ZoomIn} label="放大" onClick={() => setScale((s) => clampScale(s + SCALE_STEP_BTN))} />
          <div className="pdf-interaction-switch" role="group" aria-label="PDF 交互模式">
            <button
              type="button"
              className={interactionMode === "select" ? "active" : ""}
              onClick={() => setPdfInteractionMode("select")}
              title="选择文字：拖选复制、局部翻译"
            >
              <MousePointer2 size={13} />
              选择
            </button>
            <button
              type="button"
              className={interactionMode === "hand" ? "active" : ""}
              onClick={() => setPdfInteractionMode("hand")}
              title="手型：拖拽平移 PDF 视图"
            >
              <Hand size={13} />
              手型
            </button>
          </div>
          <span className="pdf-page-label">
            <IconButton icon={ChevronLeft} label="上一页 (←)" onClick={() => setPageNum((p) => Math.max(1, p - 1))} disabled={pageNum <= 1} />
            <input
              type="number"
              min="1"
              max={numPages || 1}
              value={pageNum}
              onChange={(e) => setPageNum(Math.max(1, Math.min(numPages || 1, Number(e.target.value) || 1)))}
            />
            <span>/ {numPages}</span>
            <IconButton icon={ChevronRight} label="下一页 (→)" onClick={() => setPageNum((p) => Math.min(numPages || 1, p + 1))} disabled={pageNum >= numPages} />
          </span>
          <IconButton
            icon={Sparkles}
            label="AI 解读 (Ctrl+I)"
            onClick={() => openAiPanel("quick")}
            className={showPanel && panelTab === "ai" ? "active" : ""}
          />
          <IconButton
            icon={showPanel ? PanelRightClose : PanelRightOpen}
            label={showPanel ? "收起侧栏" : "展开侧栏"}
            onClick={() => {
              if (showPanel) collapseSidePanel();
              else expandSidePanel(panelTab === "ai" ? "ai" : "translate");
            }}
            className={showPanel ? "active" : ""}
          />
          <IconButton
            icon={Download}
            label="导出原文副本"
            onClick={exportOriginalPdf}
            disabled={!pdfSourceBase64 || loading}
          />
          <IconButton
            icon={AppWindow}
            label="用其他软件打开（可选程序）"
            onClick={() => openOriginalExternally(true)}
            disabled={(!pdfSourceBase64 && !paperId) || loading}
          />
          <IconButton icon={X} label="关闭" onClick={onClose} />
        </div>
      </div>

      <div className={`pdf-body${aiFocus ? " ai-focus-mode" : ""}${showPanel ? "" : " panel-collapsed"}`}>
        <div className="pdf-canvas-stage">
          <div
            className={`pdf-canvas-wrap${canUseHandPan ? " is-hand-mode" : " is-select-mode"}${isPanning ? " is-panning" : ""}${ocrSelectMode ? " is-ocr-mode" : ""}`}
            ref={canvasWrapRef}
            title={canUseHandPan ? "手型模式：拖拽平移 · Ctrl+滚轮缩放 · ←/→ 翻页" : "选择模式：拖选文字复制 · Ctrl+滚轮缩放 · ←/→ 翻页"}
            onPointerDown={handlePanPointerDown}
            onPointerMove={handlePanPointerMove}
            onPointerUp={handlePanPointerUp}
            onPointerCancel={handlePanPointerUp}
          >
            {loading ? (
              <div className="pdf-state"><Loader2 size={22} className="spin" /> 正在加载 PDF...</div>
            ) : error ? (
              <div className="pdf-state error">
                <strong>PDF 加载失败</strong>
                <span>{error}</span>
                {errorIsAuth ? (
                  <p>该站点可能要求登录或开启了反爬。若你已在「论文搜索」页的内嵌浏览器中登录过该站点，点「重试」会自动携带登录状态；仍失败可改用浏览器打开。</p>
                ) : (
                  <p>可以换一个 PDF 链接，或从本地打开文件。</p>
                )}
                <div className="pdf-error-actions">
                  {errorIsAuth ? <button className="pdf-open-external" onClick={() => loadSource({ url, doi, useCache: false })}>重试</button> : null}
                  <button className="pdf-open-external" onClick={() => window.open(url, "_blank", "noopener")}>用系统浏览器打开</button>
                </div>
              </div>
            ) : (
              <>
                {evidenceHighlight?.page === pageNum ? (
                  <div className="pdf-evidence-jump" role="status" aria-live="polite">
                    <Link2 size={14} />
                    <strong>已跳转到第 {pageNum} 页</strong>
                    {evidenceHighlight.reason ? <span>{evidenceHighlight.reason}</span> : null}
                    {evidenceHighlight.quote ? <q>{evidenceHighlight.quote}</q> : null}
                    <button type="button" aria-label="关闭依据提示" onClick={() => setEvidenceHighlight(null)}><X size={13} /></button>
                  </div>
                ) : null}
                <div className={`pdf-page-compare display-${displayMode}${evidenceHighlight?.page === pageNum ? " evidence-jump-active" : ""}${usingLayoutPdf ? " is-layout-pdf" : ""}`}>
                {layoutDisplayVariant && layoutViewLoading && !layoutViewReady ? (
                  <div className="pdf-layout-view-status" role="status">
                    <Loader2 size={14} className="spin" />
                    <span>正在加载第 {pageNum} 页版式译文…</span>
                  </div>
                ) : null}
                {layoutDisplayVariant && layoutViewError ? (
                  <div className="pdf-layout-view-status is-error" role="alert">
                    <span>版式译文加载失败：{layoutViewError}</span>
                    <button type="button" onClick={() => handleDisplayModeChange(displayMode === "bilingual" ? "bilingual" : "translated")}>重试</button>
                    <button type="button" onClick={() => handleDisplayModeChange("original")}>回原文</button>
                  </div>
                ) : null}
                {layoutDisplayVariant && !layoutPageResolved.url && !layoutViewLoading ? (
                  <div className="pdf-layout-view-status" role="status">
                    <Languages size={14} />
                    <span>
                      {currentLayoutPage.running || (pdfMathState === "working" && !currentLayoutPage.done)
                        ? `第 ${pageNum} 页版式译文生成中，当前先显示原文（未完成前不会显示「就绪」）`
                        : hasAnyLayoutResult
                          ? `第 ${pageNum} 页尚无版式译文，当前显示原文`
                          : "请先在右侧开始版式翻译"}
                    </span>
                    {displayMode !== "original" ? (
                      <button type="button" onClick={() => handleDisplayModeChange("original")}>回原文</button>
                    ) : null}
                  </div>
                ) : null}
                {layoutViewReady && currentLayoutPage.done ? (
                  <div className="pdf-layout-view-status is-ready" role="status">
                    <span>
                      第 {pageNum} 页
                      {displayMode === "bilingual" ? "中英对照" : "译文"}
                      已就绪（版式）
                    </span>
                    <button type="button" onClick={() => handleDisplayModeChange("original")}>回原文</button>
                  </div>
                ) : null}
                {layoutViewReady && !currentLayoutPage.done && pdfMathState === "working" ? (
                  <div className="pdf-layout-view-status" role="status">
                    <Loader2 size={14} className="spin" />
                    <span>第 {pageNum} 页仍在生成，请稍候…</span>
                  </div>
                ) : null}
                <div
                  ref={pageSurfaceRef}
                  className={`pdf-page-surface${ocrSelectMode ? " is-ocr-selecting" : ""}${canUseHandPan ? " is-hand-mode" : " is-select-mode"}${usingLayoutPdf ? " is-layout-pdf" : ""}`}
                  onMouseUp={captureTextSelection}
                  onPointerDown={handleOcrPointerDown}
                  onPointerMove={handleOcrPointerMove}
                  onPointerUp={handleOcrPointerUp}
                  onPointerCancel={handleOcrPointerUp}
                >
                    <canvas ref={canvasRef} className="pdf-canvas" />
                    <div
                      ref={textLayerRef}
                      className={`textLayer pdf-text-layer${canUseHandPan ? " is-hand-passthrough" : ""}`}
                      aria-label={canUseHandPan ? "手型模式下文字层不可选" : "可选择的 PDF 文字层"}
                    />

                    {/* 有版式 PDF 时不再叠文字覆盖层；仅文字翻译回退时使用 */}
                    {!usingLayoutPdf && displayMode === "translated" && currentPageTranslationText && !pageTranslationFailed && !pageIsOcr ? (
                      <PdfLayoutTranslationLayer lines={currentPageTranslationLayout} scale={scale} />
                    ) : null}

                    {ocrSelectMode ? (
                      <div className="pdf-ocr-select-hint" role="status">拖框选择扫描区域，松开后自动 OCR</div>
                    ) : null}
                    {ocrSelectionBox ? (
                      <div
                        className={`pdf-ocr-selection-box${ocrDragging ? " is-dragging" : ""}`}
                        style={{
                          left: `${ocrSelectionBox.left * 100}%`,
                          top: `${ocrSelectionBox.top * 100}%`,
                          width: `${ocrSelectionBox.width * 100}%`,
                          height: `${ocrSelectionBox.height * 100}%`
                        }}
                        aria-label="OCR 选区"
                      />
                    ) : null}

                    {!usingLayoutPdf && displayMode !== "original" && (!currentPageTranslationText || pageTranslationFailed) && currentParagraphTranslations.length ? (
                  <div className="pdf-paragraph-overlay-stack">
                    {currentParagraphTranslations.map(([key, translation]) => (
                      <div className="pdf-inline-translation-card" key={key}>
                        <strong>段落 {Number(key.split(":")[1]) + 1}</strong>
                        <p>{translation}</p>
                      </div>
                    ))}
                  </div>
                ) : null}

                    {currentSelectionTranslations.map((item) => (
                  <div
                    className="pdf-selection-translation-card"
                    key={item.id}
                    style={{ left: `${item.x}%`, top: `${item.y}%` }}
                    onMouseDown={(event) => event.stopPropagation()}
                    onMouseUp={(event) => event.stopPropagation()}
                    onPointerDown={(event) => event.stopPropagation()}
                    onPointerUp={(event) => event.stopPropagation()}
                  >
                    <button type="button" className="pdf-selection-translation-close" aria-label="关闭选区译文" onClick={() => removeSelectionTranslation(item.id)}>×</button>
                    <span>{item.translation}</span>
                  </div>
                ))}

                    {!usingLayoutPdf && !layoutPageResolved.url && displayMode === "bilingual" && !hasInlineTranslation && !pageTranslationFailed ? (
                  <div className="pdf-empty-translation-overlay">
                    <Languages size={22} />
                    <strong>本页还没有译文</strong>
                    <span>{hasAnyLayoutResult || pdfMathState === "working" ? "请等待本页版式翻译完成，或用上方切换原文。" : "请先开始版式翻译，或使用侧栏文字翻译。"}</span>
                    {pdfMathState !== "working" && !hasAnyLayoutResult ? (
                      <button type="button" onClick={() => translateWithPdfMath({ force: false })} disabled={!pdfSourceBase64 || !config || !pdfMathStatus.available}>
                        开始翻译
                      </button>
                    ) : null}
                  </div>
                ) : null}

                    {selectionPopup ? (
                  <div
                    className="pdf-selection-popover"
                    style={{ left: `${selectionPopup.x}%`, top: `${selectionPopup.y}%` }}
                    onMouseDown={(event) => event.stopPropagation()}
                    onMouseUp={(event) => event.stopPropagation()}
                    onPointerDown={(event) => event.stopPropagation()}
                    onPointerUp={(event) => event.stopPropagation()}
                  >
                    <div className="pdf-selection-popover-head">
                      <div className="pdf-selection-popover-copy">
                        {selectionPopup.ocr ? <strong className="pdf-ocr-popup-label">OCR 识别结果</strong> : null}
                        <span>{selectionPopup.text.slice(0, 90)}{selectionPopup.text.length > 90 ? "…" : ""}</span>
                        {selectionPopup.error ? <em>{selectionPopup.error}</em> : null}
                      </div>
                      <button type="button" className="pdf-selection-popover-close" aria-label="关闭局部翻译" onClick={() => setSelectionPopup(null)}>×</button>
                    </div>
                    <button
                      type="button"
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={translateSelection}
                      disabled={!config || selectionLoading}
                    >
                      {selectionLoading ? "翻译中…" : config ? (selectionPopup.ocr ? "翻译 OCR 选区" : "翻译选中文字") : "请先配置 API"}
                    </button>
                    </div>
                  ) : null}
                </div>

                {!usingLayoutPdf && displayMode !== "original" && currentPageTranslationText && !pageTranslationFailed && pageIsOcr ? (
                  <section className={`pdf-page-translation-sheet ${displayMode}`} aria-label={`第 ${pageNum} 页译文`}>
                    <div className="pdf-overlay-head">
                      <strong>第 {pageNum} 页译文</strong>
                      <button type="button" onClick={() => handleDisplayModeChange("original")}>查看原文</button>
                    </div>
                    <div className="pdf-translation-context">按本页可见的从上到下顺序翻译</div>
                    <div className="pdf-overlay-copy">{pageTranslations[pageNum]}</div>
                  </section>
                ) : null}
              </div>
              </>
            )}
          </div>

          {hasPageSource && !error ? (
            <>
              <button
                type="button"
                className="pdf-edge-page-btn previous"
                onClick={() => setPageNum((p) => Math.max(1, p - 1))}
                disabled={pageNum <= 1}
                aria-label="PDF 上一页"
                title="上一页 (←)"
              >
                <ChevronLeft size={20} />
              </button>
              <button
                type="button"
                className="pdf-edge-page-btn next"
                onClick={() => setPageNum((p) => Math.min(numPages || 1, p + 1))}
                disabled={pageNum >= numPages}
                aria-label="PDF 下一页"
                title="下一页 (→)"
              >
                <ChevronRight size={20} />
              </button>
            </>
          ) : null}
        </div>

        {showPanel ? (
          <aside ref={panelRef} className={`pdf-translate-panel${aiFocus ? " is-ai-focus" : ""}`}>
            <div className="pdf-panel-tabs">
              <Segmented
                value={panelTab}
                onChange={setPanelTab}
                options={[
                  { value: "translate", label: "版式翻译" },
                  { value: "ai", label: "AI 解读" },
                  { value: "notes", label: "手记" }
                ]}
              />
              <button
                type="button"
                className="pdf-panel-collapse-btn"
                onClick={collapseSidePanel}
                title="收起侧栏"
                aria-label="收起侧栏"
              >
                <PanelRightClose size={14} />
                收起
              </button>
            </div>

            {panelTab === "translate" ? (
              <div className="pdf-translate-shell" ref={translateShellRef}>
                <div className="pdf-panel-head">
                  <div>
                    <Languages size={15} />
                    <strong>版式翻译</strong>
                    <span title={config?.model || ""}>
                      {pdfMathStatus.loading
                        ? "检测引擎…"
                        : pdfMathStatus.available
                          ? "引擎就绪"
                          : "引擎未安装"}
                      {pdfCacheLabel ? ` · ${pdfCacheLabel}` : ""}
                    </span>
                  </div>
                  {aiFocus ? (
                    <div className="pdf-panel-actions">
                      <button type="button" onClick={() => setAiFocus(false)} title="回到 PDF (Esc)">
                        <Minimize2 size={13} />
                        回到 PDF
                      </button>
                    </div>
                  ) : null}
                </div>

                {/* 主力：版式翻译 —— 一个主按钮，状态一眼能懂 */}
                <section className="pdf-layout-primary-card" aria-label="版式翻译">
                  <div className="pdf-layout-primary-head">
                    <div>
                      <strong>版式翻译</strong>
                      <p>保留原排版生成中文。一点开始/继续，已译过的页自动跳过；翻页会优先译你正在看的页。</p>
                    </div>
                    <em className={
                      layoutAllDone ? "ready"
                        : pdfMathState === "working" ? "busy"
                          : pdfMathStatus.available ? "ready" : "missing"
                    }>
                      {pdfMathStatus.loading
                        ? "检测中"
                        : !pdfMathStatus.available
                          ? "未安装"
                          : layoutAllDone
                            ? "已完成"
                            : pdfMathState === "working"
                              ? "翻译中"
                              : hasAnyLayoutResult
                                ? "可继续"
                                : "就绪"}
                    </em>
                  </div>

                  <div className={`pdf-layout-status-card${pdfMathState === "working" ? " is-working" : ""}${layoutAllDone ? " is-done" : ""}`} role="status">
                    <div className="pdf-layout-status-row">
                      <strong>{layoutStatusSummary}</strong>
                      {(layoutPageCount || numPages) ? (
                        <span className="pdf-layout-status-count">
                          {layoutCompletedCount}/{layoutPageCount || numPages}
                        </span>
                      ) : null}
                    </div>
                    <div className="pdf-layout-progress" aria-hidden="true">
                      <i style={{ width: `${layoutProgressPercent}%` }} />
                    </div>
                    <div className="pdf-layout-page-pill">
                      {currentLayoutPage.running ? (
                        <span className="is-busy">本页翻译中</span>
                      ) : currentLayoutPage.done ? (
                        <span className="is-ok">本页已完成 · 可切「译文」</span>
                      ) : hasAnyLayoutResult || pdfMathState === "working" ? (
                        <span className="is-wait">本页未完成</span>
                      ) : (
                        <span>当前第 {pageNum} 页</span>
                      )}
                    </div>
                    {pdfMathState === "working" && pdfMathProgress ? (
                      <p className="pdf-layout-status-detail">{pdfMathProgress}</p>
                    ) : null}
                  </div>

                  <div className="pdf-layout-primary-actions">
                    {layoutPrimaryAction.kind === "stop" ? (
                      <button
                        type="button"
                        className="pdf-layout-primary-btn is-stop"
                        onClick={cancelPdfMath}
                        disabled={!pdfMathJobId}
                      >
                        <Loader2 size={15} className="spin" />
                        停止
                      </button>
                    ) : (
                      <button
                        type="button"
                        className={`pdf-layout-primary-btn${layoutPrimaryAction.kind === "done" ? " is-done" : ""}`}
                        onClick={() => translateWithPdfMath({ force: false })}
                        disabled={layoutPrimaryAction.disabled || !pdfMathStatus.available}
                        title={
                          layoutPrimaryAction.kind === "continue"
                            ? "接着译没做完的页，已完成的不会重来"
                            : layoutPrimaryAction.kind === "start"
                              ? "从当前页优先，依次译完全部未完成页"
                              : undefined
                        }
                      >
                        {layoutPrimaryAction.kind === "start" || layoutPrimaryAction.kind === "continue" ? (
                          <Languages size={15} />
                        ) : null}
                        {layoutPrimaryAction.label}
                      </button>
                    )}

                    {(hasAnyLayoutResult || layoutAllDone) && pdfMathState !== "working" ? (
                      <details className="pdf-layout-more">
                        <summary>更多</summary>
                        <button
                          type="button"
                          className="pdf-layout-danger-btn"
                          onClick={() => {
                            if (window.confirm("将重新翻译全书并覆盖已有译文，确定吗？")) {
                              void translateWithPdfMath({ force: true });
                            }
                          }}
                          disabled={!pdfSourceBase64 || !config || !pdfMathStatus.available}
                        >
                          重新翻译全书
                        </button>
                      </details>
                    ) : null}
                  </div>

                  {!config ? (
                    <div className="pdf-config-hint">需要先在设置中配置 API Key。</div>
                  ) : null}
                  {!pdfMathStatus.available && !pdfMathStatus.loading ? (
                    <span className="pdf-layout-engine-hint">
                      {pdfMathStatus.installHint || "请先安装 PDFMathTranslate，并在设置中指定 pdf2zh.exe。"}
                    </span>
                  ) : null}
                  {pdfMathError ? <div className="pdf-ocr-error" role="alert">{pdfMathError}</div> : null}

                  {hasAnyLayoutResult ? (
                    <div className="pdf-layout-ready-hint" role="status">
                      <div className="pdf-layout-ready-hint-main">
                        <strong>
                          {layoutAllDone
                            ? "全书译文已就绪"
                            : `已完成 ${layoutCompletedCount}${layoutPageCount ? ` / ${layoutPageCount}` : ""} 页`}
                        </strong>
                        <span>上方工具栏切换 <em>原文 · 译文 · 中英对照</em></span>
                      </div>
                      <div className="pdf-layout-ready-modes">
                        <button
                          type="button"
                          className={displayMode === "original" ? "active" : ""}
                          onClick={() => handleDisplayModeChange("original")}
                        >
                          原文
                        </button>
                        <button
                          type="button"
                          className={displayMode === "translated" ? "active" : ""}
                          onClick={() => handleDisplayModeChange("translated")}
                          disabled={!currentLayoutPage.done && !resolveLayoutPageUrl(pdfMathResult, pageNum, "mono").url}
                          title={currentLayoutPage.done ? "显示本页译文" : "本页尚未译完"}
                        >
                          译文{currentLayoutPage.done ? "" : "·未就绪"}
                        </button>
                        <button
                          type="button"
                          className={displayMode === "bilingual" ? "active" : ""}
                          onClick={() => handleDisplayModeChange("bilingual")}
                          disabled={!currentLayoutPage.done && !resolveLayoutPageUrl(pdfMathResult, pageNum, "dual").url}
                          title={currentLayoutPage.done ? "显示中英对照" : "本页尚未译完"}
                        >
                          中英对照{currentLayoutPage.done ? "" : "·未就绪"}
                        </button>
                      </div>
                    </div>
                  ) : null}
                </section>

                <div className="pdf-translate-page-nav" aria-label="翻译页码">
                  <button
                    type="button"
                    onClick={() => setPageNum((p) => Math.max(1, p - 1))}
                    disabled={pageNum <= 1}
                    aria-label="翻译上一页"
                  >
                    <ChevronLeft size={15} />
                    上一页
                  </button>
                  <span>第 {pageNum} / {numPages || "—"} 页</span>
                  <button
                    type="button"
                    onClick={() => setPageNum((p) => Math.min(numPages || 1, p + 1))}
                    disabled={!numPages || pageNum >= numPages}
                    aria-label="翻译下一页"
                  >
                    下一页
                    <ChevronRight size={15} />
                  </button>
                  <em>也可按 ← / →</em>
                </div>

                {ocrProgress ? <div className="pdf-ocr-progress" role="status">{ocrProgress}</div> : null}
                {ocrError ? <div className="pdf-ocr-error" role="alert">{ocrError}</div> : null}
                {pdfCacheError ? <div className="pdf-ocr-error" role="alert">{pdfCacheError}</div> : null}

                {/* 次要：普通文字翻译 + OCR，默认折叠 */}
                <details className="pdf-translate-secondary" open={Boolean(pageTranslations[pageNum]) || Boolean(translatingPage) || translatingAll}>
                  <summary>
                    <span>文字翻译与 OCR（可选）</span>
                    <em>不保留版式，适合快速对照</em>
                  </summary>
                  <div className="pdf-translate-secondary-body">
                    <div className="pdf-translate-secondary-actions" aria-label="文字翻译操作">
                      <button
                        type="button"
                        onClick={() => translateCurrentPage(Boolean(pageTranslations[pageNum]))}
                        disabled={!config || !hasPageSource || Boolean(translatingPage)}
                      >
                        {translatingPage ? <Loader2 size={13} className="spin" /> : null}
                        {translatingPage ? "正在翻译本页" : pageTranslations[pageNum] ? "重新翻译本页" : "翻译本页文字"}
                      </button>
                      <button type="button" onClick={translateFull} disabled={!config || !hasPageSource || translatingAll}>
                        {translatingAll ? <Loader2 size={13} className="spin" /> : null}
                        {translatingAll ? "正在翻译全文" : "翻译全文文字"}
                      </button>
                    </div>
                    {translateProgress ? <div className="pdf-translate-progress">{translateProgress}</div> : null}
                    <div className="pdf-panel-actions pdf-translate-secondary-tools">
                      <button
                        type="button"
                        onClick={() => {
                          setDisplayMode("original");
                          setOcrSelectionBox(null);
                          setSelectionPopup(null);
                          setOcrSelectMode((value) => !value);
                        }}
                        disabled={!hasPageSource || ocrBusy}
                        className={ocrSelectMode ? "active" : ""}
                        title="框选扫描页、图片或复杂表格区域"
                      >
                        <Scan size={13} />
                        {ocrSelectMode ? "取消框选" : "框选 OCR"}
                      </button>
                      <button type="button" onClick={() => recognizePageText(pageNum)} disabled={!hasPageSource || ocrBusy}>
                        {ocrBusy ? <Loader2 size={13} className="spin" /> : <Scan size={13} />}
                        {ocrBusy ? "OCR 识别中" : ocrPageTexts[pageNum] ? "已识别本页" : "识别本页 OCR"}
                      </button>
                      {paperId ? <button type="button" onClick={clearPdfCache}>清除本地缓存</button> : null}
                    </div>
                  </div>
                </details>

                {pageTranslationFailed ? (
                  <div className="pdf-translation-error" role="alert">
                    <div className="pdf-block-label">
                      <strong>本页翻译失败</strong>
                      <button
                        type="button"
                        onClick={() => {
                          setPageTranslations((previous) => {
                            const next = { ...previous };
                            delete next[pageNum];
                            return next;
                          });
                          setPageTranslationLayouts((previous) => {
                            const next = { ...previous };
                            delete next[pageNum];
                            return next;
                          });
                          translateCurrentPage(true);
                        }}
                        disabled={!config || Boolean(translatingPage)}
                      >
                        重试本页
                      </button>
                    </div>
                    <p>{currentPageTranslationText}</p>
                  </div>
                ) : currentPageTranslationText ? (
                  displayMode === "translated" && !pageIsOcr ? (
                    <div className="pdf-page-translation-status">
                      <Check size={14} />
                      <span>本页已完成原位覆盖翻译，图片和版式保持不变。</span>
                      <button type="button" onClick={() => setDisplayMode("original")}>查看原文</button>
                    </div>
                  ) : (
                    <div className="pdf-page-translation">
                      <div className="pdf-block-label">
                        <span>本页全文翻译</span>
                        <Check size={13} />
                      </div>
                      <p>{pageTranslations[pageNum]}</p>
                    </div>
                  )
                ) : null}

                {paragraphs.length || ocrPageTexts[pageNum] ? (
                  <button
                    type="button"
                    className="pdf-text-details-toggle"
                    onClick={() => setShowTextDetails((value) => !value)}
                  >
                    {showTextDetails ? "收起本页文字" : `查看本页文字${paragraphs.length ? `（${paragraphs.length} 段）` : ""}`}
                  </button>
                ) : null}

                {showTextDetails && ocrPageTexts[pageNum] ? (
                  <div className="pdf-ocr-result">
                    <div className="pdf-block-label">
                      <span>本页 OCR 原文（已缓存）</span>
                      <Check size={13} />
                    </div>
                    <p>{ocrPageTexts[pageNum]}</p>
                  </div>
                ) : null}

                {showTextDetails && (displayMode !== "translated" || pageIsOcr) ? <div className="pdf-paragraph-list">
                  {paragraphs.length ? (
                    paragraphs.map((para, i) => {
                      const key = `${pageNum}:${i}`;
                      const translation = paragraphTranslations[key];
                      const translating = translatingParagraphs[key];
                      return (
                        <div className="pdf-paragraph" key={key}>
                          <div className="pdf-block-label">
                            <span>段落 {i + 1}</span>
                            <button onClick={() => translateParagraph(i)} disabled={!config || translating}>
                              {translating ? <Loader2 size={12} className="spin" /> : null}
                              {translating ? "翻译中" : translation ? "重新翻译" : "翻译本段"}
                            </button>
                          </div>
                          <p className="pdf-para-original">{para}</p>
                          {translation ? <p className={`pdf-para-translation ${translation.startsWith("翻译失败") ? "error" : ""}`}>{translation}</p> : null}
                        </div>
                      );
                    })
                  ) : (
                    <div className="pdf-no-text">
                      <p>这一页没有可提取的文字，可能是扫描版图片 PDF。</p>
                      <span>可在“更多工具”中使用 OCR。</span>
                    </div>
                  )}
                </div> : null}
              </div>
            ) : panelTab === "notes" ? (
              <div className="pdf-notes-shell">
                <div className="pdf-panel-head">
                  <div>
                    <StickyNote size={15} />
                    <strong>阅读手记</strong>
                    <span>
                      {notesSaveStatus === "saving"
                        ? "保存中…"
                        : notesSaveStatus === "saved"
                          ? "已保存"
                          : notesSaveStatus === "local"
                            ? "已存本机"
                            : notesSaveStatus === "error"
                              ? "保存失败"
                              : paperId
                                ? "自动保存"
                                : "仅本机保存"}
                    </span>
                  </div>
                </div>
                <p className="pdf-notes-hint">
                  页标记加在文首，标记下面才是这一页的正文。再标另一页时，新标记仍加在最上面。
                </p>
                <div className="pdf-notes-toolbar">
                  <button type="button" onClick={insertNotesPageMarker} title="在文末插入当前页标记">
                    插入第 {pageNum} 页
                  </button>
                  <button type="button" onClick={clearReadingNotes} disabled={!readingNotes} title="清空本篇手记">
                    清空
                  </button>
                </div>
                {notePages.length ? (
                  <div className="pdf-notes-jumps" aria-label="手记页码">
                    {notePages.map((page) => (
                      <button
                        key={page}
                        type="button"
                        className={page === pageNum ? "active" : ""}
                        onClick={() => setPageNum(page)}
                        title={`跳到第 ${page} 页`}
                      >
                        第 {page} 页
                      </button>
                    ))}
                  </div>
                ) : null}
                <textarea
                  ref={notesTextareaRef}
                  className="pdf-notes-textarea"
                  value={readingNotes}
                  onChange={handleNotesChange}
                  placeholder={"例如：\n- 方法核心是……\n- 图 2 有点反直觉\n- 和某篇工作的差异：……"}
                  spellCheck={false}
                />
                <div className="pdf-notes-foot">
                  <span>{readingNotes.length ? `${readingNotes.length} 字` : "空白手记"}</span>
                  <span>{paperId ? "随文献缓存同步" : "未关联文献库 · 仅浏览器本地"}</span>
                </div>
              </div>
            ) : (
              <div className="pdf-ai-shell">
                <div className="pdf-panel-head">
                  <div>
                    <Sparkles size={15} />
                    <strong>AI 解读</strong>
                    <span>{config ? `已启用 · ${config.model}` : "未配置 API"}</span>
                    {aiFocus ? <em className="pdf-ai-focus-badge">已放大</em> : null}
                  </div>
                  {!aiFocus ? (
                    <div className="pdf-panel-actions">
                      <button
                        type="button"
                        className="pdf-ai-focus-toggle"
                        onClick={() => setAiFocus(true)}
                        title="放大侧栏 (Ctrl+Shift+F)"
                      >
                        <Maximize2 size={13} />
                        放大
                      </button>
                    </div>
                  ) : null}
                </div>

                {aiFocus ? (
                  <div className="pdf-ai-focus-bar">
                    <span>侧栏已放大</span>
                    <button type="button" onClick={() => setAiFocus(false)}>
                      <BookOpen size={13} />
                      回到 PDF
                    </button>
                  </div>
                ) : null}

                <div className="pdf-ai-mode-row">
                  <button
                    className="pdf-ai-mode-btn"
                    onClick={() => runInterpret("quick")}
                    disabled={interpretLoading || askLoading}
                    title="Ctrl+I"
                  >
                    {interpretLoading && interpretMeta?.mode !== "full" && interpretProgress ? (
                      <Loader2 size={13} className="spin" />
                    ) : null}
                    快速解读
                  </button>
                  <button
                    className="pdf-ai-mode-btn primary"
                    onClick={() => runInterpret("full")}
                    disabled={interpretLoading || askLoading}
                    title="Ctrl+Shift+I"
                  >
                    {interpretLoading ? <Loader2 size={13} className="spin" /> : null}
                    完全解读
                  </button>
                </div>
                <p className="pdf-ai-hint">
                  快速：摘要/引言/结论要点 · 完全：更广正文 + 基础知识分层。
                  快捷键 Ctrl+I / Ctrl+Shift+I · 放大侧栏 Ctrl+Shift+F
                </p>
                <UsageMeter
                  usage={interpretMeta?.usage}
                  model={interpretMeta?.model || config?.model || ""}
                  estimateTokens={estimateTokensFromText(
                    Object.values(effectiveTextByPage || {}).join("\n").slice(0, interpretMeta?.mode === "full" ? 28000 : 12000)
                  )}
                  usedChars={interpretMeta?.usedChars || 0}
                  pageCoverage={interpretMeta?.pageCoverage || ""}
                />

                {interpretProgress ? <div className="pdf-translate-progress">{interpretProgress}</div> : null}
                {interpretError ? <div className="pdf-config-hint">{interpretError}</div> : null}
                {!config ? (
                  <div className="pdf-config-hint">需要先在设置中配置 API Key 才能解读。</div>
                ) : null}

                <div className="pdf-ai-scroll" ref={aiScrollRef}>
                  {interpretMeta && interpretResult ? (
                    <div className="pdf-ai-meta-row">
                      <div className="pdf-ai-meta">
                        {interpretMeta.mode === "full" ? "完全解读" : "快速解读"}
                        {interpretMeta.pageCoverage ? ` · 覆盖页 ${interpretMeta.pageCoverage}` : ""}
                        {interpretMeta.usedChars ? ` · ${interpretMeta.usedChars} 字` : ""}
                      </div>
                      <div className="pdf-ai-save-actions">
                        <span className={`pdf-ai-save-status ${saveInterpretationStatus === "error" ? "error" : ""}`} role="status">
                          {saveInterpretationStatus === "saving" ? "保存中…" : saveInterpretationStatus === "saved" ? "已保存" : saveInterpretationStatus === "error" ? "保存失败" : "未保存"}
                        </span>
                        <button type="button" onClick={saveCurrentInterpretation} disabled={saveInterpretationStatus === "saving"}>
                          {saveInterpretationStatus === "saving" ? "保存中" : "保存解读"}
                        </button>
                      </div>
                    </div>
                  ) : null}

                  {saveInterpretationError ? <div className="pdf-config-hint">{saveInterpretationError}</div> : null}

                  {interpretResult?.evidence?.length ? (
                    <EvidenceLinks items={interpretResult.evidence} onJump={jumpToEvidence} />
                  ) : null}

                  {interpretResult ? (
                    <div className="pdf-ai-result">
                      {interpretResult.oneSentence ? (
                        <section className="pdf-ai-card">
                          <h4>一句话概括</h4>
                          <p>{interpretResult.oneSentence}</p>
                        </section>
                      ) : null}

                      {prereqs.length ? (
                        <section className="pdf-ai-card">
                          <h4>理解本文所需基础知识</h4>
                          <ul className="pdf-ai-prereq-list">
                            {prereqs.map((p, i) => (
                              <li key={`${p.name}-${i}`}>
                                <div className="pdf-ai-prereq-head">
                                  <strong>{p.name}</strong>
                                  <span className={`pdf-ai-level ${p.level === "加分" ? "bonus" : "must"}`}>
                                    {p.level || "必备"}
                                  </span>
                                </div>
                                {p.why ? <p className="pdf-ai-why">{p.why}</p> : null}
                                {p.hint ? <p className="pdf-ai-hint-line">补齐建议：{p.hint}</p> : null}
                              </li>
                            ))}
                          </ul>
                        </section>
                      ) : null}

                      {interpretResult.background ? (
                        <section className="pdf-ai-card">
                          <h4>研究背景</h4>
                          <div className="pdf-ai-md">{renderMarkdown(interpretResult.background)}</div>
                        </section>
                      ) : null}

                      {interpretResult.problem ? (
                        <section className="pdf-ai-card">
                          <h4>核心问题</h4>
                          <div className="pdf-ai-md">{renderMarkdown(interpretResult.problem)}</div>
                        </section>
                      ) : null}

                      {interpretResult.method ? (
                        <section className="pdf-ai-card">
                          <h4>方法要点</h4>
                          <div className="pdf-ai-md">{renderMarkdown(interpretResult.method)}</div>
                        </section>
                      ) : null}

                      {interpretResult.contributions?.length ? (
                        <section className="pdf-ai-card">
                          <h4>主要贡献</h4>
                          <ul className="pdf-ai-bullets">
                            {interpretResult.contributions.map((c, i) => (
                              <li key={i}>{c}</li>
                            ))}
                          </ul>
                        </section>
                      ) : null}

                      {interpretResult.experiments ? (
                        <section className="pdf-ai-card">
                          <h4>实验与证据</h4>
                          <div className="pdf-ai-md">{renderMarkdown(interpretResult.experiments)}</div>
                        </section>
                      ) : null}

                      {interpretResult.findings ? (
                        <section className="pdf-ai-card">
                          <h4>主要结论</h4>
                          <div className="pdf-ai-md">{renderMarkdown(interpretResult.findings)}</div>
                        </section>
                      ) : null}

                      {interpretResult.limitations ? (
                        <section className="pdf-ai-card">
                          <h4>局限</h4>
                          <div className="pdf-ai-md">{renderMarkdown(interpretResult.limitations)}</div>
                        </section>
                      ) : null}

                      {interpretResult.takeaways?.length ? (
                        <section className="pdf-ai-card">
                          <h4>精炼要点</h4>
                          <ul className="pdf-ai-bullets">
                            {interpretResult.takeaways.map((t, i) => (
                              <li key={i}>{t}</li>
                            ))}
                          </ul>
                        </section>
                      ) : null}

                      {interpretResult.conceptPath?.length ? (
                        <section className="pdf-ai-card">
                          <h4>概念学习路径</h4>
                          <ol className="pdf-ai-steps">
                            {interpretResult.conceptPath.map((s, i) => (
                              <li key={i}>{s}</li>
                            ))}
                          </ol>
                        </section>
                      ) : null}

                      {interpretResult.questions?.length ? (
                        <section className="pdf-ai-card">
                          <h4>精读五问</h4>
                          <ol className="pdf-ai-steps">
                            {interpretResult.questions.map((s, i) => (
                              <li key={i}>{s}</li>
                            ))}
                          </ol>
                        </section>
                      ) : null}

                      {interpretResult.readingTips ? (
                        <section className="pdf-ai-card">
                          <h4>阅读建议</h4>
                          <div className="pdf-ai-md">{renderMarkdown(interpretResult.readingTips)}</div>
                        </section>
                      ) : null}
                    </div>
                  ) : !interpretLoading && !interpretError ? (
                    <p className="pdf-no-text">
                      点「快速解读」或按 Ctrl+I，让 AI 先读文章并列出理解所需基础知识。
                      需要更大阅读区时，点「放大」。
                    </p>
                  ) : null}

                  {followups.length ? (
                    <div className="pdf-ai-followups">
                      <h4>追问记录</h4>
                      {followups.map((f) => (
                        <div className="pdf-ai-followup" key={f.id}>
                          <div className="pdf-ai-message user">
                            <span className="pdf-ai-message-label">你</span>
                            <p className="pdf-ai-q">{f.q}</p>
                          </div>
                          <div className={`pdf-ai-message assistant ${f.status === "error" ? "error" : ""}`}>
                            <span className="pdf-ai-message-label">
                              <Sparkles size={13} /> AI
                            </span>
                            {f.status === "thinking" ? (
                              <div className="pdf-ai-thinking" role="status" aria-live="polite">
                                <Loader2 size={15} className="spin" />
                                正在思考…
                              </div>
                            ) : (
                              <div className="pdf-ai-a">{renderMarkdown(f.a)}</div>
                            )}
                            {f.status !== "thinking" && f.evidence?.length ? (
                              <EvidenceLinks items={f.evidence} onJump={jumpToEvidence} />
                            ) : null}
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>

                <div className="pdf-ai-ask">
                  <textarea
                    ref={askInputRef}
                    className="pdf-ai-ask-input"
                    rows={aiFocus ? 3 : 2}
                    placeholder={interpretResult ? "继续追问这篇论文…" : "先完成解读后再追问"}
                    value={askInput}
                    disabled={!config || askLoading}
                    onChange={(e) => setAskInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        askFollowup();
                      }
                    }}
                  />
                  <button
                    className="pdf-ai-ask-btn"
                    onClick={askFollowup}
                    disabled={!config || askLoading || !askInput.trim()}
                  >
                    {askLoading ? <Loader2 size={14} className="spin" /> : <Send size={14} />}
                    提问
                  </button>
                </div>
              </div>
            )}
          </aside>
        ) : (
          <div className="pdf-panel-collapsed-rail" aria-label="侧栏已收起">
            <button
              type="button"
              className="pdf-panel-expand-btn"
              onClick={() => expandSidePanel("translate")}
              title="展开翻译侧栏"
            >
              <PanelRightOpen size={15} />
              <span>翻译</span>
            </button>
            <button
              type="button"
              className="pdf-panel-expand-btn is-ai"
              onClick={() => expandSidePanel("ai")}
              title="展开 AI 解读"
            >
              <Sparkles size={15} />
              <span>解读</span>
            </button>
            <button
              type="button"
              className="pdf-panel-expand-btn is-notes"
              onClick={() => expandSidePanel("notes")}
              title="展开阅读手记"
            >
              <StickyNote size={15} />
              <span>手记</span>
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
