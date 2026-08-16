# ScholarLoop

当前版本 **V1.1**。更新说明见 [CHANGELOG.md](CHANGELOG.md)。

面向科研新手的本地论文学习与写作闭环：聚合检索、阅读翻译、文献管理、学习路径和论文草稿都在本机完成。

个人数据只留在你的电脑上，仓库里不包含文献库、笔记、PDF 和 API Key。

## 功能

- 六源聚合检索：arXiv、OpenAlex、Semantic Scholar、PubMed、Crossref、知网
- AI 搜索与 Agent 专注学习，API 在「设置」里配置（OpenAI 兼容）
- 内置 PDF 阅读器：原文 / 译文 / 对照、OCR、AI 解读
- 排版翻译：设置里可一键安装 PDFMathTranslate（约 240MB，安装到本机 `tools/pdf2zh`）
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

1. 打开「设置 → API 配置」，填写 OpenAI 兼容的 API Key、接口地址和模型。Key 只保存在本机浏览器。
2. 如需 PDF 排版翻译：打开「设置 → PDFMathTranslate」，点「安装到本机」。安装包不会进 git。
3. 外刊访问可在设置里填写网络代理；机构资源只保存入口网址，账号密码不入库。

## 隐私

这些只留在你自己的电脑上，不会进 git：

- 文献库、笔记、学习路径、机构入口（学校名和 WebVPN 地址）写在 `data/store.json`
- 内嵌浏览器登录 Cookie 在 Electron 用户目录的 `persist:scholarloop` 分区，不在项目文件夹里
- API Key 在本机浏览器 localStorage
- `tools/pdf2zh`、PDF 缓存、日志、`.env`

克隆下来是空数据，用自己的文献和配置即可。

## 数据源

聚合搜索走公开学术 API。Semantic Scholar 偶有限流，失败来源会自动跳过并重试；知网走公开检索接口；万方等暂以门户跳转 + 手动导入补全。

## 技术栈

- 前端：React 18 + Vite
- 后端：Node.js + Express
- 桌面：Electron
- 存储：本地 JSON
