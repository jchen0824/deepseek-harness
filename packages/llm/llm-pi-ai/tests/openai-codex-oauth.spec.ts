import { Context } from '@deepseek-ai/cordis'
import { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import type {
  CredentialInfo as HarnessCredentialInfo,
  CredentialMutation,
  CredentialRef,
  ResolvedCredential,
} from '@deepseek-ai/dsh-credentials'
import type {
  AuthInteraction,
  Credential,
  CredentialStore,
  Models,
  OAuthCredential,
} from '@earendil-works/pi-ai'
import type { LlmOAuthConnection } from '@deepseek-ai/dsh-llm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  OPENAI_CODEX_LOGIN_LEASE_REF,
  OpenAICodexCredentialStore,
} from '../src/oauth-credential-store.ts'
import { OpenAICodexOAuthController } from '../src/openai-codex-oauth.ts'

const PROVIDER = 'openai-codex'

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept
    reject = decline
  })
  return { promise, resolve, reject }
}

/** Shared atomic document double: controller instances represent separate processes. */
class SharedCredentials extends CredentialProvider {
  private readonly values = new Map<CredentialRef, string>()
  private operations: Promise<void> = Promise.resolve()
  private operationCount = 0
  private modificationsBlocked = false
  private pause: {
    operation: number
    reached: Deferred<undefined>
    release: Deferred<undefined>
  } | undefined
  private delayedMutationResult: {
    ref: CredentialRef
    reached: Deferred<undefined>
    release: Deferred<undefined>
  } | undefined

  pauseOperation(operation: number): { reached: Promise<undefined>; release: () => void } {
    const reached = deferred<undefined>()
    const release = deferred<undefined>()
    this.pause = { operation, reached, release }
    return { reached: reached.promise, release: () => { release.resolve(undefined) } }
  }

  /** Delay one caller's result after its private mutation commits and releases the document lock. */
  delayMutationResult(ref: CredentialRef): { reached: Promise<undefined>; release: () => void } {
    const reached = deferred<undefined>()
    const release = deferred<undefined>()
    this.delayedMutationResult = { ref, reached, release }
    return { reached: reached.promise, release: () => { release.resolve(undefined) } }
  }

  /** Reject every mutation until the returned release function restores the provider. */
  blockModifications(): () => void {
    this.modificationsBlocked = true
    return () => { this.modificationsBlocked = false }
  }

  override resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    const value = this.values.get(ref)
    return Promise.resolve(value === undefined ? undefined : { value, source: 'memory' })
  }

  override describe(ref: CredentialRef): Promise<HarnessCredentialInfo> {
    return Promise.resolve({ configured: this.values.has(ref), source: 'memory', writable: true })
  }

  override set(ref: CredentialRef, value: string): Promise<void> {
    return this.modify(ref, async () => ({ value, result: undefined, visibility: 'public' }))
  }

  override unset(ref: CredentialRef): Promise<void> {
    return this.modify(ref, async () => ({ value: undefined, result: undefined, visibility: 'public' }))
  }

  override modify<T>(
    ref: CredentialRef,
    mutate: (current: string | undefined) => Promise<CredentialMutation<T>>,
  ): Promise<T> {
    const task = this.operations.then(async () => {
      if (this.modificationsBlocked) throw new Error('credentials unavailable')
      this.operationCount += 1
      if (this.pause?.operation === this.operationCount) {
        const pause = this.pause
        pause.reached.resolve(undefined)
        await pause.release.promise
        if (this.pause === pause) this.pause = undefined
      }
      const mutation = await mutate(this.values.get(ref))
      if (mutation.value === undefined) this.values.delete(ref)
      else this.values.set(ref, mutation.value)
      return mutation.result
    })
    this.operations = task.then(() => undefined, () => undefined)
    const delayed = this.delayedMutationResult
    if (delayed?.ref !== ref) return task
    this.delayedMutationResult = undefined
    return task.then(async (result) => {
      delayed.reached.resolve(undefined)
      await delayed.release.promise
      return result
    })
  }
}

function oauth(expires = Date.now() + 60_000): OAuthCredential {
  return {
    type: 'oauth',
    access: 'private-access-value',
    refresh: 'private-refresh-value',
    expires,
    accountId: 'private-account-value',
  }
}

