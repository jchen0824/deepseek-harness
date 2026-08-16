// Keyless browser proof for the complete Codex OAuth-to-selection path. The
// scaffold owns the device-code transition, while the real Models store,
// topology event, pi-ai catalog, Host model gate, and composer selection paths
// remain assembled exactly as the Web bundle ships them. A deterministic
// native-provider failure drives a real model request and proves that stream,
// persistence, Host history, browser events, visible copy, and logs expose
// only the provider-neutral failure.
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { Logger } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import {
  acknowledgeReloadConnectionLoss, assertFixtureInventory, captureStableAria, compareOrRefreshGolden,
  launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/openai-codex-oauth', import.meta.url))
const FLOW_EXPECTED = join(SNAPSHOT_DIR, 'flow.expected.md')
const MODE = webSnapshotMode()
const PROVIDER_FAILURE_MESSAGE = 'OpenAI Codex request failed'
const REDACTION_SENTINELS = [
  'sensitive-token-sentinel',
  'sensitive-authorization-sentinel',
  'sensitive-account-sentinel',
  'sensitive-plan-sentinel',
  'sensitive-reference-sentinel',
  'sensitive-error-sentinel',
] as const

/** Add a stable Markdown heading to one captured ARIA state. */
function stage(title: string, snapshot: string): string {
  return `# ${title}\n\n${snapshot}`
}

describe.skipIf(MODE === 'record')('web e2e: Codex OAuth reaches normal model selection', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  let browserConsoleMessages: string[]
  let oauthRpcPayloads: Array<Promise<string>>
  let oauthEventPayloads: string[]

  /** Read one session's authoritative model catalog and selection through Host RPC. */
  const models = async (sessionId: SessionId) => {
    const response = await scaffold.ctx.apiProxy.sessions.models({
      rpcId: `codex-oauth-models-${sessionId}` as never,
      payload: { sessionId },
    })
    if (!response.result.ok) throw new Error(`session.models failed: ${response.result.error.message}`)
    return response.result.value
  }

  beforeAll(async () => {
    scaffold = await launchWebScaffold({ openAiCodexOAuth: true })
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    browserConsoleMessages = []
    page.on('console', message => browserConsoleMessages.push(message.text()))
    oauthRpcPayloads = []
    oauthEventPayloads = []
    page.on('response', (response) => {
      const path = new URL(response.url()).pathname
      if (path.startsWith('/api/llm.oauth') || path === '/api/llm.providers') {
        oauthRpcPayloads.push(response.text())
      }
    })
    page.on('websocket', (socket) => {
      if (new URL(socket.url()).pathname !== '/api/events.host') return
      socket.on('framereceived', frame => oauthEventPayloads.push(String(frame.payload)))
    })
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('connects, inherits the saved default, and keeps later session selection scoped', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-openai-codex-oauth'))
    const initialSession = scaffold.ctx.agents.roots().at(-1)?.session.id
    if (initialSession === undefined) throw new Error('Codex OAuth scenario has no connected workspace session')
    expect((await models(initialSession)).groups.some(group => group.id === 'openai-codex')).toBe(false)

    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Settings' })
    await dialog.waitFor({ timeout: 10_000 })
    await dialog.getByRole('button', { name: 'Models', exact: true }).click()
    const provider = dialog.getByText('openai-codex', { exact: true })
    await provider.waitFor({ timeout: 10_000 })
    const missing = await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd)

    await dialog.getByRole('button', { name: 'Connect ChatGPT', exact: true }).click()
    await dialog.getByText('ABCD-EFGH', { exact: true }).waitFor({ timeout: 10_000 })
    const verificationLink = dialog.getByRole('link', { name: 'Open verification page', exact: true })
    expect(await verificationLink.getAttribute('href')).toBe('https://auth.openai.com/codex/device')
    const deviceCode = await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd)
    // Registering the profile makes its public model topology stable before
    // private OAuth state changes; the loopback-only connection view still
    // decides whether the Models card treats it as usable.
    await expect.poll(
      async () => (await models(initialSession)).groups.some(group => group.id === 'openai-codex'),
      { timeout: 10_000 },
    ).toBe(true)
    await expect.poll(
      () => oauthEventPayloads.filter(payload => payload.includes('llm/adapters-updated')).length,
      { timeout: 10_000 },
    ).toBeGreaterThan(0)
    const topologyUpdatesBeforeCompletion = oauthEventPayloads
      .filter(payload => payload.includes('llm/adapters-updated')).length

    let connectedFromLifecycle = ''
    let completionTopologyUpdates = 0
    const stopTopologyWatch = scaffold.ctx.on('llm/adapters-updated', () => { completionTopologyUpdates += 1 })
    try {
      await scaffold.completeOAuthLogin('openai-codex', async () => {
        // The OAuth state remains loopback-only. The card's local status refresh
        // observes the terminal connection without changing public topology.
        await dialog.getByText('Connected', { exact: true }).waitFor({ timeout: 10_000 })
        expect((await models(initialSession)).groups.some(group => group.id === 'openai-codex')).toBe(true)
        connectedFromLifecycle = await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd)
      })
    } finally {
      stopTopologyWatch()
    }
    expect(completionTopologyUpdates).toBe(0)
    await expect.poll(
      async () => (await models(initialSession)).groups.some(group => group.id === 'openai-codex'),
      { timeout: 10_000 },
    ).toBe(true)

    await dialog.getByRole('button', { name: 'Close', exact: true }).click()
    const trigger = page.getByRole('button', { name: /^Select model/ })
    await trigger.waitFor({ timeout: 15_000 })
    await trigger.click()
    await page.getByRole('menuitem', { name: /^Model/ }).click()
    await page.getByRole('menuitemradio', { name: 'GPT-5.4', exact: true }).waitFor({ timeout: 10_000 })
    const picker = await captureStableAria(page, '[role="menu"]', scaffold.workspaceCwd)
    await page.getByRole('menuitemradio', { name: 'GPT-5.4', exact: true }).click()
    await expect.poll(() => trigger.getAttribute('aria-label'), { timeout: 10_000 })
      .toMatch(/^Select model, current GPT-5\.4/)
    await trigger.click()
    await page.getByRole('menuitem', { name: /^Effort/ }).click()
    await page.getByRole('menuitemradio', { name: /^High/ }).click()
    await expect.poll(() => trigger.getAttribute('aria-label'), { timeout: 10_000 })
      .toBe('Select model, current GPT-5.4, reasoning effort High')
    const currentSelection = await captureStableAria(
      page,
      'button[aria-label^="Select model"]',
      scaffold.workspaceCwd,
    )

    const settings = await readFile(join(scaffold.harnessHome, 'settings.yaml'), 'utf8')
    expect(settings).toContain('agent-default-model:')
    expect(settings).toContain('provider: openai-codex')
    expect(settings).toContain('model: gpt-5.4')
    expect(settings).toContain('reasoningEffort: high')

    const logStart = scaffold.ctx.logger.buffer.length
    const input = page.locator('textarea').first()
    await input.waitFor({ timeout: 10_000 })
    const settled = scaffold.whenTurnSettled()
    await input.fill('Exercise the provider failure path.')
    await input.press('Enter')
    expect(await settled).toBe(initialSession)
    await page.getByText(PROVIDER_FAILURE_MESSAGE, { exact: true }).last().waitFor({ timeout: 10_000 })
    const providerFailure = await captureStableAria(page, '[data-chat-flow]', scaffold.workspaceCwd)

    const initialAgent = scaffold.ctx.agents.get(initialSession)
    if (initialAgent === undefined) throw new Error('Codex OAuth scenario lost its initial Agent')
    const streamPayload = JSON.stringify(initialAgent.session.events)
    expect(streamPayload).toContain(PROVIDER_FAILURE_MESSAGE)
    const persistedPayload = JSON.stringify(await scaffold.ctx.sessionPersistence.inspect(initialSession))
    expect(persistedPayload).toContain(PROVIDER_FAILURE_MESSAGE)
    const browserHistory = await page.evaluate(async ({ sessionId }) => {
      const response = await fetch('/api/session.history', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'client-request',
          rpcId: 'codex-oauth-failure-history',
          method: 'session.history',
          payload: { sessionId },
        }),
      })
      if (!response.ok) throw new Error(`session.history returned HTTP ${response.status}`)
      return response.text()
    }, { sessionId: String(initialSession) })
    expect(browserHistory).toContain(PROVIDER_FAILURE_MESSAGE)
    await expect.poll(
      () => oauthEventPayloads.some(payload => payload.includes(PROVIDER_FAILURE_MESSAGE)),
      { timeout: 10_000 },
    ).toBe(true)
    const logPayload = scaffold.ctx.logger.buffer.slice(logStart)
      .map(message => Logger.format({ colors: false, export: () => undefined }, message))
      .join('\n')
    for (const sentinel of REDACTION_SENTINELS) {
      expect(streamPayload).not.toContain(sentinel)
      expect(persistedPayload).not.toContain(sentinel)
      expect(browserHistory).not.toContain(sentinel)
      expect(logPayload).not.toContain(sentinel)
      expect(browserConsoleMessages.join('\n')).not.toContain(sentinel)
    }

    // The failed request made the Session nonblank. Reload the list projection
    // so New session exercises default inheritance from an ordinary turn.
    const warningStart = tripwire.warnings.length
    await page.reload({ waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    acknowledgeReloadConnectionLoss(tripwire, warningStart)
    await expect.poll(() => trigger.getAttribute('aria-label'), { timeout: 10_000 })
      .toBe('Select model, current GPT-5.4, reasoning effort High')

    await page.getByRole('button', { name: /^New session/ }).last().click()
    await expect.poll(() => trigger.getAttribute('aria-label'), { timeout: 10_000 })
      .toBe('Select model, current GPT-5.4, reasoning effort High')
    const inheritedDefault = await captureStableAria(
      page,
      'button[aria-label^="Select model"]',
      scaffold.workspaceCwd,
    )
    await expect.poll(
      () => scaffold.ctx.agents.roots().some(agent => agent.session.id !== initialSession),
      { timeout: 10_000 },
    ).toBe(true)
    const laterSession = scaffold.ctx.agents.roots().map(agent => agent.session.id)
      .find(sessionId => sessionId !== initialSession)
    if (laterSession === undefined) throw new Error('Codex OAuth scenario did not create a later session')
    expect((await models(laterSession)).current).toEqual({
      provider: 'openai-codex', model: 'gpt-5.4', reasoningEffort: 'high',
    })

    // Changing the later session through the same picker leaves the first
    // session's logged override untouched, while the default write follows
    // the ordinary gesture for sessions created after this point.
    await trigger.click()
    await page.getByRole('menuitem', { name: /^Model/ }).click()
    await page.getByRole('menuitemradio', { name: 'DeepSeek-V4-Flash', exact: true }).click()
    await expect.poll(() => trigger.getAttribute('aria-label'), { timeout: 10_000 })
      .toBe('Select model, current DeepSeek-V4-Flash')
    expect((await models(initialSession)).current).toEqual({
      provider: 'openai-codex', model: 'gpt-5.4', reasoningEffort: 'high',
    })
    expect((await models(laterSession)).current).toEqual({
      provider: 'deepseek-official', model: 'deepseek-v4-flash',
    })
    const scopedSelection = await captureStableAria(
      page,
      'button[aria-label^="Select model"]',
      scaffold.workspaceCwd,
    )

    const flow = [
      stage('Disconnected Models card', missing),
      stage('Fixed device code', deviceCode),
      stage('Connected through the loopback lifecycle refresh', connectedFromLifecycle),
      stage('Connected Codex catalog in the normal picker', picker),
      stage('Current session Codex selection', currentSelection),
      stage('Provider-neutral model failure', providerFailure),
      stage('Saved default inherited by a later session', inheritedDefault),
      stage('Later session override remains scoped', scopedSelection),
    ].join('\n\n')
    const redaction = scaffold.oauthRedactionEvidence('openai-codex')
    expect(redaction.sentinels).toEqual(REDACTION_SENTINELS)
    expect(redaction.payloadsIssued).toBeGreaterThan(0)
    expect(redaction.modelRequests).toBeGreaterThan(0)
    const privatePayload = JSON.stringify(redaction.lastPrivatePayload)
    for (const sentinel of REDACTION_SENTINELS) expect(privatePayload).toContain(sentinel)

    const rpcPayload = (await Promise.all(oauthRpcPayloads)).join('\n')
    expect(rpcPayload).toContain('ABCD-EFGH')
    expect(rpcPayload).toContain('openai-codex')
    expect(oauthEventPayloads.filter(payload => payload.includes('llm/adapters-updated')))
      .toHaveLength(topologyUpdatesBeforeCompletion)
    expect(oauthEventPayloads.some(payload => payload.includes('llm/oauth-connection-updated'))).toBe(false)
    const browserPayload = `${rpcPayload}\n${oauthEventPayloads.join('\n')}`
    expect(browserPayload).toContain('"status":"connected"')
    expect(browserPayload).toContain(PROVIDER_FAILURE_MESSAGE)
    for (const sentinel of REDACTION_SENTINELS) expect(browserPayload).not.toContain(sentinel)

    const visibleOutput = `${flow}\n${await page.locator('body').innerText()}`
    expect(visibleOutput).not.toMatch(/\b(?:sk-[A-Za-z0-9_-]{8,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})\b/)
    expect(visibleOutput).not.toMatch(/\b[A-Z][A-Z0-9_]*(?:OAUTH|LOGIN_LEASE)[A-Z0-9_]*\b/)
    expect(visibleOutput).not.toMatch(/(?:invalid[_-]grant|provider\s+(?:denied|error)|authorization\s+failed)/i)
    await compareOrRefreshGolden(FLOW_EXPECTED, flow, MODE)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 90_000)

  it('keeps the fixture inventory closed', async () => {
    await assertFixtureInventory(SNAPSHOT_DIR, ['flow.expected.md'])
  })
})
