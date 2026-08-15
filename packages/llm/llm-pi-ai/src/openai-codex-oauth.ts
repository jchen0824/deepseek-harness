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
  startup: Deferred<LlmOAuthDeviceCode | undefined>
  deviceCode?: LlmOAuthDeviceCode
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
    attempt.startup.resolve(deviceCode)
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

  /** Run pi-ai login, renewal, state publication, and matching release to settlement. */
  private async runAttempt(attempt: LoginAttempt): Promise<void> {
    const renewal = this.renewUntilSettled(attempt)
    try {
      const interaction: AuthInteraction = {
        signal: attempt.abort.signal,
        prompt: prompt => this.prompt(attempt, prompt),
        notify: (event) => { this.notify(attempt, event) },
      }
      await this.options.models().login(PROVIDER, 'oauth', interaction)
      if (attempt.abort.signal.aborted) throw oauthFailure()
      if (await this.options.credentialStore.read(PROVIDER) === undefined) throw oauthFailure()
      this.reconnectRequired = false
      this.publish('connected')
      attempt.startup.resolve(undefined)
    } catch {
      this.publish(await this.failedAttemptStatus(attempt.ownerId))
      attempt.startup.reject(oauthFailure())
    } finally {
      delete attempt.deviceCode
      attempt.abort.abort('OpenAI Codex login settled')
      await renewal
      try {
        await this.releaseLease(attempt.ownerId)
      } catch {
        attempt.startup.reject(oauthFailure())
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
    if (this.attempt !== undefined && this.connectionStatus === 'connecting') return this.connection()
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

  /** Claim the lease and begin pi-ai's device-code flow without awaiting completion. */
  async start(): Promise<LlmOAuthStart> {
    if (this.disposed) throw oauthFailure()
    const current = await this.status()
    if (current.status === 'connected') return { kind: 'connected', connection: current }
    if (current.status === 'connecting') return { kind: 'already-connecting', connection: current }

    const ownerId = this.createOwnerId()
    if (!await this.claimLease(ownerId)) {
      return { kind: 'already-connecting', connection: this.publish('connecting') }
    }
    const attempt: LoginAttempt = {
      ownerId,
      abort: new AbortController(),
      startup: deferred<LlmOAuthDeviceCode | undefined>(),
      done: Promise.resolve(),
    }
    this.attempt = attempt
    this.publish('connecting')
    attempt.done = this.runAttempt(attempt)
    const deviceCode = await attempt.startup.promise
    if (deviceCode !== undefined) {
      return { kind: 'device-code', connection: this.connection(), deviceCode }
    }
    return { kind: 'connected', connection: this.connection() }
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