/** Fake pi-ai Models surface that executes the interaction and persists on success. */
class DeviceCodeModels {
  readonly completion = deferred<OAuthCredential>()
  readonly selections: string[] = []
  loginCount = 0
  logoutCount = 0
  prompt: 'device-select' | 'manual-code' | 'lookalike-select' = 'device-select'
  abortCleanup: Promise<void> | undefined
  lastSignal: AbortSignal | undefined
  private persistencePause: { reached: Deferred<undefined>; release: Deferred<undefined> } | undefined
  private persistedPause: { reached: Deferred<undefined>; release: Deferred<undefined> } | undefined
  private logoutPause: { reached: Deferred<undefined>; release: Deferred<undefined> } | undefined

  /** Pause after provider completion but before the generation-scoped write. */
  pausePersistence(): { reached: Promise<undefined>; release: () => void } {
    const reached = deferred<undefined>()
    const release = deferred<undefined>()
    this.persistencePause = { reached, release }
    return { reached: reached.promise, release: () => { release.resolve(undefined) } }
  }

  /** Pause after the generation-scoped write but before provider completion. */
  pauseAfterPersistence(): { reached: Promise<undefined>; release: () => void } {
    const reached = deferred<undefined>()
    const release = deferred<undefined>()
    this.persistedPause = { reached, release }
    return { reached: reached.promise, release: () => { release.resolve(undefined) } }
  }

  /** Pause immediately before pi-ai deletes the generation-scoped credential. */
  pauseLogout(): { reached: Promise<undefined>; release: () => void } {
    const reached = deferred<undefined>()
    const release = deferred<undefined>()
    this.logoutPause = { reached, release }
    return { reached: reached.promise, release: () => { release.resolve(undefined) } }
  }

  /** Bind the fake Models calls to the controller-supplied generation store. */
  models(store: CredentialStore): Models {
    return {
      login: (providerId: string, type: string, interaction: AuthInteraction) => (
        this.login(store, providerId, type, interaction)
      ),
      logout: (providerId: string) => this.logout(store, providerId),
    } as unknown as Models
  }

  private async login(
    store: CredentialStore,
    providerId: string,
    type: string,
    interaction: AuthInteraction,
  ): Promise<Credential> {
    this.loginCount += 1
    this.lastSignal = interaction.signal
    if (providerId !== PROVIDER || type !== 'oauth') throw new Error('unexpected login route')
    if (this.prompt === 'manual-code') {
      await interaction.prompt({ type: 'manual_code', message: 'unsupported callback prompt' })
      throw new Error('unsupported prompt unexpectedly returned')
    }
    if (this.prompt === 'lookalike-select') {
      this.selections.push(await interaction.prompt({
        type: 'select',
        message: 'Select another provider login method:',
        options: [
          { id: 'browser', label: 'Browser login (default)' },
          { id: 'device_code', label: 'Device code login (headless)' },
        ],
      }))
      throw new Error('lookalike prompt unexpectedly returned')
    }
    const selected = await interaction.prompt({
      type: 'select',
      message: 'Select OpenAI Codex login method:',
      options: [
        { id: 'browser', label: 'Browser login (default)' },
        { id: 'device_code', label: 'Device code login (headless)' },
      ],
    })
    this.selections.push(selected)
    interaction.notify({
      type: 'device_code',
      verificationUri: 'https://auth.openai.com/codex/device',
      userCode: 'ABCD-EFGH',
      intervalSeconds: 5,
      expiresInSeconds: 900,
    })
    try {
      const credential = await Promise.race([
        this.completion.promise,
        new Promise<never>((_resolve, reject) => {
          if (interaction.signal?.aborted) {
            reject(new Error('provider cancellation detail'))
            return
          }
          interaction.signal?.addEventListener('abort', () => {
            reject(new Error('provider cancellation detail'))
          }, { once: true })
        }),
      ])
      const pause = this.persistencePause
      if (pause !== undefined) {
        pause.reached.resolve(undefined)
        await pause.release.promise
        if (this.persistencePause === pause) this.persistencePause = undefined
      }
      await store.modify(PROVIDER, async () => credential)
      const persisted = this.persistedPause
      if (persisted !== undefined) {
        persisted.reached.resolve(undefined)
        await persisted.release.promise
        if (this.persistedPause === persisted) this.persistedPause = undefined
      }
      return credential
    } catch (error) {
      await this.abortCleanup
      throw error
    }
  }

