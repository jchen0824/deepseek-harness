/**
 * Private pi-ai credential storage for the OpenAI Codex OAuth route.
 *
 * The durable record lives behind one reserved Harness credential reference.
 * Reads use the same atomic mutation operation as writes so they reconcile
 * cross-process file changes and fail when a read-only environment value
 * shadows the writable record. The reference and provider/storage diagnostics
 * never cross this module's public credential-store methods.
 *
 * @module dsh-llm-pi-ai/oauth-credential-store
 */

import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { CredentialMutation, CredentialProvider } from '@deepseek-ai/dsh-credentials'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type {
  Credential,
  CredentialInfo,
  CredentialStore,
  OAuthCredential,
} from '@earendil-works/pi-ai'

/** Private durable reference for the versioned OpenAI Codex OAuth credential. */
export const OPENAI_CODEX_OAUTH_REF = credentialRef('DSH_OPENAI_CODEX_OAUTH')

/** Private durable reference for the cross-process OpenAI Codex login lease. */
export const OPENAI_CODEX_LOGIN_LEASE_REF = credentialRef('DSH_OPENAI_CODEX_LOGIN_LEASE')

const PROVIDER = 'openai-codex'
const STORAGE_ERROR_CODE = 'OPENAI_CODEX_AUTH_STORAGE'

/** Versioned durable credential record; pi-ai owns credential extension fields. */
interface StoredOAuthRecord {
  version: 2
  generation: number
  credential?: OAuthCredential
}

const INITIAL_GENERATION = 0

/** Distinguish a pi-ai callback rejection from storage and codec failures. */
class CredentialCallbackFailure extends Error {
  constructor(readonly value: unknown) {
    super('pi-ai credential callback failed')
  }
}

/** Return the single redacted storage failure exposed by this package. */
function storageFailure(): LlmError {
  return new LlmError('OpenAI Codex authentication storage is unavailable', STORAGE_ERROR_CODE)
}

/** Narrow a parsed JSON value to an ordinary object. */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Validate a credential at the durable JSON boundary. */
function oauthCredential(value: unknown): OAuthCredential {
  if (!isObject(value)
    || value.type !== 'oauth'
    || typeof value.access !== 'string'
    || value.access.length === 0
    || typeof value.refresh !== 'string'
    || value.refresh.length === 0
    || typeof value.expires !== 'number'
    || !Number.isFinite(value.expires)) {
    throw storageFailure()
  }
  return value as OAuthCredential
}

/** Decode one absent or versioned private record. */
function decodeRecord(value: string | undefined): StoredOAuthRecord | undefined {
  if (value === undefined) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw storageFailure()
  }
  if (!isObject(parsed)
    || parsed.version !== 2
    || typeof parsed.generation !== 'number'
    || !Number.isSafeInteger(parsed.generation)
    || parsed.generation < INITIAL_GENERATION) {
    throw storageFailure()
  }
  return {
    version: 2,
    generation: parsed.generation,
    ...parsed.credential === undefined ? {} : { credential: oauthCredential(parsed.credential) },
  }
}

/** Return the initial private record used before any login generation exists. */
function initialRecord(): StoredOAuthRecord {
  return { version: 2, generation: INITIAL_GENERATION }
}

/** Encode one validated private record. */
function encodeRecord(record: StoredOAuthRecord): string {
  const validated: StoredOAuthRecord = {
    version: 2,
    generation: record.generation,
    ...record.credential === undefined ? {} : { credential: oauthCredential(record.credential) },
  }
  try {
    return JSON.stringify(validated)
  } catch {
    throw storageFailure()
  }
}

/**
 * pi-ai credential store backed by the Harness credential provider.
 *
 * Only OpenAI Codex mutations are accepted. Reads for other provider ids are
 * missing so the same store can be installed on a multi-provider `Models`
 * collection without intercepting provider-native ambient authentication.
 */
export class OpenAICodexCredentialStore implements CredentialStore {
  constructor(private readonly credentials: () => CredentialProvider | undefined) {}

  /** Resolve the currently mounted credential provider or fail redacted. */
  private provider(): CredentialProvider {
    const provider = this.credentials()
    if (provider === undefined) throw storageFailure()
    return provider
  }

  /** Run one private atomic mutation and remove storage details from failures. */
  private async mutatePrivate<T>(
    mutate: (current: string | undefined) => Promise<CredentialMutation<T>>,
  ): Promise<T> {
    try {
      return await this.provider().modify(OPENAI_CODEX_OAUTH_REF, mutate)
    } catch (error) {
      if (error instanceof CredentialCallbackFailure) {
        if (error.value instanceof Error) throw error.value
        throw storageFailure()
      }
      throw storageFailure()
    }
  }

  /** Read the durable OAuth credential, or `undefined` when absent. */
  read(providerId: string): Promise<Credential | undefined> {
    if (providerId !== PROVIDER) return Promise.resolve(undefined)
    return this.mutatePrivate(current => Promise.resolve({
      value: current,
      result: decodeRecord(current)?.credential,
      visibility: 'private',
    }))
  }

  /**
   * Read a credential only when its durable login generation is authoritative.
   * @param generation - current coordination generation.
   * @returns the matching credential, or `undefined` after revocation or takeover.
   */
  readForGeneration(generation: number): Promise<Credential | undefined> {
    return this.mutatePrivate((current) => {
      const record = decodeRecord(current)
      return Promise.resolve({
        value: current,
        result: record?.generation === generation ? record.credential : undefined,
        visibility: 'private',
      })
    })
  }

