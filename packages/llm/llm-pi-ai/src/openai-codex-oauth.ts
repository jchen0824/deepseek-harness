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
import type { AuthInteraction, AuthPrompt, CredentialStore, Models } from '@earendil-works/pi-ai'
import {
  OPENAI_CODEX_LOGIN_LEASE_REF,
  type OpenAICodexCredentialStore,
} from './oauth-credential-store.ts'

const PROVIDER = 'openai-codex'
const OAUTH_ERROR_CODE = 'OPENAI_CODEX_OAUTH'
const DEVICE_CODE_PROMPT_MESSAGE = 'Select OpenAI Codex login method:'

/** Expiring lease carried by the private cross-process coordination record. */
interface StoredLoginLease {
  ownerId: string
  state: 'pending'
  expiresAt: number
}

/** Durable generation, reconnect state, and optional login lease. */
interface StoredOAuthCoordination {
  version: 2
  generation: number
  reconnectRequired: boolean
  lease?: StoredLoginLease
}

/** Generation transition assigned to one successful lease claim. */
interface LoginAuthority {
  previousGeneration: number
  generation: number
}

/** Credential cleanup decided from the lease revoked by one authority change. */
interface AuthorityRevocation {
  generation: number
  clearCredential: boolean
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
  authority?: LoginAuthority
  abort: AbortController
  startup: Deferred<LlmOAuthStart>
  deviceCode?: LlmOAuthDeviceCode
  phase: 'setup' | 'polling' | 'settled'
  done: Promise<void>
}

/** One cancellable status recheck for a lease observed in another process. */
interface LeaseExpiryRefresh {
  expiresAt: number
  abort: AbortController
  done: Promise<void>
}

/** Dependencies retained for the controller's full host lifetime. */
export interface OpenAICodexOAuthControllerOptions {
  /** Resolve the currently mounted private credential provider. */
  credentials: () => CredentialProvider | undefined
  /** Stable pi-ai credential store shared by every immutable model snapshot. */
  credentialStore: OpenAICodexCredentialStore
  /** Build a current full-profile model snapshot over the supplied credential store. */
  models: (credentialStore: CredentialStore) => Models
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

/** Return the initial durable coordination state. */
function initialCoordination(): StoredOAuthCoordination {
  return { version: 2, generation: 0, reconnectRequired: false }
}

/** Decode an absent or versioned coordination record. */
function decodeCoordination(value: string | undefined): StoredOAuthCoordination {
  if (value === undefined) return initialCoordination()
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw oauthFailure()
  }
  if (!isObject(parsed)
    || parsed.version !== 2
    || typeof parsed.generation !== 'number'
    || !Number.isSafeInteger(parsed.generation)
    || parsed.generation < 0
    || typeof parsed.reconnectRequired !== 'boolean') {
    throw oauthFailure()
  }
  if (parsed.lease !== undefined) {
    if (!isObject(parsed.lease)
      || typeof parsed.lease.ownerId !== 'string'
      || parsed.lease.ownerId.length === 0
      || parsed.lease.state !== 'pending'
      || typeof parsed.lease.expiresAt !== 'number'
      || !Number.isFinite(parsed.lease.expiresAt)) {
      throw oauthFailure()
    }
  }
  return parsed as unknown as StoredOAuthCoordination
}

