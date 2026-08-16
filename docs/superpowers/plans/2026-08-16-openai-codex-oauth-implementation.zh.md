# OpenAI Codex 订阅 OAuth 实施计划

[English](2026-08-16-openai-codex-oauth-implementation.md) | 中文

> **面向代理执行者：** 必须使用子技能：使用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans` 按任务逐项实施本计划。步骤使用复选框（`- [ ]`）语法跟踪。

**目标：** 让 Harness 用户通过设备代码 OAuth 连接 ChatGPT/Codex 订阅，并将目录中的 `openai-codex` 模型作为普通主模型使用。

**架构：** 以宿主拥有的持久 pi-ai `CredentialStore` 和受租约保护的 OAuth 控制器扩展现有 pi-ai 适配器；不引入 Codex app-server 模型运行时。为 LLM 能力层加入与提供商无关的认证元数据和 OAuth 控制器注册表，再仅通过宿主 API 和专用 Models 卡片暴露经过脱敏的状态。

**技术栈：** TypeScript、Cordis 服务和事件、`@earendil-works/pi-ai` 0.82.1、Zod/RPC schema、React 设置 UI、Vitest、Playwright Web fixture、基于 Mermaid 的设计文档。

**规范：** [OpenAI Codex 订阅 OAuth 设计](../specs/2026-08-16-openai-codex-oauth-design.md)

## 全局约束

- 使用 pi-ai 原生 `openai-codex` OAuth 路径；现有 `subagent-codex` 提供商仍是独立的可选子代理集成。
- 仅使用设备代码登录：宿主交互选择 pi-ai 的 `device_code` 选项，并拒绝所有文本、密钥、手动代码和浏览器回调提示。
- 不得让访问令牌、刷新令牌、授权载荷、账户身份、套餐数据、私有凭据引用名或原始提供商失败信息进入设置、浏览器 RPC、会话事件、诊断、日志或快照。
- 在固定私有引用 `DSH_OPENAI_CODEX_OAUTH` 和 `DSH_OPENAI_CODEX_LOGIN_LEASE` 下存储 OAuth 记录和登录租约；二者均不可配置也不可显示。
- 在每次异步 OAuth 记录或租约变更期间持有本地凭据提供商的跨进程锁；不得加入面向浏览器的通用凭据变更 RPC。
- 私有凭据变更不得发出 `credentials/updated`，因为该事件会将其引用名送达浏览器客户端。它只发出不带 payload、仅供 Host 使用的 `credentials/private-updated`，OAuth 状态则不出现在公开目录或转发给浏览器的事件中。
- OAuth 目录行在 dormant 时仍保持可见；模型路由仅在 OAuth 配置已连接，或已有配置显式命名 `apiKeyEnv` 后才变为 active。
- `openai-codex` 可以使用已经存在的、显式配置 `apiKeyEnv` 的旧配置；但原生 OAuth 配置在 OAuth 刷新失败或被撤销后，绝不能回退到 API key、环境变量或另一提供商。
- 无头配置不能启动交互式登录。它只能使用存储在同一 Harness home 中的成功连接。
- 将租约超时作为经过验证的 `llm-pi-ai` 配置，而非隐藏常量。按该配置超时的确定比例续约。
- 对 Codex 支持的请求，继续由普通 Harness 模型选择、会话历史、工具执行、重试行为和推理强度控制保持权威。

---

## 范围检查

凭据、LLM、宿主和 UI 变更是一条依赖链，而不是独立项目：在持久存储和经过脱敏的运行时生命周期存在之前，UI 不能安全地暴露登录；在二者均存在之前，适配器也不能服务 OAuth 配置。下列每项任务仍以可单独测试的交付物和提交结束。

## 文件结构

- 修改 `packages/credentials/credentials/src/index.ts` 和 `packages/credentials/credentials/src/types.ts`，定义具备原子性和可见性意识的凭据变更服务操作。
- 修改 `packages/credentials/credentials-local/src/index.ts`，使该操作在现有队列和跨进程文件锁下运行，同时仅为私有变更发布不带 payload、仅供 Host 使用的失效通知。
- 修改 `packages/llm/llm/src/{types.ts,index.ts,error.ts}`，声明提供商认证元数据、OAuth 连接类型、控制器注册表、经过脱敏的 LLM 事件和 reconnect-required 错误代码。
- 创建 `packages/llm/llm-pi-ai/src/{oauth-credential-store}.ts`，以私有 OAuth 记录实现 pi-ai 的 `CredentialStore`。
- 创建 `packages/llm/llm-pi-ai/src/{openai-codex-oauth}.ts`，负责设备代码交互、会过期的登录租约、取消、状态和脱敏。
- 修改 `packages/llm/llm-pi-ai/src/{adapter,index,catalog,provider,config}.ts`，为每个 pi-ai 模型快照提供共享存储、注册控制器、公布 `openai-codex`，并规范化 OAuth 请求失败。
- 修改 `packages/host/apiproxy/src/api/{llm.ts,llm.schema.ts,index.ts,rpc-map.ts}` 和 `packages/host/apiproxy/src/{api-proxy.ts,fetch/client.ts,fetch/handler.ts}`，仅承载类型化的脱敏 OAuth 操作和连接视图。
- 修改 `packages/api/remotes/src/remote-events.ts` 及其客户端导出，使私有凭据失效通知与 OAuth 连接状态均不会到达浏览器客户端；Models 在公开拓扑更新后读取本地生命周期状态。
- 修改 `packages/client/ui-settings-models/src/client/{store.ts,ModelsSection.tsx,index.ts,locales.ts}` 并创建 `OAuthProviderCard.tsx`，实现设备代码卡片和认证感知的提供商就绪状态。
- 在现有测试套件旁添加聚焦单元、宿主载体、客户端组件、加载器组合和无密钥 Web 测试；仅向快照添加确定性 fixture 记录。
- 更新配对的包、子系统和用户文档，以及非简单功能所需的 Agent Note。

未来文件名使用 `{literal-name}`，仅用于将尚未创建的目标与当前仓库路径区分；创建时使用不带花括号的字面文件名。

### Task 1: 添加原子私有凭据变更

**文件：**
- 修改：`packages/credentials/credentials/src/index.ts`
- 修改：`packages/credentials/credentials/src/types.ts`
- 修改：`packages/credentials/credentials/tests/credentials.spec.ts`
- 修改：`packages/credentials/credentials/tests/memory.ts`
- 修改：`packages/credentials/credentials-local/src/index.ts`
- 修改：`packages/credentials/credentials-local/tests/local.spec.ts`
- 修改：`packages/credentials/credentials-local/tests/review-fixes.spec.ts`

**接口：**
- 产出供宿主侧消费者使用的 `CredentialMutation<T>`、`CredentialMutationVisibility` 和 `CredentialProvider.modify<T>(ref, mutate)`。
- 产出本地提供商对 `set`、`unset` 和 `modify` 的序列化，它们通过一条队列和文件锁变更路径执行。
- 产出不变量：只有已变更的 `public` 变更才会发出 `credentials/updated`。

- [ ] **步骤 1：编写针对已序列化 public 和 private 变更的失败服务与本地提供商测试。**

  ```text
  const result = await provider.modify(ref, async current => ({
    value: current === undefined ? 'rotated-secret' : undefined,
    result: current,
    visibility: 'private',
  }))

  expect(result).toBeUndefined()
  expect(updated).toEqual([])
  expect((await provider.resolve(ref))?.value).toBe('rotated-secret')
  ```

  添加成对测试：两个 `LocalCredentialProvider` 实例共享一个文档，第一个回调保持 pending，第二个读到第一个已提交的值；已变更的 `public` 变更恰好发出一个事件。加入被拒绝的回调、未变更值、环境遮蔽和释放场景。

- [ ] **步骤 2：运行新的凭据测试并确认缺失操作会失败。**

  Run: `pnpm exec vitest run packages/credentials/credentials/tests/credentials.spec.ts packages/credentials/credentials-local/tests/local.spec.ts packages/credentials/credentials-local/tests/review-fixes.spec.ts`

  Expected: FAIL because `CredentialProvider.modify` and the local implementation do not exist.

- [ ] **步骤 3：定义服务级变更结果和抽象操作。**

  ```text
  export type CredentialMutationVisibility = 'public' | 'private'

  export interface CredentialMutation<T> {
    value: string | undefined
    result: T
    visibility: CredentialMutationVisibility
  }

  abstract modify<T>(
    ref: CredentialRef,
    mutate: (current: string | undefined) => Promise<CredentialMutation<T>>,
  ): Promise<T>
  ```

  从凭据包现有公开类型表面导出新类型，说明 `current` 是提供商管理的存储值而不是继承的环境值，并说明调用方必须让私有引用只留在宿主侧。

- [ ] **步骤 4：将本地提供商重构为一条加锁变更原语。**

  ```text
  private async mutate<T>(
    ref: CredentialRef,
    mutate: (current: string | undefined) => Promise<CredentialMutation<T>>,
  ): Promise<T> {
    return this.operations.run(async () => withFileLock(this.lockPath, async () => {
      const document = await this.reconcileFromDisk()
      this.assertUnshadowed(ref, document)
      const before = document.values[ref]
      const mutation = await mutate(document.values[ref])
      await this.commitMutation(document, ref, mutation.value)
      if (mutation.visibility === 'public' && before !== mutation.value) this.notifyUpdated(ref)
      return mutation.result
    }))
  }
  ```

  将 `set` 和 `unset` 作为 `public` 变更经由该原语执行。保留仅所有者可读的原子写入、加锁后重新读取、不变更写入和既有错误类别。在提交前捕获变更前的值，以便事件比较正确。

- [ ] **步骤 5：更新内存测试提供商并运行聚焦凭据套件。**

  Run: `pnpm exec vitest run packages/credentials/credentials/tests/credentials.spec.ts packages/credentials/credentials-local/tests/local.spec.ts packages/credentials/credentials-local/tests/review-fixes.spec.ts`

  Expected: PASS, including cross-instance read-modify-write serialization and no event for private or unchanged mutations.

- [ ] **步骤 6：提交凭据基础。**

  ```bash
  git add packages/credentials/credentials/src/index.ts packages/credentials/credentials/src/types.ts packages/credentials/credentials/tests/credentials.spec.ts packages/credentials/credentials/tests/memory.ts packages/credentials/credentials-local/src/index.ts packages/credentials/credentials-local/tests/local.spec.ts packages/credentials/credentials-local/tests/review-fixes.spec.ts
  git commit -m "feat(credentials): add atomic private mutation"
  ```

### Task 2: 以脱敏 OAuth 生命周期类型扩展 LLM 能力层

**文件：**
- 修改：`packages/llm/llm/src/types.ts`
- 修改：`packages/llm/llm/src/index.ts`
- 修改：`packages/llm/llm/src/error.ts`
- 修改：`packages/llm/llm/tests/service.spec.ts`
- 修改：`packages/llm/llm/tests/topology.spec.ts`
- 修改：`packages/llm/llm/tests/adapter-failure.spec.ts`

**接口：**
- 仅间接通过后续适配器代码使用 `CredentialProvider.modify`；此任务没有凭据包导入。
- 产出必需的 `LlmConfigurableProvider.auth` 元数据和由 `llm-pi-ai` 与宿主代理使用的 `LlmOAuthController` 注册 API。
- 产出 `llm/oauth-connection-updated` 事件，其载荷不含设备代码和任何凭据材料。

- [ ] **步骤 1：编写针对认证元数据、控制器注册、释放和脱敏更新的失败 LLM 运行时测试。**

  ```text
  const dispose = runtime.registerOAuthController(controller)

  expect(runtime.getOAuthController('openai-codex')).toBe(controller)
  runtime.emitOAuthConnectionUpdated({ provider: 'openai-codex', status: 'connected' })
  expect(events).toEqual([{ provider: 'openai-codex', status: 'connected' }])
  dispose()
  expect(runtime.getOAuthController('openai-codex')).toBeUndefined()
  ```

  覆盖重复提供商 id、空 id、无效连接状态、注册释放，以及缺少 `auth` 的目录条目。

- [ ] **步骤 2：运行 LLM 服务测试并确认新的生命周期表面尚不存在。**

  Run: `pnpm exec vitest run packages/llm/llm/tests/service.spec.ts packages/llm/llm/tests/topology.spec.ts`

  Expected: FAIL because configurable providers have no authentication metadata and `LlmRuntime` has no OAuth-controller registry.

- [ ] **步骤 3：将提供商和连接类型加入 LLM 服务定义。**

  ```text
  export type LlmProviderAuth =
    | { kind: 'api-key' }
    | { kind: 'oauth' }
    | { kind: 'native' }

  export type LlmOAuthConnectionStatus = 'missing' | 'connecting' | 'connected' | 'reconnect-required'

  export interface LlmOAuthConnection {
    provider: string
    status: LlmOAuthConnectionStatus
  }

  export interface LlmOAuthDeviceCode {
    verificationUri: string
    userCode: string
    intervalSeconds?: number
    expiresInSeconds?: number
  }

  export type LlmOAuthStart =
    | { kind: 'device-code'; connection: LlmOAuthConnection; deviceCode: LlmOAuthDeviceCode }
    | { kind: 'already-connecting'; connection: LlmOAuthConnection }
    | { kind: 'connected'; connection: LlmOAuthConnection }

  export interface LlmOAuthController {
    readonly provider: string
    status(): Promise<LlmOAuthConnection>
    start(): Promise<LlmOAuthStart>
    cancel(): Promise<LlmOAuthConnection>
    disconnect(): Promise<LlmOAuthConnection>
  }
  ```

  使 `LlmConfigurableProvider.auth: LlmProviderAuth` 成为必填项。从 `error.ts` 导出 `OAUTH_RECONNECT_REQUIRED_CODE = 'OAUTH_RECONNECT_REQUIRED'`，并扩展失败测试，使请求可按该代码路由，而无需解析提供商消息。

- [ ] **步骤 4：在 `LlmRuntime` 中实现注册表和脱敏事件。**

  ```text
  registerOAuthController(controller: LlmOAuthController): () => void
  getOAuthController(provider: string): LlmOAuthController | undefined
  emitOAuthConnectionUpdated(connection: LlmOAuthConnection): void
  ```

  在注册时验证提供商标识符和控制器所有权，使用 `ctx.effect()` 绑定释放器，从公开读取返回分离的连接数据，并以载荷文档声明类型化 Cordis 事件。不要在此包中加入通用登录端点。

- [ ] **步骤 5：使用显式认证元数据更新所有现有可配置提供商 fixture 并运行聚焦测试。**

  Run: `pnpm exec vitest run packages/llm/llm/tests/service.spec.ts packages/llm/llm/tests/topology.spec.ts`

  Expected: PASS, including rejected duplicate controllers and an event payload containing only provider and status.

- [ ] **步骤 6：提交与提供商无关的 OAuth 能力层。**

  ```bash
  git add packages/llm/llm/src/types.ts packages/llm/llm/src/index.ts packages/llm/llm/src/error.ts packages/llm/llm/tests/service.spec.ts packages/llm/llm/tests/topology.spec.ts packages/llm/llm/tests/adapter-failure.spec.ts
  git commit -m "feat(llm): add OAuth provider lifecycle"
  ```

### Task 3: 实现 pi-ai OAuth 存储、租约控制器和路由

**文件：**
- 创建：`packages/llm/llm-pi-ai/src/{oauth-credential-store}.ts`
- 创建：`packages/llm/llm-pi-ai/src/{openai-codex-oauth}.ts`
- 修改：`packages/llm/llm-pi-ai/src/adapter.ts`
- 修改：`packages/llm/llm-pi-ai/src/index.ts`
- 修改：`packages/llm/llm-pi-ai/src/catalog.ts`
- 修改：`packages/llm/llm-pi-ai/src/provider.ts`
- 修改：`packages/llm/llm-pi-ai/src/config.ts`
- 修改：`packages/llm/llm-pi-ai/tests/{adapter.spec.ts,catalog.spec.ts,config.spec.ts,dynamic-config.spec.ts,loader-composition.spec.ts}`
- 创建：`packages/llm/llm-pi-ai/tests/{oauth-credential-store}.spec.ts`
- 创建：`packages/llm/llm-pi-ai/tests/{openai-codex-oauth}.spec.ts`

**接口：**
- 使用 `CredentialProvider.modify`、`LlmOAuthController`、`LlmOAuthStart` 和 `LlmRuntime.emitOAuthConnectionUpdated`。
- 产出 `OpenAICodexCredentialStore`、`OpenAICodexOAuthController` 和稳定的 `PiAiAdapter` 凭据存储选项，由每个不可变模型快照共享。
- 产出经 OAuth 认证的 `openai-codex` 目录条目，以及被撤销或刷新失败凭据的 `OAUTH_RECONNECT_REQUIRED_CODE` LLM 失败。

- [ ] **步骤 1：针对假的 pi-ai `Models` 实现编写失败的存储和控制器测试。**

  ```text
  await controller.start()
  expect(interaction.prompt).toHaveBeenCalledWith(expect.objectContaining({ type: 'select' }))
  expect(await store.read('openai-codex')).toBeUndefined()

  interaction.notify({
    type: 'device_code',
    verificationUri: 'https://auth.openai.com/codex/device',
    userCode: 'ABCD-EFGH',
    intervalSeconds: 5,
    expiresInSeconds: 900,
  })
  expect(await controller.status()).toEqual({ provider: 'openai-codex', status: 'connecting' })
  ```

  覆盖设备代码选择、两个控制器之间唯一的活动租约、租约续约和过期接管、取消、有序释放、格式错误的存储 JSON、环境遮蔽、凭据存储刷新序列化、成功登录持久化、注销，以及每个已发出状态的脱敏。

- [ ] **步骤 2：运行新的 pi-ai 测试并确认存储和控制器模块尚不存在。**

  Run: `pnpm exec vitest run packages/llm/llm-pi-ai/tests/{oauth-credential-store.spec.ts,openai-codex-oauth.spec.ts} packages/llm/llm-pi-ai/tests/catalog.spec.ts`

  Expected: FAIL because neither private record persistence nor a controller can start pi-ai login.

- [ ] **步骤 3：在固定私有引用上实现凭据存储编解码器。**

  ```text
  export const OPENAI_CODEX_OAUTH_REF = credentialRef('DSH_OPENAI_CODEX_OAUTH')
  export const OPENAI_CODEX_LOGIN_LEASE_REF = credentialRef('DSH_OPENAI_CODEX_LOGIN_LEASE')

  type StoredOAuthRecord = { version: 1; credential: OAuthCredential }
  type StoredLoginLease = { version: 1; ownerId: string; state: 'pending'; expiresAt: number }

  class OpenAICodexCredentialStore implements CredentialStore {
    read(providerId: string): Promise<Credential | undefined>
    list(): Promise<readonly CredentialInfo[]>
    modify(providerId: string, fn: (current: Credential | undefined) => Promise<Credential | undefined>): Promise<Credential | undefined>
    delete(providerId: string): Promise<void>
  }
  ```

  仅接受 `openai-codex`，在返回前 JSON 解析并检查记录版本，拒绝 `type` 不为 `'oauth'` 的存储或拟议凭据，让每次写入都经由 `credentials.modify(... visibility: 'private')`，并将格式错误或不可读数据转为包内脱敏认证失败。不要从公开方法暴露私有引用。

- [ ] **步骤 4：实现设备代码控制器和跨进程租约生命周期。**

  ```text
  class OpenAICodexOAuthController implements LlmOAuthController {
    readonly provider = 'openai-codex'
    status(): Promise<LlmOAuthConnection>
    start(): Promise<LlmOAuthStart>
    cancel(): Promise<LlmOAuthConnection>
    disconnect(): Promise<LlmOAuthConnection>
    markReconnectRequired(): void
  }
  ```

  在启动轮询器前原子认领私有租约。向 pi-ai 提供一个 `AuthInteraction`：其 `prompt()` 只为受支持的选择提示返回 `'device_code'`，并拒绝其他提示；其 `notify()` 只将当前设备代码字段保留在宿主内存中；其 `signal` 是控制器拥有的 abort signal。在每个轮询间隔前续约，仅在 `finally` 中释放相同所有者的租约，在有序释放时取消并释放；当另一个存活所有者持有租约时返回 `already-connecting` 而非第二个代码。取消、过期和提供商登录失败会清除 pending 代码，释放已拥有的租约；若不存在保存记录则发布 `missing`，若保存记录无法认证则发布 `reconnect-required`。仅通过 LLM 事件发出 `{ provider, status }`。

- [ ] **步骤 5：将共享存储接入 pi-ai 快照并注册路由。**

  ```text
  const models: MutableModels = createModels({ credentials: this.config.credentials })

  ctx.llm.registerOAuthController(openaiCodexOAuth)
  ```

  在保留每个配置快照不可变模型集合的同时，为宿主插件生命周期保持一个存储实例和一个控制器。将目录条目标记为 `{ kind: 'api-key' }`、`{ kind: 'oauth' }` 或 `{ kind: 'native' }`；将 `openai-codex` 作为 OAuth 能力而非过滤掉。仅当其配置有显式 `apiKeyEnv` 或控制器报告 `connected` 时注册 `openai-codex` 适配器路由；否则保持目录条目 dormant，并在每次脱敏控制器转换后刷新适配器注册。为控制器提供完整配置的 `Models` factory，使其能在主路由 dormant 时登录。绝不能为原生 OAuth 配置传递 API-key 覆盖。捕获适配器中的 pi-ai OAuth 刷新失败，调用 `markReconnectRequired()`，并抛出带 `OAUTH_RECONNECT_REQUIRED_CODE` 的 `LlmError`，而不记录提供商载荷。

- [ ] **步骤 6：加入经过验证的租约超时配置和动态重载覆盖。**

  ```text
  oauth: {
    loginLeaseTtlMs: 30_000,
  }
  ```

  添加正数且有边界的 schema 值，用于租约过期和续约调度，并证明配置重载会保留存储和控制器状态，仅替换不可变模型快照。从私有记录异步初始化控制器，并在读取完成后刷新注册。更新目录测试：`openai-codex` 在存在可用配置前作为 dormant 出现，仅在已连接 OAuth 配置或显式旧 `apiKeyEnv` 配置已解析后 active。

- [ ] **步骤 7：运行聚焦 pi-ai 套件。**

  Run: `pnpm exec vitest run packages/llm/llm-pi-ai/tests/{oauth-credential-store.spec.ts,openai-codex-oauth.spec.ts} packages/llm/llm-pi-ai/tests/adapter.spec.ts packages/llm/llm-pi-ai/tests/catalog.spec.ts packages/llm/llm-pi-ai/tests/config.spec.ts packages/llm/llm-pi-ai/tests/dynamic-config.spec.ts packages/llm/llm-pi-ai/tests/loader-composition.spec.ts`

  Expected: PASS, with no network request and no token, private reference, or raw pi-ai message in assertions.

- [ ] **步骤 8：提交 pi-ai OAuth 实现。**

  ```bash
  git add packages/llm/llm-pi-ai/src packages/llm/llm-pi-ai/tests
  git commit -m "feat(llm-pi-ai): support Codex OAuth"
  ```

### Task 4: 添加脱敏宿主 RPC 和远程事件传输

**文件：**
- 修改：`packages/host/apiproxy/src/api/llm.ts`
- 修改：`packages/host/apiproxy/src/api/llm.schema.ts`
- 修改：`packages/host/apiproxy/src/api/{index.ts,rpc-map.ts}`
- 修改：`packages/host/apiproxy/src/{api-proxy.ts,fetch/client.ts,fetch/handler.ts}`
- 修改：`packages/api/remotes/src/{remote-events.ts,index.ts}`
- 修改：`packages/host/apiproxy/tests/{api-proxy-models.spec.ts,api-proxy-config.spec.ts,rpc-schemas.spec.ts,client-handler.spec.ts,fetch-carrier.spec.ts}`
- 修改：`packages/client/connection/tests/fake-api.client.ts`
- 修改：`packages/client/connection/src/client/fixture.ts`

**接口：**
- 使用 LLM 能力层中的 `LlmOAuthController`、`LlmOAuthConnection` 和 `LlmOAuthStart`。
- 产出 `ConfigurableProviderView.auth`、`ConfigurableProviderView.connection`、`llm.oauthStart`、`llm.oauthStatus`、`llm.oauthCancel` 和 `llm.oauthDisconnect`。
- 让 `llm/oauth-connection-updated` 保持 Host 内部事件；仅直接的仅限回环地址生命周期答复携带脱敏连接视图。

- [ ] **步骤 1：编写 schema 和载体测试，断言精确公开字段。**

  ```text
  expect(await api.llm.oauthStart({ provider: 'openai-codex' })).toEqual({
    connection: { provider: 'openai-codex', status: 'connecting' },
    start: {
      kind: 'device-code',
      deviceCode: {
        verificationUri: 'https://auth.openai.com/codex/device',
        userCode: 'ABCD-EFGH',
        intervalSeconds: 5,
        expiresInSeconds: 900,
      },
    },
  })
  ```

  断言每个响应、事件、假客户端和 JSON schema 都会拒绝或省略 `access`、`refresh`、`accountId`、租约或引用名、提供商错误文本和任意 OAuth 提供商 id。

- [ ] **步骤 2：运行选定宿主载体测试并确认 RPC 方法尚不存在。**

  Run: `pnpm exec vitest run packages/host/apiproxy/tests/api-proxy-models.spec.ts packages/host/apiproxy/tests/api-proxy-config.spec.ts packages/host/apiproxy/tests/rpc-schemas.spec.ts packages/host/apiproxy/tests/client-handler.spec.ts packages/host/apiproxy/tests/fetch-carrier.spec.ts`

  Expected: FAIL because the public LLM API has no OAuth operation or redacted connection field.

- [ ] **步骤 3：使用刻意收窄的设备代码结果定义 wire 视图和 Zod schema。**

  ```text
  interface OAuthConnectionView {
    provider: string
    status: 'missing' | 'connecting' | 'connected' | 'reconnect-required'
  }

  interface OAuthStartView {
    connection: OAuthConnectionView
    start: LlmOAuthStart
  }
  ```

  将 `auth` 加入 `ConfigurableProviderView`；把连接状态保留在直接的仅限回环地址生命周期答复中。将 `verificationUri` 验证为 URL，将代码字符串验证为非空且有界文本，并将间隔和过期时间验证为正整数。仅在直接 start 响应中保留设备代码字段；不得将其加入提供商快照或远程事件。

- [ ] **步骤 4：分派四个宿主方法并净化失败。**

  ```text
  llm.oauthStart({ provider })
  llm.oauthStatus({ provider })
  llm.oauthCancel({ provider })
  llm.oauthDisconnect({ provider })
  ```

  从 `ctx.llm` 解析控制器，拒绝未知提供商和非 OAuth 路由，将包错误映射到稳定且面向操作的消息，并使用控制器返回的连接作为唯一状态响应。让 `llm/oauth-connection-updated` 保持 Host 内部事件，绝不在代理中按私有名称作特殊处理。

- [ ] **步骤 5：扩展 fetch handler、生成的 API map、假客户端和 fixture 传输。**

  ```text
  'llm.oauthStart': request => api.llm.oauthStart(request)
  'llm.oauthStatus': request => api.llm.oauthStatus(request)
  'llm.oauthCancel': request => api.llm.oauthCancel(request)
  'llm.oauthDisconnect': request => api.llm.oauthDisconnect(request)
  ```

  在 `rpc-map`、`fetch/client`、`fetch/handler`、测试客户端和 fixture 请求 switch 中按相同请求和响应顺序加入方法。将新事件加入显式远程事件 allowlist。

- [ ] **步骤 6：运行聚焦宿主和传输测试。**

  Run: `pnpm exec vitest run packages/host/apiproxy/tests/api-proxy-models.spec.ts packages/host/apiproxy/tests/api-proxy-config.spec.ts packages/host/apiproxy/tests/rpc-schemas.spec.ts packages/host/apiproxy/tests/client-handler.spec.ts packages/host/apiproxy/tests/fetch-carrier.spec.ts`

  Expected: PASS, including the proof that a standard credential update cannot be used to disclose OAuth private-reference activity.

- [ ] **步骤 7：提交宿主和远程传输。**

  ```bash
  git add packages/host/apiproxy/src packages/host/apiproxy/tests packages/api/remotes/src packages/client/connection/tests/fake-api.client.ts packages/client/connection/src/client/fixture.ts
  git commit -m "feat(host): expose redacted Codex OAuth state"
  ```

### Task 5: 构建 Models OAuth 卡片和就绪状态行为

**文件：**
- 创建：`packages/client/ui-settings-models/src/client/{OAuthProviderCard}.tsx`
- 修改：`packages/client/ui-settings-models/src/client/{store.ts,ModelsSection.tsx,index.ts,locales.ts}`
- 修改：`packages/client/ui-settings-models/src/client/ModelsSection.module.css`
- 修改：`packages/client/ui-settings-models/tests/{store.client.spec.ts,components.client.spec.tsx,provider-form.client.spec.tsx,readiness.client.spec.ts}`

**接口：**
- 使用 `ConfigurableProviderView.auth`、`ConfigurableProviderView.connection` 和四个 `api.llm.oauth*` 方法。
- 产出 OAuth 专用卡片，其临时设备代码展示为组件本地状态，其持久页面状态为脱敏提供商快照。
- 产出 `providerUsable(row)` 行为：OAuth 需要已连接的连接，API key 需要已配置的命名 key，native 需要 active 路由。

- [ ] **步骤 1：为每个卡片状态和变更顺序编写失败的 store 与组件测试。**

  ```tsx
  await user.click(screen.getByRole('button', { name: 'Connect ChatGPT' }))
  expect(api.settings.mutate).toHaveBeenCalledWith(expect.objectContaining({
    path: ['providers', 'openai-codex'],
    value: {},
  }))
  expect(api.llm.oauthStart).toHaveBeenCalledWith({ provider: 'openai-codex' })
  expect(screen.getByText('ABCD-EFGH')).toBeVisible()
  expect(screen.queryByLabelText(/API key/i)).toBeNull()
  ```

  覆盖 Connect、Connecting、Connected、Reconnect、Cancel、Disconnect、Remove provider、成功 disconnect 后失败的 remove、拓扑更新后的本地状态重载，以及旧显式 `apiKeyEnv` 就绪状态但不渲染 OAuth API-key 输入。

- [ ] **步骤 2：运行 Models UI 测试并确认尚无 OAuth 编辑器。**

  Run: `pnpm exec vitest run packages/client/ui-settings-models/tests/store.client.spec.ts packages/client/ui-settings-models/tests/components.client.spec.tsx packages/client/ui-settings-models/tests/provider-form.client.spec.tsx packages/client/ui-settings-models/tests/readiness.client.spec.ts`

  Expected: FAIL because `ProviderEditor` is API-key-only and the store treats a reference-free active route as usable.

- [ ] **步骤 3：使 store 具备认证感知能力，同时不查询私有凭据。**

  ```text
  export function providerUsable(row: ProviderRow): boolean {
    if (!row.entry.active) return false
    if (row.entry.auth.kind === 'oauth') {
      return row.connection?.status === 'connected'
        || (row.apiKeyEnv !== undefined && row.credential?.configured === true)
    }
    if (row.entry.auth.kind === 'api-key') return row.apiKeyEnv === undefined || row.credential?.configured === true
    return true
  }
  ```

  仅为命名的配置 API-key 引用请求 `credentials.describe`。从 `llm.providers` 复制 `auth`，并从仅限回环地址的 `llm.oauthStatus` 关联 `connection`；绝不从凭据 badge 或 OAuth 记录引用推导 OAuth 状态。

- [ ] **步骤 4：加入包含安全浏览器操作和复制功能的专用卡片。**

  ```tsx
  <a href={deviceCode.verificationUri} target="_blank" rel="noreferrer">
    Open verification page
  </a>
  <button onClick={() => void navigator.clipboard.writeText(deviceCode.userCode)}>
    Copy code
  </button>
  ```

  从本地关联的类型化连接视图渲染 `Connect ChatGPT`、`Connecting`、`Connected`、`Reconnect`、`Cancel` 和 `Disconnect`。在直接 `oauthStart` 响应后仅将 URL 和代码保留在本地组件状态，在取消、disconnect、卸载或终态状态刷新后清除它们，并使用普通安全链接而不是加入宿主 URL 打开 RPC。

- [ ] **步骤 5：接入配置创建、重新连接、断开、移除和事件失效。**

  ```text
  await api.settings.mutate({ ns, path: ['providers', 'openai-codex'], value: {} })
  await api.llm.oauthStart({ provider: 'openai-codex' })
  await api.llm.oauthDisconnect({ provider: 'openai-codex' })
  await removeProviderProfile('openai-codex')
  ```

  在 start 前创建或保留空配置。移除时，先 await disconnect，再执行现有配置移除；第二步失败时显示仍已配置但已断开的结果。除当前设置失效器外还订阅公开的 `llm/adapters-updated`，再本地读取 OAuth 状态，并保持普通 `ProviderEditor` API-key 行为不变。

- [ ] **步骤 6：运行聚焦 Models UI 测试。**

  Run: `pnpm exec vitest run packages/client/ui-settings-models/tests/store.client.spec.ts packages/client/ui-settings-models/tests/components.client.spec.tsx packages/client/ui-settings-models/tests/provider-form.client.spec.tsx packages/client/ui-settings-models/tests/readiness.client.spec.ts`

  Expected: PASS, including a visible device code only during the active page-owned start response and no leaked account, token, or provider-error field.

- [ ] **步骤 7：提交 Models UI。**

  ```bash
  git add packages/client/ui-settings-models/src packages/client/ui-settings-models/tests
  git commit -m "feat(models): add Codex OAuth connection card"
  ```

### Task 6: 证明选择器、默认值、配置组合和完整 Web 行为

**文件：**
- 修改：`packages/host/apiproxy/tests/api-proxy-models.spec.ts`
- 修改：`packages/client/ui-model-selection/tests/model-select.client.spec.tsx`
- 修改：`packages/llm/llm-pi-ai/tests/loader-composition.spec.ts`
- 创建：`apps/web/tests/openai-codex-oauth.e2e.ts`
- 创建：`apps/web/tests/snapshots/openai-codex-oauth/flow.expected.md`
- 修改：`apps/web/tests/scaffold.ts`
- 修改：`apps/web/tests/README.md`
- 修改：`apps/web/tests/README.zh.md`
- 修改：`apps/web/tests/README.i18n.yaml`

**接口：**
- 使用已连接 OAuth 提供商条目、普通 `session.models` 和 `session.selectModel` API，以及经过脱敏的 Models UI API。
- 产出无密钥、确定性的证明：提供商仅在已连接时才可选择，并且选择保留现有默认值、每会话和推理行为。
- 产出真实 base-plus-headless 组合测试，证明保存的 OAuth 可在不进行交互式无头登录的情况下使用。

- [ ] **步骤 1：编写失败的模型选择和组合测试。**

  ```text
  expect(await api.session.models({ sessionId })).toEqual(expect.objectContaining({
    groups: [expect.objectContaining({ provider: 'openai-codex' })],
  }))

  await api.session.selectModel({
    sessionId,
    provider: 'openai-codex',
    model: 'gpt-5.4',
    reasoningEffort: 'high',
  })
  ```

  断言断开连接的路由不能被选择，已连接路由出现在普通选择器中，默认选择通过现有设置路径保持，每会话覆盖仍限定在该会话，并且无头组合不会调用 OAuth-start 方法。

- [ ] **步骤 2：运行聚焦选择器和组合测试并确认它们尚不了解 OAuth 就绪状态。**

  Run: `pnpm exec vitest run packages/host/apiproxy/tests/api-proxy-models.spec.ts packages/client/ui-model-selection/tests/model-select.client.spec.tsx packages/llm/llm-pi-ai/tests/loader-composition.spec.ts`

  Expected: FAIL because the OAuth route is absent after a completed connection or treated as selectable before one.

- [ ] **步骤 3：保留现有已注册路由选择门，并证明其 OAuth 状态转换。**

  ```text
  expect(await api.session.models({ sessionId })).not.toEqual(expect.objectContaining({
    groups: [expect.objectContaining({ provider: 'openai-codex' })],
  }))

  await fixture.completeOAuthLogin('openai-codex')
  await vi.waitFor(async () => {
    expect(await api.session.models({ sessionId })).toEqual(expect.objectContaining({
      groups: [expect.objectContaining({ provider: 'openai-codex' })],
    }))
  })
  ```

  不要加入平行的仅客户端选择保护：Task 3 中的适配器注册让断开连接的 OAuth 配置保持未注册，因此现有 `resolveCallConfig` 会拒绝它。保留 pi-ai 目录模型 id 和推理元数据；不得硬编码 Codex 模型列表。

- [ ] **步骤 4：加入确定性的完整 Web OAuth 场景和 ARIA golden。**

  ```text
  await page.getByRole('button', { name: 'Connect ChatGPT' }).click()
  await expect(page.getByText('ABCD-EFGH')).toBeVisible()
  await fixture.completeOAuthLogin('openai-codex')
  await expect(page.getByRole('button', { name: /Connected/ })).toBeVisible()
  ```

  使用返回固定验证 URL 和代码、仅在测试请求完成时推进、并发出脱敏连接事件的假控制器扩展 Web scaffold。在一个无密钥预期 Markdown 快照中捕获 Models 卡片、选择器、默认选择和每会话选择；断言输出不含令牌形式的值、私有引用名或原始提供商错误。

- [ ] **步骤 5：运行完整 Web 检查并仅记录确定性 golden。**

  Run: `pnpm run test:web:built -- apps/web/tests/openai-codex-oauth.e2e.ts`

  Expected: PASS, with the checked-in ARIA snapshot showing the complete redacted flow.

- [ ] **步骤 6：提交集成覆盖。**

  ```bash
  git add packages/host/apiproxy/tests/api-proxy-models.spec.ts packages/client/ui-model-selection/tests/model-select.client.spec.tsx packages/llm/llm-pi-ai/tests/loader-composition.spec.ts apps/web/tests/openai-codex-oauth.e2e.ts apps/web/tests/snapshots/openai-codex-oauth apps/web/tests/scaffold.ts apps/web/tests/README.md apps/web/tests/README.zh.md apps/web/tests/README.i18n.yaml
  git commit -m "test(web): cover Codex OAuth model selection"
  ```

### Task 7: 记录功能、保留决策记录并运行与发布相关的门禁

**文件：**
- 修改：`packages/llm/llm-pi-ai/README.md`
- 修改：`packages/llm/llm-pi-ai/README.zh.md`
- 修改：`packages/llm/llm-pi-ai/README.i18n.yaml`
- 修改：`docs/subsystems/credentials.md`
- 修改：`docs/subsystems/credentials.zh.md`
- 修改：`docs/subsystems/credentials.i18n.yaml`
- 修改：`docs/user/guide/providers.md`
- 修改：`docs/user/guide/providers.zh.md`
- 修改：`docs/user/guide/providers.i18n.yaml`
- 创建：`.agents/notes/proposed/feature/2026-08-16-openai-codex-oauth.md`
- 创建：`.agents/notes/proposed/feature/2026-08-16-openai-codex-oauth.zh.md`
- 创建：`.agents/notes/proposed/feature/2026-08-16-openai-codex-oauth.i18n.yaml`
- 创建：`packages/llm/llm-pi-ai/tests/{openai-codex-oauth}.e2e.ts`
- 修改或整合：`.agents/notes/implemented/bug-fix/2026-08-13-oauth-only-providers-withheld.{md,zh.md,i18n.yaml}`

**接口：**
- 使用此前全部行为和测试命令；不引入运行时 API。
- 产出配对的、现行用户与操作员说明，以及保留为何选择 pi-ai OAuth 而非 app-server 和 Codex CLI 凭据导入的决策记录。
- 产出明确选择加入的个人订阅 smoke 流程，CI 永不调用它。

- [ ] **步骤 1：在修改文案前编写文档测试或面向门禁的断言。**

  ```sh
  pnpm run verify-translation-pairing docs/subsystems/credentials.md docs/user/guide/providers.md packages/llm/llm-pi-ai/README.md
  pnpm run verify-md-links docs/subsystems/credentials.md docs/user/guide/providers.md packages/llm/llm-pi-ai/README.md
  ```

  记录当前文档门禁结果，然后用它验证所有已修改的面向用户和包文档在文案变更后仍保持配对和链接完整。

- [ ] **步骤 2：记录私有变更和 OAuth 运行模型。**

  ```md
  1. Open **Settings → Models**.
  2. Choose **Connect ChatGPT** for OpenAI Codex.
  3. Open the verification page, enter the displayed code, and complete sign-in.
  4. Select a connected `openai-codex` model in the normal picker.
  ```

  在 pi-ai README 中更新共享凭据存储和租约行为及仅设备代码交互；在凭据子系统文档中更新原子私有变更及其不通知规则；在提供商指南中更新连接、重新连接、断开、移除和无头使用行为。说明模型可用性由订阅控制，且个人 OAuth 令牌不属于配置文件。

- [ ] **步骤 3：加入功能 Agent Note 并协调已被取代的隐藏说明。**

  ```md
  ## Decision

  `openai-codex` uses pi-ai's durable OAuth credential store and a private cross-process login lease.

  ## Alternatives rejected

  - A primary Codex app-server adapter
  - Importing Codex CLI credential files
  - Browser-callback and pasted-token login in V1
  ```

  创建配对的 proposed 功能 Note，涵盖问题、决策、替代方案、不变量、运行风险和验收证据。将旧 Note 的理由保留在新 Note 中，再在 `rg` 确认并修复每个入站引用后，更新其现状事实，或仅在完整 triplet 被整合和删除时删除；绝不将其改写为无关的历史决策。

- [ ] **步骤 4：记录一个选择加入的真实登录 smoke，而不将订阅置入 CI。**

  ```sh
  DSH_OPENAI_CODEX_OAUTH_SMOKE=1 pnpm exec vitest run packages/llm/llm-pi-ai/tests/{openai-codex-oauth}.e2e.ts
  ```

  让该测试在没有显式标志时自行跳过，要求人工启动设备代码授权，并且仅断言脱敏成功加上无害的目录或 `checkAuth` 结果。不得用此测试发送模型请求、打印凭据或创建持久用户 fixture。

- [ ] **步骤 5：重新记录每个已修改翻译对并运行最终聚焦门禁。**

  ```sh
  pnpm run verify-translation-pairing --write packages/llm/llm-pi-ai/README.md docs/subsystems/credentials.md docs/user/guide/providers.md .agents/notes/proposed/feature/2026-08-16-openai-codex-oauth.md
  pnpm run test:snapshot -- -t "OpenAI Codex OAuth"
  pnpm run typecheck
  pnpm run lint
  pnpm run doc-sync
  git diff --check
  ```

  在这些最终门禁前运行 Tasks 1 至 6 中的聚焦单元、宿主、UI 和 Web 命令。若旧 Agent Note 被整合，将其替代对加入翻译命令，并验证旧 triplet 作为完整集合不存在。

- [ ] **步骤 6：提交文档和最终验证工件。**

  ```bash
  git add packages/llm/llm-pi-ai/README.md packages/llm/llm-pi-ai/README.zh.md packages/llm/llm-pi-ai/README.i18n.yaml docs/subsystems/credentials.md docs/subsystems/credentials.zh.md docs/subsystems/credentials.i18n.yaml docs/user/guide/providers.md docs/user/guide/providers.zh.md docs/user/guide/providers.i18n.yaml .agents/notes
  git commit -m "docs: document Codex subscription OAuth"
  ```

## 覆盖检查

- 设备代码专用 pi-ai 登录、普通主模型路径、模型选择、默认选择、每会话选择和推理元数据在 Tasks 3、5 和 6 中实施。
- 持久私有 OAuth 存储、原子刷新、跨进程租约所有权、过期恢复、取消和有序关闭在 Tasks 1 和 3 中实施和测试。
- 跨凭据、LLM 事件、宿主 RPC、远程传输、UI 状态、日志和快照的脱敏在 Tasks 1、2、3、4、5 和 6 中强制执行。
- 刷新失败和撤销在 Task 3 中成为 reconnect-required 而不回退认证；宿主和 UI 姿态在 Tasks 4 和 5 中得到证明。
- 先断开再移除的顺序、配置移除失败的沟通，以及已共享成功登录的无头使用在 Tasks 5 和 6 中覆盖。
- 配对文档、决策记录、选择加入 smoke 流程和仓库门禁在 Task 7 中完成。
