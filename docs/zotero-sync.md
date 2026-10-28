# Zotero 同步（第一版）

在「设置 → Zotero 手机阅读」填入自己创建的 API Key，允许读取个人库、写入文献和文件访问。点击「保存配置」会先校验授权，再加密保存。留空保存保留原授权。「验证已保存的连接」不会上传论文。

随后在设置或文献库点击「同步全部文献」。目标是个人库中的同名顶层分类（默认 ScholarLoop），无需安装电脑端 Zotero。iPhone 安装 Zotero、登录同一账号后同步，即可下载已上传的 PDF。

## 同步范围

- 单向：ScholarLoop → Zotero。上传标题、作者、DOI、年份、期刊、摘要、网页地址、标签及 PDF。
- 使用 Zotero Storage；本版不配置 WebDAV，也不接入群组库。附件占用账号空间。
- 优先使用本地 PDF（包括阅读缓存）；否则尝试下载现有 PDF 直链。无可获取全文时明确标记「仅条目」，不会把网页链接当成已上传 PDF。
- 完整中文排版译文以独立附件 `paper.zh.pdf` 上传到同一条目；逐页译文全部完成后按页序合并，缺页不上传，原文版本不匹配时提示重新翻译。AI 解读、学习路径和阅读记录留在本地；Zotero 修改、批注和删除暂不回传。本地删除不会删除云端条目。
- 已同步条目维护本地映射，按 DOI 查找已有云端条目；无 DOI 时按标题与年份匹配。已有的其他分类、标签和笔记保留。
- 仅更新由本功能创建条目的元数据；匹配到原有条目时只添加分类和全文附件。
- 本地 PDF 内容变化时使用新附件；检测到对应云端 PDF 被修改时报告冲突，保留云端文件，不覆盖手机修改。可在 Zotero 网页确认并备份版本、删除发生冲突的旧附件后重试。

## 自动同步与失败重试

默认手动同步。主动开启自动同步并保存后，应用运行期间每 60 秒检查新增/更新的文献及中文排版译文。首轮会处理现有未同步文献。网络等失败会等待至少 5 分钟再重试，并遵守 Zotero 的 Backoff/Retry-After。

手动重试会复用条目和附件 key，防止因上传或注册失败重复创建。仅条目结果可在获取全文后手动同步重试。退出应用会中断任务，下次显示中断提示；再次同步可继续。同步中禁止修改账号或断开授权。

## 本地存储与安全

- API Key 单独使用 Windows DPAPI CurrentUser 加密保存于 `%LOCALAPPDATA%/ScholarLoop/zotero/credentials.dpapi`，复用现有凭据加密实现；不会写入 `store.json`、浏览器 localStorage、导出备份、日志或状态接口。加密文件不进入 Git。
- `data/zotero-state.json` 保存账号对应的条目/分类映射与最近一次结果，不含 Key。请保留该文件以便恢复同步；其内容同样不进入 Git。
- 断开连接清除本机授权，保留映射及云端文献。账号重连可复用映射。
- 本机接口使用与现有登录功能相同的 Host、Origin 和远程地址检查，其他网页不可调用授权与同步接口。
- 未实现凭据解密的跨平台替代；当前面向 Windows 桌面运行环境。

## 验证

`node --test server/zotero.test.js` 使用模拟 Zotero 与上传服务验证协议、去重、上传中断恢复、权限/配额错误、并发互斥、远程 PDF 冲突和自动重试；不会改动真实文献库。

实际账号上传和 iPhone 下载需填写自己的 Key 后验证，本地模拟通过不代表云端或手机端已验收。

实现依据：[Zotero Web API 写入](https://www.zotero.org/support/dev/web_api/v3/write_requests)、[文件上传](https://www.zotero.org/support/dev/web_api/v3/file_upload)、[版本与同步](https://www.zotero.org/support/dev/web_api/v3/syncing)。
