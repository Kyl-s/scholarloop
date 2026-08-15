function escapeHtml(text) {
  return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function inlineMd(text) {
  const escaped = escapeHtml(text);
  const parts = escaped.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  return parts.map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**")) return <strong key={i}>{part.slice(2, -2)}</strong>;
    if (part.startsWith("`") && part.endsWith("`")) return <code key={i} className="md-inline-code">{part.slice(1, -1)}</code>;
    return <span key={i}>{part}</span>;
  });
}

export function renderMarkdown(text) {
  const lines = String(text || "").split("\n");
  const nodes = [];
  let list = [];
  let inCode = false;
  let codeLines = [];
  let para = [];

  const flushList = (key) => {
    if (list.length) {
      nodes.push(<ul key={key} className="md-list">{list.map((li, i) => <li key={i}>{li}</li>)}</ul>);
      list = [];
    }
  };

  const flushPara = (key) => {
    if (para.length) {
      const children = [];
      para.forEach((chunk, i) => {
        if (i > 0) children.push(" ");
        children.push(...chunk);
      });
      nodes.push(<p key={key} className="md-p">{children}</p>);
      para = [];
    }
  };

  lines.forEach((line, i) => {
    if (line.trim().startsWith("```")) {
      if (inCode) {
        nodes.push(<pre key={`c${i}`} className="md-code"><code>{escapeHtml(codeLines.join("\n"))}</code></pre>);
        codeLines = [];
        inCode = false;
      } else {
        flushPara(`p${i}`);
        flushList(`l${i}`);
        inCode = true;
      }
      return;
    }
    if (inCode) {
      codeLines.push(line);
      return;
    }
    const trimmed = line.trim();
    if (!trimmed) {
      flushPara(`p${i}`);
      flushList(`l${i}`);
      return;
    }
    if (/^#{1,3}\s/.test(trimmed)) {
      flushPara(`p${i}`);
      flushList(`l${i}`);
      const level = trimmed.match(/^#+/)[0].length;
      const Tag = level === 1 ? "h3" : level === 2 ? "h4" : "strong";
      nodes.push(<Tag key={`h${i}`} className="md-head">{inlineMd(trimmed.replace(/^#+\s/, ""))}</Tag>);
      return;
    }
    const bullet = trimmed.match(/^[-*•]\s+(.*)/);
    if (bullet) {
      flushPara(`p${i}`);
      list.push(<span key={i}>{inlineMd(bullet[1])}</span>);
      return;
    }
    const numbered = trimmed.match(/^\d+[.、]\s+(.*)/);
    if (numbered) {
      flushPara(`p${i}`);
      list.push(<span key={i}>{inlineMd(numbered[1])}</span>);
      return;
    }
    flushList(`l${i}`);
    para.push(inlineMd(trimmed));
  });
  flushPara("end");
  flushList("end");
  if (inCode) nodes.push(<pre key="endcode" className="md-code"><code>{escapeHtml(codeLines.join("\n"))}</code></pre>);
  return nodes;
}
