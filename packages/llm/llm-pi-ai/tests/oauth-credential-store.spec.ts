import { Context } from '@deepseek-ai/cordis'
import { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import type {
  CredentialInfo as HarnessCredentialInfo,
  CredentialMutation,
  CredentialRef,
  ResolvedCredential,
} from '@deepseek-ai/dsh-credentials'
import { createModels } from '@earendil-works/pi-ai'
import type { OAuthCredential, Provider } from '@earendil-works/pi-ai'
import { describe, expect, it } from 'vitest'
import { OpenAICodexCredentialStore } from '../src/oauth-credential-store.ts'

const PROVIDER = 'openai-codex'

/** Serialized credential double with an optional read-only environment shadow. */
class AtomicCredentials extends CredentialProvider {
  private readonly values = new Map<CredentialRef, string>()
  private operations: Promise<void> = Promise.resolve()
  private nextSeed: string | undefined
  readonly visibilities: string[] = []
  shadowed = false

  seedNextReference(value: string): void {
    this.nextSeed = value
  }

  latestStoredValue(): string | undefined {
    return [...this.values.values()].at(-1)
  }

  override resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    const value = this.values.get(ref)
    return Promise.resolve(value === undefined ? undefined : { value, source: 'memory' })
  }

  override describe(ref: CredentialRef): Promise<HarnessCredentialInfo> {
    if (this.shadowed) return Promise.resolve({ configured: true, source: 'env', writable: false })
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
      if (this.shadowed) throw new Error('read-only launch environment contains confidential data')
      if (!this.values.has(ref) && this.nextSeed !== undefined) {
        this.values.set(ref, this.nextSeed)
        this.nextSeed = undefined
      }
      const mutation = await mutate(this.values.get(ref))
      this.visibilities.push(mutation.visibility)
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

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

describe('OpenAICodexCredentialStore', () => {
  it('treats an absent record and unrelated providers as missing', async () => {
    const credentials = new AtomicCredentials(new Context())
    const store = new OpenAICodexCredentialStore(() => credentials)

    await expect(store.read(PROVIDER)).resolves.toBeUndefined()
    await expect(store.read('deepseek')).resolves.toBeUndefined()
    await expect(store.list()).resolves.toEqual([])
  })

  it('persists only OAuth credentials through private atomic mutations', async () => {
    const credentials = new AtomicCredentials(new Context())
    const store = new OpenAICodexCredentialStore(() => credentials)

    await store.modify(PROVIDER, async () => oauth())

    expect((await store.read(PROVIDER))?.type).toBe('oauth')
    await expect(store.list()).resolves.toEqual([{ providerId: PROVIDER, type: 'oauth' }])
    const stored = JSON.parse(credentials.latestStoredValue() ?? '{}') as {
      version?: unknown
      credential?: { type?: unknown }
    }
    expect({ version: stored.version, credentialType: stored.credential?.type }).toEqual({
      version: 1, credentialType: 'oauth',
    })
    expect(credentials.visibilities.every(visibility => visibility === 'private')).toBe(true)
  })

  it('rejects unsupported writes and non-OAuth proposed credentials', async () => {
    const credentials = new AtomicCredentials(new Context())
    const store = new OpenAICodexCredentialStore(() => credentials)

    await expect(store.modify('deepseek', async () => oauth())).rejects.toMatchObject({
      code: 'OPENAI_CODEX_AUTH_STORAGE',
    })
    await expect(store.modify(PROVIDER, async () => ({ type: 'api_key', key: 'not-accepted' })))
      .rejects.toMatchObject({ code: 'OPENAI_CODEX_AUTH_STORAGE' })
  })

  it('turns malformed durable data and environment shadowing into one redacted failure', async () => {
    const malformed = new AtomicCredentials(new Context())
    malformed.seedNextReference('{"version":2,"credential":{"type":"oauth"}}')
    const malformedStore = new OpenAICodexCredentialStore(() => malformed)

    await expect(malformedStore.read(PROVIDER)).rejects.toEqual(expect.objectContaining({
      code: 'OPENAI_CODEX_AUTH_STORAGE',
      message: 'OpenAI Codex authentication storage is unavailable',
    }))

    const shadowed = new AtomicCredentials(new Context())
    shadowed.shadowed = true
    const shadowedStore = new OpenAICodexCredentialStore(() => shadowed)
    await expect(shadowedStore.read(PROVIDER)).rejects.toEqual(expect.objectContaining({
      code: 'OPENAI_CODEX_AUTH_STORAGE',
      message: 'OpenAI Codex authentication storage is unavailable',
    }))
  })

  it('serializes pi-ai refresh across model collections sharing the store', async () => {
    const credentials = new AtomicCredentials(new Context())
    const store = new OpenAICodexCredentialStore(() => credentials)
    await store.modify(PROVIDER, async () => oauth(0))
    const entered = deferred()
    const release = deferred()
    let refreshes = 0
    const provider = {
      id: PROVIDER,
      name: 'Codex test provider',
      auth: {
        oauth: {
          name: 'Codex test OAuth',
          login: async () => oauth(),
          refresh: async () => {
            refreshes += 1
            entered.resolve()
            await release.promise
            return oauth()
          },
          toAuth: async () => ({}),
        },
      },
      getModels: () => [],
      stream: () => { throw new Error('not used') },
      streamSimple: () => { throw new Error('not used') },
    } satisfies Provider
    const firstModels = createModels({ credentials: store })
    const secondModels = createModels({ credentials: store })
    firstModels.setProvider(provider)
    secondModels.setProvider(provider)

    const first = firstModels.getAuth(PROVIDER)
    await entered.promise
    const second = secondModels.getAuth(PROVIDER)
    await Promise.resolve()
    expect(refreshes).toBe(1)
    release.resolve()
    await expect(Promise.all([first, second])).resolves.toEqual([
      { auth: {}, source: 'OAuth' },
      { auth: {}, source: 'OAuth' },
    ])
    expect(refreshes).toBe(1)
  })

  it('deletes the stored connection through pi-ai logout', async () => {
    const credentials = new AtomicCredentials(new Context())
    const store = new OpenAICodexCredentialStore(() => credentials)
    await store.modify(PROVIDER, async () => oauth())
    const models = createModels({ credentials: store })

    await models.logout(PROVIDER)

    await expect(store.read(PROVIDER)).resolves.toBeUndefined()
    expect(credentials.visibilities.every(visibility => visibility === 'private')).toBe(true)
  })
})
