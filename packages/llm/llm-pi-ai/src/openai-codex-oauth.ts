/**
 * Host-owned OpenAI Codex device-code lifecycle over pi-ai OAuth.
 *
 * One expiring private lease authorizes one process to run pi-ai's poller.
 * The controller retains a device code only for the initiating call, and all
 * broadcasts contain only the provider route and redacted lifecycle status.
 *
 * @module dsh-llm-pi-ai/openai-codex-oauth
 */

import { randomUUID } from 'node:crypto'
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type {
  LlmOAuthConnection,
  LlmOAuthConnectionStatus,
  LlmOAuthController,
  LlmOAuthDeviceCode,
  LlmOAuthStart,
} from '@deepseek-ai/dsh-llm'
import type { AuthInteraction, AuthPrompt, Models } from '@earendil-works/pi-ai'
import {
  OPENAI_CODEX_LOGIN_LEASE_REF,
  type OpenAICodexCredentialStore,
} from './oauth-credential-store.ts'

const PROVIDER = 'openai-codex'
const OAUTH_ERROR_CODE = 'OPENAI_CODEX_OAUTH'
const DEVICE_CODE_PROMPT_MESSAGE = 'Select OpenAI Codex login method:'

/** Expiring private coordination record shared by Harness processes. */
interface StoredLoginLease {
  version: 1
  ownerId: string
  state: 'pending'
  expiresAt: number
}

/** One deferred result that ignores settlement after its first outcome. */
interface Deferred<T> {
  promise: Promise<T>
  resolve(value: T): void
  reject(error: unknown): void
  readonly settled: boolean
}

/** One locally owned login attempt and its complete settlement. */
interface LoginAttempt {
  ownerId: string
  abort: AbortController
  startup: Deferred<LlmOAuthStart>
  deviceCode?: LlmOAuthDeviceCode
  ownsLease: boolean
  phase: 'setup' | 'polling' | 'settled'
  done: Promise<void>
}

/** Dependencies retained for the controller's full host lifetime. */
export interface OpenAICodexOAuthControllerOptions {
  /** Resolve the currently mounted private credential provider. */
  credentials: () => CredentialProvider | undefined
  /** Stable pi-ai credential store shared by every immutable model snapshot. */
  credentialStore: OpenAICodexCredentialStore
  /** Return the current full-profile model snapshot, including dormant routes. */
  models: () => Models
  /** Return the current validated login-lease lifetime. */
  loginLeaseTtlMs: () => number
  /** Publish one redacted status transition through the LLM runtime. */
  emitConnectionUpdated: (connection: LlmOAuthConnection) => void
  /** Clock seam for deterministic lease tests. */
  now?: () => number
  /** Opaque lease-owner generator; production uses random UUIDs. */
  createOwnerId?: () => string
}

/** Create a single-settlement deferred value. */
function deferred<T>(): Deferred<T> {
  let accept!: (value: T) => void
  let decline!: (error: unknown) => void
  let settled = false
  const promise = new Promise<T>((resolve, reject) => {
    accept = resolve
    decline = reject
  })
  return {
    promise,
    resolve(value) {
      if (settled) return
      settled = true
      accept(value)
    },
    reject(error) {
      if (settled) return
      settled = true
      decline(error)
    },
    get settled() { return settled },
  }
}

/** Return the package's redacted interactive-login failure. */
function oauthFailure(): LlmError {
  return new LlmError('OpenAI Codex sign-in could not complete', OAUTH_ERROR_CODE)
}

/** Narrow a parsed JSON value to an ordinary object. */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Decode an absent or versioned login lease. */
function decodeLease(value: string | undefined): StoredLoginLease | undefined {
  if (value === undefined) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw oauthFailure()
  }
  if (!isObject(parsed)
    || parsed.version !== 1
    || typeof parsed.ownerId !== 'string'
    || parsed.ownerId.length === 0
    || parsed.state !== 'pending'
    || typeof parsed.expiresAt !== 'number'
    || !Number.isFinite(parsed.expiresAt)) {
    throw oauthFailure()
  }
  return parsed as unknown as StoredLoginLease
}

/** Encode one validated private login lease. */
function encodeLease(lease: StoredLoginLease): string {
  return JSON.stringify(lease)
}

