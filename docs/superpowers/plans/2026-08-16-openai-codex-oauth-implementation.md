# OpenAI Codex subscription OAuth Implementation Plan

English | [中文](2026-08-16-openai-codex-oauth-implementation.zh.md)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a Harness user connect a ChatGPT/Codex subscription through device-code OAuth and use catalogued `openai-codex` models as normal primary models.

**Architecture:** Extend the existing pi-ai adapter with a host-owned, durable pi-ai `CredentialStore` and a lease-guarded OAuth controller; do not introduce a Codex app-server model runtime. Add provider-neutral authentication metadata and an OAuth-controller registry to the LLM seam, then expose only redacted state through the host API and a dedicated Models card.

**Tech Stack:** TypeScript, Cordis services/events, `@earendil-works/pi-ai` 0.82.1, Zod/RPC schemas, React settings UI, Vitest, Playwright web fixtures, Mermaid-backed design documentation.

**Spec:** [OpenAI Codex subscription OAuth design](../specs/2026-08-16-openai-codex-oauth-design.md)

## Global Constraints

- Use pi-ai's native `openai-codex` OAuth path; the existing `subagent-codex` provider remains a separate, optional subagent integration.
- Use device-code login only: the host interaction chooses pi-ai's `device_code` option and rejects every text, secret, manual-code, and browser-callback prompt.
- Keep access tokens, refresh tokens, authorization payloads, account identity, plan data, private credential-reference names, and raw provider failures out of settings, browser RPC, session events, diagnostics, logs, and snapshots.
- Store the OAuth record and login lease under the fixed private references `DSH_OPENAI_CODEX_OAUTH` and `DSH_OPENAI_CODEX_LOGIN_LEASE`; neither is configurable or displayed.
- Hold the local credential provider's cross-process lock across each asynchronous OAuth record or lease mutation; do not add a browser-facing generic credential-mutation RPC.
- A private credential mutation must not emit `credentials/updated`, because that event reaches browser clients with its reference name. It emits only payload-free host-private `credentials/private-updated`, and OAuth state remains absent from the public directory and forwarded browser events.
- The OAuth directory row remains visible while dormant; the model route becomes active only after an OAuth profile is connected or an existing profile explicitly names `apiKeyEnv`.
- `openai-codex` may use legacy explicitly configured `apiKeyEnv` profiles that already exist, but a native OAuth profile never falls back to an API key, environment value, or another provider after OAuth refresh fails or is revoked.
- A headless profile cannot start login. It can only consume a successful connection stored in the same Harness home.
- Treat the lease timeout as validated `llm-pi-ai` configuration, not a hidden constant. Renew at a deterministic fraction of that configured timeout.
- Keep ordinary Harness model selection, session history, tool execution, retry behavior, and reasoning-effort controls authoritative for Codex-backed requests.

---

## Scope Check

The credential, LLM, host, and UI changes are one dependency chain rather than independent projects: the UI cannot safely expose a login until the durable store and redacted runtime lifecycle exist, and the adapter cannot serve an OAuth profile until both are present. Each task below still ends with a separately testable deliverable and commit.

## File Structure

- Modify `packages/credentials/credentials/src/index.ts` and `packages/credentials/credentials/src/types.ts` to define an atomic, visibility-aware credential mutation service operation.
- Modify `packages/credentials/credentials-local/src/index.ts` to run that operation under its existing queue and cross-process file lock while publishing only payload-free host-private invalidation for private changes.
- Modify `packages/llm/llm/src/{types.ts,index.ts,error.ts}` to declare provider authentication metadata, OAuth connection types, a controller registry, the redacted LLM event, and the reconnect-required error code.
- Create `packages/llm/llm-pi-ai/src/{oauth-credential-store}.ts` to implement pi-ai's `CredentialStore` over the private OAuth record.
- Create `packages/llm/llm-pi-ai/src/{openai-codex-oauth}.ts` to own the device-code interaction, expiring login lease, cancellation, status, and redaction.
- Modify `packages/llm/llm-pi-ai/src/{adapter,index,catalog,provider,config}.ts` to give every pi-ai model snapshot the shared store, register the controller, advertise `openai-codex`, and normalize OAuth request failures.
- Modify `packages/host/apiproxy/src/api/{llm.ts,llm.schema.ts,index.ts,rpc-map.ts}` and `packages/host/apiproxy/src/{api-proxy.ts,fetch/client.ts,fetch/handler.ts}` to carry only typed redacted OAuth operations and connection views.
- Modify `packages/api/remotes/src/remote-events.ts` and its client exports so neither private credential invalidation nor OAuth connection state reaches browser clients; Models reads its local lifecycle status after a public topology update.
- Modify `packages/client/ui-settings-models/src/client/{store.ts,ModelsSection.tsx,index.ts,locales.ts}` and create `OAuthProviderCard.tsx` for the device-code card and auth-aware provider readiness.
- Add focused unit, host-carrier, client-component, loader-composition, and keyless web tests beside the existing test suites; add only deterministic fixture records to snapshots.
- Update the paired package, subsystem, and user documentation plus the Agent Note required for a non-trivial feature.

