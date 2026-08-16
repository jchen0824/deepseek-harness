# Agent Note: OAuth public topology privacy

Status: implemented

English | [中文](2026-08-16-oauth-public-topology-privacy.zh.md)

## Problem

A configured native Codex OAuth profile did not register its adapter until the controller reported `connected`. Public `llm.providers` exposes route activity, and public `llm.models` plus `session.models` expose route membership. A public or trusted remote reader could therefore infer private OAuth connection state from catalog membership or a forwarded `llm/adapters-updated` event.

OAuth lifecycle RPCs are loopback-only because their replies and mutations concern private account state. The public model catalog is intentionally available to trusted remote clients, so it must not become an alternate OAuth-status read.

## Decision

The generic pi-ai adapter registers every resolved profile, including an OAuth-only Codex profile, regardless of OAuth status. An absent profile still registers no route. `llm.providers`, `llm.models`, and `session.models` therefore vary with profile configuration, not with private OAuth connection state. A private status transition emits the local `llm/oauth-connection-updated` event without re-registering the adapter or emitting a public topology update.

The Models page reads `llm.oauthStatus` directly on loopback and `providerUsable` requires its OAuth connection to be `connected`. A disconnected native OAuth request is protected by the normal request preflight and returns `OAUTH_RECONNECT_REQUIRED`. This supersedes the status-coupled registration portion of [OpenAI Codex subscription OAuth](../feature/2026-08-16-openai-codex-oauth.md).

## Alternatives considered

**Redacting only `llm.providers.active`.** Rejected because `llm.models` and `session.models` still disclose the same route through their group membership.

**Withholding every configured OAuth route from public catalogs.** Rejected because catalog topology is a normal trusted-remote capability and a route can be published without revealing whether its OAuth credential is connected.

**Allowing trusted remotes to call lifecycle RPCs.** Rejected because a status result is itself private account state, and start, cancel, and disconnect mutate durable credentials.

## Consequences

A configured but disconnected OAuth profile contributes public catalog metadata, which reveals profile presence but not connection or entitlement state. The Models page remains unusable until loopback status is `connected`, and direct native requests fail predictably until then.

Trusted remotes can use the same provider and model catalog as loopback clients, but lifecycle RPCs remain forbidden. Connection transitions no longer cause public catalog churn, so model selectors do not learn credential state from membership or event timing.

## Verification

The pi-ai dynamic-configuration suite proves a configured OAuth route remains registered across peer credential and lease transitions without an `llm/adapters-updated` event. Catalog and Host tests pin profile-driven provider/model membership without OAuth status in the public provider result. The client-connection host test compares loopback and trusted-remote catalog replies and proves the trusted remote receives `403` for `llm.oauthStatus`. The assembled Web OAuth scenario observes the Codex model group before connection completion and retains it after the private status transition.
