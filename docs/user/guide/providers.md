# Configure models

English | [中文](providers.zh.md)

This guide assumes you started the Web UI through the [root README](../../../README.md#run). Model changes take effect on the next request without restarting the server.

## Configure DeepSeek

Open **Settings → Models**. The DeepSeek card exposes one API-key field; enter the key and save it.

![The Models page: the DeepSeek card, with Add provider and Add a custom provider below it](providers-models-page.png)

Keys are write-only. The page receives a redacted descriptor after saving, never the literal secret. The key is stored in `$DSH_HOME/.credentials.yaml`, while settings retain only its credential reference.

## Add a catalog provider

Choose **Add provider**, select a provider such as Anthropic or OpenAI, enter its API key, and save. The installed catalog supplies the endpoint, protocol, and model list.

Providers with native authentication need their native credentials instead. Bedrock, Vertex, and Azure use AWS credentials and a region, an ADC project, and an `api-version` respectively; filling only the API-key field does not configure them. OpenAI Codex uses the ChatGPT connection below.

## Connect OpenAI Codex with ChatGPT

1. Open **Settings → Models**.
2. Choose **Connect ChatGPT** for OpenAI Codex.
3. Open the verification page, enter the displayed code, and complete sign-in.
4. Select a connected `openai-codex` model in the normal picker.

The page supports device-code sign-in only. It keeps the code in the current page while authorization is pending and stores the completed OAuth connection in the Harness credential store. Personal access and refresh tokens, account data, and the implementation-owned private references never enter `settings.yaml`, `cordis.yml`, provider configuration, browser events, or snapshots. Do not paste personal OAuth tokens into configuration files.

**Disconnect** removes the saved OAuth connection but keeps the provider configuration, so **Connect ChatGPT** can start a new sign-in. A revoked connection or failed refresh shows **Reconnect** and never falls back to an API key, environment credential, or another provider. **Delete** disconnects first and then removes the provider configuration; if deletion fails after disconnecting, the card remains configured but disconnected so you can retry safely.

OpenAI controls which catalog models a subscription may use; a connected account does not guarantee access to every listed model. A Headless run cannot start the interactive login, but the Web and Headless profiles consume the same successful connection when they use the same Harness home. Keep the `openai-codex` provider configuration and model selection in that home, connect through the Web UI once, and then run Headless normally.

## Add a custom provider

Choose **Add a custom provider** for a company gateway, self-hosted server, or provider absent from the installed catalog. Supply a lowercase Provider ID, base URL, API protocol, credential, and at least one model.

![The custom provider form: Provider ID, display name, base URL, API protocol, and API key](providers-custom-form.png)

The Provider ID is permanent because requests, saved sessions, model defaults, and credential references use it. To rename a provider, add a new provider and delete the old one. The display name, base URL, protocol, credential, and models remain editable.

Under **Model catalog**, choose **Fetch available models** to query the base URL and credential currently shown in the form. Selecting candidates updates the draft; the provider is not stored until you save. Catalog providers use their installed catalog without a network request.

### Image input

A model you enter by hand is treated as text-only until it says otherwise, because nothing can ask an endpoint which modalities it accepts. Attaching an image to such a model is refused before it is sent, naming the model.

A vision model on a custom provider therefore needs one line. The form has no field for it; add `input` to the model in `$DSH_HOME/settings.yaml`:

```yaml
llm-pi-ai:
  providers:
    my-gateway:
      apiKeyEnv: GATEWAY_API_KEY
      api: openai-completions
      baseURL: https://gateway.example/v1
      models:
        - id: legacy-chat
        - id: vision-preview
          input: [text, image]
```

`input` accepts `text` and `image`, and applies to that model alone, so one route can serve both kinds. Omitting it — or writing an empty list, which means the same thing — keeps whatever the installed catalog records for that model, and falls back to the route's `defaultInput` for a model the catalog does not describe.

If every model you entered by hand takes images, set the fallback once on the route instead of on each of them:

```yaml
llm-pi-ai:
  providers:
    vision-gateway:
      apiKeyEnv: GATEWAY_API_KEY
      api: openai-completions
      baseURL: https://vision.example/v1
      defaultInput: [text, image]
      models:
        - id: first-model
        - id: second-model
```

`defaultInput` is a fallback, not an override, and defaults to `[text]`: on a catalog provider it answers only for models the catalog does not describe, so it never removes images from a catalog model that has them. Narrow one of those with that model's own `input`. A catalog provider has no `models` list to put it in, so write it under `modelOverrides`, keyed by model id:

```yaml
llm-pi-ai:
  providers:
    anthropic:
      modelOverrides:
        claude-sonnet-4-5:
          input: [text]
```

Every list must name at least one modality except a model's own, where an empty list means the same as omitting it. An unknown modality is refused wherever it is written.

Both fields state a claim about your endpoint rather than checking it. A model that declares images its endpoint does not serve is not caught here; the provider rejects the request instead.

## Select a model

Configured providers appear in the model picker. Selecting a model also makes it the default for new sessions. A session that has already sent a request retains the model recorded in its own log.

If a saved default names a provider that was deleted, the composer displays **Select model** and blocks input until another model is selected.

## Troubleshooting

- **`MISSING_CREDENTIAL`** — Store the provider key through the Models page or supply the referenced environment variable.
- **`UNKNOWN_MODEL`** — Select a configured model or add the missing model to the custom provider.
- **Fetching available models returns 401** — Check the key. Model discovery calls the OpenAI-compatible `GET /models` endpoint; enter models manually for endpoints that do not provide it.
- **An image is refused before sending** — The model declares no image modality. Give a custom provider's model `input: [text, image]`; DeepSeek's own chat-completions route is text-only and cannot be configured otherwise.
- **The provider rejects a request carrying an image** — The model declares images its endpoint does not actually serve. Remove `image` from whichever list granted it — the model's `input`, or the route's `defaultInput` — then start a new session: the attached image stays in the session log, so the same request repeats until the session moves off it.

## Advanced configuration

The generated [plugin configuration catalog](../../config-catalog.md) lists every supported field and default. The [`dsh-llm-pi-ai`](../../../packages/llm/llm-pi-ai/README.md) and [`dsh-llm-deepseek`](../../../packages/llm/llm-deepseek/README.md) references own direct `settings.yaml` configuration, catalog resolution, reasoning controls, credentials, and adapter errors.
