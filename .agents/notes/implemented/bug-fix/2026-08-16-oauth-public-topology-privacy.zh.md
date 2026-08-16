# Agent Note: OAuth 公开拓扑隐私

Status: implemented

[English](2026-08-16-oauth-public-topology-privacy.md) | 中文

## 问题

已配置的原生 Codex OAuth profile 在控制器报告 `connected` 前不会注册适配器。公开的 `llm.providers` 会暴露路由活跃状态，公开的 `llm.models` 与 `session.models` 会暴露路由成员身份。因此，公开或受信任的远程读取者可以从目录成员身份或转发的 `llm/adapters-updated` 事件推断私有 OAuth 连接状态。

OAuth 生命周期 RPC 只限回环地址，因为其答复和修改涉及私有账户状态。公开模型目录有意向受信任远程客户端开放，因此不能成为另一种 OAuth 状态读取方式。

## 决策

通用 pi-ai 适配器会注册每个已解析的 profile，包括仅支持 OAuth 的 Codex profile，而不依赖 OAuth 状态。没有 profile 时仍不会注册路由。因此，`llm.providers`、`llm.models` 与 `session.models` 随 profile 配置变化，而不随私有 OAuth 连接状态变化。私有状态转换会发出本地 `llm/oauth-connection-updated` 事件，但不会重新注册适配器或发出公开拓扑更新。

模型页会在回环地址直接读取 `llm.oauthStatus`，而 `providerUsable` 要求 OAuth 连接为 `connected`。未连接的原生 OAuth 请求受到常规请求预检保护，并返回 `OAUTH_RECONNECT_REQUIRED`。这取代了 [OpenAI Codex 订阅 OAuth](../feature/2026-08-16-openai-codex-oauth.md) 中与状态耦合的注册部分。

## 曾考虑的替代方案

**只隐藏 `llm.providers.active`。** 不采用，因为 `llm.models` 与 `session.models` 仍会通过各自的分组成员身份泄露同一条路由。

**从公开目录中隐藏每个已配置 OAuth 路由。** 不采用，因为目录拓扑是正常的受信任远程能力，而且发布路由无需暴露其 OAuth 凭据是否已连接。

**允许受信任远程客户端调用生命周期 RPC。** 不采用，因为状态结果本身就是私有账户状态，而开始、取消和断开连接都会修改持久凭据。

## 后果

已配置但未连接的 OAuth profile 会提供公开 catalog 元数据，它会暴露 profile 存在但不会暴露连接或授权状态。模型页会保持不可用，直至回环地址状态为 `connected`，直接原生请求在此前会稳定失败。

受信任远程客户端可以使用与回环客户端相同的提供方和模型目录，但生命周期 RPC 仍被拒绝。连接转换不再导致公开目录变化，因此模型选择器无法从成员身份或事件时序获知凭据状态。

## 验证

pi-ai 动态配置套件证明，已配置 OAuth 路由会跨同级进程凭据和租约转换保持注册，且不会发出 `llm/adapters-updated` 事件。catalog 与 Host 测试固定了由 profile 驱动的提供方和模型成员身份，公开提供方结果中不包含 OAuth 状态。client-connection Host 测试会对比回环地址与受信任远程目录答复，并证明受信任远程客户端调用 `llm.oauthStatus` 会收到 `403`。组装的 Web OAuth 场景会在连接完成前观察 Codex 模型组，并在私有状态转换后保留它。
