# Agent Note: OpenAI Codex subscription OAuth

Status: implemented

English | [中文](2026-08-16-openai-codex-oauth.zh.md)

## Problem

The installed pi-ai catalog includes `openai-codex`, but the route authenticates through OAuth alone. A usable offer therefore needs three things the generic API-key path does not supply: a durable pi-ai `CredentialStore`, an interactive login lifecycle, and a configuration surface that never exposes the resulting credential. Without all three, an API-key card or keyless profile advertises a route that fails before making a request.

The earlier safe posture withheld OAuth-only catalog entries while leaving already-stored profiles visible and removable. Reversing that posture is valid only when a disconnected entry remains harmless, connecting does not widen credential visibility, and a successful connection enters the same model-selection and request path as every other primary model.

## Decision

`openai-codex` uses pi-ai's durable OAuth credential store plus a private cross-process authority record carrying a generation, login lease, and reconnect state. The generic pi-ai adapter owns one credential store and one OAuth controller for its Host lifetime; every immutable model collection delegates Codex authentication and refresh to that shared store.

The configurable-provider directory always presents the installed route as `{ kind: 'oauth' }`, while adapter registration keeps it dormant until its profile is connected. The Models page creates an empty profile before login and exposes dedicated connect, cancel, reconnect, disconnect, and delete actions. Once connected, the ordinary pi-ai catalog, model picker, saved default, session-scoped selection, reasoning metadata, and LLM request path apply without a Codex-specific selection path.

The controller accepts only pi-ai's exact device-code selector. It returns the verification URL and one-time code only to the initiating call, rejects browser-callback, manual-code, secret, pasted-token, and lookalike interactions, and clears device-code state when the attempt settles or is cancelled. A Headless profile cannot initiate login; it consumes an existing connection when it shares the Harness home and provider settings with the Web profile.

## Security and lifecycle invariants

The OAuth credential and authority record live under fixed implementation-owned private references. Those references are not configuration: they never appear in `settings.yaml`, `cordis.yml`, provider profiles, browser RPC, events, logs, diagnostics, sessions, or snapshots. The Host rejects generic credential describe, set, and unset for either reference before provider lookup with one detail-free response, so probing reveals neither existence nor state and cannot mutate visibility or emit an event. The credential provider holds its cross-process file lock across each asynchronous read-modify-write callback and atomic commit. Private mutation metadata prevents `credentials/updated` from revealing a reference through the writer, another process, or later file reconciliation; OAuth observers receive only `{ provider, status }`.

The authority record has a monotonic generation and at most one expiring lease with an opaque owner, validated configurable lifetime, half-lifetime renewal, expiry takeover, and matching-owner release. Claiming a login advances the generation and hands pi-ai a generation-scoped credential-store facade. Cancel and disconnect advance the durable generation and clear the lease, so a remote or late poller cannot persist or recreate credentials after revocation; plugin disposal aborts and awaits only owned work, then releases its matching lease without revoking a connection. Another process observing a live lease receives redacted `already-connecting` state instead of a second device code.

pi-ai serializes refreshes through the same shared credential store. Revocation, refresh failure, malformed storage, or unavailable credential storage durably marks the route `reconnect-required`, which every process observes, and produces the stable `OAUTH_RECONNECT_REQUIRED` request failure without raw provider data. All other native Codex terminal events and synchronous provider exceptions are classified internally, then replaced with `OpenAI Codex request failed` before any stream chunk or thrown failure leaves the adapter. Native OAuth never falls back to an API key, process environment, or another provider. An already-existing profile that explicitly names `apiKeyEnv` remains a separate legacy key-auth route; it is not reachable as an OAuth fallback and the OAuth settings card never asks for a key.

## Alternatives considered

**A primary Codex app-server adapter.** Rejected because it would create a second model runtime and selection path beside the existing pi-ai route. pi-ai already owns the Codex catalog, protocol implementation, OAuth exchange, refresh, and model metadata; adapting those through the existing LLM seam keeps normal primary-model behavior authoritative.

