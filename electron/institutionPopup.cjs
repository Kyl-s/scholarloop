/**
 * Validate and route popup requests originating from an embedded institution
 * browser. Keeping this logic independent from Electron makes the security
 * boundary easy to exercise without starting the desktop application.
 */
function safeHttpUrl(value) {
  if (typeof value !== "string") return null;
  const target = value.trim();
  if (!target) return null;
  try {
    const parsed = new URL(target);
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || !parsed.hostname) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

/**
 * Create a WebContents.setWindowOpenHandler callback. Every popup is denied
 * at the Electron boundary; valid HTTP(S) targets are handed to the embedder
 * so it can create/focus an in-app tab.
 */
function createInstitutionPopupHandler({ notify, onRejected } = {}) {
  const send = typeof notify === "function" ? notify : () => {};
  const reject = typeof onRejected === "function" ? onRejected : () => {};
  return ({ url } = {}) => {
    const target = safeHttpUrl(url);
    if (target) send(target);
    else reject(url);
    return { action: "deny" };
  };
}

module.exports = { safeHttpUrl, createInstitutionPopupHandler };
