import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '../src/index.ts'
import type { CredentialRef } from '../src/index.ts'
import { MemoryCredentials } from './memory.ts'

const REF = credentialRef('DEEPSEEK_API_KEY')

async function boot(seed: Record<string, string> = {}): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(MemoryCredentials, seed)
  return ctx
}

describe('credentialRef', () => {
  it('brands POSIX shell identifiers', () => {
    expect(credentialRef('DEEPSEEK_API_KEY')).toBe('DEEPSEEK_API_KEY')
    expect(credentialRef('_private')).toBe('_private')
    expect(credentialRef('lower_case9')).toBe('lower_case9')
  })

  it('rejects every other shape', () => {
    for (const invalid of ['', '9LEADING', 'WITH-DASH', 'WITH SPACE', 'ns:key']) {
      expect(() => credentialRef(invalid)).toThrow(TypeError)
    }
  })
})

describe('the credentials seam through the memory provider', () => {
  it('mounts as ctx.credentials and resolves a seeded reference with its source', async () => {
    const ctx = await boot({ DEEPSEEK_API_KEY: 'sk-seeded' })
    expect(await ctx.credentials.resolve(REF)).toEqual({ value: 'sk-seeded', source: 'memory' })
    expect(await ctx.credentials.describe(REF)).toEqual({ configured: true, source: 'memory', writable: true })
  })

  it('treats an empty stored value as absent everywhere', async () => {
    const ctx = await boot({ DEEPSEEK_API_KEY: '' })
    expect(await ctx.credentials.resolve(REF)).toBeUndefined()
    expect(await ctx.credentials.describe(REF)).toEqual({ configured: false, writable: true })
  })

  it('stores through set, removes through unset, and emits the committed change', async () => {
    const ctx = await boot()
    const events: CredentialRef[] = []
    ctx.on('credentials/updated', ref => void events.push(ref))

    await ctx.credentials.set(REF, 'sk-live')
    expect(await ctx.credentials.resolve(REF)).toEqual({ value: 'sk-live', source: 'memory' })
    await ctx.credentials.unset(REF)
    expect(await ctx.credentials.resolve(REF)).toBeUndefined()
    expect(events).toEqual([REF, REF])
  })

  it('stores a private mutation without publishing its value change', async () => {
    const ctx = await boot()
    const events: CredentialRef[] = []
    let privateUpdates = 0
    ctx.on('credentials/updated', ref => void events.push(ref))
    ctx.on('credentials/private-updated', () => { privateUpdates += 1 })

    const result = await ctx.credentials.modify(REF, async current => ({
      value: current === undefined ? 'rotated-secret' : undefined,
      result: current,
      visibility: 'private',
    }))

    expect(result).toBeUndefined()
    expect(events).toEqual([])
    expect(privateUpdates).toBe(1)
    expect(await ctx.credentials.resolve(REF)).toEqual({ value: 'rotated-secret', source: 'memory' })
  })

  it('publishes one changed public mutation', async () => {
    const ctx = await boot()
    const events: CredentialRef[] = []
    ctx.on('credentials/updated', ref => void events.push(ref))

    await ctx.credentials.modify(REF, async () => ({
      value: 'sk-live',
      result: undefined,
      visibility: 'public',
    }))

    expect(events).toEqual([REF])
  })

  it('serializes held mutation callbacks before exposing the next stored value', async () => {
    const ctx = await boot()
    let releaseFirst!: () => void
    const firstHeld = new Promise<void>((resolve) => { releaseFirst = resolve })
    let firstStarted!: () => void
    const started = new Promise<void>((resolve) => { firstStarted = resolve })

    const first = ctx.credentials.modify(REF, async (current) => {
      expect(current).toBeUndefined()
      firstStarted()
      await firstHeld
      return { value: 'first', result: undefined, visibility: 'private' as const }
    })
    await started
    let secondStarted = false
    let secondCurrent: string | undefined
    const second = ctx.credentials.modify(REF, async (current) => {
      secondStarted = true
      secondCurrent = current
      return { value: 'second', result: undefined, visibility: 'private' as const }
    })
    await Promise.resolve()
    expect(secondStarted).toBe(false)
    releaseFirst()
    await Promise.all([first, second])

    expect(secondCurrent).toBe('first')
    expect(await ctx.credentials.resolve(REF)).toEqual({ value: 'second', source: 'memory' })
  })

  it('keeps an unchanged public set silent', async () => {
    const ctx = await boot({ DEEPSEEK_API_KEY: 'sk-live' })
    const events: CredentialRef[] = []
    ctx.on('credentials/updated', ref => void events.push(ref))

    await ctx.credentials.set(REF, 'sk-live')

    expect(events).toEqual([])
  })

  it('rejects an empty set and keeps an absent unset silent', async () => {
    const ctx = await boot()
    const events: CredentialRef[] = []
    ctx.on('credentials/updated', ref => void events.push(ref))

    await expect(ctx.credentials.set(REF, '')).rejects.toThrow(/empty value/)
    await ctx.credentials.unset(REF)
    expect(events).toEqual([])
  })

  it('removes the service with its fiber', async () => {
    const ctx = new Context()
    const fiber = await ctx.plugin(MemoryCredentials)
    expect(ctx.get('credentials')).toBeDefined()
    await fiber.dispose()
    expect(ctx.get('credentials')).toBeUndefined()
  })
})
