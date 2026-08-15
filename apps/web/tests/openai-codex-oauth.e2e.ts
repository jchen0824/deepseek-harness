// Keyless browser proof for the complete Codex OAuth-to-selection path. The
// scaffold owns the device-code transition, while the real Models store,
// remote event, pi-ai catalog, Host model gate, and composer selection paths
// remain assembled exactly as the Web bundle ships them. No model call is
// made; a stray call still fails through the fixture-less route-only adapter.
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session'
import {
  acknowledgeReloadConnectionLoss, assertFixtureInventory, captureStableAria, compareOrRefreshGolden,
  launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/openai-codex-oauth', import.meta.url))
const FLOW_EXPECTED = join(SNAPSHOT_DIR, 'flow.expected.md')
const MODE = webSnapshotMode()

/** Add a stable Markdown heading to one captured ARIA state. */
function stage(title: string, snapshot: string): string {
  return `# ${title}\n\n${snapshot}`
}

describe.skipIf(MODE === 'record')('web e2e: Codex OAuth reaches normal model selection', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

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

    let connectedFromEvent = ''
    await scaffold.completeOAuthLogin('openai-codex', async () => {
      // The fixture has emitted only llm/oauth-connection-updated here. Its
      // adapter is deliberately withheld until this callback returns, so a
      // connected card at this barrier proves the actual event invalidation.
      await dialog.getByText('Connected', { exact: true }).waitFor({ timeout: 10_000 })
      expect((await models(initialSession)).groups.some(group => group.id === 'openai-codex')).toBe(false)
      connectedFromEvent = await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd)
    })
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

    // Model selection alone deliberately leaves a Session blank and reusable.
    // Commit an empty completed turn, then reload the list projection, so New
    // session exercises default inheritance without issuing a model request.
    const initialAgent = scaffold.ctx.agents.get(initialSession)
    if (initialAgent === undefined) throw new Error('Codex OAuth scenario lost its initial Agent')
    initialAgent.session.append('turn/start', { turn: 1 })
    initialAgent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await scaffold.ctx.sessions.flush(initialAgent.session)
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
      stage('Connected through the OAuth event', connectedFromEvent),
      stage('Connected Codex catalog in the normal picker', picker),
      stage('Current session Codex selection', currentSelection),
      stage('Saved default inherited by a later session', inheritedDefault),
      stage('Later session override remains scoped', scopedSelection),
    ].join('\n\n')
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
