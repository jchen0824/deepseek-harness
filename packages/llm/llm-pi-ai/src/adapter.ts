/**
 * Generic pi-ai-backed implementation of the Harness LLM seam.
 *
 * Each resolution produces one **immutable** snapshot — the profiles plus a
 * `Models` collection holding the `Provider` each route built — and an
 * operation captures a whole snapshot before its first `await`. A
 * configuration change builds a *new* collection rather than mutating the one
 * in use, because `Models.streamSimple()` is lazy: it resolves the provider
 * when the stream is first consumed, which is after the credential await, so a
 * mutated collection would let a request that started under one configuration
 * finish under another — or fail with a provider that no longer exists. This is
 * what makes the seam's per-step call freeze (`llm.prepareCall()`) hold all the
 * way down: switching models mid-reply takes effect on the next step, never
 * inside the one in flight.
 *
 * Each native Codex request receives a private failure tracker over the same
 * host-scoped OAuth credential store. Its request-local `Models` collection is
 * built only from the already-captured profile snapshot and serves preflight,
 * lazy dispatch, and the final stream guard. The guard can therefore identify
 * that request's late auth failure without retaining provider diagnostics or
 * observing a concurrent request. An explicit `apiKeyEnv` still resolves
 * through the Harness seam and becomes the highest-priority request override;
 * the native Codex OAuth profile omits that override and lets pi-ai resolve and
 * refresh its stored credential.
 *
 * @module dsh-llm-pi-ai/adapter
 */

import { createModels, getSupportedThinkingLevels, ModelsError } from '@earendil-works/pi-ai'
import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  Credential,
  CredentialInfo,
  CredentialStore,
  Model,
  Models,
  ModelThinkingLevel,
  MutableModels,
  SimpleStreamOptions,
  ThinkingLevel,
} from '@earendil-works/pi-ai'
import {
  attributionHeaders,
  contentHasImage,
  LlmAdapter,
  LlmError,
  OAUTH_RECONNECT_REQUIRED_CODE,
  ReasoningEffortId,
} from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  ReasoningEffortId as ReasoningEffortIdType,
  ResolvedRetryPolicy,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import { idleWatchdog, timeoutOf } from '@deepseek-ai/dsh-timeout'
import type { ResolvedPiAiProviderProfile } from './config.ts'
import { toPiContext } from './context.ts'
import type { OpenAICodexOAuthController } from './openai-codex-oauth.ts'
import { classifyPiAiError, mapStopReason, toStreamChunks } from './stream.ts'

const OPENAI_CODEX_PROVIDER = 'openai-codex'
const OPENAI_CODEX_REQUEST_FAILURE = 'OpenAI Codex request failed'

/** One resolution's frozen view: the profiles and the collection built from them. */
interface PiAiSnapshot {
  /** The resolved profiles this collection was built from, used as its identity. */
  profiles: ReadonlyMap<string, ResolvedPiAiProviderProfile>
  /** Providers for exactly those profiles; never mutated once published. */
  models: Models
}

/** Request-owned auth collection and its optional durable-store failure tracker. */
interface NativeOAuthRequest {
  /** Providers copied only from the profile snapshot captured at request entry. */
  models: Models
  /** Failures raised while this request alone uses the shared durable store. */
  oauthFailures?: OAuthFailureTrackingStore
}

/** Track typed Codex credential failures until lazy pi-ai setup reaches its terminal event. */
class OAuthFailureTrackingStore implements CredentialStore {
  private failureVersion = 0

  constructor(private readonly delegate: CredentialStore) {}

  /** Current monotonic failure marker for request-local comparisons. */
  version(): number {
    return this.failureVersion
  }

  /** Record a failure only for the host-owned native OAuth provider. */
  private mark(providerId: string): void {
    if (providerId === OPENAI_CODEX_PROVIDER) this.failureVersion += 1
  }

  async read(providerId: string): Promise<Credential | undefined> {
    try {
      return await this.delegate.read(providerId)
    } catch (error) {
      this.mark(providerId)
      throw error
    }
  }