Future filenames use `{literal-name}` only to distinguish a not-yet-created target from a current repository path; create the literal filename without braces.

### Task 1: Add atomic private credential mutation

**Files:**
- Modify: `packages/credentials/credentials/src/index.ts`
- Modify: `packages/credentials/credentials/src/types.ts`
- Modify: `packages/credentials/credentials/tests/credentials.spec.ts`
- Modify: `packages/credentials/credentials/tests/memory.ts`
- Modify: `packages/credentials/credentials-local/src/index.ts`
- Modify: `packages/credentials/credentials-local/tests/local.spec.ts`
- Modify: `packages/credentials/credentials-local/tests/review-fixes.spec.ts`

**Interfaces:**
- Produces `CredentialMutation<T>`, `CredentialMutationVisibility`, and `CredentialProvider.modify<T>(ref, mutate)` for host-side consumers.
- Produces local-provider serialization for `set`, `unset`, and `modify` through one queue-and-file-lock mutation path.
- Produces the invariant that only a changed `public` mutation emits `credentials/updated`.

- [ ] **Step 1: Write failing service and local-provider tests for serialized public and private mutations.**

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

  Add paired tests where two `LocalCredentialProvider` instances share one document, the first callback remains pending, the second sees the first committed value, and a changed `public` mutation emits exactly one event. Add rejected-callback, unchanged-value, environment-shadow, and disposal cases.

- [ ] **Step 2: Run the new credential tests and confirm the missing operation fails.**

  Run: `pnpm exec vitest run packages/credentials/credentials/tests/credentials.spec.ts packages/credentials/credentials-local/tests/local.spec.ts packages/credentials/credentials-local/tests/review-fixes.spec.ts`

  Expected: FAIL because `CredentialProvider.modify` and the local implementation do not exist.

- [ ] **Step 3: Define the service-level mutation result and abstract operation.**

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

  Export the new types from the credential package's existing public type surface, document that `current` is the provider-managed stored value rather than an inherited environment value, and document that callers must keep private references host-only.

- [ ] **Step 4: Refactor the local provider onto one locked mutation primitive.**

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

  Route `set` and `unset` through this primitive as `public` mutations. Preserve owner-only atomic writes, re-read-after-lock behavior, no-op writes, and existing error classes. Capture the pre-mutation value before commit so notification comparison is correct.

- [ ] **Step 5: Update in-memory test providers and run the focused credential suites.**

  Run: `pnpm exec vitest run packages/credentials/credentials/tests/credentials.spec.ts packages/credentials/credentials-local/tests/local.spec.ts packages/credentials/credentials-local/tests/review-fixes.spec.ts`

  Expected: PASS, including cross-instance read-modify-write serialization and no event for private or unchanged mutations.

- [ ] **Step 6: Commit the credential foundation.**

  ```bash
  git add packages/credentials/credentials/src/index.ts packages/credentials/credentials/src/types.ts packages/credentials/credentials/tests/credentials.spec.ts packages/credentials/credentials/tests/memory.ts packages/credentials/credentials-local/src/index.ts packages/credentials/credentials-local/tests/local.spec.ts packages/credentials/credentials-local/tests/review-fixes.spec.ts
  git commit -m "feat(credentials): add atomic private mutation"
  ```

### Task 2: Extend the LLM seam with redacted OAuth lifecycle types

**Files:**
- Modify: `packages/llm/llm/src/types.ts`
- Modify: `packages/llm/llm/src/index.ts`
- Modify: `packages/llm/llm/src/error.ts`
- Modify: `packages/llm/llm/tests/service.spec.ts`
- Modify: `packages/llm/llm/tests/topology.spec.ts`
- Modify: `packages/llm/llm/tests/adapter-failure.spec.ts`

**Interfaces:**
- Consumes `CredentialProvider.modify` only indirectly through later adapter code; this task has no credential-package import.
- Produces required `LlmConfigurableProvider.auth` metadata and the `LlmOAuthController` registration API used by `llm-pi-ai` and the host proxy.
- Produces the `llm/oauth-connection-updated` event whose payload excludes device codes and all credential material.

