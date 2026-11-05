import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Scan, Loader2, RefreshCw, Square, AlertTriangle } from "lucide-react";
import { renderMarkdown } from "./markdown.jsx";
import { parseVisionPages, visionModelIdentity, visionResultsFor } from "../pdfVisionReadingState.js";
import { buildPdfVisionLines } from "../pdfText.js";
import { visionOverlayPlan } from "./PdfVisionTranslationLayer.jsx";

const KIND_LABELS = { title: "标题", heading: "小节", paragraph: "段落", caption: "图注", equation: "公式", table: "表格", list: "列表", note: "注释" };

export default function PdfVisionReading({ doc, imageSource, numPages, page, text, config, isOriginal, loading, onPageResult, coverage, onApplyResult, onStart, detailsHost, displayLabel, onShowDetails }) {
  const identity = visionModelIdentity(config);
  const results = useMemo(() => visionResultsFor(doc || imageSource, identity), [doc, imageSource, identity]);
  const [, refresh] = useState(0);
  const [batch, setBatch] = useState({ status: "idle", pages: [], completed: 0 });
  const [scope, setScope] = useState("current");
  const [range, setRange] = useState("");
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState("");
  const [notice, setNotice] = useState("");
  const [requestSeconds, setRequestSeconds] = useState(0);
  useEffect(() => {
    setRequestSeconds(0);
    if (batch.status !== "working") return undefined;
    const startedAt = Date.now();
    const timer = window.setInterval(() => setRequestSeconds(Math.floor((Date.now() - startedAt) / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, [batch.status, batch.activePage]);
  const total = doc ? Number(doc.numPages || numPages) || 0 : imageSource ? 1 : 0;
  const selection = scope === "range" && doc ? parseVisionPages(range, total)
    : { pages: scope === "all" && doc ? Array.from({ length: total }, (_, index) => index + 1) : total ? [page] : [], error: "" };
  const pending = selection.pages.filter((number) => !results.has(number));
  const completed = results.size;
  const state = results.get(page) || { status: "idle" };
  const localPlan = useMemo(() => visionOverlayPlan(state), [state]);
  const requestRef = useRef(null);
  const sequenceRef = useRef(0);
  useLayoutEffect(() => {
    setBatch({ status: "idle", pages: [], completed: 0 });
    setScope("current");
    setRange("");
    setApplying(false);
    setApplyError("");
    setNotice("");
    return () => {
      sequenceRef.current += 1;
      requestRef.current?.controller.abort();
      requestRef.current?.renderTask?.cancel();
      requestRef.current = null;
    };
    // Only a real source/model change invalidates the batch. Switching the
    // visible canvas back to its source must not abort a newly started request.
  }, [results]);

  const cancel = () => {
    sequenceRef.current += 1;
    requestRef.current?.controller.abort();
    requestRef.current?.renderTask?.cancel();
    requestRef.current = null;
    setApplying(false);
    setNotice("");
    setBatch((previous) => ({ ...previous, status: "canceled" }));
  };

  // Rebuild old text anchors locally; the translated blocks and screenshot are
  // reused. No fetch, cloud request or translation charge is involved.
  const applyToPage = async () => {
    if (applying || requestRef.current) { setNotice("已有任务正在处理，请等待或先取消。"); return; }
    if (loading || !isOriginal || state.status !== "done" || state.layoutVersion !== 1) { setNotice("当前页没有可免费应用的带坐标译文，或原始文件尚未就绪。"); return; }
    onStart?.();
    const sequence = sequenceRef.current;
    const targetPage = page;
    setApplying(true);
    setApplyError("");
    try {
      let entry = { ...state };
      if (doc && state.positioningVersion !== 2) {
        const sourcePage = await doc.getPage(targetPage);
        const content = await sourcePage.getTextContent();
        const lines = buildPdfVisionLines(content, sourcePage.getViewport({ scale: 1 }));
        const compact = (value) => String(value || "").replace(/\s+/g, "").toLowerCase();
        const overlaps = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === 4 && b.length === 4
          && a.every(Number.isFinite) && b.every(Number.isFinite)
          && a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];
        const blocks = state.blocks.map((block) => {
          // A genuinely scanned page has no PDF text anchors to rebuild.
          if (!lines.length && !content.items?.some((item) => item.str?.trim())) return block;
          const oldIndexes = Array.isArray(block.lineIndexes) ? block.lineIndexes : [];
          const oldRows = (state.lines || []).filter((line) => oldIndexes.includes(line.index));
          const oldText = compact(oldRows.map((line) => line.text).join(""));
          const source = compact(block.source);
          const anchors = lines.filter((line) => {
            const value = compact(line.text);
            if (!value || !(source.includes(value) || oldText.includes(value))) return false;
            const boxes = oldRows.length ? oldRows.map((row) => row.bbox) : [block.bbox];
            return boxes.some((box) => overlaps(line.bbox, box));
          });
          // Do not carry numerical IDs across the changed line-grouping order.
          // Every old row must be recoverable, not just one matching fragment.
          const indexesComplete = oldRows.length === oldIndexes.length && new Set(oldIndexes).size === oldIndexes.length;
          const complete = anchors.length > 0 && indexesComplete && (oldRows.length
            ? oldRows.every((oldRow) => {
              const text = compact(oldRow.text);
              const nearby = anchors.filter((line) => overlaps(line.bbox, oldRow.bbox));
              return text && (nearby.some((line) => compact(line.text).includes(text)) || compact(nearby.map((line) => line.text).join("")).includes(text));
            })
            : Boolean(source) && compact(anchors.map((line) => line.text).join("")) === source);
          return { ...block, lineIndexes: complete ? anchors.map((line) => line.index) : [],
            localAnchorMappingReason: complete ? "" : "旧行锚点无法完整映射到原页，保留原图；需重译此页才能重新定位（会调用模型）" };
        });
        entry = { ...entry, lines, blocks, positioningVersion: 2, lineDiagnostics: lines.diagnostics,
          textLayerPresent: Boolean(content.items?.some((item) => item.str?.trim())), textExtractionFailed: false };
      }
      if (sequenceRef.current !== sequence || results.get(targetPage) !== state) return;
      results.set(targetPage, entry);
      onPageResult?.(targetPage, entry, results);
      onApplyResult?.();
      refresh((value) => value + 1);
    } catch (error) {
      if (sequenceRef.current === sequence) setApplyError(error.message || "本地排版失败，保留已有译文，请重试。");
    } finally {
      if (sequenceRef.current === sequence) setApplying(false);
    }
  };

  const translate = async (replaceCurrent = false) => {
    // Selecting the workflow is synchronous even when a guard explains why
    // this click cannot send a request. History must never remain in front.
    onStart?.();
    setNotice("");
    setApplyError("");
    const reason = requestRef.current || applying ? "已有任务正在处理，请等待或先取消。"
      : !config ? "请先在设置中配置支持图片输入的模型。"
      : !config.model?.trim() ? "模型名称为空，请在设置中选择模型。"
      : !config.baseUrl?.trim() ? "模型接口地址为空，请在设置中补全。"
      : !config.apiKey?.trim() && !/^scholarloop-chatgpt:\/\/local(?:\/|$)/.test(config.baseUrl.trim()) ? "缺少 API Key，请在设置中补全模型凭据。"
      : loading ? "原始文件仍在加载，请稍后再试。"
      : !isOriginal ? "尚无可用的原始文档，不能把历史译文截图再次发送翻译。请重新打开原始文件。"
      : !doc && !imageSource ? "尚未打开原始 PDF 或图片，请先打开文件。"
      : !replaceCurrent && selection.error ? selection.error : "";
    if (reason) { setNotice(reason); return; }
    const pages = replaceCurrent ? [page] : pending;
    if (!pages.length) { setNotice("所选页已有文本译文，不会重复收费。原页覆盖为 0 时仍待处理：可免费重新排版，或明确点击重译当前页。"); return; }
    const sequence = ++sequenceRef.current;
    const controller = new AbortController();
    const request = { controller, renderTask: null };
    requestRef.current = request;
    const current = () => sequenceRef.current === sequence && !controller.signal.aborted;
    let finished = 0;
    let activePage = pages[0];
    setBatch({ status: "preparing", pages, completed: 0, activePage });
    try {
      // Let the synchronous preparation feedback paint before screenshot work.
      await new Promise((resolve) => requestAnimationFrame(resolve));
      for (const targetPage of pages) {
      if (!current()) return;
      activePage = targetPage;
      setBatch({ status: "preparing", pages, completed: finished, activePage });
      // Render the source document, never the visible translated canvas/overlay.
      const canvas = document.createElement("canvas");
      const context = canvas.getContext("2d");
      if (!context) throw new Error("无法创建原页截图画布，请关闭其他高内存页面后重试。");
      let extractedText = !doc && targetPage === page ? text || "" : "";
      let lines = [];
      let textLayerPresent = false;
      let textExtractionFailed = false;
      if (doc) {
        const sourcePage = await doc.getPage(targetPage);
        if (!current()) return;
        const base = sourcePage.getViewport({ scale: 1 });
        const viewport = sourcePage.getViewport({ scale: 1800 / Math.max(base.width, base.height) });
        canvas.width = Math.max(1, Math.ceil(viewport.width));
        canvas.height = Math.max(1, Math.ceil(viewport.height));
        request.renderTask = sourcePage.render({ canvasContext: context, viewport, background: "#ffffff" });
        await request.renderTask.promise;
        request.renderTask = null;
        if (!current()) return;
        {
          // Text is supplementary; the full-page image remains authoritative.
          const content = await sourcePage.getTextContent().catch(() => null);
          textExtractionFailed = !content;
          textLayerPresent = Boolean(content?.items?.some((item) => item.str?.trim()));
          lines = buildPdfVisionLines(content, { ...viewport, width: canvas.width, height: canvas.height });
          extractedText = (content?.items || []).map((item) => `${item.str || ""}${item.hasEOL ? "\n" : " "}`).join("");
        }
      } else {
        const image = await new Promise((resolve, reject) => {
          const element = new Image();
          element.onload = () => resolve(element);
          element.onerror = () => reject(new Error("原图加载失败，请重新打开文件"));
          element.src = imageSource.src;
        });
        if (!current()) return;
        const ratio = Math.min(1, 1800 / Math.max(image.naturalWidth, image.naturalHeight));
        canvas.width = Math.max(1, Math.round(image.naturalWidth * ratio));
        canvas.height = Math.max(1, Math.round(image.naturalHeight * ratio));
        context.fillStyle = "#ffffff";
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
      }
      if (!current()) return;
      let image = canvas.toDataURL("image/png");
      if (image.length * 0.75 > 8 * 1024 * 1024) image = canvas.toDataURL("image/jpeg", 0.88);
      canvas.width = 0;
      canvas.height = 0;
      if (image.length * 0.75 > 8 * 1024 * 1024) throw new Error("本页截图超过 8MB，未发送。请使用较小的原始图片重试。");
      setBatch({ status: "working", pages, completed: finished, activePage });
      const response = await fetch("/api/pdf/vision-translate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({ image, text: String(extractedText).slice(0, 40000), page: targetPage, targetLang: "zh", config, layoutVersion: 1, lines: lines.map(({ index, text: lineText, bbox, safe }) => ({ index, text: lineText, bbox, safe: safe === true })) })
      });
      const result = await response.json().catch(() => null);
      if (!current()) return;
      if (!response.ok) {
        const detail = typeof result?.error === "string" ? result.error : result?.error?.message || result?.message;
        throw new Error(detail || `请求失败（HTTP ${response.status}），请检查服务配置后重试。`);
      }
      if (Number(result?.page) !== targetPage || !Array.isArray(result?.blocks) || !result.blocks.length
        || result.blocks.some((block) => !block || typeof block.id !== "string" || !KIND_LABELS[block.kind]
          || typeof block.source !== "string" || typeof block.translation !== "string" || (!block.source.trim() && !block.translation.trim()))) {
        throw new Error("模型未返回有效的本页分段结果，未标记为完成。请重试。");
      }
      const entry = { status: "done", image, layoutVersion: result.layoutVersion === 1 ? 1 : 0, positioningVersion: 2, lines, lineDiagnostics: lines.diagnostics, textLayerPresent, textExtractionFailed, blocks: result.blocks, warnings: Array.isArray(result.warnings) ? result.warnings.filter((item) => typeof item === "string") : [] };
      setBatch({ status: "typesetting", pages, completed: finished, activePage });
      await new Promise((resolve) => requestAnimationFrame(resolve));
      if (!current()) return;
      results.set(targetPage, entry);
      onPageResult?.(targetPage, entry, results);
      finished += 1;
      refresh((value) => value + 1);
      }
      if (current()) setBatch({ status: "done", pages, completed: finished });
    } catch (error) {
      if (current()) setBatch({ status: "error", pages, completed: finished, activePage, error: error.message || "视觉精读失败，请重试" });
    } finally {
      if (sequenceRef.current === sequence) requestRef.current = null;
    }
  };

  const busy = applying || ["preparing", "working", "typesetting"].includes(batch.status);
  return (
    <section className="pdf-vision-reading pdf-translation-dock" aria-label={`第 ${page} 页视觉翻译`}>
      <div className="pdf-reading-context" role="status">
        <span><Scan size={15} /><em className="pdf-workspace-edition">新工作台</em><strong>当前显示 · {displayLabel || "原文"}</strong></span>
        <span>第 {page} / {total || "—"} 页 · {!state.blocks ? "尚未视觉翻译" : coverage ? `已翻译 ${state.blocks.length} 块 · 实际覆盖 ${coverage.covered} 段${!coverage.covered ? " · 覆盖待处理" : ""}` : `已翻译 ${state.blocks.length} 块 · 尚未确认覆盖`}</span>
        <button type="button" onClick={onShowDetails}>结果详情 ↗</button>
      </div>
      <header className="pdf-translation-command">
        <div className="pdf-translation-command-title"><strong>视觉翻译</strong><span title={config?.model}>{config?.model || "未配置模型"}</span></div>
        <fieldset className="pdf-vision-scope" disabled={busy || !total}>
          <legend className="sr-only">翻译页数</legend>
          <div className="pdf-vision-scope-options">
            {[["current", "当前页"], ["range", "页码范围"], ["all", "全文"]].map(([value, label]) => (
              <label key={value} className={scope === value ? "is-selected" : ""}>
                <input type="radio" name="pdf-vision-scope" value={value} checked={scope === value} disabled={!doc && value !== "current"} onChange={() => setScope(value)} />{label}
              </label>
            ))}
          </div>
          {scope === "range" && doc ? <label className="pdf-vision-range">页码范围
            <input type="text" value={range} placeholder="例如 1-5,8" maxLength={2000} aria-invalid={Boolean(selection.error)} aria-describedby="pdf-vision-range-hint" onChange={(event) => setRange(event.target.value)} />
            <span id="pdf-vision-range-hint" className={selection.error ? "pdf-vision-range-error" : ""}>{selection.error || `已选 ${selection.pages.length} 页，重复页码自动合并。`}</span>
          </label> : null}
        </fieldset>
        <div className="pdf-vision-actions">
          <button type="button" className="pdf-vision-start" onClick={() => translate()} aria-disabled={busy}>
            {busy ? <Loader2 size={15} className="spin" /> : <Scan size={15} />}
             {applying ? "本地排版中…" : busy ? `第 ${batch.activePage} 页处理中…` : !selection.error && selection.pages.length && !pending.length ? "检查所选页译文" : `开始视觉翻译 · ${pending.length} 页`}
          </button>
          {busy ? <button type="button" onClick={cancel}><Square size={12} /> 取消</button> : null}
           {!busy && state.status === "done" ? <details className="pdf-translation-local-tools"><summary>当前页操作</summary><div>{state.layoutVersion === 1 ? <button type="button" onClick={applyToPage}><RefreshCw size={14} />免费重新排版</button> : null}<button type="button" onClick={() => translate(true)}>重译当前页 · 1 次付费调用</button></div></details> : null}
        </div>
      </header>
      <div aria-live="polite" role="status" className="pdf-translation-telemetry">
        <span>视觉文本 {completed} / {total || "—"} 页</span>
        {batch.pages.length ? <span>当前批次 {batch.completed} / {batch.pages.length} 页 · {batch.status === "preparing" ? `第 ${batch.activePage} 页 · 准备原页` : batch.status === "working" ? `第 ${batch.activePage} 页 · 请求模型，等待最终结果 · 已等待 ${requestSeconds} 秒` : batch.status === "typesetting" || applying ? "本地排版中" : batch.status === "canceled" ? "已取消，保留完成页" : batch.status === "error" ? "失败，后续已暂停" : "文本完成 · 覆盖以当前页为准"}</span> : <span>点击后串行调用 {pending.length} 次模型，可能收费 · 已有 {selection.pages.length - pending.length} 页将跳过</span>}
        {batch.status === "working" ? <span className="pdf-request-waiting-note">接口仅返回最终结果，不提供模型内部进度；等待中可取消。</span> : null}
        <details><summary>发送与保护说明</summary><p>仅点击后发送原页截图和文本；公式、图表与无法安全排版的段落保留原图，完整译文见详情。免费排版不请求模型。取消阻止后续页并忽略迟到结果，已发送请求仍可能计费。切换文件或模型会取消任务；结果仅保留在内存。</p></details>
      </div>
      {notice || applyError || batch.status === "error" ? <div className="pdf-translation-feedback" role="alert"><AlertTriangle size={15} /><div>{notice ? <div>{notice}</div> : null}{applyError ? <div>{applyError}</div> : null}{batch.status === "error" ? <div>第 {batch.activePage} 页失败：{batch.error}；已保留完成页，修正后点击开始继续。</div> : null}</div></div> : null}
      {detailsHost ? createPortal(<div className="pdf-vision-reading pdf-vision-detail-content">
      <div className="pdf-vision-result-heading"><strong>第 {page} 页译文</strong><span>{state.status === "done" ? `${state.blocks.length} 个阅读块 · 请结合原页核对` : busy && batch.activePage === page ? "正在处理，完成后显示" : "尚未翻译此页"}</span></div>
      {state.warnings?.length ? <div className="pdf-vision-warnings"><strong>阅读提示</strong><ul>{state.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></div> : null}
      {applyError ? <div className="pdf-vision-error" role="alert">{applyError}</div> : null}
      {state.status === "done" ? <div className={coverage?.covered ? "pdf-vision-local-coverage" : "pdf-vision-warnings"} role="status">文本已翻译 · {coverage ? `原页已覆盖 ${coverage.covered} 段 / ${coverage.total} 块${!coverage.covered ? "；注意：原页尚未覆盖，请查看各段原因。" : "；其余保留原图。"}` : "尚未确认原页覆盖；可点击免费应用到页面。"}</div> : null}
      {state.lineDiagnostics && (state.lineDiagnostics.omittedRows || state.lineDiagnostics.truncatedRows || state.lineDiagnostics.unpositionedItems || state.lineDiagnostics.clampedItems) ? <div className="pdf-vision-warnings">坐标提示：{state.lineDiagnostics.omittedRows ? `达到 800 行 / 100000 字符限额，省略 ${state.lineDiagnostics.omittedRows} 行；本页缺少完整碰撞证据，保留原图。` : `局部异常：${state.lineDiagnostics.truncatedRows || 0} 行超过 1600 字符，${state.lineDiagnostics.clampedItems || 0} 项越界，${state.lineDiagnostics.unpositionedItems || 0} 项无法定位；受影响段落保留原图，其余逐段核对。`}</div> : null}
      {state.status === "done" && state.layoutVersion !== 1 ? <div className="pdf-vision-warnings">此旧结果没有坐标，仅供侧栏阅读；要尝试原页覆盖，需重译当前页（会调用模型，可能收费）。已有坐标的结果可免费重新排版。</div> : null}
      {state.blocks?.map((block, index) => (
        <article key={`${block.id}-${index}`} className={`pdf-vision-block is-${block.kind}`}>
          <div className="pdf-vision-block-label"><span>{String(index + 1).padStart(2, "0")}</span>{KIND_LABELS[block.kind]}</div>
          <small className="pdf-vision-block-coverage">{coverage?.blocks?.[index]?.overlayStatus === "covered" ? "已覆盖原页" : `保留原图 · ${coverage?.blocks?.[index]?.rejectionReason || localPlan[index]?.rejectionReason || "等待应用到页面并核对排版"}`}</small>
          {block.kind === "equation" ? <>
            <div className="pdf-vision-equation">{renderMarkdown(block.source || block.translation)}</div>
            {block.source && block.translation && block.translation !== block.source ? <div className="pdf-vision-translation">{renderMarkdown(block.translation)}</div> : null}
            <small>公式为模型识别结果，请与原页核对。</small>
          </> : <>
            <div className="pdf-vision-translation">{block.translation ? (block.kind === "table" ? <pre className="pdf-vision-table">{block.translation}</pre> : renderMarkdown(block.translation)) : <p>此块未返回译文，请核对原文。</p>}</div>
            {block.source ? <details className="pdf-vision-source"><summary>查看原文</summary>{block.kind === "table" ? <pre className="pdf-vision-table">{block.source}</pre> : <div>{renderMarkdown(block.source)}</div>}</details> : null}
          </>}
        </article>
      ))}
      {state.image ? <details className="pdf-vision-snapshot"><summary>核对发送的原页截图</summary><img src={state.image} alt={`发送给模型的第 ${page} 页原始截图`} /></details> : null}
      {!state.blocks ? <div className="pdf-vision-detail-empty"><Scan size={28} /><h3>译文将在这里展开</h3><p>在阅读区上方选择页数并开始视觉翻译。历史版式结果不计入视觉翻译进度。</p></div> : null}
      </div>, detailsHost) : null}
    </section>
  );
}
