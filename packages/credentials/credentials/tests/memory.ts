import type { Context } from '@deepseek-ai/cordis'
import { CredentialProvider } from '../src/index.ts'
import type { CredentialInfo, CredentialMutation, CredentialRef, ResolvedCredential } from '../src/index.ts'

/**
 * In-memory credentials provider for interface and consumer tests: one
 * always-writable `memory` source seeded from plugin config.
 */
export class MemoryCredentials extends CredentialProvider {
  private readonly store = new Map<string, string>()
  /** Settled operation tail that serializes async read-modify-write callbacks. */
  private operations: Promise<void> = Promise.resolve()

  constructor(ctx: Context, seed: Record<string, string> = {}) {
    super(ctx)
    for (const [key, value] of Object.entries(seed)) this.store.set(key, value)
  }

  override resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    const value = this.store.get(ref)
    return Promise.resolve(value === undefined || value.length === 0
      ? undefined
      : { value, source: 'memory' })
  }

  override describe(ref: CredentialRef): Promise<CredentialInfo> {
    const value = this.store.get(ref)
    const configured = value !== undefined && value.length > 0
    return Promise.resolve({
      configured,
      ...configured ? { source: 'memory' } : {},
      writable: true,
    })
  }

  override set(ref: CredentialRef, value: string): Promise<void> {
    if (value.length === 0) {
      return Promise.reject(new Error('memory credentials: an empty value cannot be stored; use unset'))
    }
    return this.modify(ref, async () => ({ value, result: undefined, visibility: 'public' }))
  }

  override unset(ref: CredentialRef): Promise<void> {
    return this.modify(ref, async () => ({ value: undefined, result: undefined, visibility: 'public' }))
  }

  override async modify<T>(
    ref: CredentialRef,
    mutate: (current: string | undefined) => Promise<CredentialMutation<T>>,
  ): Promise<T> {
    return this.enqueue(async () => {
      const before = this.store.get(ref)
      const mutation = await mutate(before)
      if (mutation.value === '') {
        throw new Error('memory credentials: an empty value cannot be stored; use undefined')
      }
      if (before !== mutation.value) {
        if (mutation.value === undefined) this.store.delete(ref)
        else this.store.set(ref, mutation.value)
        if (mutation.visibility === 'public') this.notifyUpdated(ref)
        else this.notifyPrivateUpdated()
      }
      return mutation.result
    })
  }

  /** Queue one mutation while keeping the tail usable after a rejected callback. */
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.operations.then(operation)
    this.operations = task.then(() => undefined, () => undefined)
    return task
  }
}
