import { useEffect, useState } from "react";
import { BarChart3, Trash2 } from "lucide-react";
import {
  cacheHitRate,
  clearLlmUsageStore,
  formatPercent,
  formatTokenCount,
  LLM_USAGE_EVENT,
  loadLlmUsageStore,
  USAGE_KIND_LABELS
} from "../llmUsage.js";
import { Badge, Button } from "./ui.jsx";

export default function UsageStats() {
  const [open, setOpen] = useState(false);
  const [store, setStore] = useState(() => loadLlmUsageStore());

  useEffect(() => {
    const refresh = () => setStore(loadLlmUsageStore());
    window.addEventListener(LLM_USAGE_EVENT, refresh);
    window.addEventListener("storage", refresh);
    return () => {
      window.removeEventListener(LLM_USAGE_EVENT, refresh);
      window.removeEventListener("storage", refresh);
    };
  }, []);

  const totals = store.totals || {};
  const hit = cacheHitRate(totals);
  const kinds = Object.entries(store.byKind || {});
  const models = Object.entries(store.byModel || {});
  const recent = (store.recent || []).slice(0, 8);
  const hasData = Number(totals.calls || 0) > 0;

  const reset = () => {
    if (!window.confirm("确定清空本机保存的 Token 统计？这不会影响供应商账单。")) return;
    setStore(clearLlmUsageStore());
  };

  return (
    <div className="usage-stats">
      <button type="button" className="usage-stats-toggle" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <BarChart3 size={15} />
        <span>
          <strong>用量统计</strong>
          <em>
            {hasData
              ? `累计 ${formatTokenCount(totals.totalTokens)} tokens · 缓存命中 ${formatPercent(hit)} · ${totals.calls} 次`
              : "展开查看 Token 消耗和缓存命中率"}
          </em>
        </span>
        <Badge tone="neutral">{open ? "收起" : "展开"}</Badge>
      </button>

      {open ? (
        <div className="usage-stats-body">
          {!hasData ? (
            <p className="usage-stats-empty">还没有记录。解读、翻译和 Agent 对话成功后会记在本机浏览器，不会上传。</p>
          ) : (
            <>
              <div className="usage-stats-grid">
                <div>
                  <em>输入</em>
                  <strong>{formatTokenCount(totals.promptTokens)}</strong>
                </div>
                <div>
                  <em>输出</em>
                  <strong>{formatTokenCount(totals.completionTokens)}</strong>
                </div>
                <div>
                  <em>缓存命中</em>
                  <strong>{formatPercent(hit)}</strong>
                </div>
                <div>
                  <em>缓存 token</em>
                  <strong>{formatTokenCount(totals.cachedTokens)}</strong>
                </div>
              </div>

              {kinds.length ? (
                <div className="usage-stats-table">
                  <strong>按功能</strong>
                  {kinds.map(([kind, bucket]) => (
                    <div key={kind}>
                      <span>{USAGE_KIND_LABELS[kind] || kind}</span>
                      <span>{formatTokenCount(bucket.totalTokens)} · 命中 {formatPercent(cacheHitRate(bucket))} · {bucket.calls} 次</span>
                    </div>
                  ))}
                </div>
              ) : null}

              {models.length ? (
                <div className="usage-stats-table">
                  <strong>按模型</strong>
                  {models.map(([model, bucket]) => (
                    <div key={model}>
                      <span>{model}</span>
                      <span>{formatTokenCount(bucket.totalTokens)} · 命中 {formatPercent(cacheHitRate(bucket))}</span>
                    </div>
                  ))}
                </div>
              ) : null}

              {recent.length ? (
                <div className="usage-stats-table">
                  <strong>最近调用</strong>
                  {recent.map((item, index) => (
                    <div key={`${item.at}-${index}`}>
                      <span>{USAGE_KIND_LABELS[item.kind] || item.kind} · {item.model}</span>
                      <span>{formatTokenCount(item.totalTokens)}{item.cachedTokens ? ` · 缓存 ${formatTokenCount(item.cachedTokens)}` : ""}</span>
                    </div>
                  ))}
                </div>
              ) : null}

              <div className="usage-stats-actions">
                <Button variant="ghost" icon={Trash2} onClick={reset}>清空统计</Button>
                {store.updatedAt ? <em>更新于 {store.updatedAt.replace("T", " ").slice(0, 19)}</em> : null}
              </div>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