  list(): Promise<readonly CredentialInfo[]> {
    return this.delegate.list()
  }

  async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined> {
    try {
      return await this.delegate.modify(providerId, async (current) => {
        try {
          return await fn(current)
        } catch (error) {
          this.mark(providerId)
          throw error
        }
      })
    } catch (error) {
      this.mark(providerId)
      throw error
    }
  }

  async delete(providerId: string): Promise<void> {
    try {
      await this.delegate.delete(providerId)
    } catch (error) {
      this.mark(providerId)
      throw error
    }
  }
}

/** Return the provider-neutral failure for any unusable native Codex OAuth state. */
function oauthReconnectFailure(): LlmError {
  return new LlmError(
    'OpenAI Codex connection needs to be reconnected',
    OAUTH_RECONNECT_REQUIRED_CODE,
  )
}

/** Throw the single public reconnect failure after committing durable controller state. */
async function reconnectOAuth(
  controller: PiAiAdapterOptions['oauthController'],
  generation: number | undefined,
): Promise<never> {
  if (controller !== undefined && generation !== undefined) {
    await controller.markReconnectRequired(generation)
  }
  throw oauthReconnectFailure()
}

/** Return the terminal message carried by a pi-ai terminal event. */
function terminalMessage(event: AssistantMessageEvent): AssistantMessage | undefined {
  switch (event.type) {
    case 'done': return event.message
    case 'error': return event.error
    default: return undefined
  }
}

/**
 * Stop native OAuth setup/auth failures before pi-ai's flattened terminal data
 * reaches stream translation. Ordinary provider failures retain their normal
 * finish chunk after a successful final auth check.
 */
async function* guardNativeOAuthEvents(
  events: AsyncIterable<AssistantMessageEvent>,
  models: Models,
  oauthFailures: OAuthFailureTrackingStore | undefined,
  model: Model<Api>,
  failureVersion: number | undefined,
  controller: PiAiAdapterOptions['oauthController'],
  generation: number | undefined,
): AsyncGenerator<AssistantMessageEvent> {
  for await (const event of events) {
    const terminal = terminalMessage(event)
    if (terminal?.stopReason === 'error') {
      const trackedFailure = failureVersion !== undefined
        && oauthFailures?.version() !== failureVersion
      const reason = mapStopReason(terminal, model.contextWindow)
      const providerAuthFailure = reason.kind === 'error' && reason.failure.code === 'AUTH'
      let unavailable = trackedFailure || providerAuthFailure
      if (!unavailable) {
        try {
          unavailable = await models.getAuth(model) === undefined
        } catch (error) {
          if (!(error instanceof ModelsError)) throw error
          unavailable = true
        }
      }
      if (unavailable) await reconnectOAuth(controller, generation)
    }
    yield event
  }
}

/** Replace every native Codex terminal failure message before yielding a chunk. */
async function* sanitizeNativeCodexChunks(
  events: AsyncIterable<AssistantMessageEvent>,
  contextWindow: number | undefined,
): AsyncGenerator<StreamChunk> {
  for await (const chunk of toStreamChunks(events, contextWindow)) {
    if (chunk.type !== 'finish'
      || (chunk.reason.kind !== 'error' && chunk.reason.kind !== 'aborted')) {
      yield chunk
      continue
    }
    yield {
      ...chunk,
      reason: {
        ...chunk.reason,
        failure: { ...chunk.reason.failure, message: OPENAI_CODEX_REQUEST_FAILURE },
      },
    }
  }
}

/** Convert a thrown native provider failure without retaining its message or cause. */
function nativeCodexFailure(error: unknown): LlmError {
  const message = typeof error === 'string'
    ? error
    : error instanceof Error
      ? error.message
      : ''
  return new LlmError(OPENAI_CODEX_REQUEST_FAILURE, classifyPiAiError(message))
}

