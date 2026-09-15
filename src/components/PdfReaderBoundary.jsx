import { Component } from "react";
import { AlertTriangle, X } from "lucide-react";

export default class PdfReaderBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error) {
    console.error("[PdfReader] crashed:", error);
  }

  handleClose = () => {
    this.setState({ error: null });
    this.props.onClose?.();
  };

  handleRetry = () => {
    this.setState({ error: null });
  };

  render() {
    if (!this.state.error) return this.props.children;

    const message = String(this.state.error?.message || this.state.error || "未知错误");
    return (
      <div className="pdf-reader" role="alert">
        <div className="pdf-toolbar">
          <div className="pdf-toolbar-title">
            <AlertTriangle size={16} />
            <strong>阅读器异常</strong>
          </div>
          <button className="icon-btn" aria-label="关闭" title="关闭" onClick={this.handleClose}>
            <X size={17} strokeWidth={2} />
          </button>
        </div>
        <div className="pdf-body">
          <div className="pdf-canvas-stage">
            <div className="pdf-state error">
              <strong>内置阅读器崩溃</strong>
              <span>主界面仍可继续使用。可关闭后重开，或用系统浏览器 / 本地文件打开。</span>
              <details className="pdf-error-details">
                <summary>查看错误详情</summary>
                <span>{message}</span>
              </details>
              <div className="pdf-error-actions">
                <button className="pdf-open-external" onClick={this.handleRetry}>重试</button>
                <button className="pdf-open-external" onClick={this.handleClose}>关闭阅读器</button>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }
}