/** Encode one validated private coordination record. */
function encodeCoordination(coordination: StoredOAuthCoordination): string {
  return JSON.stringify(coordination)
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
  private attempt: LoginAttempt | undefined
  private leaseExpiryRefresh: LeaseExpiryRefresh | undefined
  private readonly leaseExpiryRefreshes = new Set<Promise<void>>()
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

  /** Read the current validated coordination state under the cross-process lock. */
  private async readCoordination(): Promise<StoredOAuthCoordination> {
    try {
      return await this.credentials().modify(OPENAI_CODEX_LOGIN_LEASE_REF, current => Promise.resolve({
        value: current,
        result: decodeCoordination(current),
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

  /** Atomically claim an absent or expired lease and advance its generation. */
  private async claimLease(ownerId: string): Promise<LoginAuthority | undefined> {
    const now = this.now()
    const expiresAt = now + this.leaseTtlMs()
    try {
      return await this.credentials().modify(OPENAI_CODEX_LOGIN_LEASE_REF, (currentValue) => {
        const current = decodeCoordination(currentValue)
        if (current.lease !== undefined && current.lease.expiresAt > now) {
          return Promise.resolve({ value: currentValue, result: undefined, visibility: 'private' as const })
        }
        const generation = current.generation + 1
        return Promise.resolve({
          value: encodeCoordination({
            ...current,
            generation,
            lease: { ownerId, state: 'pending', expiresAt },
          }),
          result: { previousGeneration: current.generation, generation },
          visibility: 'private' as const,
        })
      })
    } catch {
      throw oauthFailure()
    }
  }

  /** Renew only an unexpired lease still owned by this attempt. */
  private async renewLease(ownerId: string, generation: number): Promise<boolean> {
    const now = this.now()
    const expiresAt = now + this.leaseTtlMs()
    try {
      return await this.credentials().modify(OPENAI_CODEX_LOGIN_LEASE_REF, (currentValue) => {
        const current = decodeCoordination(currentValue)
        if (current.generation !== generation
          || current.lease === undefined
          || current.lease.ownerId !== ownerId
          || current.lease.expiresAt <= now) {
          return Promise.resolve({ value: currentValue, result: false, visibility: 'private' as const })
        }
        return Promise.resolve({
          value: encodeCoordination({
            ...current,
            lease: { ...current.lease, expiresAt },
          }),
          result: true,
          visibility: 'private' as const,
        })
      })
    } catch {
      throw oauthFailure()
    }
  }

  /** Release only the lease whose owner still matches this attempt. */
  private async releaseLease(ownerId: string, generation: number): Promise<void> {
    try {
      await this.credentials().modify(OPENAI_CODEX_LOGIN_LEASE_REF, (currentValue) => {
        const current = decodeCoordination(currentValue)
        if (current.generation !== generation || current.lease?.ownerId !== ownerId) {
          return Promise.resolve({ value: currentValue, result: undefined, visibility: 'private' })
        }
        return Promise.resolve({
          value: encodeCoordination({
            version: 2,
            generation: current.generation,
            reconnectRequired: current.reconnectRequired,
          }),
          result: undefined,
          visibility: 'private',
        })
      })
    } catch {
      throw oauthFailure()
    }
  }

  /** Renew until the login settles; losing ownership aborts the poller. */
  private async renewUntilSettled(attempt: LoginAttempt): Promise<void> {
    const authority = attempt.authority
    if (authority === undefined) return
    while (!attempt.abort.signal.aborted) {
      const delayMs = Math.max(1, Math.floor(this.leaseTtlMs() / 2))
      if (!await wait(delayMs, attempt.abort.signal)) return
      try {
        if (!await this.renewLease(attempt.ownerId, authority.generation)) {
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

  /** Advance durable authority and optionally remove the committed credential. */
  private async revokeAuthority(
    clearCredential: 'always' | 'when-leased',
    clearReconnectRequired: boolean,
  ): Promise<AuthorityRevocation> {
    let revocation: AuthorityRevocation
    try {
      revocation = await this.credentials().modify(OPENAI_CODEX_LOGIN_LEASE_REF, (currentValue) => {
        const current = decodeCoordination(currentValue)
        const next: StoredOAuthCoordination = {
          version: 2,
          generation: current.generation + 1,
          reconnectRequired: clearReconnectRequired ? false : current.reconnectRequired,
        }
        return Promise.resolve({
          value: encodeCoordination(next),
          result: {
            generation: next.generation,
            clearCredential: clearCredential === 'always' || current.lease !== undefined,
          },
          visibility: 'private' as const,
        })
      })
      await this.options.credentialStore.revokeGeneration(
        revocation.generation,
        revocation.clearCredential,
      )
      return revocation
    } catch {
      throw oauthFailure()
    }
  }

  /** Commit successful login only while its exact lease generation remains current. */
  private async completeLogin(ownerId: string, generation: number): Promise<boolean> {
    try {
      return await this.credentials().modify(OPENAI_CODEX_LOGIN_LEASE_REF, (currentValue) => {
        const current = decodeCoordination(currentValue)
        if (current.generation !== generation || current.lease?.ownerId !== ownerId) {
          return Promise.resolve({ value: currentValue, result: false, visibility: 'private' as const })
        }
        if (current.lease.expiresAt <= this.now()) {
          return Promise.resolve({ value: currentValue, result: false, visibility: 'private' as const })
        }
        return Promise.resolve({
          value: encodeCoordination({ ...current, reconnectRequired: false }),
          result: true,
          visibility: 'private' as const,
        })
      })
    } catch {
      throw oauthFailure()
    }
  }

  /** Stop the one pending recheck without changing durable lease state. */
  private cancelLeaseExpiryRefresh(): void {
    const refresh = this.leaseExpiryRefresh
    if (refresh === undefined) return
    this.leaseExpiryRefresh = undefined
    refresh.abort.abort('OpenAI Codex observed login lease changed')
  }

  /** Remove a settled recheck only when it is still the current one. */
  private finishLeaseExpiryRefresh(refresh: LeaseExpiryRefresh, done: Promise<void>): void {
    this.leaseExpiryRefreshes.delete(done)
    if (this.leaseExpiryRefresh === refresh) this.leaseExpiryRefresh = undefined
  }

  /** Wait for an observed lease to expire, then re-read durable OAuth state. */
  private async recheckLeaseExpiry(refresh: LeaseExpiryRefresh): Promise<void> {
    try {
      const delayMs = Math.max(1, refresh.expiresAt - this.now())
      if (!await wait(delayMs, refresh.abort.signal) || this.disposed) return
      await this.inspectStatus()
    } catch {
      // This detached recheck has no caller; inspectStatus already redacts durable-state failures.
    }
  }

  /** Arm one local recheck for a live lease observed from another process. */
  private scheduleLeaseExpiryRefresh(expiresAt: number): void {
    if (this.disposed || this.leaseExpiryRefresh?.expiresAt === expiresAt) return
    this.cancelLeaseExpiryRefresh()
    const refresh: LeaseExpiryRefresh = {
      expiresAt,
      abort: new AbortController(),
      done: Promise.resolve(),
    }
    this.leaseExpiryRefresh = refresh
    const done = this.recheckLeaseExpiry(refresh)
    refresh.done = done
    this.leaseExpiryRefreshes.add(done)
    void done.then(() => { this.finishLeaseExpiryRefresh(refresh, done) })
  }

  /** Derive one redacted status entirely from durable cross-process state. */
  private async durableStatus(): Promise<LlmOAuthConnectionStatus> {
    const coordination = await this.readCoordination()
    if (coordination.lease !== undefined && coordination.lease.expiresAt > this.now()) {
      this.scheduleLeaseExpiryRefresh(coordination.lease.expiresAt)
      return 'connecting'
    }
    this.cancelLeaseExpiryRefresh()
    if (coordination.reconnectRequired) return 'reconnect-required'
    const credential = await this.options.credentialStore.readForGeneration(coordination.generation)
    return credential === undefined ? 'missing' : 'connected'
  }

  /** Derive the terminal redacted state after login cancellation or failure. */
  private async failedAttemptStatus(): Promise<LlmOAuthConnectionStatus> {
    try {
      return await this.durableStatus()
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
      return this.publish(await this.durableStatus())
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

      const authority = await this.claimLease(attempt.ownerId)
      if (authority !== undefined) attempt.authority = authority
      this.assertActive(attempt)
      if (authority === undefined) {
        attempt.phase = 'settled'
        attempt.startup.resolve({
          kind: 'already-connecting',
          connection: this.publish('connecting'),
        })
        return
      }
      const loginStore = await this.options.credentialStore.beginLogin(
        authority.previousGeneration,
        authority.generation,
      )
      this.assertActive(attempt)

      this.publish('connecting')
      attempt.phase = 'polling'
      renewal = this.renewUntilSettled(attempt)
      const interaction: AuthInteraction = {
        signal: attempt.abort.signal,
        prompt: prompt => this.prompt(attempt, prompt),
        notify: (event) => { this.notify(attempt, event) },
      }
      await this.options.models(loginStore).login(PROVIDER, 'oauth', interaction)
      if (attempt.abort.signal.aborted) throw oauthFailure()
      if (await this.options.credentialStore.readForGeneration(authority.generation) === undefined) {
        throw oauthFailure()
      }
      if (!await this.completeLogin(attempt.ownerId, authority.generation)) throw oauthFailure()
      attempt.phase = 'settled'
      const connection = this.publish('connected')
      attempt.startup.resolve({ kind: 'connected', connection })
    } catch {
      attempt.phase = 'settled'
      this.publish(await this.failedAttemptStatus())
      attempt.startup.reject(oauthFailure())
    } finally {
      delete attempt.deviceCode
      attempt.abort.abort('OpenAI Codex login settled')
      if (renewal !== undefined) await renewal
      if (attempt.authority !== undefined) {
        try {
          await this.releaseLease(attempt.ownerId, attempt.authority.generation)
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

  /**
   * Capture the durable generation that authorizes one outgoing model request.
   * @returns the generation that may later mark a refresh failure.
   */
  async captureRequestGeneration(): Promise<number> {
    return (await this.readCoordination()).generation
  }

  /** Read current cross-process lease and credential state. */
  async status(): Promise<LlmOAuthConnection> {
    if (this.attempt?.phase === 'setup'
      && this.attempt.authority === undefined
      && !this.attempt.abort.signal.aborted) {
      return this.connectingConnection()
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
      phase: 'setup',
      done: Promise.resolve(),
    }
    this.attempt = attempt
    attempt.done = this.runAttempt(attempt)
    return attempt.startup.promise
  }

  /** Abort a locally owned attempt and return its ordered-cleanup barrier. */
  private abortLocalAttempt(reason: string): Promise<void> | undefined {
    const attempt = this.attempt
    if (attempt === undefined) return undefined
    attempt.abort.abort(reason)
    return attempt.done
  }

  /** Cancel every process's current login generation and return durable state. */
  async cancel(): Promise<LlmOAuthConnection> {
    const settled = this.abortLocalAttempt('OpenAI Codex login cancelled')
    try {
      await this.revokeAuthority('when-leased', false)
    } finally {
      await settled
    }
    return this.inspectStatus()
  }

  /** Cancel login, remove the OAuth credential through pi-ai, and publish missing. */
  async disconnect(): Promise<LlmOAuthConnection> {
    const settled = this.abortLocalAttempt('OpenAI Codex login disconnected')
    let revocation: AuthorityRevocation
    try {
      revocation = await this.revokeAuthority('always', true)
    } finally {
      await settled
    }
    try {
      await this.options.models(this.options.credentialStore.logoutStoreForGeneration(revocation.generation))
        .logout(PROVIDER)
    } catch {
      throw oauthFailure()
    }
    return this.inspectStatus()
  }

  /**
   * Persist a request-time OAuth refresh failure without retaining provider data.
   * @param generation - the generation captured for the failing request.
   * @returns nothing; stale generations instead refresh the local status.
   */
  async markReconnectRequired(generation: number): Promise<void> {
    let current = false
    try {
      current = await this.credentials().modify(OPENAI_CODEX_LOGIN_LEASE_REF, (currentValue) => {
        const coordination = decodeCoordination(currentValue)
        if (coordination.generation !== generation) {
          return Promise.resolve({ value: currentValue, result: false, visibility: 'private' as const })
        }
        return Promise.resolve({
          value: encodeCoordination({ ...coordination, reconnectRequired: true }),
          result: true,
          visibility: 'private' as const,
        })
      })
    } catch {
      // The caller still receives only the redacted reconnect-required state.
    }
    if (current) this.publish('reconnect-required')
    else await this.inspectStatus()
  }

  /** Abort and await every locally owned lifecycle task before disposal returns. */
  dispose(): Promise<void> {
    this.disposal ??= this.disposeOwnedAttempt()
    return this.disposal
  }

  /** Ordered disposal implementation shared by repeat callers. */
  private async disposeOwnedAttempt(): Promise<void> {
    this.disposed = true
    this.cancelLeaseExpiryRefresh()
    const attempt = this.attempt
    if (attempt !== undefined) attempt.abort.abort('OpenAI Codex OAuth controller disposed')
    await Promise.all([
      ...this.leaseExpiryRefreshes,
      ...attempt === undefined ? [] : [attempt.done],
    ])
  }
}
