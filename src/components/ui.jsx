import { useEffect } from "react";
import { X, Loader2 } from "lucide-react";

export function Button({ variant = "primary", size = "md", icon: Icon, children, className = "", ...rest }) {
  return (
    <button className={`btn btn-${variant} btn-${size} ${className}`} {...rest}>
      {Icon ? <Icon size={size === "sm" ? 14 : size === "lg" ? 20 : 16} strokeWidth={2} /> : null}
      {children ? <span>{children}</span> : null}
    </button>
  );
}

export function IconButton({ icon: Icon, label, className = "", ...rest }) {
  return (
    <button className={`icon-btn ${className}`} aria-label={label} title={label} {...rest}>
      <Icon size={17} strokeWidth={2} />
    </button>
  );
}

export function Badge({ tone = "neutral", children, className = "" }) {
  return <span className={`badge badge-${tone} ${className}`}>{children}</span>;
}

export function SourceTag({ source, label }) {
  const map = {
    arxiv: "arXiv",
    openalex: "OpenAlex",
    semanticscholar: "S2",
    pubmed: "PubMed",
    crossref: "Crossref",
    manual: "手动",
    cnki: "知网",
    wanfang: "万方",
    baidu: "百度学术",
    googlescholar: "Scholar"
  };
  return <Badge tone="source">{label || map[source] || source}</Badge>;
}

export function Field({ label, hint, children, className = "" }) {
  return (
    <label className={`field ${className}`}>
      <span className="field-label">{label}</span>
      {children}
      {hint ? <span className="field-hint">{hint}</span> : null}
    </label>
  );
}

export function TextArea({ label, className = "", ...rest }) {
  return (
    <label className={`field ${className}`}>
      {label ? <span className="field-label">{label}</span> : null}
      <textarea className="input textarea" {...rest} />
    </label>
  );
}

export function Modal({ title, onClose, children, width = "720px" }) {
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") onClose?.();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <div className="modal" style={{ maxWidth: width }}>
        <div className="modal-head">
          <h3>{title}</h3>
          <IconButton icon={X} label="关闭" onClick={onClose} />
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

export function ProgressBar({ value = 0, max = 100, tone = "accent", className = "" }) {
  const pct = max ? Math.min(100, Math.max(0, (value / max) * 100)) : 0;
  return (
    <div className={`progress-track ${className}`}>
      <div className={`progress-fill progress-${tone}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

export function ProgressRing({ value = 0, size = 76, stroke = 7, label, sublabel }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const offset = c - (Math.min(100, Math.max(0, value)) / 100) * c;
  return (
    <div className="ring-wrap" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--line)" strokeWidth={stroke} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="var(--accent)"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={offset}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </svg>
      <div className="ring-text">
        <strong>{label ?? `${Math.round(value)}%`}</strong>
        {sublabel ? <span>{sublabel}</span> : null}
      </div>
    </div>
  );
}

export function Segmented({ options, value, onChange, className = "" }) {
  return (
    <div className={`segmented ${className}`} role="tablist">
      {options.map((opt) => (
        <button
          key={opt.value}
          role="tab"
          aria-selected={value === opt.value}
          className={value === opt.value ? "active" : ""}
          onClick={() => onChange(opt.value)}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

export function EmptyState({ icon: Icon, title, desc, action }) {
  return (
    <div className="empty-state">
      {Icon ? <Icon size={30} strokeWidth={1.6} /> : null}
      <h4>{title}</h4>
      {desc ? <p>{desc}</p> : null}
      {action}
    </div>
  );
}

export function Stars({ value = 1, onChange }) {
  return (
    <div className="stars" role="radiogroup" aria-label="理解等级">
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          role="radio"
          aria-checked={value === n}
          className={n <= value ? "on" : ""}
          onClick={() => onChange?.(n)}
          title={`${n} 级理解`}
        >
          {n <= value ? "★" : "☆"}
        </button>
      ))}
    </div>
  );
}

export function Spinner({ text = "加载中" }) {
  return (
    <div className="spinner">
      <Loader2 size={22} className="spin" />
      <span>{text}</span>
    </div>
  );
}

export function SectionHead({ title, desc, action }) {
  return (
    <div className="section-head">
      <div>
        <h2>{title}</h2>
        {desc ? <p>{desc}</p> : null}
      </div>
      {action}
    </div>
  );
}

export function formatDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return isNaN(d) ? iso : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
