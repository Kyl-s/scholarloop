import { RefreshCw } from "lucide-react";

export function connectionView(check, now = Date.now()) {
  if (check?.loading) return { label: "检测中…", tone: "muted" };
  if (!check) return { label: "待检测", tone: "muted" };
  if (check.state === "disabled") return { label: "已停用", tone: "muted" };
  if (check.state === "unconfigured") return { label: "未配置 · 仅门户", tone: "muted" };
  if (now - Date.parse(check.checkedAt) > 120000) return { label: "已过期 · 待检测", tone: "muted" };
  if (check.state === "partial") return { label: "部分可用", tone: "warn" };
  if (check.ok) return { label: "可用", tone: "ok" };
  const labels = { rate_limit: "限流中", access_denied: "授权 / 访问被拒", timeout: "连接超时", network: "连接失败", invalid_response: "响应异常", http_error: "服务异常" };
  return { label: check.state === "unknown" ? "检测失败" : labels[check.errorType] || "不可用", tone: "fail" };
}

export function SourceConnectionBadge({ check, now }) {
  const view = connectionView(check, now);
  const time = check?.checkedAt ? new Date(check.checkedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "尚未检测";
  const detail = `${view.label} · ${time}${check?.latencyMs != null ? ` · ${check.latencyMs} ms` : ""}${check?.error ? ` · ${check.error}` : ""}`;
  return <span className={`source-connection-badge ${view.tone}`} title={detail}><i aria-hidden="true" />{view.label}</span>;
}

export default function SourceConnectivity({ sources, connectivity }) {
  const { checks, now, refresh } = connectivity;
  const available = sources.filter((source) => connectionView(checks[source.id], now).tone === "ok").length;
  const busy = sources.some((source) => checks[source.id]?.loading);
  const timestamps = sources.map((source) => Date.parse(checks[source.id]?.checkedAt)).filter(Number.isFinite);
  const latest = timestamps.length ? new Date(Math.max(...timestamps)).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "尚未检测";
  return (
    <div className="source-connectivity">
      <div className="source-connectivity-head">
        <strong>数据源连接：{available}/{sources.length} 可用</strong>
        <span>最近更新 {latest} · 每 90 秒自动检测</span>
        <button type="button" onClick={refresh} disabled={busy}><RefreshCw size={13} className={busy ? "spin" : ""} />{busy ? "检测中…" : "刷新状态"}</button>
      </div>
      <div className="source-connectivity-list">{sources.map((source) => <span key={source.id} className="source-connectivity-item">{source.label}<SourceConnectionBadge check={checks[source.id]} now={now} /></span>)}</div>
      <small>检测聚合检索接口；WoS 仅手动检测或检索后更新，保护每日配额。门户及全文权限需另行确认；刷新可能复用 60 秒内的检测结果。</small>
    </div>
  );
}