- [ ] **Step 1: Write failing LLM-runtime tests for authentication metadata, controller registration, disposal, and redacted updates.**

  ```text
  const dispose = runtime.registerOAuthController(controller)

  expect(runtime.getOAuthController('openai-codex')).toBe(controller)
  runtime.emitOAuthConnectionUpdated({ provider: 'openai-codex', status: 'connected' })
  expect(events).toEqual([{ provider: 'openai-codex', status: 'connected' }])
  dispose()
  expect(runtime.getOAuthController('openai-codex')).toBeUndefined()
  ```

  Cover duplicate provider ids, empty ids, invalid connection states, registration disposal, and a directory entry without `auth`.

- [ ] **Step 2: Run the LLM-service tests and confirm the new lifecycle surface is absent.**

  Run: `pnpm exec vitest run packages/llm/llm/tests/service.spec.ts packages/llm/llm/tests/topology.spec.ts`

  Expected: FAIL because configurable providers have no authentication metadata and `LlmRuntime` has no OAuth-controller registry.

- [ ] **Step 3: Add the provider and connection types to the LLM service definition.**

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

  Make `LlmConfigurableProvider.auth: LlmProviderAuth` required. Export `OAUTH_RECONNECT_REQUIRED_CODE = 'OAUTH_RECONNECT_REQUIRED'` from `error.ts` and extend the failure tests so a request can route on that code without parsing a provider message.

- [ ] **Step 4: Implement the registry and redacted event in `LlmRuntime`.**

  ```text
  registerOAuthController(controller: LlmOAuthController): () => void
  getOAuthController(provider: string): LlmOAuthController | undefined
  emitOAuthConnectionUpdated(connection: LlmOAuthConnection): void
  ```

  Validate provider identifiers and controller ownership at registration, attach the disposer with `ctx.effect()`, return detached connection data from public reads, and declare the typed Cordis event with payload documentation. Never add a generic login endpoint to this package.

- [ ] **Step 5: Update all existing configurable-provider fixtures with explicit authentication metadata and run focused tests.**

  Run: `pnpm exec vitest run packages/llm/llm/tests/service.spec.ts packages/llm/llm/tests/topology.spec.ts`

  Expected: PASS, including rejected duplicate controllers and an event payload containing only provider and status.

- [ ] **Step 6: Commit the provider-neutral OAuth seam.**

  ```bash
  git add packages/llm/llm/src/types.ts packages/llm/llm/src/index.ts packages/llm/llm/src/error.ts packages/llm/llm/tests/service.spec.ts packages/llm/llm/tests/topology.spec.ts packages/llm/llm/tests/adapter-failure.spec.ts
  git commit -m "feat(llm): add OAuth provider lifecycle"
  ```

### Task 3: Implement the pi-ai OAuth store, lease controller, and route

**Files:**
- Create: `packages/llm/llm-pi-ai/src/{oauth-credential-store}.ts`
- Create: `packages/llm/llm-pi-ai/src/{openai-codex-oauth}.ts`
- Modify: `packages/llm/llm-pi-ai/src/adapter.ts`
- Modify: `packages/llm/llm-pi-ai/src/index.ts`
- Modify: `packages/llm/llm-pi-ai/src/catalog.ts`
- Modify: `packages/llm/llm-pi-ai/src/provider.ts`
- Modify: `packages/llm/llm-pi-ai/src/config.ts`
- Modify: `packages/llm/llm-pi-ai/tests/{adapter.spec.ts,catalog.spec.ts,config.spec.ts,dynamic-config.spec.ts,loader-composition.spec.ts}`
- Create: `packages/llm/llm-pi-ai/tests/{oauth-credential-store}.spec.ts`
- Create: `packages/llm/llm-pi-ai/tests/{openai-codex-oauth}.spec.ts`

**Interfaces:**
- Consumes `CredentialProvider.modify`, `LlmOAuthController`, `LlmOAuthStart`, and `LlmRuntime.emitOAuthConnectionUpdated`.
- Produces `OpenAICodexCredentialStore`, `OpenAICodexOAuthController`, and a stable `PiAiAdapter` credential-store option shared by every immutable model snapshot.
- Produces an OAuth-authenticated `openai-codex` directory entry and an `OAUTH_RECONNECT_REQUIRED_CODE` LLM failure for revoked or failed-refresh credentials.

- [ ] **Step 1: Write failing store and controller tests against a fake pi-ai `Models` implementation.**

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

  Cover device-code selection, one live lease across two controllers, lease renewal and expiry takeover, cancellation, orderly disposal, malformed stored JSON, environment shadowing, credential-store refresh serialization, successful login persistence, logout, and redaction of every emitted state.