/** Build a Models collection from one captured profile map and credential store. */
function modelsFrom(
  profiles: ReadonlyMap<string, ResolvedPiAiProviderProfile>,
  credentialStore: CredentialStore | undefined,
): Models {
  const models: MutableModels = createModels(
    credentialStore === undefined ? {} : { credentials: credentialStore },
  )
  for (const profile of profiles.values()) models.setProvider(profile.piProvider)
  return models
}

/** Constructor options for {@link PiAiAdapter}: the two resolution hooks the plugin owns. */
export interface PiAiAdapterOptions {
  /** Current validated profiles by provider route; called once per operation. */
  profiles: () => ReadonlyMap<string, ResolvedPiAiProviderProfile>
  /**
   * Resolve the credential for one already-resolved profile; called once per
   * stream call and frozen for that call. `undefined` defers to the route's own
   * pi-ai auth, which for an installed catalog route is its provider-native
   * ambient discovery; the plugin allows that only for a profile naming no
   * credential at all, because a named reference that misses throws `LlmError`
   * `MISSING_CREDENTIAL` rather than falling back.
   */
  resolveApiKey: (provider: string, profile: ResolvedPiAiProviderProfile) => Promise<string | undefined>
  /** Stable pi-ai credential store shared beneath every request-local OAuth facade. */
  credentialStore?: CredentialStore
  /** Raw host controller used only to bind and persist one request-time OAuth failure. */
  oauthController?: Pick<OpenAICodexOAuthController, 'captureRequestGeneration' | 'markReconnectRequired'>
  /** Resolve the optional durable attachment service at request time. */
  resolveAttachments?: () => AttachmentStore | undefined
}

/** Copy profile stream knobs into pi-ai's common option vocabulary. */
function profileOptions(
  profile: ResolvedPiAiProviderProfile,
  reasoning: ModelThinkingLevel | undefined,
  apiKey: string | undefined,
): SimpleStreamOptions {
  const enabledReasoning: ThinkingLevel | undefined = reasoning === 'off' ? undefined : reasoning
  return {
    ...apiKey === undefined ? {} : { apiKey },
    ...enabledReasoning === undefined ? {} : { reasoning: enabledReasoning },
    ...profile.thinkingBudgets === undefined ? {} : { thinkingBudgets: profile.thinkingBudgets },
    ...profile.cacheRetention === undefined ? {} : { cacheRetention: profile.cacheRetention },
    ...profile.transport === undefined ? {} : { transport: profile.transport },
    ...profile.timeoutMs === undefined ? {} : { timeoutMs: profile.timeoutMs },
    ...profile.websocketConnectTimeoutMs === undefined ? {} : { websocketConnectTimeoutMs: profile.websocketConnectTimeoutMs },
    // The agent recovery layer owns visible attempts; one adapter call is one SDK attempt.
    maxRetries: 0,
  }
}

/**
 * The profile default this exact model can actually take, for DESCRIBING it.
 * A configured level the model does not support yields none rather than
 * throwing: `resolveModel` builds the model catalog, and a catalog that fails
 * takes its whole provider out of every picker — so one mis-set profile field
 * would hide every model on the route, including the ones that support the
 * level. The request path still refuses, which is where a bad configuration
 * belongs: describing what a model can do must not fail because a deployment
 * asked it for something it cannot.
 * @param model - the resolved model descriptor.
 * @param effort - the profile's configured level, if any.
 * @returns the level when this model supports it, otherwise undefined.
 */
function describableReasoningLevel(
  model: Model<Api>,
  effort: ReasoningEffortIdType | ModelThinkingLevel | undefined,
): ModelThinkingLevel | undefined {
  if (effort === undefined) return undefined
  return getSupportedThinkingLevels(model).some(level => level === effort)
    ? effort as ModelThinkingLevel
    : undefined
}

/** Validate an explicit Harness/profile effort without invoking pi-ai's clamp. */
function resolveReasoningLevel(
  model: Model<Api>,
  effort: ReasoningEffortIdType | ModelThinkingLevel | undefined,
): ModelThinkingLevel | undefined {
  if (effort === undefined) return undefined
  const supported = getSupportedThinkingLevels(model)
  if (supported.some(level => level === effort)) return effort as ModelThinkingLevel
  throw new LlmError(
    `pi-ai provider "${model.provider}" model "${model.id}" does not support reasoning effort "${effort}"`,
    'UNSUPPORTED_REASONING_EFFORT',
  )
}

