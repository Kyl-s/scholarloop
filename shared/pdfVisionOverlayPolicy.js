// Shared by the server and page-overlay client. Keep these rules environment-free.
export const VISION_SCAN_MIN_CONFIDENCE = 0.9;
export const VISION_OVERLAY_KINDS = Object.freeze(["title", "heading", "paragraph", "caption", "list", "note"]);

export function hasVisionFormula(text) {
  if (typeof text !== "string") return false;
  // Ordinary hyphenated prose (e.g. state-of-the-art) is not mathematics.
  return /\$[^$\n]+\$|\\(?:\(|\)|\[|\])|\\(?:begin|end|frac|sqrt|sum|prod|int|alpha|beta|gamma|delta|theta|lambda|sigma|mu|pi|mathrm|mathbf|mathbb|operatorname)\b|[=∑∏∫√±≤≥≠≈∞∂∇₀-₉⁰¹²³⁴⁵⁶⁷⁸⁹]|[\p{L}\p{N})\]}]\s*\^\s*(?:[\p{L}\p{N}{(+-])|(?:\b[\p{L}]|[)\]}])_\s*(?:\{|\d)/u.test(text);
}