- [ ] **Step 2: Run the new pi-ai tests and confirm the store/controller modules are absent.**

  Run: `pnpm exec vitest run packages/llm/llm-pi-ai/tests/{oauth-credential-store.spec.ts,openai-codex-oauth.spec.ts} packages/llm/llm-pi-ai/tests/catalog.spec.ts`

  Expected: FAIL because neither private record persistence nor a controller can start pi-ai login.

- [ ] **Step 3: Implement the credential-store codec over the fixed private reference.**

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

  Accept only `openai-codex`, JSON-parse and version-check the record before returning it, reject a stored or proposed credential whose `type` is not `'oauth'`, route every write through `credentials.modify(... visibility: 'private')`, and convert malformed or unreadable data into a package-local redacted authentication failure. Do not expose the private reference from a public method.

- [ ] **Step 4: Implement the device-code controller and cross-process lease lifecycle.**

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

  Claim the private lease atomically before starting a poller. Supply pi-ai an `AuthInteraction` whose `prompt()` returns `'device_code'` only for the supported select prompt and rejects every other prompt, whose `notify()` retains only the current device-code fields in host memory, and whose `signal` is the controller-owned abort signal. Renew the lease before each poll interval, release only a matching owner lease in `finally`, cancel and release it on ordered disposal, and return `already-connecting` rather than a second code when another live owner holds the lease. Cancellation, expiry, and provider login failure clear the pending code, release the owned lease, and publish `missing` when no saved record exists or `reconnect-required` when a saved record cannot authenticate. Emit only `{ provider, status }` through the LLM event.

- [ ] **Step 5: Wire the shared store into pi-ai snapshots and register the route.**

  ```text
  const models: MutableModels = createModels({ credentials: this.config.credentials })

  ctx.llm.registerOAuthController(openaiCodexOAuth)
  ```

  Keep one store instance and one controller for the host plugin lifetime while preserving immutable model collections per profile snapshot. Mark catalog entries as `{ kind: 'api-key' }`, `{ kind: 'oauth' }`, or `{ kind: 'native' }`; include `openai-codex` as OAuth-capable rather than filtering it out. Register the `openai-codex` adapter route only when its profile has an explicit `apiKeyEnv` or the controller reports `connected`; keep its directory entry dormant otherwise, and refresh adapter registration after each redacted controller transition. Give the controller a full-profile `Models` factory so it can login while the primary route is dormant. Never pass an API-key override for a native OAuth profile. Catch pi-ai OAuth refresh failures in the adapter, call `markReconnectRequired()`, and throw `LlmError` with `OAUTH_RECONNECT_REQUIRED_CODE` without logging the provider payload.

- [ ] **Step 6: Add the validated lease-timeout configuration and dynamic reload coverage.**

  ```text
  oauth: {
    loginLeaseTtlMs: 30_000,
  }
  ```

  Add a positive bounded schema value, use it for lease expiry and renewal scheduling, and prove configuration reload keeps the store/controller state while replacing only immutable model snapshots. Initialize the controller asynchronously from the private record, then refresh registrations when that read completes. Update catalog tests so `openai-codex` appears as dormant before a usable profile exists and active only after a connected OAuth profile or explicit legacy `apiKeyEnv` profile resolves.

- [ ] **Step 7: Run the focused pi-ai suites.**

  Run: `pnpm exec vitest run packages/llm/llm-pi-ai/tests/{oauth-credential-store.spec.ts,openai-codex-oauth.spec.ts} packages/llm/llm-pi-ai/tests/adapter.spec.ts packages/llm/llm-pi-ai/tests/catalog.spec.ts packages/llm/llm-pi-ai/tests/config.spec.ts packages/llm/llm-pi-ai/tests/dynamic-config.spec.ts packages/llm/llm-pi-ai/tests/loader-composition.spec.ts`

  Expected: PASS, with no network request and no token, private reference, or raw pi-ai message in assertions.

- [ ] **Step 8: Commit the pi-ai OAuth implementation.**

  ```bash
  git add packages/llm/llm-pi-ai/src packages/llm/llm-pi-ai/tests
  git commit -m "feat(llm-pi-ai): support Codex OAuth"
  ```

### Task 4: Add redacted host RPC and remote-event transport

