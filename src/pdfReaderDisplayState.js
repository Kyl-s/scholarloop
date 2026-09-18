export function initialPdfDisplayMode() {
  return "original";
}

export function layoutVariantForDisplayMode(mode) {
  if (mode === "translated") return "mono";
  if (mode === "bilingual") return "dual";
  return "";
}

export function findLayoutPageResult(result, pageNumber) {
  return (result?.pages || []).find(
    (page) => Number(page.page) === Number(pageNumber) && page.status === "completed"
  ) || null;
}

/** Resolve the page-scoped PDF first; whole-document URLs are a fallback for legacy jobs. */
export function resolveLayoutPageUrl(result, pageNumber, variant) {
  const page = findLayoutPageResult(result, pageNumber);
  if (page) {
    if (variant === "mono") {
      if (page.monoUrl) return { url: page.monoUrl, page, variant: "mono", whole: false };
      if (page.dualUrl) return { url: page.dualUrl, page, variant: "dual", whole: false };
    }
    if (variant === "dual") {
      if (page.dualUrl) return { url: page.dualUrl, page, variant: "dual", whole: false };
      if (page.monoUrl) return { url: page.monoUrl, page, variant: "mono", whole: false };
    }
  }

  // Progressive jobs must not borrow another page or an incomplete whole-document result.
  const progressive = Array.isArray(result?.pages) && result.pages.length > 0;
  if (progressive) return { url: "", page: null, variant: "", whole: false };

  if (variant === "mono" && result?.monoUrl) {
    return { url: result.monoUrl, page: null, variant: "mono", whole: true };
  }
  if (variant === "dual" && result?.dualUrl) {
    return { url: result.dualUrl, page: null, variant: "dual", whole: true };
  }
  if (variant === "dual" && result?.monoUrl) {
    return { url: result.monoUrl, page: null, variant: "mono", whole: true };
  }
  if (variant === "mono" && result?.dualUrl) {
    return { url: result.dualUrl, page: null, variant: "dual", whole: true };
  }
  return { url: "", page: page || null, variant: "", whole: false };
}

export function canSelectLayoutDisplayMode(result, pageNumber, mode) {
  if (mode === "original") return true;
  const variant = layoutVariantForDisplayMode(mode);
  return Boolean(variant && resolveLayoutPageUrl(result, pageNumber, variant).url);
}
