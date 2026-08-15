# ScholarLoop 内嵌浏览器网站只显示一小条 — 排查文档

> 写给接手的 agent（原 CODEX）。问题已定位到 Electron `<webview>` guest 视口高度锁定 150px，
> 修复尚未完成，以下是全部排查过程、实验证据和下一步建议。

## 已修复（2026-08-07）

**根因**：不是 React 时序，也不是 Electron webview 的默认高度 bug，而是项目 CSS 把
`<webview>` 的默认 `display: flex` 覆盖成了 `display: block`。

Electron 官方文档明确说明：`webview` 内部用 `display: flex` 让 guest iframe 填满容器，
不要覆盖这个默认 display 属性。项目里 `.browser-iframe, .browser-webview` 共用一条
`display: block` 规则，导致 guest 视口初始化时只有 webview 的默认 150px 高，
之后改元素高度也不会更新。

**修复**：`src/styles.css` 拆开两条规则，`.browser-webview` 改为 `display: flex`。

**验证**（Electron 43.3.0 + CDP 实测）：
- 修复前：webview 元素 1107×694，guest `innerHeight=150`。
- 修复后：guest `innerHeight=694`，与容器一致；容器缩到 420px 时 guest 同步变 420px。
- 内嵌知网页面完整显示，登录分区 `persist:scholarloop` 不变。

下面保留原来的排查记录，作为历史参考。

## 问题现象

桌面版 ScholarLoop「论文搜索 → 内嵌浏览器」打开论文网站（默认知网，也可切万方等），
**网站内容只显示顶部一小条（约 150px 高），下方大片空白**。用户截图确认，网页版（fallback）不受影响。

## 相关文件

  - `src/pages/SearchPage.jsx` — 内嵌浏览器面板、webview 创建逻辑（已尝试改为手动创建，见「当前代码状态」）
  - `src/styles.css` — `.browser-frame` / `.browser-webview` 高度（已尝试改为 calc，见「当前代码状态」）
  - `electron/main.cjs` — `BrowserWindow` 已开 `webviewTag: true`；webview 用 `partition="persist:scholarloop"` 保留登录状态
- git：`cbad041` 首次提交，`69445f7` 修滚动（auto 定位面板顶部）

## 根因（已定位）

内嵌浏览器用 Electron `<webview>` 加载网站。**webview 元素本身的 CSS 尺寸正确（1107×694px），
但 webview 内部 guest 视口高度只有 150px**（`window.innerHeight === 150`），150px 正是 Electron webview 的默认高度。

结论：guest 视口在**创建时**被锁定为默认 150px，之后无论怎么改元素尺寸都不更新。

## 实验证据（全部在带调试端口实例上实测）

检查 guest 视口的方法：桌面版用 `electron . --remote-debugging-port=9222` 启动，
连 CDP 后 `/json` 列表里能找到 url 为网站的 `webview` target，用 WebSocket 连其 `webSocketDebuggerUrl`，
`Runtime.evaluate` 执行 `JSON.stringify({innerHeight, innerWidth})` 即可。

1. **guest 状态**：`innerHeight=150, innerWidth=1107, dpr=1.5`；网站 `document.scrollHeight=3342`。
2. **改元素高度无效**：把 webview `style.height` 设为容器高度 694px → guest 仍 150px。
3. **触发 resize 无效**：`window.dispatchEvent(new Event('resize'))` → guest 仍 150px。
4. **纯脚本重建有效**：CDP `document.createElement('webview')` + `appendChild`（高度分别试过
   `100%`、`calc(100vh - 170px)`、像素 `694px`）→ guest **全部是 694px** ✅。
5. **React JSX 渲染无效**：`<webview style={{height:'100%'}}>` → guest 150px ❌。
6. **React useEffect 手动 createElement 无效**：在 React effect 里 `document.createElement('webview')`
   + 像素高度 + `appendChild`（与第 4 条完全相同的操作）→ guest **仍 150px** ❌。

### 由此推断

- 与高度表达式无关（`100%`/`calc`/像素在纯脚本重建下都正确）。
- 与「创建 webview 的方式」相关：**页面完全稳定后用纯 DOM 脚本创建 → guest 正确；
  任何经过 React（JSX 渲染或 React effect）创建 → guest 锁死 150px**。
- 疑似 React 的 DOM 插入/reconcile 时序导致 webview 元素在 guest 初始化瞬间 layout 尺寸为 0，
  Electron 便用默认高度；纯脚本创建时 layout 已稳定。

## 当前代码状态（截至 2026-08-07，尚未修复）

`SearchPage.jsx` 已尝试「手动创建」方案（第 6 条实验），**未解决，guest 仍 150px**：

- 新增 `webviewReady` state 与 `frameRef`（指向 `.browser-frame`）。
- 新增 effect：`browserOpen && isElectron` 时，双重 `requestAnimationFrame` 后
  `document.createElement('webview')`，设置 `style.height = frame.offsetHeight + 'px'`、
  `partition="persist:scholarloop"`、`allowpopups`、`webpreferences="contextIsolation=yes, nodeIntegration=no"`，
  `appendChild` 到 `.browser-frame`；清理时移除。webview 事件监听 effect 依赖加了 `webviewReady`。
- render 里不再有 `<webview>` JSX 标签（改由 effect 创建），未就绪时显示 loading 占位。
- `styles.css` 把 `.browser-webview` 高度改为 `calc(100vh - 170px)`（移动端 `calc(100vh - 190px)`）——
  基于错误假设，可回退为 `100%` 或保留，不影响根因。

此改动没有让情况更糟（网站仍显示 150px 高，与之前一致），但对接手者可能是干扰，可回退到
React JSX 渲染 `<webview>` 的干净写法（git 历史里有，或按第 5 条实验还原）。

## 下一步建议（给接手者）

优先排查「React 创建 vs 纯脚本创建」在 guest 初始化瞬间的差异：

1. 用 raw CDP / MutationObserver 记录：React effect 里 `appendChild` 瞬间，webview 元素的
   `offsetHeight` / `getBoundingClientRect().height` 是否为 0；对比纯脚本创建时是否非 0。
   若 React 侧为 0，则是「元素入 DOM 后、guest 初始化前 layout 未跑」的时序问题。
2. 尝试把创建时机改为更晚/更稳：`setTimeout(0/100ms)`（宏任务，而非 rAF）后再 `appendChild`；
   或先 append 一个空占位、强制 reflow 后在同一 tick 换入 webview 元素。
3. 尝试 `webview` 的 `did-attach` 事件里强制 `webContents.setSize({width, height})`（需拿 guest webContents）。
4. 查 Electron 43 `<webview>` 是否有 guest 尺寸初始化已知 issue（可能需固定 Electron 版本或换 API）。
5. 兜底方案：放弃 `<webview>`，改用 Electron `BrowserView` / `WebContentsView` 嵌入网页；
   或维持「用系统浏览器打开」的 fallback（网页版当前就是这个行为）。
6. 注意保留 `partition="persist:scholarloop"`，否则用户已保存的登录状态会丢失。

## 复现

1. `npm run build`
2. `electron . --remote-debugging-port=9222`（工作目录为项目根）
3. 打开「论文搜索 → 内嵌浏览器」
4. 连 CDP 检查 webview guest `window.innerHeight`（见上方方法）→ 期望 694，实际 150