**Files:**
- Modify: `packages/host/apiproxy/src/api/llm.ts`
- Modify: `packages/host/apiproxy/src/api/llm.schema.ts`
- Modify: `packages/host/apiproxy/src/api/{index.ts,rpc-map.ts}`
- Modify: `packages/host/apiproxy/src/{api-proxy.ts,fetch/client.ts,fetch/handler.ts}`
- Modify: `packages/api/remotes/src/{remote-events.ts,index.ts}`
- Modify: `packages/host/apiproxy/tests/{api-proxy-models.spec.ts,api-proxy-config.spec.ts,rpc-schemas.spec.ts,client-handler.spec.ts,fetch-carrier.spec.ts}`
- Modify: `packages/client/connection/tests/fake-api.client.ts`
- Modify: `packages/client/connection/src/client/fixture.ts`

**Interfaces:**
- Consumes `LlmOAuthController`, `LlmOAuthConnection`, and `LlmOAuthStart` from the LLM seam.
- Produces `ConfigurableProviderView.auth`, `ConfigurableProviderView.connection`, `llm.oauthStart`, `llm.oauthStatus`, `llm.oauthCancel`, and `llm.oauthDisconnect`.
- Keeps `llm/oauth-connection-updated` Host-internal; only direct loopback lifecycle replies carry the redacted connection view.

- [ ] **Step 1: Write schema and carrier tests that assert the exact public fields.**

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

  Assert that every response, event, fake client, and JSON schema rejects or omits `access`, `refresh`, `accountId`, lease/reference names, provider error text, and an arbitrary OAuth provider id.

- [ ] **Step 2: Run the selected host-carrier tests and confirm the RPC methods are absent.**

  Run: `pnpm exec vitest run packages/host/apiproxy/tests/api-proxy-models.spec.ts packages/host/apiproxy/tests/api-proxy-config.spec.ts packages/host/apiproxy/tests/rpc-schemas.spec.ts packages/host/apiproxy/tests/client-handler.spec.ts packages/host/apiproxy/tests/fetch-carrier.spec.ts`

  Expected: FAIL because the public LLM API has no OAuth operation or redacted connection field.

- [ ] **Step 3: Define wire views and Zod schemas with a deliberately narrow device-code result.**

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

  Add `auth` to `ConfigurableProviderView`; keep connection state in direct loopback lifecycle replies. Validate `verificationUri` as a URL, code strings as non-empty bounded text, and interval/expiry as positive integers. Retain device-code fields only in the direct start response; do not add them to provider snapshots or remote events.

- [ ] **Step 4: Dispatch the four host methods and sanitize failures.**

  ```text
  llm.oauthStart({ provider })
  llm.oauthStatus({ provider })
  llm.oauthCancel({ provider })
  llm.oauthDisconnect({ provider })
  ```

  Resolve the controller from `ctx.llm`, refuse unknown providers and non-OAuth routes, map package errors to stable action-oriented messages, and use the controller's returned connection as the sole state response. Keep `llm/oauth-connection-updated` Host-internal and never special-case private names in the proxy.

- [ ] **Step 5: Extend the fetch handler, generated API map, fake client, and fixture transport.**

  ```text
  'llm.oauthStart': request => api.llm.oauthStart(request)
  'llm.oauthStatus': request => api.llm.oauthStatus(request)
  'llm.oauthCancel': request => api.llm.oauthCancel(request)
  'llm.oauthDisconnect': request => api.llm.oauthDisconnect(request)
  ```

  Add the methods in the same request/response order across `rpc-map`, `fetch/client`, `fetch/handler`, the test client, and fixture request switch. Add the new event to the explicit remote-event allowlist.

- [ ] **Step 6: Run focused host and transport tests.**

  Run: `pnpm exec vitest run packages/host/apiproxy/tests/api-proxy-models.spec.ts packages/host/apiproxy/tests/api-proxy-config.spec.ts packages/host/apiproxy/tests/rpc-schemas.spec.ts packages/host/apiproxy/tests/client-handler.spec.ts packages/host/apiproxy/tests/fetch-carrier.spec.ts`

  Expected: PASS, including the proof that a standard credential update cannot be used to disclose OAuth private-reference activity.

- [ ] **Step 7: Commit the host and remote transport.**

  ```bash
  git add packages/host/apiproxy/src packages/host/apiproxy/tests packages/api/remotes/src packages/client/connection/tests/fake-api.client.ts packages/client/connection/src/client/fixture.ts
  git commit -m "feat(host): expose redacted Codex OAuth state"
  ```

### Task 5: Build the Models OAuth card and readiness behavior

**Files:**
- Create: `packages/client/ui-settings-models/src/client/{OAuthProviderCard}.tsx`
- Modify: `packages/client/ui-settings-models/src/client/{store.ts,ModelsSection.tsx,index.ts,locales.ts}`
- Modify: `packages/client/ui-settings-models/src/client/ModelsSection.module.css`
- Modify: `packages/client/ui-settings-models/tests/{store.client.spec.ts,components.client.spec.tsx,provider-form.client.spec.tsx,readiness.client.spec.ts}`