**Importing Codex CLI credential files.** Rejected because another program's private file format, location, lifecycle, and mutation ownership are not a Harness credential contract. Import would couple one provider to external state, make refresh ownership ambiguous, and still leave Web login and shared-home coordination unsolved.

**Browser-callback and pasted-token login in V1.** Rejected because a callback adds listener, redirect, reachability, and cancellation behavior that differs across local, remote, and Headless use, while pasted tokens expose an expiring secret and bypass pi-ai's refresh lifecycle. Device-code login uses one interaction across those deployments and keeps token material inside the credential store.

**Continuing to withhold OAuth-only catalog entries.** This was the correct failure posture while the adapter had no durable store, login flow, or OAuth-specific UI. It is rejected for the shipped feature because all three pieces exist and the dormant route prevents a disconnected card from becoming selectable.

**Rejecting a disconnected keyless Codex profile during profile resolution.** Rejected because validation runs for the whole settings namespace at startup and write time; one disconnected profile would otherwise refuse every route in that namespace and strand the profile outside the UI. Resolution accepts the profile, the directory keeps it addressable, and adapter registration is the operation that withholds it until connected.

**Mapping `Provider is not configured` to a named `LlmError`.** Still deferred because this is a general pi-ai diagnostic rather than an OAuth-lifecycle failure: an API-key catalog route that names no credential can still reach it when provider-native environment discovery finds nothing. Native Codex OAuth instead converts missing, revoked, and failed-refresh state to `OAUTH_RECONNECT_REQUIRED`, so broadening this feature would not strengthen its no-fallback guarantee.

## Consequences

Users can connect a ChatGPT subscription from Models and then select its Codex models like ordinary primary models. OpenAI controls which installed-catalog models the subscription may use; connection and catalog listing do not probe entitlements with a model request. Disconnect retains the profile for a later reconnect, while delete removes configuration only after disconnect returns terminal `missing`; a nonterminal reply or later settings failure leaves a recoverable configured card.

Several Harness processes sharing one home also share the OAuth generation, lease, reconnect state, and credential, coordinating every mutation under the same file lock. A cancel or disconnect in any process revokes the active generation for all of them. Lease duration is deployment-configurable because slow or interrupted environments need a different takeover interval, but an overly short value increases avoidable takeover and cancellation. Storage corruption or provider revocation never exposes the rejected payload; it costs a reconnect.

Other catalog providers retain their existing authentication classification. Providers offering an API-key method remain on the API-key path even if they also offer OAuth, and native-environment providers remain native. Existing explicit-key Codex profiles remain operable without weakening the native OAuth no-fallback rule.

`classifyPiAiError()` still maps recognized provider messages to stable codes and uses `PI_AI_ERROR` for unrecognized failures. Native Codex now retains only that classification and discards the provider message; unrelated pi-ai routes keep their existing error text because this feature does not change their privacy policy. Missing, revoked, and refresh-failure Codex states bypass this path through `OAUTH_RECONNECT_REQUIRED`.

## Verification

Credential and pi-ai package suites pin private atomic mutation, generation-scoped writes, two-controller cancel/disconnect races, cross-process reconnect propagation, device-code-only interaction, disposal, dormant registration, terminal-event and synchronous-exception redaction, and the explicit legacy-key distinction. Host tests pin the private generic-credential guard plus explicit OAuth projection fields; client tests pin terminal disconnect-before-delete ordering. Loader composition proves a saved connection works through the shipped Headless profile without starting login. The keyless assembled Web scenario makes a real failing Codex request and proves its hostile sentinel is absent from stream events, durable persistence, browser history and events, Host and browser logs, visible copy, and the golden. The opt-in personal-subscription smoke retains credentials only in process memory, disconnects after a redacted `checkAuth()` and catalog check, and self-skips unless explicitly enabled.