/**
 * Selectable reasoning efforts for one model, or nothing at all.
 *
 * A model that carries no reasoning metadata — every hand-declared one, and
 * every catalog model pi-ai marks as non-reasoning — is reported by pi-ai as
 * supporting the single level `off`. Passing that through would offer a control
 * that cannot do what it says: `off` is translated to *omitting* the reasoning
 * option, which for such a model is byte-for-byte the same request as naming no
 * effort — so a provider whose own default is to think would keep thinking with
 * `off` selected. Omitting `reasoning` entirely is the seam's way of saying the
 * capability is unavailable, which leaves the surface offering only the
 * provider's default.
 * @param model - the resolved model descriptor.
 * @param defaultLevel - the profile's configured effort, already validated.
 * @returns the `reasoning` field, or an empty object when none can be offered.
 */
function reasoningInfo(
  model: Model<Api>,
  defaultLevel: ModelThinkingLevel | undefined,
): Pick<LlmResolvedModelInfo, 'reasoning'> | Record<string, never> {
  if (!model.reasoning) return {}
  const levels = getSupportedThinkingLevels(model)
  return {
    reasoning: {
      efforts: levels.map(level => ({
        id: ReasoningEffortId(level),
        name: `${level.charAt(0).toUpperCase()}${level.slice(1)}`,
      })),
      ...defaultLevel === undefined ? {} : { defaultEffort: ReasoningEffortId(defaultLevel) },
    },
  }
}

/** Merge deployment headers while removing case-insensitive attribution collisions. */
function requestHeaders(headers: Readonly<Record<string, string>> | undefined): Record<string, string> {
  const attribution = attributionHeaders()
  const reserved = new Set(Object.keys(attribution).map(name => name.toLowerCase()))
  return {
    ...Object.fromEntries(Object.entries(headers ?? {}).filter(([name]) => !reserved.has(name.toLowerCase()))),
    ...attribution,
  }
}

/**
 * pi-ai-backed multi-provider adapter. Each operation reads the current
 * profiles, so a configuration change reaches the next request without a
 * restart; model descriptors come from the collection those profiles built.
 */
export class PiAiAdapter extends LlmAdapter {
  private snapshot: PiAiSnapshot | undefined

  constructor(private readonly config: PiAiAdapterOptions) {
    super()
  }

  /**
   * The snapshot for the current profiles. Resolution memoizes its result, so
   * an unchanged configuration is recognized by identity; a changed one gets a
   * brand-new collection, leaving any snapshot an operation already captured
   * untouched for as long as that operation holds it.
   */
  private current(): PiAiSnapshot {
    const profiles = this.config.profiles()
    if (this.snapshot?.profiles === profiles) return this.snapshot
    const models = modelsFrom(profiles, this.config.credentialStore)
    this.snapshot = { profiles, models }
    return this.snapshot
  }

  /** Create one native OAuth collection without consulting profiles again. */
  private nativeOAuthRequest(snapshot: PiAiSnapshot): NativeOAuthRequest {
    const oauthFailures = this.config.credentialStore === undefined
      ? undefined
      : new OAuthFailureTrackingStore(this.config.credentialStore)
    const models = modelsFrom(snapshot.profiles, oauthFailures)
    return { models, ...oauthFailures === undefined ? {} : { oauthFailures } }
  }

  /** The profile for one route within one snapshot, or the not-owned failure. */
  private profileOf(snapshot: PiAiSnapshot, provider: string): ResolvedPiAiProviderProfile {
    const profile = snapshot.profiles.get(provider)
    if (profile === undefined) {
      throw new LlmError(`pi-ai adapter does not own provider "${provider}"`, 'NO_ADAPTER')
    }
    return profile
  }