**Interfaces:**
- Consumes `ConfigurableProviderView.auth`, `ConfigurableProviderView.connection`, and the four `api.llm.oauth*` methods.
- Produces an OAuth-specific card whose ephemeral device-code display is component-local and whose durable page state is the redacted provider snapshot.
- Produces `providerUsable(row)` behavior: OAuth requires a connected connection, API-key requires a configured named key, and native requires an active route.

- [ ] **Step 1: Write failing store and component tests for every card state and mutation ordering.**

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

  Cover Connect, Connecting, Connected, Reconnect, Cancel, Disconnect, Remove provider, a failed remove after successful disconnect, local status reload after a topology update, and legacy explicit `apiKeyEnv` readiness without rendering an OAuth API-key field.

- [ ] **Step 2: Run the Models UI tests and confirm there is no OAuth editor.**

  Run: `pnpm exec vitest run packages/client/ui-settings-models/tests/store.client.spec.ts packages/client/ui-settings-models/tests/components.client.spec.tsx packages/client/ui-settings-models/tests/provider-form.client.spec.tsx packages/client/ui-settings-models/tests/readiness.client.spec.ts`

  Expected: FAIL because `ProviderEditor` is API-key-only and the store treats a reference-free active route as usable.

- [ ] **Step 3: Make the store authentication-aware without looking up private credentials.**

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

  Request `credentials.describe` only for named profile API-key references. Copy `auth` from `llm.providers` and join `connection` from loopback-only `llm.oauthStatus`; never derive OAuth status from a credential badge or an OAuth record reference.

- [ ] **Step 4: Add a dedicated card with safe browser actions and copy.**

  ```tsx
  <a href={deviceCode.verificationUri} target="_blank" rel="noreferrer">
    Open verification page
  </a>
  <button onClick={() => void navigator.clipboard.writeText(deviceCode.userCode)}>
    Copy code
  </button>
  ```

  Render `Connect ChatGPT`, `Connecting`, `Connected`, `Reconnect`, `Cancel`, and `Disconnect` from the locally joined typed connection view. Keep URL and code only in local component state after a direct `oauthStart` response, clear them after cancellation, disconnect, unmount, or a terminal status refresh, and use an ordinary safe link rather than adding a host URL-opening RPC.

- [ ] **Step 5: Wire profile creation, reconnect, disconnect, removal, and event invalidation.**

  ```text
  await api.settings.mutate({ ns, path: ['providers', 'openai-codex'], value: {} })
  await api.llm.oauthStart({ provider: 'openai-codex' })
  await api.llm.oauthDisconnect({ provider: 'openai-codex' })
  await removeProviderProfile('openai-codex')
  ```

  Create or retain the empty profile before start. On removal, await disconnect first, then the existing profile removal; show the configured-but-disconnected result when the second action fails. Subscribe to public `llm/adapters-updated` alongside the current settings invalidators, then read OAuth status locally, and leave ordinary `ProviderEditor` API-key behavior unchanged.

- [ ] **Step 6: Run focused Models UI tests.**

  Run: `pnpm exec vitest run packages/client/ui-settings-models/tests/store.client.spec.ts packages/client/ui-settings-models/tests/components.client.spec.tsx packages/client/ui-settings-models/tests/provider-form.client.spec.tsx packages/client/ui-settings-models/tests/readiness.client.spec.ts`

  Expected: PASS, including a visible device code only during the active page-owned start response and no leaked account, token, or provider-error field.

- [ ] **Step 7: Commit the Models UI.**

  ```bash
  git add packages/client/ui-settings-models/src packages/client/ui-settings-models/tests
  git commit -m "feat(models): add Codex OAuth connection card"
  ```

### Task 6: Prove picker, default, profile composition, and assembled web behavior

**Files:**
- Modify: `packages/host/apiproxy/tests/api-proxy-models.spec.ts`
- Modify: `packages/client/ui-model-selection/tests/model-select.client.spec.tsx`
- Modify: `packages/llm/llm-pi-ai/tests/loader-composition.spec.ts`
- Create: `apps/web/tests/openai-codex-oauth.e2e.ts`
- Create: `apps/web/tests/snapshots/openai-codex-oauth/flow.expected.md`
- Modify: `apps/web/tests/scaffold.ts`
- Modify: `apps/web/tests/README.md`
- Modify: `apps/web/tests/README.zh.md`
- Modify: `apps/web/tests/README.i18n.yaml`