/** Wait for one timer interval, resolving false when cancellation wins. */
function wait(delayMs: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false)
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve(true)
    }, delayMs)
    const onAbort = (): void => {
      clearTimeout(timer)
      resolve(false)
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/** Device-code-only OAuth controller for the catalogued OpenAI Codex route. */
export class OpenAICodexOAuthController implements LlmOAuthController {
  readonly provider = PROVIDER
  private connectionStatus: LlmOAuthConnectionStatus = 'missing'
  private reconnectRequired = false
  private attempt: LoginAttempt | undefined
  private disposed = false
  private disposal: Promise<void> | undefined
  private readonly now: () => number
  private readonly createOwnerId: () => string

  constructor(private readonly options: OpenAICodexOAuthControllerOptions) {
    this.now = options.now ?? Date.now
    this.createOwnerId = options.createOwnerId ?? randomUUID
  }

  /** Return the current detached redacted connection. */
  private connection(): LlmOAuthConnection {
    return { provider: PROVIDER, status: this.connectionStatus }
  }

  /** Return the setup/polling state without mutating the last published state. */
  private connectingConnection(): LlmOAuthConnection {
    return { provider: PROVIDER, status: 'connecting' }
  }

  /** Commit and broadcast one status transition. */
  private publish(status: LlmOAuthConnectionStatus): LlmOAuthConnection {
    if (this.connectionStatus === status) return this.connection()
    this.connectionStatus = status
    const connection = this.connection()
    if (!this.disposed) this.options.emitConnectionUpdated(connection)
    return connection
  }

  /** Resolve the credential provider without disclosing why it is absent. */
  private credentials(): CredentialProvider {
    const credentials = this.options.credentials()
    if (credentials === undefined) throw oauthFailure()
    return credentials
  }

  /** Read the current validated lease under the provider's cross-process lock. */
  private async readLease(): Promise<StoredLoginLease | undefined> {
    try {
      return await this.credentials().modify(OPENAI_CODEX_LOGIN_LEASE_REF, current => Promise.resolve({
        value: current,
        result: decodeLease(current),
        visibility: 'private',
      }))
    } catch {
      throw oauthFailure()
    }
  }

  /** Return the current positive bounded TTL supplied by validated config. */
  private leaseTtlMs(): number {
    const value = this.options.loginLeaseTtlMs()
    if (!Number.isInteger(value) || value <= 0) throw oauthFailure()
    return value
  }

  /** Atomically claim an absent or expired lease for one new owner. */
  private async claimLease(ownerId: string): Promise<boolean> {
    const now = this.now()
    const expiresAt = now + this.leaseTtlMs()
    try {
      return await this.credentials().modify(OPENAI_CODEX_LOGIN_LEASE_REF, (currentValue) => {
        const current = decodeLease(currentValue)
        if (current !== undefined && current.expiresAt > now) {
          return Promise.resolve({ value: currentValue, result: false, visibility: 'private' as const })
        }
        return Promise.resolve({
          value: encodeLease({ version: 1, ownerId, state: 'pending', expiresAt }),
          result: true,
          visibility: 'private' as const,
        })
      })
    } catch {
      throw oauthFailure()
    }
  }

  /** Renew only an unexpired lease still owned by this attempt. */
  private async renewLease(ownerId: string): Promise<boolean> {
    const now = this.now()
    const expiresAt = now + this.leaseTtlMs()
    try {
      return await this.credentials().modify(OPENAI_CODEX_LOGIN_LEASE_REF, (currentValue) => {
        const current = decodeLease(currentValue)
        if (current === undefined || current.ownerId !== ownerId || current.expiresAt <= now) {
          return Promise.resolve({ value: currentValue, result: false, visibility: 'private' as const })
        }
        return Promise.resolve({
          value: encodeLease({ ...current, expiresAt }),
          result: true,
          visibility: 'private' as const,
        })
      })
    } catch {
      throw oauthFailure()
    }
  }

  /** Release only the lease whose owner still matches this attempt. */
  private async releaseLease(ownerId: string): Promise<void> {
    try {
      await this.credentials().modify(OPENAI_CODEX_LOGIN_LEASE_REF, (currentValue) => {
        const current = decodeLease(currentValue)
        return Promise.resolve(current?.ownerId === ownerId
          ? { value: undefined, result: undefined, visibility: 'private' }
          : { value: currentValue, result: undefined, visibility: 'private' })
      })
    } catch {
      throw oauthFailure()
    }
  }

  /** Renew until the login settles; losing ownership aborts the poller. */
  private async renewUntilSettled(attempt: LoginAttempt): Promise<void> {
    while (!attempt.abort.signal.aborted) {
      const delayMs = Math.max(1, Math.floor(this.leaseTtlMs() / 2))
      if (!await wait(delayMs, attempt.abort.signal)) return
      try {
        if (!await this.renewLease(attempt.ownerId)) {
          attempt.abort.abort('OpenAI Codex login lease expired or changed owner')
          return
        }
      } catch {
        attempt.abort.abort('OpenAI Codex login lease renewal failed')
        return
      }
    }
  }

  /** Accept only pi-ai's supported device-code selector. */
  private prompt(attempt: LoginAttempt, prompt: AuthPrompt): Promise<string> {
    if (attempt.abort.signal.aborted || prompt.signal?.aborted) throw oauthFailure()
    if (prompt.type !== 'select'
      || prompt.message !== DEVICE_CODE_PROMPT_MESSAGE
      || prompt.options.length !== 2
      || prompt.options[0]?.id !== 'browser'
      || prompt.options[0].label !== 'Browser login (default)'
      || prompt.options[0].description !== undefined
      || prompt.options[1]?.id !== 'device_code'
      || prompt.options[1].label !== 'Device code login (headless)'
      || prompt.options[1].description !== undefined) {
      throw oauthFailure()
    }
    return Promise.resolve('device_code')
  }

  /** Retain only a detached device-code event for the initiating call. */
  private notify(attempt: LoginAttempt, event: Parameters<AuthInteraction['notify']>[0]): void {
    if (event.type !== 'device_code' || this.attempt !== attempt || attempt.abort.signal.aborted) return
    const deviceCode: LlmOAuthDeviceCode = {
      verificationUri: event.verificationUri,
      userCode: event.userCode,
      ...event.intervalSeconds === undefined ? {} : { intervalSeconds: event.intervalSeconds },
      ...event.expiresInSeconds === undefined ? {} : { expiresInSeconds: event.expiresInSeconds },
    }
    attempt.deviceCode = deviceCode
    attempt.startup.resolve({
      kind: 'device-code',
      connection: this.connectingConnection(),
      deviceCode,
    })
  }

  /** Derive the terminal redacted state after login cancellation or failure. */
  private async failedAttemptStatus(ownerId: string): Promise<LlmOAuthConnectionStatus> {
    try {
      const lease = await this.readLease()
      if (lease !== undefined && lease.ownerId !== ownerId && lease.expiresAt > this.now()) return 'connecting'
      return await this.options.credentialStore.read(PROVIDER) === undefined
        ? 'missing'
        : 'reconnect-required'
    } catch {
      return 'reconnect-required'
    }
  }

  /** Refuse setup or polling after local cancellation/disposal wins. */
  private assertActive(attempt: LoginAttempt): void {
    if (this.disposed || attempt.abort.signal.aborted) throw oauthFailure()
  }

  /** Read current cross-process state without the local-attempt shortcut. */
  private async inspectStatus(): Promise<LlmOAuthConnection> {
    try {
      const lease = await this.readLease()
      if (lease !== undefined && lease.expiresAt > this.now()) return this.publish('connecting')
      if (this.reconnectRequired) return this.publish('reconnect-required')
      const credential = await this.options.credentialStore.read(PROVIDER)
      return this.publish(credential === undefined ? 'missing' : 'connected')
    } catch {
      return this.publish('reconnect-required')
    }
  }

  /** Run setup, pi-ai login, renewal, and matching release to settlement. */
  private async runAttempt(attempt: LoginAttempt): Promise<void> {
    let renewal: Promise<void> | undefined
    try {
      const current = await this.inspectStatus()
      this.assertActive(attempt)
      if (current.status === 'connected') {
        attempt.phase = 'settled'
        attempt.startup.resolve({ kind: 'connected', connection: current })
        return
      }
      if (current.status === 'connecting') {
        attempt.phase = 'settled'
        attempt.startup.resolve({ kind: 'already-connecting', connection: current })
        return
      }

      attempt.ownsLease = await this.claimLease(attempt.ownerId)
      this.assertActive(attempt)
      if (!attempt.ownsLease) {
        attempt.phase = 'settled'
        attempt.startup.resolve({
          kind: 'already-connecting',
          connection: this.publish('connecting'),
        })
        return
      }

      this.publish('connecting')
      attempt.phase = 'polling'
      renewal = this.renewUntilSettled(attempt)
      const interaction: AuthInteraction = {
        signal: attempt.abort.signal,
        prompt: prompt => this.prompt(attempt, prompt),
        notify: (event) => { this.notify(attempt, event) },
      }
      await this.options.models().login(PROVIDER, 'oauth', interaction)
      if (attempt.abort.signal.aborted) throw oauthFailure()
      if (await this.options.credentialStore.read(PROVIDER) === undefined) throw oauthFailure()
      this.reconnectRequired = false
      attempt.phase = 'settled'
      const connection = this.publish('connected')
      attempt.startup.resolve({ kind: 'connected', connection })
    } catch {
      attempt.phase = 'settled'
      this.publish(await this.failedAttemptStatus(attempt.ownerId))
      attempt.startup.reject(oauthFailure())
    } finally {
      delete attempt.deviceCode
      attempt.abort.abort('OpenAI Codex login settled')
      if (renewal !== undefined) await renewal
      if (attempt.ownsLease) {
        try {
          await this.releaseLease(attempt.ownerId)
        } catch {
          attempt.startup.reject(oauthFailure())
        }
      }
      if (this.attempt === attempt) this.attempt = undefined
    }
  }

  /**
   * Initialize the redacted state from the private credential and lease records.
   * @returns the current redacted connection.
   */
  initialize(): Promise<LlmOAuthConnection> {
    return this.status()
  }

  /** Read current cross-process lease and credential state. */
  async status(): Promise<LlmOAuthConnection> {
    if (this.attempt !== undefined) {
      return this.attempt.phase === 'settled' ? this.connection() : this.connectingConnection()
    }
    return this.inspectStatus()
  }

  /** Own setup cancellation before beginning any awaited cross-process operation. */
  start(): Promise<LlmOAuthStart> {
    if (this.disposed) return Promise.reject(oauthFailure())
    if (this.attempt !== undefined) {
      if (this.attempt.phase === 'settled' && this.connectionStatus === 'connected') {
        return Promise.resolve({ kind: 'connected', connection: this.connection() })
      }
      return Promise.resolve({
        kind: 'already-connecting',
        connection: this.connectingConnection(),
      })
    }

    const attempt: LoginAttempt = {
      ownerId: this.createOwnerId(),
      abort: new AbortController(),
      startup: deferred<LlmOAuthStart>(),
      ownsLease: false,
      phase: 'setup',
      done: Promise.resolve(),
    }
    this.attempt = attempt
    attempt.done = this.runAttempt(attempt)
    return attempt.startup.promise
  }

  /** Cancel and settle a locally owned login attempt. */
  async cancel(): Promise<LlmOAuthConnection> {
    const attempt = this.attempt
    if (attempt !== undefined) {
      attempt.abort.abort('OpenAI Codex login cancelled')
      await attempt.done
    }
    return this.status()
  }

  /** Cancel login, remove the OAuth credential through pi-ai, and publish missing. */
  async disconnect(): Promise<LlmOAuthConnection> {
    await this.cancel()
    try {
      await this.options.models().logout(PROVIDER)
    } catch {
      throw oauthFailure()
    }
    this.reconnectRequired = false
    this.publish('missing')
    return this.status()
  }

  /** Mark a request-time OAuth refresh failure without retaining provider data. */
  markReconnectRequired(): void {
    this.reconnectRequired = true
    this.publish('reconnect-required')
  }

  /** Abort and await every locally owned lifecycle task before disposal returns. */
  dispose(): Promise<void> {
    this.disposal ??= this.disposeOwnedAttempt()
    return this.disposal
  }

  /** Ordered disposal implementation shared by repeat callers. */
  private async disposeOwnedAttempt(): Promise<void> {
    this.disposed = true
    const attempt = this.attempt
    if (attempt === undefined) return
    attempt.abort.abort('OpenAI Codex OAuth controller disposed')
    await attempt.done
  }
}
