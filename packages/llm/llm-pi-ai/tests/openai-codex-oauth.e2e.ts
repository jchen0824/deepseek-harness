import { Context } from '@deepseek-ai/cordis'
import { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import type {
  CredentialInfo,
  CredentialMutation,
  CredentialRef,
  ResolvedCredential,
} from '@deepseek-ai/dsh-credentials'
import type { LlmOAuthConnection } from '@deepseek-ai/dsh-llm'
import { createModels } from '@earendil-works/pi-ai'
import type { MutableModels } from '@earendil-works/pi-ai'
import { describe, expect, it } from 'vitest'
import { OpenAICodexCredentialStore } from '../src/oauth-credential-store.ts'
import { OpenAICodexOAuthController } from '../src/openai-codex-oauth.ts'
import { resolveProfiles } from '../src/config.ts'

const PROVIDER = 'openai-codex'
const enabled = process.env.DSH_OPENAI_CODEX_OAUTH_SMOKE === '1'
const AUTHORIZATION_TIMEOUT_MS = 20 * 60 * 1_000

/** Process-local credential provider that leaves no persistent login fixture. */
class VolatileCredentials extends CredentialProvider {
  private readonly values = new Map<CredentialRef, string>()
  private operations: Promise<void> = Promise.resolve()

  override resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    const value = this.values.get(ref)
    return Promise.resolve(value === undefined ? undefined : { value, source: 'memory' })
  }

  override describe(ref: CredentialRef): Promise<CredentialInfo> {
    const configured = this.values.has(ref)
    return Promise.resolve({ configured, ...configured ? { source: 'memory' } : {}, writable: true })
  }

  override set(ref: CredentialRef, value: string): Promise<void> {
    return this.modify(ref, async () => ({ value, result: undefined, visibility: 'private' }))
  }

  override unset(ref: CredentialRef): Promise<void> {
    return this.modify(ref, async () => ({ value: undefined, result: undefined, visibility: 'private' }))
  }

  override modify<T>(
    ref: CredentialRef,
    mutate: (current: string | undefined) => Promise<CredentialMutation<T>>,
  ): Promise<T> {
    const operation = this.operations.then(async () => {
      const mutation = await mutate(this.values.get(ref))
      if (mutation.value === undefined) this.values.delete(ref)
      else this.values.set(ref, mutation.value)
      return mutation.result
    })
    this.operations = operation.then(() => undefined, () => undefined)
    return operation
  }
}

async function waitForConnected(controller: OpenAICodexOAuthController): Promise<LlmOAuthConnection> {
  const deadline = Date.now() + AUTHORIZATION_TIMEOUT_MS
  while (Date.now() < deadline) {
    const connection = await controller.status()
    if (connection.status === 'connected') return connection
    if (connection.status === 'missing' || connection.status === 'reconnect-required') {
      throw new Error('OpenAI Codex sign-in did not complete')
    }
    await new Promise(resolve => setTimeout(resolve, 1_000))
  }
  throw new Error('OpenAI Codex sign-in timed out')
}

describe.skipIf(!enabled)('OpenAI Codex OAuth personal-subscription smoke', () => {
  it('authorizes by device code and checks only redacted auth and catalog state', async () => {
    const credentials = new VolatileCredentials(new Context())
    const credentialStore = new OpenAICodexCredentialStore(() => credentials)
    const models: MutableModels = createModels({ credentials: credentialStore })
    const profile = resolveProfiles({ [PROVIDER]: {} }).get(PROVIDER)
    if (profile === undefined) throw new Error('OpenAI Codex catalog route is unavailable')
    models.setProvider(profile.piProvider)
    const controller = new OpenAICodexOAuthController({
      credentials: () => credentials,
      credentialStore,
      models: () => models,
      loginLeaseTtlMs: () => 30_000,
      emitConnectionUpdated: () => {},
    })

    try {
      const start = await controller.start()
      if (start.kind !== 'device-code') throw new Error('OpenAI Codex device-code sign-in did not start')
      process.stdout.write(
        `\nOpen ${start.deviceCode.verificationUri} and enter ${start.deviceCode.userCode}.\n`,
      )

      await expect(waitForConnected(controller)).resolves.toEqual({
        provider: PROVIDER,
        status: 'connected',
      })
      await expect(models.checkAuth(PROVIDER)).resolves.toEqual({ type: 'oauth', source: 'OAuth' })
      expect(models.getModels(PROVIDER).length).toBeGreaterThan(0)
    } finally {
      await controller.disconnect()
      await controller.dispose()
    }
  }, AUTHORIZATION_TIMEOUT_MS)
})
