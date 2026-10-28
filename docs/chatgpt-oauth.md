# ChatGPT OAuth 试用接入

在桌面版或本机浏览器的「设置 → ChatGPT OAuth（实验性）」中点击 **Continue with ChatGPT**，在系统浏览器完成授权，返回选择模型并启用。无需 API Key。普通 API 供应商继续保留，可随时切换。

此实现通过 OpenAI 官方 Sign in with ChatGPT 动态注册流程请求套餐使用权限；账号及套餐是否可用以授权页面和实际模型响应为准。它不会读取 ChatGPT 历史聊天。OAuth 使用独立的 Responses API 适配器，覆盖 Agent、AI 搜索、普通翻译、PDF 解读、日记和 PDFMathTranslate 本地模型代理。旧的环境变量专用「深度 AI 解读」接口仍按原配置工作。

## 试用边界

- 仅本机使用。Tailscale/远程访问不能借用本机 OAuth 会话。
- 访问令牌、刷新令牌、ID token、账号与注册信息使用 Windows DPAPI CurrentUser 加密，存放于 `%LOCALAPPDATA%/ScholarLoop/chatgpt/credentials.dpapi`，不进入 localStorage、数据导出或项目文件。重启后自动恢复；本地供应商列表仅保存非秘密标记 `oauth-managed`。
- 如果原凭据目录的原子替换报 `EXDEV`，自动改用 `%APPDATA%/scholar-loop/chatgpt/credentials.dpapi`；仍使用 DPAPI CurrentUser 加密及原子写入。备用文件一旦存在就优先读取，退出状态不会被旧文件覆盖，备用文件损坏时也不会恢复旧令牌。
- 非秘密安装 ID 存放于原目录 `host-id.txt`。持续复用同一安装 ID 和已颁发的客户端 ID。加密凭据绑定当前 Windows 用户，不应复制到其他账号或设备使用。
- 登录使用临时 `127.0.0.1` 回调端口、PKCE S256、一次性 state/nonce；ID token 用 `jose` 校验签名、issuer、audience、过期时间和 nonce。缺少套餐授权时禁止推理。
- 令牌刷新串行执行；新令牌和轮换后的刷新令牌一起原子写入加密文件。退出时清除本地令牌，保留注册映射，并尝试撤销远程会话；失败会提示到 ChatGPT 设置断开连接。
- 模型选择沿用 API 配置的表单样式和刷新图标，将账号目录与常用的 GPT-6.1 Sol、GPT-6 Astra、GPT-6 Sol、GPT-6 Luna 合并去重，统一显示模型 ID，并支持自定义输入。刷新保留当前选择。内置选项不代表账号目录已开放，是否可调用以实际响应为准。
- 账号目录通过官方接口实时获取；下拉列表另外合并内置常用模型。成功取得模型列表不代表推理已通过。只有收到 `response.completed` 才视为完成。请求可能消耗套餐额度。
- 图片和函数工具经协议转换；音视频和其他未支持内容不会静默降级。

## 验证

定向检查：`node --test server/proxy.test.js server/chatgptAuth.test.js server/chatgptModel.test.js server/chatgptVault.test.js`（包括本地代理转发、EXDEV 迁移、真实 Windows DPAPI 的虚构凭据加解密测试）。代理请求使用 npm Undici 的 fetch 和 ProxyAgent，避免混用 Node 内置 fetch 的 dispatcher 协议。
前端构建：`npm run build`。
真实验收需要用户浏览器授权后，选择目录中的模型，完成一条短翻译或 Agent 请求。

参考：[官方注册与登录](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)、[模型调用](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)、[预览限制](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)。
