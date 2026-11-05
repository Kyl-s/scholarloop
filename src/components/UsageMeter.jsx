import {
  cacheHitRate,
  contextWindowForModel,
  formatPercent,
  formatTokenCount,
  hasUsage
} from "../llmUsage.js";

export default function UsageMeter({
  usage,
  model,
  estimateTokens = 0,
  usedChars = 0,
  pageCoverage = "",
  compact = false,
  variant = "panel"
}) {
  const windowSize = contextWindowForModel(model);
  const real = hasUsage(usage);
  const used = real ? usage.promptTokens : estimateTokens;
  const ratio = windowSize > 0 ? Math.min(1, used / windowSize) : 0;
  const tone = ratio >= 0.85 ? "high" : ratio >= 0.55 ? "mid" : "ok";
  const hit = real ? cacheHitRate(usage) : 0;

  if (variant === "inline") {
    // 侧栏里的单行形态：只留一个百分比和细进度条，细节放到 title，避免把内部统计铺在正文里。
    const details = [
      `上下文 ${formatTokenCount(used)} / ${formatTokenCount(windowSize)}${real ? "" : "（估算）"}`,
      real ? `缓存命中 ${formatPercent(hit)}` : "解读后显示实际用量",
      real ? `输出 ${formatTokenCount(usage.completionTokens)}` : "",
      pageCoverage ? `覆盖页 ${pageCoverage}` : "",
      usedChars ? `${formatTokenCount(usedChars)} 字` : ""
    ].filter(Boolean);
    return (
      <span
        className={`usage-inline is-${tone}`}
        title={details.join(" · ")}
        aria-label={`上下文使用 ${formatPercent(ratio)}`}
      >
        <i className="usage-inline-track" aria-hidden="true">
          <b style={{ width: `${used > 0 ? Math.max(4, ratio * 100) : 0}%` }} />
        </i>
        {formatPercent(ratio)}
      </span>
    );
  }

  return (
    <div className={`usage-meter${compact ? " is-compact" : ""}`} aria-label="上下文使用">
      <div className="usage-meter-head">
        <strong>上下文</strong>
        <span>
          {real ? "" : "约 "}
          {formatTokenCount(used)} / {formatTokenCount(windowSize)}
          <em>{formatPercent(ratio)}</em>
        </span>
      </div>
      <div className="usage-meter-bar" aria-hidden="true">
        <i className={`usage-meter-fill is-${tone}`} style={{ width: `${used > 0 ? Math.max(2, ratio * 100) : 0}%` }} />
      </div>
      <div className="usage-meter-foot">
        {real ? (
          <>
            <span>缓存命中 {formatPercent(hit)}{usage.cachedTokens ? ` · ${formatTokenCount(usage.cachedTokens)}` : ""}</span>
            <span>输出 {formatTokenCount(usage.completionTokens)}</span>
          </>
        ) : (
          <span>解读后显示实际用量和缓存命中</span>
        )}
        {pageCoverage ? <span>覆盖 {pageCoverage}</span> : null}
        {usedChars ? <span>{formatTokenCount(usedChars)} 字</span> : null}
      </div>
    </div>
  );
}
