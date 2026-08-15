export function webviewFailureMessage(event) {
  if (event?.isMainFrame === false) return "";
  if (Number(event?.errorCode) === -3) return ""; // ERR_ABORTED: normal during redirects/navigation replacement
  const description = String(event?.errorDescription || event?.reason || "页面加载失败").trim();
  const code = Number.isFinite(Number(event?.errorCode)) ? ` (${event.errorCode})` : "";
  return `${description}${code}`;
}
