/**
 * llm domain zod schemas (names derived from map keys: llmProvidersRequestSchema /
 * llmProvidersValueSchema / llmModelsRequestSchema / llmModelsValueSchema).
 */

import { z } from 'zod'
import type { RequestPayload, ResponseValue } from './rpc-map.ts'
import type { Wire } from './rpc.schema.ts'
import type {
  ConfigurableProviderView,
  DiscoveredModelView,
  OAuthConnectionView,
  OAuthStartActionView,
} from './llm.ts'
import { modelCatalogFailureSchema, modelProviderGroupSchema } from './sessions.schema.ts'

/** Provider authentication metadata exposed by llm.providers. */
export const llmProviderAuthSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('api-key') }),
  z.object({ kind: z.literal('oauth') }),
  z.object({ kind: z.literal('native') }),
])

/** Redacted OAuth connection state shared by snapshots, replies, and events. */
export const oauthConnectionViewSchema = z.object({
  provider: z.string().min(1).max(256),
  status: z.union([
    z.literal('missing'),
    z.literal('connecting'),
    z.literal('connected'),
    z.literal('reconnect-required'),
  ]),
}) satisfies z.ZodType<Wire<OAuthConnectionView>>

/** ConfigurableProviderView row of llm.providers. */
export const configurableProviderViewSchema = z.object({
  provider: z.string().min(1),
  displayName: z.string().min(1),
  settingsNs: z.string(),
  settingsPath: z.array(z.string()),
  active: z.boolean(),
  auth: llmProviderAuthSchema,
  connection: oauthConnectionViewSchema.optional(),
  declared: z.boolean().optional(),
}) satisfies z.ZodType<Wire<ConfigurableProviderView>>

/** llm.providers request payload. */
export const llmProvidersRequestSchema = z.object({}) satisfies z.ZodType<Wire<RequestPayload<'llm.providers'>>>

/** llm.providers response value. */
export const llmProvidersValueSchema = z.object({
  providers: z.array(configurableProviderViewSchema),
}) satisfies z.ZodType<Wire<ResponseValue<'llm.providers'>>>

/** llm.models request payload. */
export const llmModelsRequestSchema = z.object({}) satisfies z.ZodType<Wire<RequestPayload<'llm.models'>>>

/** llm.models response value. */
export const llmModelsValueSchema = z.object({
  groups: z.array(modelProviderGroupSchema),
  failures: z.array(modelCatalogFailureSchema),
}) satisfies z.ZodType<Wire<ResponseValue<'llm.models'>>>

/** DiscoveredModelView row of llm.discoverModels. */
export const discoveredModelViewSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).optional(),
  contextWindow: z.number().int().positive().optional(),
  maxTokens: z.number().int().positive().optional(),
}) satisfies z.ZodType<Wire<DiscoveredModelView>>

/** llm.discoverModels request payload. */
export const llmDiscoverModelsRequestSchema = z.object({
  settingsNs: z.string().min(1),
  provider: z.string().min(1).optional(),
  baseURL: z.string().min(1).optional(),
  api: z.string().min(1).optional(),
  // Write-only at the host: used for this one interrogation, never stored and
  // never returned. It does ride the client's outgoing envelope like every
  // other secret-bearing payload (`credentials.set`, `settings.update`), which
  // `subscribeEnvelopes()` observers can see — redacting that tap is a
  // configuration-plane-wide change, not this method's to make alone.
  apiKey: z.string().min(1).optional(),
}) satisfies z.ZodType<Wire<RequestPayload<'llm.discoverModels'>>>

/** llm.discoverModels response value. */
export const llmDiscoverModelsValueSchema = z.object({
  models: z.array(discoveredModelViewSchema),
}) satisfies z.ZodType<Wire<ResponseValue<'llm.discoverModels'>>>

const oauthProviderRequestSchema = z.object({
  provider: z.string().min(1).max(256),
})

/** llm.oauthStart request payload. */
export const llmOAuthStartRequestSchema = oauthProviderRequestSchema satisfies z.ZodType<Wire<RequestPayload<'llm.oauthStart'>>>

/** llm.oauthStatus request payload. */
export const llmOAuthStatusRequestSchema = oauthProviderRequestSchema satisfies z.ZodType<Wire<RequestPayload<'llm.oauthStatus'>>>

/** llm.oauthCancel request payload. */
export const llmOAuthCancelRequestSchema = oauthProviderRequestSchema satisfies z.ZodType<Wire<RequestPayload<'llm.oauthCancel'>>>

/** llm.oauthDisconnect request payload. */
export const llmOAuthDisconnectRequestSchema = oauthProviderRequestSchema satisfies z.ZodType<Wire<RequestPayload<'llm.oauthDisconnect'>>>

const oauthDeviceCodeSchema = z.object({
  verificationUri: z.url().max(2048),
  userCode: z.string().min(1).max(256),
  intervalSeconds: z.number().int().positive().optional(),
  expiresInSeconds: z.number().int().positive().optional(),
})

const oauthStartActionViewSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('device-code'), deviceCode: oauthDeviceCodeSchema }),
  z.object({ kind: z.literal('already-connecting') }),
  z.object({ kind: z.literal('connected') }),
]) satisfies z.ZodType<Wire<OAuthStartActionView>>

/** llm.oauthStart response value. */
export const llmOAuthStartValueSchema = z.object({
  connection: oauthConnectionViewSchema,
  start: oauthStartActionViewSchema,
}) satisfies z.ZodType<Wire<ResponseValue<'llm.oauthStart'>>>

/** Shared redacted response value for OAuth status, cancellation, and disconnection. */
export const llmOAuthConnectionValueSchema = z.object({
  connection: oauthConnectionViewSchema,
}) satisfies z.ZodType<Wire<ResponseValue<'llm.oauthStatus'>>>

/** llm.oauthStatus response value. */
export const llmOAuthStatusValueSchema = llmOAuthConnectionValueSchema satisfies z.ZodType<Wire<ResponseValue<'llm.oauthStatus'>>>

/** llm.oauthCancel response value. */
export const llmOAuthCancelValueSchema = llmOAuthConnectionValueSchema satisfies z.ZodType<Wire<ResponseValue<'llm.oauthCancel'>>>

/** llm.oauthDisconnect response value. */
export const llmOAuthDisconnectValueSchema = llmOAuthConnectionValueSchema satisfies z.ZodType<Wire<ResponseValue<'llm.oauthDisconnect'>>>