  private async logout(store: CredentialStore, providerId: string): Promise<void> {
    this.logoutCount += 1
    const pause = this.logoutPause
    if (pause !== undefined) {
      pause.reached.resolve(undefined)
      await pause.release.promise
      if (this.logoutPause === pause) this.logoutPause = undefined
    }
    await store.delete(providerId)
  }
}

interface MutableNumber { value: number }

let ownerCounter = 0
const controllers: OpenAICodexOAuthController[] = []

function controllerOf(
  credentials: SharedCredentials,
  models: DeviceCodeModels,
  events: LlmOAuthConnection[],
  now: MutableNumber,
  ttl: MutableNumber = { value: 100 },
): OpenAICodexOAuthController {
  const controller = new OpenAICodexOAuthController({
    credentials: () => credentials,
    credentialStore: new OpenAICodexCredentialStore(() => credentials),
    models: store => models.models(store),
    loginLeaseTtlMs: () => ttl.value,
    emitConnectionUpdated: (connection) => { events.push(connection) },
    now: () => now.value,
    createOwnerId: () => `test-owner-${++ownerCounter}`,
  })
  controllers.push(controller)
  return controller
}

async function writeGenerationOneLease(
  credentials: SharedCredentials,
  expiresAt: number,
): Promise<void> {
  await credentials.modify(OPENAI_CODEX_LOGIN_LEASE_REF, async () => ({
    value: JSON.stringify({
      version: 2,
      generation: 1,
      reconnectRequired: false,
      lease: {
        ownerId: 'abandoned-owner',
        state: 'pending',
        expiresAt,
      },
    }),
    result: undefined,
    visibility: 'private',
  }))
}

async function persistGenerationOneCredentialWithLease(
  credentials: SharedCredentials,
  expiresAt: number,
): Promise<void> {
  const store = new OpenAICodexCredentialStore(() => credentials)
  const loginStore = await store.beginLogin(0, 1)
  await loginStore.modify(PROVIDER, async () => oauth())
  await writeGenerationOneLease(credentials, expiresAt)
}

async function waitForStatus(
  controller: OpenAICodexOAuthController,
  status: LlmOAuthConnection['status'],
): Promise<void> {
  await vi.waitFor(async () => {
    await expect(controller.status()).resolves.toEqual({ provider: PROVIDER, status })
  })
}

afterEach(async () => {
  await Promise.allSettled(controllers.splice(0).map(controller => controller.dispose()))
  vi.useRealTimers()
})