  /** List only redacted OpenAI Codex credential metadata. */
  async list(): Promise<readonly CredentialInfo[]> {
    const credential = await this.read(PROVIDER)
    return credential === undefined ? [] : [{ providerId: PROVIDER, type: credential.type }]
  }

  /** Serialize a pi-ai credential mutation through the cross-process file lock. */
  modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined> {
    if (providerId !== PROVIDER) return Promise.reject(storageFailure())
    return this.mutatePrivate(async (currentValue) => {
      const record = decodeRecord(currentValue) ?? initialRecord()
      const current = record.credential
      let proposed: Credential | undefined
      try {
        proposed = await fn(current)
      } catch (error) {
        throw new CredentialCallbackFailure(error)
      }
      if (proposed === undefined) {
        return { value: currentValue, result: current, visibility: 'private' }
      }
      const credential = oauthCredential(proposed)
      const value = encodeRecord({ ...record, credential })
      return { value, result: credential, visibility: 'private' }
    })
  }

  /** Remove the credential while retaining the generation revocation tombstone. */
  async delete(providerId: string): Promise<void> {
    if (providerId !== PROVIDER) throw storageFailure()
    await this.mutatePrivate((current) => {
      const record = decodeRecord(current) ?? initialRecord()
      return Promise.resolve({
        value: encodeRecord({ version: 2, generation: record.generation }),
        result: undefined,
        visibility: 'private',
      })
    })
  }

  /**
   * Bind a new login generation before provider interaction begins.
   * @param previousGeneration - generation that authorized the lease claim.
   * @param generation - generation assigned to the new lease holder.
   * @returns a store facade whose writes fail after revocation or takeover.
   */
  async beginLogin(previousGeneration: number, generation: number): Promise<CredentialStore> {
    if (!Number.isSafeInteger(previousGeneration)
      || !Number.isSafeInteger(generation)
      || previousGeneration < INITIAL_GENERATION
      || generation <= previousGeneration) {
      throw storageFailure()
    }
    await this.mutatePrivate((current) => {
      const record = decodeRecord(current) ?? initialRecord()
      if (record.generation > previousGeneration) throw storageFailure()
      return Promise.resolve({
        value: encodeRecord({ ...record, generation }),
        result: undefined,
        visibility: 'private',
      })
    })
    return this.loginStore(generation)
  }

  /**
   * Advance the credential tombstone without allowing an older revoker to win.
   * @param generation - durable coordination generation to record.
   * @param clearCredential - whether the committed credential must be removed.
   */
  async revokeGeneration(generation: number, clearCredential: boolean): Promise<void> {
    if (!Number.isSafeInteger(generation) || generation < INITIAL_GENERATION) throw storageFailure()
    await this.mutatePrivate((current) => {
      const record = decodeRecord(current) ?? initialRecord()
      if (record.generation > generation) {
        return Promise.resolve({ value: current, result: undefined, visibility: 'private' })
      }
      const next: StoredOAuthRecord = {
        version: 2,
        generation,
        ...clearCredential || record.credential === undefined ? {} : { credential: record.credential },
      }
      return Promise.resolve({
        value: encodeRecord(next),
        result: undefined,
        visibility: 'private',
      })
    })
  }

  /**
   * Return the pi-ai store used only to log out one already-revoked generation.
   * Its delete is a no-op after a newer generation wins, so a stale logout
   * cannot erase a later successful connection.
   * @param generation - generation whose credential pi-ai is allowed to remove.
   * @returns a generation-scoped credential store for `Models.logout()`.
   */
  logoutStoreForGeneration(generation: number): CredentialStore {
    const loginStore = this.loginStore(generation)
    return {
      ...loginStore,
      delete: async (providerId) => {
        if (providerId !== PROVIDER) throw storageFailure()
        await this.revokeGeneration(generation, true)
      },
    }
  }

  /** Create the pi-ai store used only by one currently authorized login. */
  private loginStore(generation: number): CredentialStore {
    const read = async (providerId: string): Promise<Credential | undefined> => {
      if (providerId !== PROVIDER) return undefined
      return this.readForGeneration(generation)
    }
    return {
      read,
      list: async () => {
        const credential = await read(PROVIDER)
        return credential === undefined ? [] : [{ providerId: PROVIDER, type: credential.type }]
      },
      modify: async (providerId, fn) => {
        if (providerId !== PROVIDER) throw storageFailure()
        return this.mutatePrivate(async (current) => {
          const record = decodeRecord(current) ?? initialRecord()
          if (record.generation !== generation) throw storageFailure()
          let proposed: Credential | undefined
          try {
            proposed = await fn(record.credential)
          } catch (error) {
            throw new CredentialCallbackFailure(error)
          }
          if (proposed === undefined) {
            return { value: current, result: record.credential, visibility: 'private' }
          }
          const credential = oauthCredential(proposed)
          return {
            value: encodeRecord({ ...record, credential }),
            result: credential,
            visibility: 'private',
          }
        })
      },
      delete: async (providerId) => {
        if (providerId !== PROVIDER) throw storageFailure()
        await this.mutatePrivate((current) => {
          const record = decodeRecord(current) ?? initialRecord()
          if (record.generation !== generation) throw storageFailure()
          return Promise.resolve({
            value: encodeRecord({ version: 2, generation }),
            result: undefined,
            visibility: 'private',
          })
        })
      },
    }
  }
}
