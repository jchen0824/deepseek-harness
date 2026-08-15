/**
 * Real-composition guard for the dormant pi-ai posture: LlmRuntime,
 * settings-file, credentials-local, and a bare `llm-pi-ai` row boot from a
 * test-only cordis.yml through the actual Loader + Include path, an external
 * edit of settings.yaml registers the route live, and the next request
 * carries the credential the credentials document supplies. A hand-mounted `ctx.plugin` cannot
 * catch Loader export-shape failures, which is why the twin adapter has the
 * same guard.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import LlmRuntime, { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import FileSettingsProvider from '@deepseek-ai/dsh-settings-file'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import { assemble } from './assemble.ts'
import { closeMockServers, mockServer, textEvents } from './mock-server.ts'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
  await closeMockServers()
  vi.unstubAllEnvs()
})

/** Options for the Loader composition fixture. */
interface CompositionOptions {
  /** Seed a saved OAuth connection before the base adapter row activates. */
  savedOAuthBaseUrl?: string
}

/** Boot the base adapter composition through Loader, with an optional saved OAuth connection. */
async function loadComposition(options: CompositionOptions = {}): Promise<{ ctx: Context; settingsPath: string }> {
  root = await mkdtemp(join(tmpdir(), 'dsh-pi-composition-'))
  const settingsPath = join(root, 'settings.yaml')
  await writeFile(settingsPath, options.savedOAuthBaseUrl === undefined
    ? '# personal settings\n'
    : [
      'llm-pi-ai:',
      '  providers:',
      '    openai-codex:',
      '      api: openai-completions',
      `      baseURL: ${options.savedOAuthBaseUrl}/v1`,
      '',
    ].join('\n'))
  await writeFile(join(root, '.credentials.yaml'), 'PI_COMPOSITION_KEY: key-from-store\n', { mode: 0o600 })

  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    '- id: llm',
    "  name: 'test-llm-service'",
    '- id: settings',
    "  name: '@deepseek-ai/dsh-settings-file'",
    '  config:',
    `    path: ${JSON.stringify(settingsPath)}`,
    '    debounceMs: 10',
    '- id: credentials',
    "  name: '@deepseek-ai/dsh-credentials-local'",
    '  config:',
    `    path: ${JSON.stringify(join(root, '.credentials.yaml'))}`,
    '    debounceMs: 10',
    ...options.savedOAuthBaseUrl === undefined
      ? []
      : [
        '- id: saved-oauth',
        "  name: 'test-saved-oauth'",
      ],
    '- id: llm-pi-ai',
    "  name: '@deepseek-ai/dsh-llm-pi-ai'",
    ...options.savedOAuthBaseUrl === undefined ? [] : ['  inject: [savedOAuthReady]'],
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['test-llm-service', LlmRuntime],
    ['@deepseek-ai/dsh-settings-file', FileSettingsProvider],
    ['@deepseek-ai/dsh-credentials-local', LocalCredentialProvider],
    ['test-saved-oauth', {
      name: 'test-saved-oauth',
      inject: ['credentials'],
      async apply(seedCtx: Context) {
        const store = new LlmPiAi.OpenAICodexCredentialStore(() => seedCtx.credentials)
        await store.modify('openai-codex', async () => ({
          type: 'oauth',
          access: 'ABCD-EFGH',
          refresh: 'ABCD-EFGH',
          expires: 4_102_444_800_000,
        }))
        return seedCtx.provide('savedOAuthReady' as never, true as never)
      },
    }],
    ['@deepseek-ai/dsh-llm-pi-ai', LlmPiAi],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await ctx.loader.await()
  return { ctx, settingsPath }
}

describe('llm-pi-ai real dormant composition', () => {
  it('boots with zero routes and registers one the moment settings supply a profile', async () => {
    vi.stubEnv('PI_COMPOSITION_KEY', '')
    const server = await mockServer([{ events: textEvents }])
    const { ctx, settingsPath } = await loadComposition()

    // The shipped posture: the adapter exists, no route does.
    expect(ctx.llm.listProviders()).toEqual([])
    expect(ctx.llm.listConfigurableProviders()).toContainEqual({
      provider: 'openai-codex',
      displayName: 'openai-codex',
      settingsNs: 'llm-pi-ai',
      settingsPath: ['providers', 'openai-codex'],
      auth: { kind: 'oauth' },
      declared: false,
    })
    expect(ctx.llm.getOAuthController('openai-codex')).toBeDefined()

    // Exactly what the web Models page leaves on disk.
    await writeFile(settingsPath, [
      'llm-pi-ai:',
      '  providers:',
      '    deepseek:',
      '      apiKeyEnv: PI_COMPOSITION_KEY',
      `      baseURL: ${server.url}`,
      '',
    ].join('\n'))
    await vi.waitFor(() => {
      expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual(['deepseek'])
    }, { timeout: 5000 })

    const result = await assemble(ctx, { provider: 'deepseek', model: 'deepseek-v4-flash', messages: [] })
    expect(result.message.content).toEqual([{ type: 'text', text: 'hello' }])
    expect(server.headers[0]?.authorization).toBe('Bearer key-from-store')
  })

  it('uses a saved OAuth connection in the shared base route without starting headless login', async () => {
    const server = await mockServer([{ events: textEvents }])
    const { ctx } = await loadComposition({ savedOAuthBaseUrl: server.url })
    const controller = ctx.llm.getOAuthController('openai-codex')
    if (controller === undefined) throw new Error('expected Codex OAuth controller')
    const start = vi.spyOn(controller, 'start')

    await vi.waitFor(() => {
      expect(ctx.llm.listProviders().map(provider => provider.id)).toContain('openai-codex')
    })
    await expect(controller.status()).resolves.toEqual({ provider: 'openai-codex', status: 'connected' })
    await expect(ctx.llm.listModels('openai-codex')).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: 'openai-codex', id: 'gpt-5.4' }),
    ]))

    const result = await assemble(ctx, {
      provider: 'openai-codex',
      model: 'gpt-5.4',
      reasoningEffort: ReasoningEffortId('high'),
      messages: [],
    })
    expect(result.message.content).toEqual([{ type: 'text', text: 'hello' }])
    expect(server.paths).toEqual(['/v1/chat/completions'])
    expect(start).not.toHaveBeenCalled()
  })
})