**Interfaces:**
- Consumes the connected OAuth provider entry, normal `session.models` and `session.selectModel` APIs, and the redacted Models UI API.
- Produces keyless, deterministic proof that the provider becomes selectable only while connected and that selection retains existing default, per-session, and reasoning behavior.
- Produces a real base-plus-headless composition test showing saved OAuth is usable without interactive headless login.

- [ ] **Step 1: Write failing model-selection and composition tests.**

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

  Assert the disconnected route cannot be selected, a connected route appears in the normal picker, a default selection persists through the existing setting path, a per-session override remains scoped to that session, and the headless composition calls no OAuth-start method.

- [ ] **Step 2: Run the focused picker and composition tests and confirm they do not know OAuth readiness.**

  Run: `pnpm exec vitest run packages/host/apiproxy/tests/api-proxy-models.spec.ts packages/client/ui-model-selection/tests/model-select.client.spec.tsx packages/llm/llm-pi-ai/tests/loader-composition.spec.ts`

  Expected: FAIL because the OAuth route is absent after a completed connection or treated as selectable before one.

- [ ] **Step 3: Keep selection on the existing registered-route gate and prove its OAuth state transitions.**

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

  Do not add a parallel client-only selection guard: the adapter registration from Task 3 leaves a disconnected OAuth profile unregistered, so existing `resolveCallConfig` rejects it. Preserve pi-ai's catalog model ids and reasoning metadata; do not hardcode a Codex model list.

- [ ] **Step 4: Add a deterministic full-web OAuth scenario and ARIA golden.**

  ```text
  await page.getByRole('button', { name: 'Connect ChatGPT' }).click()
  await expect(page.getByText('ABCD-EFGH')).toBeVisible()
  await fixture.completeOAuthLogin('openai-codex')
  await expect(page.getByRole('button', { name: /Connected/ })).toBeVisible()
  ```

  Extend the web scaffold with a fake controller that returns the fixed verification URL and code, advances only when the test requests completion, and emits a redacted connection event. Capture the Models card, picker, default selection, and per-session selection in one keyless expected Markdown snapshot; assert the output lacks token-shaped values, private-reference names, and raw provider errors.

- [ ] **Step 5: Run the assembled web checks and record only the deterministic golden.**

  Run: `pnpm run test:web:built -- apps/web/tests/openai-codex-oauth.e2e.ts`

  Expected: PASS, with the checked-in ARIA snapshot showing the complete redacted flow.

- [ ] **Step 6: Commit integration coverage.**

  ```bash
  git add packages/host/apiproxy/tests/api-proxy-models.spec.ts packages/client/ui-model-selection/tests/model-select.client.spec.tsx packages/llm/llm-pi-ai/tests/loader-composition.spec.ts apps/web/tests/openai-codex-oauth.e2e.ts apps/web/tests/snapshots/openai-codex-oauth apps/web/tests/scaffold.ts apps/web/tests/README.md apps/web/tests/README.zh.md apps/web/tests/README.i18n.yaml
  git commit -m "test(web): cover Codex OAuth model selection"
  ```

### Task 7: Document the feature, preserve the decision record, and run release-relevant gates

**Files:**
- Modify: `packages/llm/llm-pi-ai/README.md`
- Modify: `packages/llm/llm-pi-ai/README.zh.md`
- Modify: `packages/llm/llm-pi-ai/README.i18n.yaml`
- Modify: `docs/subsystems/credentials.md`
- Modify: `docs/subsystems/credentials.zh.md`
- Modify: `docs/subsystems/credentials.i18n.yaml`
- Modify: `docs/user/guide/providers.md`
- Modify: `docs/user/guide/providers.zh.md`
- Modify: `docs/user/guide/providers.i18n.yaml`
- Create: `.agents/notes/proposed/feature/2026-08-16-openai-codex-oauth.md`
- Create: `.agents/notes/proposed/feature/2026-08-16-openai-codex-oauth.zh.md`
- Create: `.agents/notes/proposed/feature/2026-08-16-openai-codex-oauth.i18n.yaml`
- Create: `packages/llm/llm-pi-ai/tests/{openai-codex-oauth}.e2e.ts`
- Modify or consolidate: `.agents/notes/implemented/bug-fix/2026-08-13-oauth-only-providers-withheld.{md,zh.md,i18n.yaml}`

**Interfaces:**
- Consumes all prior behavior and test commands; introduces no runtime API.
- Produces paired, current user/operator instructions and a decision record that preserves why pi-ai OAuth was selected over app-server and Codex CLI credential import.
- Produces an explicit opt-in personal-subscription smoke procedure that CI never invokes.

