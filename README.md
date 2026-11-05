# ScholarLoop

当前版本 **V1.1**。更新说明见 [CHANGELOG.md](CHANGELOG.md)。

面向科研新手的本地论文学习与写作闭环：聚合检索、阅读翻译、文献管理、学习路径和论文草稿都在本机完成。

作者：[Phantom](https://github.com/Kyl-s)

仓库：[github.com/Kyl-s/scholarloop](https://github.com/Kyl-s/scholarloop)

个人数据只留在你的电脑上，仓库里不包含文献库、笔记、PDF 和 API Key。

## 功能

- 六源聚合检索：arXiv、OpenAlex、Semantic Scholar、PubMed、Crossref、知网
- AI 搜索与 Agent 专注学习；支持 OpenAI 兼容 API，也支持 ChatGPT 账号授权
- 内置 PDF 阅读器：原文 / 译文 / 中英对照、OCR、AI 解读、视觉精读、手记
- 版式翻译：调用本机 PDFMathTranslate（BabelDOC）逐页生成译文，尽量保留原排版
  - 公式、作者/单位、参考文献按原文回贴，避免被误译或重排
  - 译后做确定性检查和视觉复核；只有安全、可验证的修改才会写回 PDF
  - 单页失败不会中断整本；失败页会保留在侧栏，可继续翻译
- 视觉翻译：对扫描版或复杂版面，用支持图片输入的视觉模型按页生成覆盖式译文
- AI 解读：快速 / 完全两种模式，支持引导式精读、追问和理解进度记录
- 文献库、学习路径、思考记录、论文草稿
- 桌面窗口：Electron，可最小化到托盘

## 运行

```bash
npm install
npm run dev
```

浏览器打开 http://localhost:5173 。

也可以双击 `start-app.cmd`，或运行 `npm run desktop` 打开桌面窗口。

生产模式：

```bash
npm run build
npm start
```

打开 http://127.0.0.1:8787 。

## 首次设置

1. 打开「设置 → API 配置」，填写 OpenAI 兼容的 API Key、接口地址和模型；也可以使用 ChatGPT 账号授权，不必手填 Key。
2. 如需 PDF 版式翻译：打开「设置 → PDFMathTranslate」，点「安装到本机」。安装包不会进 git。
3. 如需视觉翻译 / 视觉精读：在 API 配置里选择一个支持图片输入的视觉模型。
4. 外刊访问可在设置里填写网络代理；机构资源只保存入口网址，账号密码不入库；站内打开新窗口的链接会在内嵌浏览器新标签中打开，并共享本机登录会话。

## PDF 阅读器

- 顶部切换「原文 / 译文 / 中英对照」，译文来源可选版式译文或视觉译文。
- 右侧「翻译」页签：启动版式翻译、查看进度、重新翻译当前页；失败页会显示原因。
- 工具栏「视觉精读」：选择当前页或页码范围，用视觉模型识别版面并生成覆盖式译文。
- 右侧「AI 解读」页签：快速解读抓摘要与结论，完全解读覆盖全文；支持引导式精读、追问和理解进度。
- 右侧「手记」页签：按论文和页码记录阅读笔记，可跳回原文位置。

版式翻译由本机 PDFMathTranslate/BabelDOC 完成。遇到引擎级限制（例如 PDF 字体 CID 段落过多）时，该页可能无法生成译文；可以改用视觉翻译，或把相关页拆成单独 PDF 再翻。扫描版 PDF 没有文本层时，版式翻译会提示回退，视觉翻译更适合这类文档。

## 测试

```bash
npm test
```

Windows 下如果并行测试遇到文件占用，改用串行：

```bash
node --test --test-concurrency=1 "src/**/*.test.js" "server/**/*.test.js"
```

## iPhone PWA（个人使用）

第一版 iPhone 访问方式不需要 Xcode、Cloudflare 或公网端口：电脑继续运行 ScholarLoop，iPhone 和电脑都登录同一个 Tailscale 个人网络，再由 Tailscale Serve 提供私有 HTTPS 地址。

1. 在电脑和 iPhone 安装并登录 Tailscale，确认两台设备出现在同一个网络中。
2. 运行 `scripts\start-scholarloop-tailscale.cmd`，或分别运行：

   ```bash
   npm start
   tailscale serve --https=443 http://127.0.0.1:8787
   ```

3. 在 Tailscale 管理界面或命令输出中找到电脑的 `*.ts.net` HTTPS 地址。
4. 用 iPhone Safari 打开该地址，确认 ScholarLoop 可用后选择“添加到主屏幕”。

Tailscale Serve 只把本机 `127.0.0.1:8787` 提供给同一 Tailscale 网络内的设备，不需要开放 Windows 防火墙入站端口。使用 PWA 时 iPhone 上的 Tailscale 必须保持连接；电脑端服务关闭时，页面会显示无法连接电脑服务。个人数据、PDF 缓存和 AI 配置仍保存在电脑端。

## 隐私

这些只留在你自己的电脑上，不会进 git：

- 文献库、笔记、学习路径、机构入口（学校名和 WebVPN 地址）写在 `data/store.json`
- PDF 原文、缓存和版式译文在 `data/pdfs`、`data/pdf-cache`、`data/pdf-translations`
- 内嵌浏览器登录 Cookie 在 Electron 用户目录的 `persist:scholarloop` 分区，不在项目文件夹里
- API Key 在本机浏览器 localStorage；ChatGPT OAuth 凭据由 Windows DPAPI 加密保存在本机用户目录
- `tools/pdf2zh`、日志、`.env`

使用云端模型时，AI 解读会把正文摘录、视觉翻译会把页面图片发送到你配置的 API 服务；如果在意隐私，请使用本机或可信的模型服务。

克隆下来是空数据，用自己的文献和配置即可。

## 数据源

聚合搜索走公开学术 API。Semantic Scholar 偶有限流，失败来源会自动跳过并重试；知网走公开检索接口；万方等暂以门户跳转 + 手动导入补全。

## 技术栈

- 前端：React 18 + Vite
- 后端：Node.js + Express
- 桌面：Electron
- 存储：本地 JSON
- PDF 处理：pdf.js、PDFMathTranslate/BabelDOC、PyMuPDF（按需调用）
- 测试：node:test
