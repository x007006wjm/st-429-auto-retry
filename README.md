# 429 Auto Retry (Vertex / API) — TauriTavern / SillyTavern 前端扩展

针对 Google Vertex AI 等渠道频繁遇到 `429 (RESOURCE_EXHAUSTED)` 错误的前端自动重试插件，零外部依赖，兼容 **TauriTavern** 与原版 **SillyTavern**。

## 功能特性
- **自定义最大重试次数**（默认 `5` 次，可在扩展面板 `0-20` 自由调整）
- **智能退避策略**：优先读取上游 `Retry-After` 响应头，否则采用 **指数退避 + ±25% 随机抖动**
- **兼容包装后的 429**：不仅识别 HTTP `429`，也能识别后端将上游 Vertex 429 包装为 500/400 或 JSON 错误体的情况
- **可选重试 502 / 503 / 529**：应对 Vertex 偶发的服务临时过载
- **流式安全**：`200 text/event-stream` 建立后直接放行，不阻塞流式输出
- **支持随时中断**：退避等待期间点击酒馆“停止生成”，立即取消重试
- **可视化统计**：实时显示本次会话的重试次数与恢复成功次数

## 安装方法

### 方式一：本地直接放入目录（最简单）
将整个 `st-429-auto-retry` 文件夹复制到对应扩展目录，然后**重启应用 / 刷新页面**：

- **TauriTavern（全局扩展）**：`data/extensions/third-party/st-429-auto-retry`
- **TauriTavern（当前用户）**：`data/default-user/extensions/st-429-auto-retry`
- **原版 SillyTavern**：`public/scripts/extensions/third-party/st-429-auto-retry`

### 方式二：通过 TauriTavern 内置扩展管理器安装
如果你需要将它同步到手机端（Android / iOS）：
1. 将 `st-429-auto-retry` 文件夹推送到你自己的 GitHub 仓库；
2. 打开 TauriTavern → 顶部 **扩展（Extensions）** → **安装扩展（Install Extension）**，粘贴仓库链接即可。

## 使用说明
安装并重启后，打开 **扩展（Extensions）** 面板，找到 **「429 自动重试 (Vertex / API)」** 折叠栏即可调整参数：
- **最大重试次数**：推荐 `3 ~ 5`
- **基础等待时间**：推荐 `2000 ms`
- **指数退避倍率**：推荐 `2`（即约 2s → 4s → 8s → 16s）
- **仅对 Vertex AI 渠道生效**：如果只希望限制在 Vertex 渠道生效可勾选此项
