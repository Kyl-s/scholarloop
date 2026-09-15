import katex from "katex";
import "katex/dist/katex.min.css";

function mathNode(source, displayMode, key) {
  try {
    const html = katex.renderToString(String(source || "").trim(), {
      displayMode,
      output: "htmlAndMathml",
      throwOnError: false,
      strict: "ignore",
      trust: false
    });
    return <span key={key} className={displayMode ? "md-math md-math-block" : "md-math"} dangerouslySetInnerHTML={{ __html: html }} />;
  } catch {
    return <code key={key} className="md-math-fallback">{String(source || "")}</code>;
  }
}

function findInlineMath(text, start) {
  const source = String(text || "");
  const candidates = [
    { open: "\\(", close: "\\)", displayMode: false },
    { open: "\\[", close: "\\]", displayMode: true }
  ];
  let best = null;
  for (const candidate of candidates) {
    const at = source.indexOf(candidate.open, start);
    if (at < 0 || (best && at >= best.at)) continue;
    const end = source.indexOf(candidate.close, at + candidate.open.length);
    if (end >= 0) best = { ...candidate, at, end };
  }
  for (let at = source.indexOf("$", start); at >= 0; at = source.indexOf("$", at + 1)) {
    if (source[at + 1] === "$" || source[at - 1] === "\\") continue;
    const end = source.indexOf("$", at + 1);
    if (end < 0 || source[end - 1] === "\\") continue;
    if (!best || at < best.at) best = { open: "$", close: "$", displayMode: false, at, end };
    break;
  }
  return best;
}

function inlineMd(text) {
  const source = String(text || "");
  const nodes = [];
  let cursor = 0;
  let key = 0;
  while (cursor < source.length) {
    const math = findInlineMath(source, cursor);
    if (!math) {
      nodes.push(...renderInlineTokens(source.slice(cursor), key));
      break;
    }
    if (math.at > cursor) nodes.push(...renderInlineTokens(source.slice(cursor, math.at), key));
    nodes.push(mathNode(source.slice(math.at + math.open.length, math.end), math.displayMode, `math-${key}`));
    key += 1;
    cursor = math.end + math.close.length;
  }
  if (!source && !nodes.length) return [<span key="empty" />];
  return nodes;
}

function renderInlineTokens(escaped, keyOffset = 0) {
  const parts = String(escaped).split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  return parts.map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**")) return <strong key={`b-${keyOffset}-${i}`}>{part.slice(2, -2)}</strong>;
    if (part.startsWith("`") && part.endsWith("`")) return <code key={`c-${keyOffset}-${i}`} className="md-inline-code">{part.slice(1, -1)}</code>;
    return <span key={`t-${keyOffset}-${i}`}>{part}</span>;
  });
}

export function renderMarkdown(text) {
  const lines = String(text || "").split("\n");
  const nodes = [];
  let list = [];
  let inCode = false;
  let codeLines = [];
  let mathBlock = null;
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
        nodes.push(<pre key={`c${i}`} className="md-code"><code>{codeLines.join("\n")}</code></pre>);
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
    if (mathBlock) {
      if (trimmed === mathBlock.close) {
        nodes.push(mathNode(mathBlock.lines.join("\n"), true, `math-block-${i}`));
        mathBlock = null;
      } else {
        mathBlock.lines.push(line);
      }
      return;
    }
    if (trimmed === "$$" || trimmed === "\\[") {
      flushPara(`p${i}`);
      flushList(`l${i}`);
      mathBlock = { close: trimmed === "$$" ? "$$" : "\\]", lines: [] };
      return;
    }
    if ((trimmed.startsWith("$$") && trimmed.endsWith("$$") && trimmed.length > 4)
      || (trimmed.startsWith("\\[") && trimmed.endsWith("\\]") && trimmed.length > 4)) {
      const isBracket = trimmed.startsWith("\\[");
      const openLength = isBracket ? 2 : 2;
      const closeLength = 2;
      flushPara(`p${i}`);
      flushList(`l${i}`);
      nodes.push(mathNode(trimmed.slice(openLength, -closeLength), true, `math-block-${i}`));
      return;
    }
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
  if (inCode) nodes.push(<pre key="endcode" className="md-code"><code>{codeLines.join("\n")}</code></pre>);
  return nodes;
}