  /** The configured descriptor for one exact route/model pair within one snapshot. */
  private modelOf(snapshot: PiAiSnapshot, provider: string, model: string): Model<Api> {
    this.profileOf(snapshot, provider)
    const resolved = snapshot.models.getModel(provider, model)
    if (resolved === undefined) {
      throw new LlmError(`pi-ai provider "${provider}" has no configured model "${model}"`, 'UNKNOWN_MODEL')
    }
    return resolved
  }

  override providerInfo(provider: string): LlmProviderInfo {
    // The configured name, not the route key: `displayName` exists so a
    // deployment can label a route, and a label only the configuration surface
    // reads would leave every selector showing the raw key.
    return { id: provider, name: this.current().profiles.get(provider)?.displayName ?? provider }
  }

  override providerRetryPolicy(provider: string): ResolvedRetryPolicy | undefined {
    return this.current().profiles.get(provider)?.retryPolicy
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve().then(() => {
      const snapshot = this.current()
      this.profileOf(snapshot, provider)
      return snapshot.models.getModels(provider).map(model => ({
        provider,
        id: model.id,
        name: model.name,
        inputModalities: [...model.input],
      }))
    })
  }

  override resolveModel(
    provider: string,
    model: string,
    _signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    return Promise.resolve().then(() => {
      const snapshot = this.current()
      const profile = this.profileOf(snapshot, provider)
      const resolvedModel = this.modelOf(snapshot, provider, model)
      const defaultLevel = describableReasoningLevel(resolvedModel, profile.reasoning)
      // Only a cap the deployment configured is a request default; the
      // catalog's `maxTokens` sizes the model and stops there.
      const configuredMaxTokens = profile.configuredMaxTokens.get(model)
      return {
        provider,
        id: model,
        name: resolvedModel.name,
        inputModalities: [...resolvedModel.input],
        context: { contextWindow: resolvedModel.contextWindow },
        ...configuredMaxTokens === undefined ? {} : { defaultMaxTokens: configuredMaxTokens },
        ...reasoningInfo(resolvedModel, defaultLevel),
      }
    })
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (options.stop !== undefined) {
      throw new LlmError('llm-pi-ai does not support GenerateOptions.stop', 'UNSUPPORTED_OPTION')
    }
    // One capture per stream call, taken before any await: the profile, the
    // model descriptor, and the collection all come from the same immutable
    // snapshot, and the credential freezes with them. A configuration change
    // mid-request builds a separate snapshot, so this request finishes under
    // the one it started with and the next call picks up the new one.
    const snapshot = this.current()
    const profile = this.profileOf(snapshot, options.provider)
    const model = this.modelOf(snapshot, options.provider, options.model)
    const reasoning = resolveReasoningLevel(
      model,
      options.reasoningEffort ?? profile.reasoning,
    )
    const nativeCodexOAuth = profile.provider === OPENAI_CODEX_PROVIDER && profile.apiKeyEnv === undefined
    const oauthRequest = nativeCodexOAuth ? this.nativeOAuthRequest(snapshot) : undefined
    const requestModels = oauthRequest?.models ?? snapshot.models
    const apiKey = nativeCodexOAuth
      ? undefined
      : await this.config.resolveApiKey(options.provider, profile)

    let oauthGeneration: number | undefined
    if (nativeCodexOAuth) {
      try {
        oauthGeneration = await this.config.oauthController?.captureRequestGeneration()
        // Preflight pi-ai's locked refresh while the typed ModelsError is still
        // available. `streamSimple()` is lazy and otherwise flattens it into a
        // provider-text event, which must not enter the Harness stream.
        const auth = await requestModels.getAuth(model)
        if (auth === undefined) {
          await reconnectOAuth(this.config.oauthController, oauthGeneration)
        }
      } catch (error) {
        if (error instanceof ModelsError || error instanceof LlmError) {
          await reconnectOAuth(this.config.oauthController, oauthGeneration)
        }
        throw error
      }
    }
    const oauthFailureVersion = oauthRequest?.oauthFailures?.version()

    const consumer = new AbortController()
    const upstream = options.signal === undefined
      ? consumer.signal
      : AbortSignal.any([options.signal, consumer.signal])
    const streamIdleTimeoutMs = profile.streamIdleTimeoutMs
    using watchdog = idleWatchdog(upstream, streamIdleTimeoutMs, 'LLM_STREAM_IDLE_TIMEOUT')

    try {
      const containsImage = options.messages.some(message => contentHasImage(message.content))
      if (containsImage && !model.input.includes('image')) {
        throw new LlmError(`pi-ai model "${model.id}" does not support image input`, 'UNSUPPORTED_CONTENT')
      }
      const attachments = containsImage ? this.config.resolveAttachments?.() : undefined
      if (containsImage && attachments === undefined) {
        throw new LlmError('pi-ai image input requires the durable attachment service', 'UNSUPPORTED_CONTENT')
      }
      const context = attachments === undefined
        ? toPiContext(options)
        : await toPiContext(options, attachments)
      const sourceEvents = requestModels.streamSimple(model, context, {
        ...profileOptions(profile, reasoning, apiKey),
        ...options.temperature === undefined ? {} : { temperature: options.temperature },
        ...options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens },
        ...options.sessionId === undefined ? {} : { sessionId: String(options.sessionId) },
        signal: watchdog.signal,
        // Profile headers are deployment-owned; attribution names are
        // Harness-owned and therefore win collisions.
        headers: requestHeaders(profile.headers),
      })
      const events = nativeCodexOAuth
        ? guardNativeOAuthEvents(
          sourceEvents,
          requestModels,
          oauthRequest?.oauthFailures,
          model,
          oauthFailureVersion,
          this.config.oauthController,
          oauthGeneration,
        )
        : sourceEvents
      const chunks = nativeCodexOAuth
        ? sanitizeNativeCodexChunks(events, model.contextWindow)
        : toStreamChunks(events, model.contextWindow)
      const iterator = chunks[Symbol.asyncIterator]()
      let exhausted = false
      try {
        while (true) {
          const result = await watchdog.next(iterator)
          const timeout = timeoutOf(watchdog.signal, 'LLM_STREAM_IDLE_TIMEOUT')
          if (timeout !== undefined) throw timeout
          if (result.done) {
            exhausted = true
            return
          }
          yield result.value
        }
      } finally {
        if (!exhausted) {
          consumer.abort('pi-ai stream consumer stopped')
          try {
            await iterator.return(undefined)
          } catch (_abortedSdkTeardown) {
            // The stable signal already owns SDK termination; return-time abort cannot add an outcome.
          }
        }
      }
    } catch (error: unknown) {
      if (error instanceof LlmError && error.code === OAUTH_RECONNECT_REQUIRED_CODE) throw error
      if (nativeCodexOAuth
        && (oauthFailureVersion !== oauthRequest?.oauthFailures?.version()
          || error instanceof ModelsError)) {
        await reconnectOAuth(this.config.oauthController, oauthGeneration)
      }
      if (timeoutOf(watchdog.signal, 'LLM_STREAM_IDLE_TIMEOUT') !== undefined) {
        throw new LlmError(
          nativeCodexOAuth
            ? `OpenAI Codex stream idle timeout after ${streamIdleTimeoutMs}ms`
            : `pi-ai stream idle timeout after ${streamIdleTimeoutMs}ms`,
          'TIMEOUT',
          nativeCodexOAuth ? undefined : { cause: error },
        )
      }
      if (options.signal?.aborted) {
        throw new LlmError(
          nativeCodexOAuth ? 'OpenAI Codex request aborted by caller' : 'pi-ai request aborted by caller',
          'ABORTED',
          nativeCodexOAuth ? undefined : { cause: error },
        )
      }
      if (nativeCodexOAuth) throw nativeCodexFailure(error)
      throw error
    } finally {
      consumer.abort('pi-ai stream consumer stopped')
    }
  }
}