describe('OpenAICodexOAuthController', () => {
  it('selects device-code login and returns as soon as the code is available', async () => {
    const credentials = new SharedCredentials(new Context())
    const models = new DeviceCodeModels()
    const events: LlmOAuthConnection[] = []
    const controller = controllerOf(credentials, models, events, { value: 0 })

    await expect(controller.start()).resolves.toEqual({
      kind: 'device-code',
      connection: { provider: PROVIDER, status: 'connecting' },
      deviceCode: {
        verificationUri: 'https://auth.openai.com/codex/device',
        userCode: 'ABCD-EFGH',
        intervalSeconds: 5,
        expiresInSeconds: 900,
      },
    })
    expect(models.selections).toEqual(['device_code'])
    await expect(controller.status()).resolves.toEqual({ provider: PROVIDER, status: 'connecting' })
    expect(events).toEqual([{ provider: PROVIDER, status: 'connecting' }])
  })

  it('persists a successful login and emits only redacted status transitions', async () => {
    const credentials = new SharedCredentials(new Context())
    const store = new OpenAICodexCredentialStore(() => credentials)
    const models = new DeviceCodeModels()
    const events: LlmOAuthConnection[] = []
    const controller = controllerOf(credentials, models, events, { value: 0 })
    await controller.start()

    models.completion.resolve(oauth())
    await waitForStatus(controller, 'connected')

    expect((await store.read(PROVIDER))?.type).toBe('oauth')
    expect(events).toEqual([
      { provider: PROVIDER, status: 'connecting' },
      { provider: PROVIDER, status: 'connected' },
    ])
  })

  it('allows only one live login lease across controller processes', async () => {
    const credentials = new SharedCredentials(new Context())
    const firstModels = new DeviceCodeModels()
    const secondModels = new DeviceCodeModels()
    const now = { value: 0 }
    const first = controllerOf(credentials, firstModels, [], now)
    const second = controllerOf(credentials, secondModels, [], now)
    await first.start()

    await expect(second.start()).resolves.toEqual({
      kind: 'already-connecting',
      connection: { provider: PROVIDER, status: 'connecting' },
    })
    expect(firstModels.loginCount).toBe(1)
    expect(secondModels.loginCount).toBe(0)
  })

  it('lets another controller cancel the live generation without credential recreation', async () => {
    const credentials = new SharedCredentials(new Context())
    const ownerModels = new DeviceCodeModels()
    const remoteModels = new DeviceCodeModels()
    const now = { value: 0 }
    const ownerEvents: LlmOAuthConnection[] = []
    const remoteEvents: LlmOAuthConnection[] = []
    const owner = controllerOf(credentials, ownerModels, ownerEvents, now)
    const remote = controllerOf(credentials, remoteModels, remoteEvents, now)
    await owner.start()

    await expect(remote.cancel()).resolves.toEqual({ provider: PROVIDER, status: 'missing' })
    ownerModels.completion.resolve(oauth())
    await waitForStatus(owner, 'missing')

    const store = new OpenAICodexCredentialStore(() => credentials)
    await expect(store.read(PROVIDER)).resolves.toBeUndefined()
    expect(remoteModels.loginCount).toBe(0)
    expect(ownerEvents.at(-1)).toEqual({ provider: PROVIDER, status: 'missing' })
    expect(remoteEvents).not.toContainEqual({ provider: PROVIDER, status: 'connecting' })
    expect(JSON.stringify([...ownerEvents, ...remoteEvents])).not.toMatch(/private-(?:access|refresh|account)-value/)
  })

  it('remote cancellation clears a credential persisted by the still-live lease', async () => {
    const credentials = new SharedCredentials(new Context())
    const store = new OpenAICodexCredentialStore(() => credentials)
    const ownerModels = new DeviceCodeModels()
    const now = { value: 0 }
    const owner = controllerOf(credentials, ownerModels, [], now)
    const remote = controllerOf(credentials, new DeviceCodeModels(), [], now)
    const persisted = ownerModels.pauseAfterPersistence()
    await owner.start()
    ownerModels.completion.resolve(oauth())
    await persisted.reached

    try {
      await expect(store.read(PROVIDER)).resolves.toMatchObject({ type: 'oauth' })
      await expect(remote.cancel()).resolves.toEqual({ provider: PROVIDER, status: 'missing' })
      await expect(store.read(PROVIDER)).resolves.toBeUndefined()
    } finally {
      persisted.release()
    }
    await waitForStatus(owner, 'missing')
  })

  it('does not rebase a revoked credential into a replacement login that fails', async () => {
    const credentials = new SharedCredentials(new Context())
    await persistGenerationOneCredentialWithLease(credentials, 100)
    const now = { value: 0 }
    const revoker = controllerOf(credentials, new DeviceCodeModels(), [], now)
    const replacementModels = new DeviceCodeModels()
    const replacement = controllerOf(credentials, replacementModels, [], now)
    const revocationCommitted = credentials.delayMutationResult(OPENAI_CODEX_LOGIN_LEASE_REF)
    const cancelling = revoker.cancel()
    await revocationCommitted.reached

    try {
      await expect(replacement.start()).resolves.toMatchObject({ kind: 'device-code' })
      replacementModels.completion.reject(new Error('provider rejected login'))

      await waitForStatus(replacement, 'missing')
    } finally {
      revocationCommitted.release()
    }

    await expect(cancelling).resolves.toEqual({ provider: PROVIDER, status: 'missing' })
    await expect(new OpenAICodexCredentialStore(() => credentials).read(PROVIDER)).resolves.toBeUndefined()
  })

  it('lets another controller disconnect while provider completion is waiting to persist', async () => {
    const credentials = new SharedCredentials(new Context())
    const ownerModels = new DeviceCodeModels()
    const remoteModels = new DeviceCodeModels()
    const now = { value: 0 }
    const owner = controllerOf(credentials, ownerModels, [], now)
    const remote = controllerOf(credentials, remoteModels, [], now)
    const persistence = ownerModels.pausePersistence()
    await owner.start()
    ownerModels.completion.resolve(oauth())
    await persistence.reached

    try {
      await expect(remote.disconnect()).resolves.toEqual({ provider: PROVIDER, status: 'missing' })
    } finally {
      persistence.release()
    }
    await waitForStatus(owner, 'missing')

    const store = new OpenAICodexCredentialStore(() => credentials)
    await expect(store.read(PROVIDER)).resolves.toBeUndefined()
    expect(remoteModels.logoutCount).toBe(1)
  })

  it('lets remote removal delete its profile only after polling is durably disconnected', async () => {
    const credentials = new SharedCredentials(new Context())
    const ownerModels = new DeviceCodeModels()
    const now = { value: 0 }
    const owner = controllerOf(credentials, ownerModels, [], now)
    const remote = controllerOf(credentials, new DeviceCodeModels(), [], now)
    const persistence = ownerModels.pausePersistence()
    let profileConfigured = true
    await owner.start()
    ownerModels.completion.resolve(oauth())
    await persistence.reached

    try {
      const connection = await remote.disconnect()
      expect(profileConfigured).toBe(true)
      if (connection.status === 'missing') profileConfigured = false
      expect(profileConfigured).toBe(false)
    } finally {
      persistence.release()
    }
    await waitForStatus(owner, 'missing')
    const store = new OpenAICodexCredentialStore(() => credentials)
    await expect(store.read(PROVIDER)).resolves.toBeUndefined()
  })

  it('propagates reconnect-required state to every controller sharing the home', async () => {
    const credentials = new SharedCredentials(new Context())
    const store = new OpenAICodexCredentialStore(() => credentials)
    await store.modify(PROVIDER, async () => oauth())
    const now = { value: 0 }
    const first = controllerOf(credentials, new DeviceCodeModels(), [], now)
    const secondEvents: LlmOAuthConnection[] = []
    const second = controllerOf(credentials, new DeviceCodeModels(), secondEvents, now)
    await expect(second.initialize()).resolves.toEqual({ provider: PROVIDER, status: 'connected' })

    await first.markReconnectRequired(await first.captureRequestGeneration())

    await expect(second.status()).resolves.toEqual({ provider: PROVIDER, status: 'reconnect-required' })
    expect(secondEvents.at(-1)).toEqual({ provider: PROVIDER, status: 'reconnect-required' })
  })

  it('does not publish reconnect-required when the durable refresh marker cannot commit', async () => {
    const credentials = new SharedCredentials(new Context())
    const store = new OpenAICodexCredentialStore(() => credentials)
    await store.modify(PROVIDER, async () => oauth())
    const events: LlmOAuthConnection[] = []
    const controller = controllerOf(credentials, new DeviceCodeModels(), events, { value: 0 })
    await expect(controller.initialize()).resolves.toEqual({ provider: PROVIDER, status: 'connected' })
    const generation = await controller.captureRequestGeneration()
    const unblock = credentials.blockModifications()

    try {
      await controller.markReconnectRequired(generation)
      expect(events).toEqual([{ provider: PROVIDER, status: 'connected' }])
    } finally {
      unblock()
    }

    await expect(controller.status()).resolves.toEqual({ provider: PROVIDER, status: 'connected' })
  })

  it('preserves an established credential when no login lease is pending', async () => {
    const credentials = new SharedCredentials(new Context())
    const store = new OpenAICodexCredentialStore(() => credentials)
    await store.modify(PROVIDER, async () => oauth())
    const controller = controllerOf(credentials, new DeviceCodeModels(), [], { value: 0 })
    await expect(controller.initialize()).resolves.toEqual({ provider: PROVIDER, status: 'connected' })

    await expect(controller.cancel()).resolves.toEqual({ provider: PROVIDER, status: 'connected' })
    await expect(store.read(PROVIDER)).resolves.toMatchObject({ type: 'oauth' })
  })

  it('does not apply a stale request refresh failure to a newer connection generation', async () => {
    const credentials = new SharedCredentials(new Context())
    const store = new OpenAICodexCredentialStore(() => credentials)
    await store.modify(PROVIDER, async () => oauth())
    const now = { value: 0 }
    const first = controllerOf(credentials, new DeviceCodeModels(), [], now)
    await expect(first.initialize()).resolves.toEqual({ provider: PROVIDER, status: 'connected' })
    const staleGeneration = await first.captureRequestGeneration()

    await expect(first.disconnect()).resolves.toEqual({ provider: PROVIDER, status: 'missing' })
    const secondModels = new DeviceCodeModels()
    const second = controllerOf(credentials, secondModels, [], now)
    await expect(second.start()).resolves.toMatchObject({ kind: 'device-code' })
    secondModels.completion.resolve(oauth())
    await waitForStatus(second, 'connected')

    await first.markReconnectRequired(staleGeneration)

    await expect(first.status()).resolves.toEqual({ provider: PROVIDER, status: 'connected' })
    await expect(second.status()).resolves.toEqual({ provider: PROVIDER, status: 'connected' })
    await expect(store.read(PROVIDER)).resolves.toMatchObject({ type: 'oauth' })
  })

  it('does not let a stale pi-ai logout delete a newer connection generation', async () => {
    const credentials = new SharedCredentials(new Context())
    const store = new OpenAICodexCredentialStore(() => credentials)
    await store.modify(PROVIDER, async () => oauth())
    const now = { value: 0 }
    const firstModels = new DeviceCodeModels()
    const first = controllerOf(credentials, firstModels, [], now)
    await expect(first.initialize()).resolves.toEqual({ provider: PROVIDER, status: 'connected' })
    const logout = firstModels.pauseLogout()
    const disconnecting = first.disconnect()
    await logout.reached

    const secondModels = new DeviceCodeModels()
    const second = controllerOf(credentials, secondModels, [], now)
    await expect(second.start()).resolves.toMatchObject({ kind: 'device-code' })
    secondModels.completion.resolve(oauth())
    await waitForStatus(second, 'connected')

    logout.release()
    await expect(disconnecting).resolves.toEqual({ provider: PROVIDER, status: 'connected' })
    await expect(second.status()).resolves.toEqual({ provider: PROVIDER, status: 'connected' })
    await expect(store.read(PROVIDER)).resolves.toMatchObject({ type: 'oauth' })
  })

  it('renews a held lease from the configured TTL before its original expiry', async () => {
    vi.useFakeTimers()
    const credentials = new SharedCredentials(new Context())
    const now = { value: 0 }
    const ttl = { value: 100 }
    const firstModels = new DeviceCodeModels()
    const first = controllerOf(credentials, firstModels, [], now, ttl)
    await first.start()

    now.value = 60
    await vi.advanceTimersByTimeAsync(50)
    now.value = 110
    const secondModels = new DeviceCodeModels()
    const second = controllerOf(credentials, secondModels, [], now, ttl)

    await expect(second.start()).resolves.toMatchObject({ kind: 'already-connecting' })
    expect(secondModels.loginCount).toBe(0)
  })

  it('permits expiry takeover and releases only a matching lease owner', async () => {
    vi.useFakeTimers()
    const credentials = new SharedCredentials(new Context())
    const now = { value: 0 }
    const ttl = { value: 100 }
    const first = controllerOf(
      credentials,
      new DeviceCodeModels(),
      [],
      now,
      ttl,
    )
    await first.start()

    now.value = 101
    const secondModels = new DeviceCodeModels()
    const second = controllerOf(credentials, secondModels, [], now, ttl)
    await expect(second.start()).resolves.toMatchObject({ kind: 'device-code' })
    await first.dispose()

    const thirdModels = new DeviceCodeModels()
    const third = controllerOf(credentials, thirdModels, [], now, ttl)
    await expect(third.start()).resolves.toMatchObject({ kind: 'already-connecting' })
    expect(secondModels.loginCount).toBe(1)
    expect(thirdModels.loginCount).toBe(0)
  })

  it('rechecks a peer after an observed lease expires following credential persistence', async () => {
    vi.useFakeTimers()
    const credentials = new SharedCredentials(new Context())
    await persistGenerationOneCredentialWithLease(credentials, 100)
    const now = { value: 0 }
    const events: LlmOAuthConnection[] = []
    const peer = controllerOf(credentials, new DeviceCodeModels(), events, now)

    await expect(peer.initialize()).resolves.toEqual({ provider: PROVIDER, status: 'connecting' })

    now.value = 100
    await vi.advanceTimersByTimeAsync(100)

    await vi.waitFor(() => {
      expect(events).toEqual([
        { provider: PROVIDER, status: 'connecting' },
        { provider: PROVIDER, status: 'connected' },
      ])
    })
  })

  it('rearms a peer recheck when a live lease is extended before its observed expiry', async () => {
    vi.useFakeTimers()
    const credentials = new SharedCredentials(new Context())
    await persistGenerationOneCredentialWithLease(credentials, 100)
    const now = { value: 0 }
    const events: LlmOAuthConnection[] = []
    const peer = controllerOf(credentials, new DeviceCodeModels(), events, now)

    await expect(peer.initialize()).resolves.toEqual({ provider: PROVIDER, status: 'connecting' })
    await writeGenerationOneLease(credentials, 200)
    await expect(peer.status()).resolves.toEqual({ provider: PROVIDER, status: 'connecting' })

    now.value = 100
    await vi.advanceTimersByTimeAsync(100)
    expect(events).toEqual([{ provider: PROVIDER, status: 'connecting' }])

    now.value = 200
    await vi.advanceTimersByTimeAsync(100)
    await vi.waitFor(() => {
      expect(events).toEqual([
        { provider: PROVIDER, status: 'connecting' },
        { provider: PROVIDER, status: 'connected' },
      ])
    })
  })

  it('cancels an observed lease recheck when the peer is disposed', async () => {
    vi.useFakeTimers()
    const credentials = new SharedCredentials(new Context())
    await persistGenerationOneCredentialWithLease(credentials, 100)
    const now = { value: 0 }
    const events: LlmOAuthConnection[] = []
    const peer = controllerOf(credentials, new DeviceCodeModels(), events, now)

    await expect(peer.initialize()).resolves.toEqual({ provider: PROVIDER, status: 'connecting' })
    await peer.dispose()

    now.value = 100
    await vi.advanceTimersByTimeAsync(100)
    expect(events).toEqual([{ provider: PROVIDER, status: 'connecting' }])
  })

  it('cancels and settles the poller before making its lease available', async () => {
    const credentials = new SharedCredentials(new Context())
    const models = new DeviceCodeModels()
    const events: LlmOAuthConnection[] = []
    const now = { value: 0 }
    const controller = controllerOf(credentials, models, events, now)
    await controller.start()

    await expect(controller.cancel()).resolves.toEqual({ provider: PROVIDER, status: 'missing' })
    expect(models.lastSignal?.aborted).toBe(true)
    const replacementModels = new DeviceCodeModels()
    const replacement = controllerOf(credentials, replacementModels, [], now)
    await expect(replacement.start()).resolves.toMatchObject({ kind: 'device-code' })
    expect(events).toEqual([
      { provider: PROVIDER, status: 'connecting' },
      { provider: PROVIDER, status: 'missing' },
    ])
  })

  it('ordered disposal waits for provider cleanup after aborting', async () => {
    const credentials = new SharedCredentials(new Context())
    const models = new DeviceCodeModels()
    const cleanup = deferred<undefined>()
    models.abortCleanup = cleanup.promise
    const controller = controllerOf(credentials, models, [], { value: 0 })
    await controller.start()

    let disposed = false
    const disposal = controller.dispose().then(() => { disposed = true })
    await Promise.resolve()
    expect(models.lastSignal?.aborted).toBe(true)
    expect(disposed).toBe(false)
    cleanup.resolve(undefined)
    await disposal
    expect(disposed).toBe(true)
  })

  it('disposal waits for setup status and prevents a later poller or event', async () => {
    const credentials = new SharedCredentials(new Context())
    const setup = credentials.pauseOperation(1)
    const models = new DeviceCodeModels()
    const events: LlmOAuthConnection[] = []
    const controller = controllerOf(credentials, models, events, { value: 0 })
    const starting = controller.start()
    await setup.reached

    let disposed = false
    const disposal = controller.dispose().then(() => { disposed = true })
    try {
      await Promise.resolve()
      expect(disposed).toBe(false)
      setup.release()
      await disposal
      await expect(starting).rejects.toMatchObject({ code: 'OPENAI_CODEX_OAUTH' })
      expect(models.loginCount).toBe(0)
      expect(events).toEqual([])
    } finally {
      setup.release()
      await starting.catch(() => undefined)
      await controller.cancel()
    }
  })

  it('disposal settles a claimed setup lease without starting its poller', async () => {
    const credentials = new SharedCredentials(new Context())
    const setup = credentials.pauseOperation(3)
    const models = new DeviceCodeModels()
    const events: LlmOAuthConnection[] = []
    const controller = controllerOf(credentials, models, events, { value: 0 })
    const starting = controller.start()
    await setup.reached

    const disposal = controller.dispose()
    try {
      setup.release()
      await disposal
      await expect(starting).rejects.toMatchObject({ code: 'OPENAI_CODEX_OAUTH' })
      expect(models.loginCount).toBe(0)
      expect(events).toEqual([])

      const replacementModels = new DeviceCodeModels()
      const replacement = controllerOf(credentials, replacementModels, [], { value: 0 })
      await expect(replacement.start()).resolves.toMatchObject({ kind: 'device-code' })
      expect(replacementModels.loginCount).toBe(1)
    } finally {
      setup.release()
      await starting.catch(() => undefined)
      await controller.cancel()
    }
  })

  it('returns already-connecting for a second start while setup is pending', async () => {
    const credentials = new SharedCredentials(new Context())
    const setup = credentials.pauseOperation(1)
    const models = new DeviceCodeModels()
    const controller = controllerOf(credentials, models, [], { value: 0 })
    const first = controller.start()
    await setup.reached

    const second = controller.start()
    try {
      await expect(Promise.race([
        second,
        Promise.resolve({ kind: 'still-pending' as const }),
      ])).resolves.toMatchObject({ kind: 'already-connecting' })
      setup.release()
      await expect(first).resolves.toMatchObject({ kind: 'device-code' })
      expect(models.loginCount).toBe(1)
    } finally {
      setup.release()
      await first.catch(() => undefined)
      await second.catch(() => undefined)
      await controller.cancel()
    }
  })

  it('rejects every prompt other than pi-ai device-code selection', async () => {
    const credentials = new SharedCredentials(new Context())
    const models = new DeviceCodeModels()
    models.prompt = 'manual-code'
    const events: LlmOAuthConnection[] = []
    const controller = controllerOf(credentials, models, events, { value: 0 })

    await expect(controller.start()).rejects.toEqual(expect.objectContaining({
      code: 'OPENAI_CODEX_OAUTH',
      message: 'OpenAI Codex sign-in could not complete',
    }))
    await expect(controller.status()).resolves.toEqual({ provider: PROVIDER, status: 'missing' })
    expect(events).toEqual([
      { provider: PROVIDER, status: 'connecting' },
      { provider: PROVIDER, status: 'missing' },
    ])
  })

  it('rejects a lookalike selector that is not pi-ai\'s supported Codex prompt', async () => {
    const credentials = new SharedCredentials(new Context())
    const models = new DeviceCodeModels()
    models.prompt = 'lookalike-select'
    const controller = controllerOf(credentials, models, [], { value: 0 })

    await expect(controller.start()).rejects.toMatchObject({ code: 'OPENAI_CODEX_OAUTH' })
    expect(models.selections).toEqual([])
  })

  it('disconnects through pi-ai logout and marks failed refreshes for reconnect', async () => {
    const credentials = new SharedCredentials(new Context())
    const store = new OpenAICodexCredentialStore(() => credentials)
    await store.modify(PROVIDER, async () => oauth())
    const models = new DeviceCodeModels()
    const events: LlmOAuthConnection[] = []
    const controller = controllerOf(credentials, models, events, { value: 0 })
    await controller.initialize()
    await expect(controller.status()).resolves.toEqual({ provider: PROVIDER, status: 'connected' })

    await controller.markReconnectRequired(await controller.captureRequestGeneration())
    await expect(controller.status()).resolves.toEqual({ provider: PROVIDER, status: 'reconnect-required' })
    await expect(controller.disconnect()).resolves.toEqual({ provider: PROVIDER, status: 'missing' })
    await expect(store.read(PROVIDER)).resolves.toBeUndefined()
    expect(models.logoutCount).toBe(1)
    expect(events).toEqual([
      { provider: PROVIDER, status: 'connected' },
      { provider: PROVIDER, status: 'reconnect-required' },
      { provider: PROVIDER, status: 'missing' },
    ])
  })
})
