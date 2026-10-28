# 论文搜索数据源状态

## 三种独立语义

- 搜索顶部：来源选择按钮决定下一次检索范围；搜索框下方的连接面板展示全部八源的最近检测状态、更新时间和刷新入口。
- 设置页：授权配置和连接状态分别显示；支持逐个重新检测。填写 Key 不代表授权通过，检测使用已保存配置。
- 搜索结果：本次执行状态，恢复会话后标注为上次检索，保留完成时间。

## 搜索响应契约

`sourceStatus` 保留兼容字段 `ok/count/error`，增加：

- `state`：`success`、`empty`、`partial`、`failed`、`skipped`、`disabled`、`unconfigured`。
- `attemptedQueries/successfulQueries/failedQueries`：按语言路由实际执行的子查询计数。
- `attempts`：来源任务执行次数，包含重试；多步骤来源任务可包含多个 HTTP 请求。
- `errors`：脱敏后的 queryIndex、错误类别、HTTP 状态、是否可重试和消息。
- `elapsedMs`：来源任务执行耗时累计，不含排队等待，不是整个搜索的墙钟耗时。
- `count/uniqueCount/filteredCount/displayedCount`：原始返回、去重、年份及相关性筛选后、最终展示的来源归属数量。
- `completedAt`：本次聚合完成时间。

`ok` 仍表示至少一个子查询成功，页面必须使用 `state` 区分部分成功。
`empty` 表示执行全部成功但没有最终展示记录；应结合计数判断原始零条、过滤淘汰或结果截断。
同一去重论文可归属多个来源，来源计数不能直接相加为论文总数。
指定年份范围时，未知年份论文不进入结果；未指定范围时保留。

## 稳定性及边界

应用可见时每 90 秒自动对来源做轻量真实检索（WoS 为保护配额，仅手动检测或检索后更新），关键词 `machine learning`，请求数量为 1；页面隐藏时暂停自动探测。检测接口为 `POST /api/sources/:id/check`，返回 `state`（connected/failed/unconfigured/disabled）、`checkedAt`、`latencyMs`、`errorType`；有效空结果也表示接口可用。

检测共用来源队列，15 秒预算，按来源和配置摘要缓存 60 秒并合并在途请求。CNKI 检测绕过业务结果缓存。普通检索完成后同步连接状态，CNKI 的缓存成功结果不刷新连接时间；历史会话不更新连接面板。超过 120 秒的结果标为过期。限流、超时、访问拒绝分别显示；检测接口本身不可达时显示“检测失败”，不会伪装为上游服务状态。

连接检测证明聚合检索接口在记录时间可用，不代表门户登录、全文权限或未来请求一定成功。顶部“服务在线”仅表示本地 ScholarLoop 后端状态。

同一来源使用进程内串行队列，跨来源可并行。HTTP 429 和 500/502/503/504 最多重试一次，优先遵循 Retry-After，否则短暂退避并加抖动；业务错误、解析错误及 401/403 不重试。

来源聚合有 60 秒时间预算，每次网络请求最多 15 秒且不超过剩余预算；排队后再次检查预算。代理与直连回退共享当前请求的 AbortSignal。前端 AI 规划是单独请求，不属于该来源聚合预算；后端自动扩词也有独立模型超时，因此这不是端到端页面耗时的硬上限。

CNKI 缓存包含数量和年份参数；只缓存通过结构校验的结果，使用副本避免合并评分污染。
异常 envelope、HTML/非法 JSON 或缺失必要集合不再被静默转换成零条。

## 验证

```sh
node --test server/sources.test.js server/sourceExecution.test.js src/sourceStatus.test.js
npm run build
node scripts/source-status-smoke.mjs
```

浏览器 smoke 只启动前端 preview 并 mock 全部 API，不读取个人数据，不请求真实来源。覆盖零结果、部分成功、授权文案、会话恢复、全源失败、请求异常。
离线 fixture 不能确认某次真实 Semantic Scholar/CNKI 请求的网络故障；需结合新搜索详情中的错误分类继续定位。
