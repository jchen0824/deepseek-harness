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
  Models,
  OAuthCredential,
} from '@earendil-works/pi-ai'
import type { LlmOAuthConnection } from '@deepseek-ai/dsh-llm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OpenAICodexCredentialStore } from '../src/oauth-credential-store.ts'
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
  private pause: {
    operation: number
    reached: Deferred<undefined>
    release: Deferred<undefined>
  } | undefined

  pauseOperation(operation: number): { reached: Promise<undefined>; release: () => void } {
    const reached = deferred<undefined>()
    const release = deferred<undefined>()
    this.pause = { operation, reached, release }
    return { reached: reached.promise, release: () => { release.resolve(undefined) } }
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
    return task
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

  constructor(private readonly store: OpenAICodexCredentialStore) {}

  async login(providerId: string, type: string, interaction: AuthInteraction): Promise<Credential> {
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
      await this.store.modify(PROVIDER, async () => credential)
      return credential
    } catch (error) {
      await this.abortCleanup
      throw error
    }
  }

  async logout(providerId: string): Promise<void> {
    this.logoutCount += 1
    await this.store.delete(providerId)
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
    models: () => models as unknown as Models,
    loginLeaseTtlMs: () => ttl.value,
    emitConnectionUpdated: (connection) => { events.push(connection) },
    now: () => now.value,
    createOwnerId: () => `test-owner-${++ownerCounter}`,
  })
  controllers.push(controller)
  return controller
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
    const store = new OpenAICodexCredentialStore(() => credentials)
    const models = new DeviceCodeModels(store)
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
    const models = new DeviceCodeModels(store)
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
    const firstModels = new DeviceCodeModels(new OpenAICodexCredentialStore(() => credentials))
    const secondModels = new DeviceCodeModels(new OpenAICodexCredentialStore(() => credentials))
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

  it('renews a held lease from the configured TTL before its original expiry', async () => {
    vi.useFakeTimers()
    const credentials = new SharedCredentials(new Context())
    const now = { value: 0 }
    const ttl = { value: 100 }
    const firstModels = new DeviceCodeModels(new OpenAICodexCredentialStore(() => credentials))
    const first = controllerOf(credentials, firstModels, [], now, ttl)
    await first.start()

    now.value = 60
    await vi.advanceTimersByTimeAsync(50)
    now.value = 110
    const secondModels = new DeviceCodeModels(new OpenAICodexCredentialStore(() => credentials))
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
      new DeviceCodeModels(new OpenAICodexCredentialStore(() => credentials)),
      [],
      now,
      ttl,
    )
    await first.start()

    now.value = 101
    const secondModels = new DeviceCodeModels(new OpenAICodexCredentialStore(() => credentials))
    const second = controllerOf(credentials, secondModels, [], now, ttl)
    await expect(second.start()).resolves.toMatchObject({ kind: 'device-code' })
    await first.dispose()

    const thirdModels = new DeviceCodeModels(new OpenAICodexCredentialStore(() => credentials))
    const third = controllerOf(credentials, thirdModels, [], now, ttl)
    await expect(third.start()).resolves.toMatchObject({ kind: 'already-connecting' })
    expect(secondModels.loginCount).toBe(1)
    expect(thirdModels.loginCount).toBe(0)
  })

  it('cancels and settles the poller before making its lease available', async () => {
    const credentials = new SharedCredentials(new Context())
    const models = new DeviceCodeModels(new OpenAICodexCredentialStore(() => credentials))
    const events: LlmOAuthConnection[] = []
    const now = { value: 0 }
    const controller = controllerOf(credentials, models, events, now)
    await controller.start()

    await expect(controller.cancel()).resolves.toEqual({ provider: PROVIDER, status: 'missing' })
    expect(models.lastSignal?.aborted).toBe(true)
    const replacementModels = new DeviceCodeModels(new OpenAICodexCredentialStore(() => credentials))
    const replacement = controllerOf(credentials, replacementModels, [], now)
    await expect(replacement.start()).resolves.toMatchObject({ kind: 'device-code' })
    expect(events).toEqual([
      { provider: PROVIDER, status: 'connecting' },
      { provider: PROVIDER, status: 'missing' },
    ])
  })

  it('ordered disposal waits for provider cleanup after aborting', async () => {
    const credentials = new SharedCredentials(new Context())
    const models = new DeviceCodeModels(new OpenAICodexCredentialStore(() => credentials))
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
    const models = new DeviceCodeModels(new OpenAICodexCredentialStore(() => credentials))
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
    const models = new DeviceCodeModels(new OpenAICodexCredentialStore(() => credentials))
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

      const replacementModels = new DeviceCodeModels(new OpenAICodexCredentialStore(() => credentials))
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
    const models = new DeviceCodeModels(new OpenAICodexCredentialStore(() => credentials))
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
    const models = new DeviceCodeModels(new OpenAICodexCredentialStore(() => credentials))
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
    const models = new DeviceCodeModels(new OpenAICodexCredentialStore(() => credentials))
    models.prompt = 'lookalike-select'
    const controller = controllerOf(credentials, models, [], { value: 0 })

    await expect(controller.start()).rejects.toMatchObject({ code: 'OPENAI_CODEX_OAUTH' })
    expect(models.selections).toEqual([])
  })

  it('disconnects through pi-ai logout and marks failed refreshes for reconnect', async () => {
    const credentials = new SharedCredentials(new Context())
    const store = new OpenAICodexCredentialStore(() => credentials)
    await store.modify(PROVIDER, async () => oauth())
    const models = new DeviceCodeModels(store)
    const events: LlmOAuthConnection[] = []
    const controller = controllerOf(credentials, models, events, { value: 0 })
    await controller.initialize()
    await expect(controller.status()).resolves.toEqual({ provider: PROVIDER, status: 'connected' })

    controller.markReconnectRequired()
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
