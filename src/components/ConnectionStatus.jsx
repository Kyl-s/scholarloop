import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, CircleAlert, LoaderCircle, RefreshCw } from "lucide-react";

const HEALTH_TIMEOUT_MS = 5000;

async function checkHealth() {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
  try {
    const response = await fetch("/api/health", {
      cache: "no-store",
      signal: controller.signal
    });
    if (!response.ok) throw new Error(String(response.status) + " " + response.statusText);
    return await response.json();
  } finally {
    window.clearTimeout(timeout);
  }
}

export default function ConnectionStatus() {
  const [status, setStatus] = useState("checking");
  const [details, setDetails] = useState(null);

  const refresh = useCallback(async () => {
    setStatus((current) => current === "online" ? "checking" : current);
    try {
      const health = await checkHealth();
      setDetails(health);
      setStatus(health?.ok ? "online" : "offline");
    } catch {
      setDetails(null);
      setStatus("offline");
    }
  }, []);

  useEffect(() => {
    refresh();
    const interval = window.setInterval(refresh, 30000);
    const onOnline = () => refresh();
    window.addEventListener("online", onOnline);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("online", onOnline);
    };
  }, [refresh]);

  if (status === "online") {
    const title = "ScholarLoop 服务在线" + (details?.version ? " · v" + details.version : "");
    return (
      <div className="connection-status online" title={title}>
        <CheckCircle2 size={14} />
        <span>服务在线</span>
      </div>
    );
  }

  if (status === "checking") {
    return (
      <div className="connection-status checking" title="正在检查 ScholarLoop 服务">
        <LoaderCircle size={14} className="spin" />
        <span>连接中</span>
      </div>
    );
  }

  return (
    <button
      type="button"
      className="connection-status offline"
      onClick={refresh}
      title="请确认电脑端 ScholarLoop 和 Tailscale 已启动，点击重试"
    >
      <CircleAlert size={14} />
      <span>无法连接电脑服务</span>
      <RefreshCw size={13} />
    </button>
  );
}
