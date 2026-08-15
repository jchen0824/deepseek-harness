/**
 * Real-composition guard for the dormant pi-ai posture: LlmRuntime,
 * settings-file, credentials-local, and a bare `llm-pi-ai` row boot from a
 * test-only cordis.yml through the actual Loader + Include path, an external
 * edit of settings.yaml registers the route live, and the next request
 * carries the credential the credentials document supplies. A hand-mounted `ctx.plugin` cannot
 * catch Loader export-shape failures, which is why the twin adapter has the
 * same guard.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import FileSettingsProvider from '@deepseek-ai/dsh-settings-file'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import { boot, healProfilesModuleFallback, loadOverlayPatches } from '../../../boot/app-boot/src/index.ts'
import { provideCmdline } from '../../../boot/cmdline/src/index.ts'
import { assemble } from './assemble.ts'
import { closeMockServers, mockServer, textEvents } from './mock-server.ts'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const BASE_PATCH_PATH = join(REPO_ROOT, 'packages/bundle/base/cordis.patch.yml')
const HEADLESS_PATCH_PATH = join(REPO_ROOT, 'packages/bundle/headless/cordis.patch.yml')
const INSTALL_ANCHOR = join(REPO_ROOT, 'apps/cli/package.json')

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
  await closeMockServers()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

/** Boot the dormant adapter composition through Loader. */
async function loadComposition(): Promise<{ ctx: Context; settingsPath: string }> {
  root = await mkdtemp(join(tmpdir(), 'dsh-pi-composition-'))
  const settingsPath = join(root, 'settings.yaml')
  await writeFile(settingsPath, '# personal settings\n')
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
    '- id: llm-pi-ai',
    "  name: '@deepseek-ai/dsh-llm-pi-ai'",
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

/** Boot the shipped base-plus-headless layer stack against a saved Codex OAuth connection. */
async function loadHeadlessComposition(baseUrl: string): Promise<{
  ctx: Context
  exit: Promise<number>
}> {
  root = await mkdtemp(join(tmpdir(), 'dsh-pi-headless-composition-'))
  vi.stubEnv('DSH_HOME', root)
  const settingsPath = join(root, 'settings.yaml')
  const credentialsPath = join(root, '.credentials.yaml')
  await writeFile(settingsPath, [
    'agent-default-model:',
    '  provider: openai-codex',
    '  model: gpt-5.4',
    '  reasoningEffort: high',
    'llm-pi-ai:',
    '  providers:',
    '    openai-codex:',
    '      api: openai-completions',
    `      baseURL: ${baseUrl}/v1`,
    '',
  ].join('\n'))

  healProfilesModuleFallback(INSTALL_ANCHOR, root)
  const profileDir = join(root, 'profiles', 'headless-composition-test')
  await mkdir(profileDir, { recursive: true })
  const rootConfig = join(profileDir, 'cordis.yml')
  await writeFile(rootConfig, '[]\n')
  const oauthSeedPlugin = join(profileDir, 'saved-oauth-seed.mjs')
  await writeFile(oauthSeedPlugin, [
    "import { OpenAICodexCredentialStore } from '@deepseek-ai/dsh-llm-pi-ai'",
    "import { OpenAICodexOAuthController } from '@deepseek-ai/dsh-llm-pi-ai'",
    "export const name = 'saved-oauth-seed'",
    "export const inject = ['credentials']",
    'export async function apply(ctx) {',
    '  const evidence = { oauthStartCalls: 0 }',
    '  const originalStart = OpenAICodexOAuthController.prototype.start',
    '  ctx.effect(() => {',
    '    OpenAICodexOAuthController.prototype.start = function (...args) {',
    '      evidence.oauthStartCalls += 1',
    '      return Reflect.apply(originalStart, this, args)',
    '    }',
    '    return () => { OpenAICodexOAuthController.prototype.start = originalStart }',
    '  })',
    '  const store = new OpenAICodexCredentialStore(() => ctx.credentials)',
    "  await store.modify('openai-codex', async () => ({",
    "    type: 'oauth', access: 'ABCD-EFGH', refresh: 'ABCD-EFGH', expires: 4102444800000,",
    '  }))',
    "  ctx.provide('savedOAuthSeeded', evidence)",
    '}',
    '',
  ].join('\n'))
  const oauthReadyPlugin = join(profileDir, 'saved-oauth-ready.mjs')
  await writeFile(oauthReadyPlugin, [
    "export const name = 'saved-oauth-ready'",
    "export const inject = ['llm']",
    'export async function apply(ctx) {',
    '  let controller',
    '  for (let attempt = 0; attempt < 100 && controller === undefined; attempt += 1) {',
    "    controller = ctx.llm.getOAuthController('openai-codex')",
    '    if (controller === undefined) await new Promise(resolve => setTimeout(resolve, 0))',
    '  }',
    "  if (controller === undefined) throw new Error('saved OAuth controller did not register')",
    '  const connection = await controller.status()',
    "  if (connection.status !== 'connected') throw new Error(`saved OAuth connection did not initialize: ${connection.status}`)",
    "  ctx.provide('savedOAuthReady', connection)",
    '}',
    '',
  ].join('\n'))
  let resolveExit: (code: number) => void = () => {}
  const exit = new Promise<number>((resolve) => { resolveExit = resolve })
  const ctx = await boot('llm-pi-ai headless composition', rootConfig, [
    ...loadOverlayPatches('llm-pi-ai headless composition', BASE_PATCH_PATH),
    ...loadOverlayPatches('llm-pi-ai headless composition', HEADLESS_PATCH_PATH),
    { id: 'settings', config: { path: settingsPath, watch: false } },
    { id: 'credentials', config: { path: credentialsPath, watch: false } },
    { id: 'session-persistence-jsonl', config: { root: join(root, 'sessions') } },
    { id: 'session-title-llm', disabled: true },
    { id: 'session-telemetry-otel', disabled: true },
    { id: 'agent-instructions', disabled: true },
    { id: 'llm-deepseek', disabled: true },
    { insert: [
      { id: 'saved-oauth-seed', name: pathToFileURL(oauthSeedPlugin).href },
      { id: 'saved-oauth-ready', name: pathToFileURL(oauthReadyPlugin).href, inject: ['savedOAuthSeeded'] },
    ] },
    { id: 'llm-pi-ai', inject: ['savedOAuthSeeded'] },
    { id: 'headless-runner', inject: ['headlessStartup', 'savedOAuthReady'] },
  ], (bootCtx) => {
    provideCmdline(bootCtx, { args: ['prove', 'saved', 'OAuth'], exit: resolveExit })
  })
  context = ctx
  return { ctx, exit }
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
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const server = await mockServer([{ events: textEvents }])
    const { ctx, exit } = await loadHeadlessComposition(server.url)
    expect(ctx.get('headlessStartup')).toEqual({ task: 'prove saved OAuth' })
    expect(ctx.get('savedOAuthReady')).toEqual({ provider: 'openai-codex', status: 'connected' })
    const controller = ctx.llm.getOAuthController('openai-codex')
    if (controller === undefined) throw new Error('expected Codex OAuth controller')

    await vi.waitFor(async () => {
      await expect(controller.status()).resolves.toEqual({ provider: 'openai-codex', status: 'connected' })
    }, { timeout: 5000 })
    await vi.waitFor(() => {
      expect(ctx.llm.listProviders().map(provider => provider.id)).toContain('openai-codex')
    }, { timeout: 5000 })
    await expect(ctx.llm.listModels('openai-codex')).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: 'openai-codex', id: 'gpt-5.4' }),
    ]))

    await expect(exit).resolves.toBe(0)
    expect(stdout).toHaveBeenCalledWith('hello\n')
    expect(server.paths).toEqual(['/v1/chat/completions'])
    expect(ctx.get('savedOAuthSeeded')).toEqual({ oauthStartCalls: 0 })
  })
})