- [ ] **Step 1: Write documentation tests or gate-facing assertions before changing prose.**

  ```sh
  pnpm run verify-translation-pairing docs/subsystems/credentials.md docs/user/guide/providers.md packages/llm/llm-pi-ai/README.md
  pnpm run verify-md-links docs/subsystems/credentials.md docs/user/guide/providers.md packages/llm/llm-pi-ai/README.md
  ```

  Record the current docs gate result, then use it to verify that all changed user-facing and package documents remain paired and linked after the prose changes.

- [ ] **Step 2: Document the private mutation and OAuth operating model.**

  ```md
  1. Open **Settings → Models**.
  2. Choose **Connect ChatGPT** for OpenAI Codex.
  3. Open the verification page, enter the displayed code, and complete sign-in.
  4. Select a connected `openai-codex` model in the normal picker.
  ```

  Update the pi-ai README with the shared credential-store/lease behavior and device-code-only interaction; update the credential subsystem document with atomic private mutation and its no-notification rule; update the provider guide with connect, reconnect, disconnect, remove, and headless-consumption behavior. State that model availability is subscription-controlled and no personal OAuth tokens belong in configuration files.

- [ ] **Step 3: Add the feature Agent Note and reconcile the superseded withholding note.**

  ```md
  ## Decision

  `openai-codex` uses pi-ai's durable OAuth credential store and a private cross-process login lease.

  ## Alternatives rejected

  - A primary Codex app-server adapter
  - Importing Codex CLI credential files
  - Browser-callback and pasted-token login in V1
  ```

  Create the paired proposed feature note with problem, decision, alternatives, invariants, operational risks, and acceptance evidence. Preserve the older note's rationale in the new note, then either update its current facts or consolidate and delete its complete triplet only after `rg` confirms and repairs every inbound reference; never rewrite it into an unrelated historical decision.

- [ ] **Step 4: Document an opt-in real-login smoke without putting a subscription in CI.**

  ```sh
  DSH_OPENAI_CODEX_OAUTH_SMOKE=1 pnpm exec vitest run packages/llm/llm-pi-ai/tests/{openai-codex-oauth}.e2e.ts
  ```

  Make this test self-skip unless the explicit flag is present, require a manually initiated device-code authorization, and assert only redacted success plus a harmless catalog or `checkAuth` result. Do not use the test to send a model request, print a credential, or create a persistent user fixture.

- [ ] **Step 5: Re-record every changed translation pair and run the final targeted gates.**

  ```sh
  pnpm run verify-translation-pairing --write packages/llm/llm-pi-ai/README.md docs/subsystems/credentials.md docs/user/guide/providers.md .agents/notes/proposed/feature/2026-08-16-openai-codex-oauth.md
  pnpm run test:snapshot -- -t "OpenAI Codex OAuth"
  pnpm run typecheck
  pnpm run lint
  pnpm run doc-sync
  git diff --check
  ```

  Run the focused unit, host, UI, and web commands from Tasks 1 through 6 before these final gates. If the old Agent Note is consolidated, include its replacement pair in the translation command and verify the old triplet is absent as a complete set.

- [ ] **Step 6: Commit the documentation and final verification artifacts.**

  ```bash
  git add packages/llm/llm-pi-ai/README.md packages/llm/llm-pi-ai/README.zh.md packages/llm/llm-pi-ai/README.i18n.yaml docs/subsystems/credentials.md docs/subsystems/credentials.zh.md docs/subsystems/credentials.i18n.yaml docs/user/guide/providers.md docs/user/guide/providers.zh.md docs/user/guide/providers.i18n.yaml .agents/notes
  git commit -m "docs: document Codex subscription OAuth"
  ```

## Coverage Review

- Device-code-only pi-ai login, the normal primary-model path, model choice, default selection, per-session selection, and reasoning metadata are implemented in Tasks 3, 5, and 6.
- Durable private OAuth storage, atomic refresh, cross-process lease ownership, expiry recovery, cancellation, and orderly shutdown are implemented and tested in Tasks 1 and 3.
- Redaction across credentials, LLM events, host RPC, remote transport, UI state, logs, and snapshots is enforced in Tasks 1, 2, 3, 4, 5, and 6.
- Refresh failure and revocation become reconnect-required without authentication fallback in Task 3; the host/UI posture is proved in Tasks 4 and 5.
- Disconnect-before-remove ordering, failed-profile-removal communication, and headless consumption of a shared successful login are covered in Tasks 5 and 6.
- Paired documentation, the decision record, opt-in smoke procedure, and repository gates are completed in Task 7.
