import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api.js";

export default function useSourceConnectivity(sources, paperSources) {
  const [checks, setChecks] = useState({});
  const [now, setNow] = useState(Date.now);
  const inFlight = useRef(new Map());
  const versions = useRef(new Map());
  const lastRefresh = useRef(0);
  const configuration = JSON.stringify((sources || []).map((s) => [s.id, s.enabled, paperSources?.[s.id]?.enabled, paperSources?.[s.id]?.configured, s.configured]));

  const check = useCallback((id) => {
    if (inFlight.current.has(id)) return inFlight.current.get(id);
    const version = (versions.current.get(id) || 0) + 1;
    versions.current.set(id, version);
    setChecks((current) => ({ ...current, [id]: { ...current[id], loading: true } }));
    const request = api.checkPaperSource(id).catch((error) => ({
      id, state: "unknown", ok: false, error: error.message || "无法获取检测结果", checkedAt: new Date().toISOString()
    })).then((result) => {
      if (versions.current.get(id) === version) setChecks((current) => ({ ...current, [id]: { ...result, loading: false } }));
      return result;
    }).finally(() => {
      if (inFlight.current.get(id) === request) inFlight.current.delete(id);
    });
    inFlight.current.set(id, request);
    return request;
  }, []);

  const refresh = useCallback((automatic = false) => {
    lastRefresh.current = Date.now();
    return Promise.all(JSON.parse(configuration).filter(([id, , , , configured]) => automatic !== true || id !== "wos" || !configured).map(([id]) => check(id)));
  }, [configuration, check]);

  const reset = useCallback((automatic = false) => {
    for (const id of versions.current.keys()) versions.current.set(id, versions.current.get(id) + 1);
    inFlight.current.clear();
    setChecks({});
    return refresh(automatic);
  }, [refresh]);

  useEffect(() => {
    if (document.visibilityState !== "hidden") reset(true);
    const tick = () => {
      setNow(Date.now());
      if (document.visibilityState !== "hidden" && Date.now() - lastRefresh.current >= 90000) refresh(true);
    };
    const timer = setInterval(tick, 15000);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [refresh, reset]);

  const recordSearch = useCallback((statuses, completedAt) => {
    const updates = {};
    for (const status of statuses || []) {
      // Normal CNKI searches can return cached papers; only its probe proves a fresh connection.
      if (status.id === "cnki" && status.ok) continue;
      if (!status.attemptedQueries && !["unconfigured", "disabled"].includes(status.state)) continue;
      versions.current.set(status.id, (versions.current.get(status.id) || 0) + 1);
      updates[status.id] = {
        ...status, loading: false, checkedAt: completedAt || new Date().toISOString(),
        state: status.state === "partial" ? "partial" : status.ok ? "connected" : status.state,
        errorType: status.errors?.[0]?.type, origin: "search"
      };
    }
    setChecks((current) => ({ ...current, ...updates }));
    setNow(Date.now());
  }, []);

  return { checks, now, check, refresh, reset, recordSearch };
}
