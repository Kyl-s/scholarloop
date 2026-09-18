import React from "react";

export default class AppErrorBoundary extends React.Component {
  state = { error: null };

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error("[App] renderer crashed:", error, info);
  }

  handleReload = () => {
    window.location.reload();
  };

  render() {
    if (!this.state.error) return this.props.children;

    const message = String(this.state.error?.message || this.state.error || "未知错误");
    const stack = this.state.error?.stack || "";

    return (
      <main style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: 32, background: "#f4f6fb" }}>
        <section style={{ width: "min(680px, 100%)", padding: 28, borderRadius: 18, background: "#fff", boxShadow: "0 16px 48px rgba(30, 45, 80, .12)" }}>
          <h1 style={{ margin: "0 0 10px", fontSize: 22 }}>ScholarLoop 暂时无法显示</h1>
          <p style={{ margin: "0 0 18px", color: "#5d6678", lineHeight: 1.6 }}>
            页面遇到渲染错误。重新加载通常可以恢复；如果问题重复出现，请保留下面的错误信息。
          </p>
          <p style={{ margin: "0 0 18px", color: "#b42318", wordBreak: "break-word" }}>{message}</p>
          {stack ? (
            <details style={{ marginBottom: 18 }}>
              <summary>错误详情</summary>
              <pre style={{ overflow: "auto", whiteSpace: "pre-wrap", color: "#5d6678" }}>{stack}</pre>
            </details>
          ) : null}
          <button type="button" onClick={this.handleReload}>重新加载</button>
        </section>
      </main>
    );
  }
}
