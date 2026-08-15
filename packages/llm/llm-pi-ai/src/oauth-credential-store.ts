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
  version: 1
  credential: OAuthCredential
}

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
function decodeRecord(value: string | undefined): OAuthCredential | undefined {
  if (value === undefined) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw storageFailure()
  }
  if (!isObject(parsed) || parsed.version !== 1 || !('credential' in parsed)) {
    throw storageFailure()
  }
  return oauthCredential(parsed.credential)
}

/** Encode one validated credential as the current private record version. */
function encodeRecord(credential: Credential): string {
  const record: StoredOAuthRecord = { version: 1, credential: oauthCredential(credential) }
  try {
    return JSON.stringify(record)
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
      result: decodeRecord(current),
      visibility: 'private',
    }))
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
      const current = decodeRecord(currentValue)
      let proposed: Credential | undefined
      try {
        proposed = await fn(current)
      } catch (error) {
        throw new CredentialCallbackFailure(error)
      }
      if (proposed === undefined) {
        return { value: currentValue, result: current, visibility: 'private' }
      }
      const value = encodeRecord(proposed)
      return { value, result: oauthCredential(proposed), visibility: 'private' }
    })
  }

  /** Remove the private record without decoding a malformed value first. */
  async delete(providerId: string): Promise<void> {
    if (providerId !== PROVIDER) throw storageFailure()
    await this.mutatePrivate(() => Promise.resolve({
      value: undefined,
      result: undefined,
      visibility: 'private',
    }))
  }
}
