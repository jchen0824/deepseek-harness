# Disconnected Models card

- dialog "Settings":
  - navigation:
    - text: Settings
    - button "General":
      - img
      - text: General
    - button "Models":
      - img
      - text: Models
    - button "Plugins":
      - img
      - text: Plugins
    - button "Agent presets":
      - img
      - text: Agent presets
  - button "Open configuration file"
  - button "Close":
    - img
    - text: Close
  - heading "Models" [level=2]
  - paragraph: Connect an account or enter API keys to use models from the following providers.
  - list:
    - listitem:
      - text: openai-codex
      - button "Connect ChatGPT"
      - button "Delete openai-codex": Delete
  - button "Add provider" [disabled]:
    - img
    - text: Add provider
  - button "Add a custom provider":
    - img
    - text: Add a custom provider

# Fixed device code

- dialog "Settings":
  - navigation:
    - text: Settings
    - button "General":
      - img
      - text: General
    - button "Models":
      - img
      - text: Models
    - button "Plugins":
      - img
      - text: Plugins
    - button "Agent presets":
      - img
      - text: Agent presets
  - button "Open configuration file"
  - button "Close":
    - img
    - text: Close
  - heading "Models" [level=2]
  - paragraph: Connect an account or enter API keys to use models from the following providers.
  - list:
    - listitem:
      - text: openai-codex Connecting
      - button "Cancel"
      - button "Delete openai-codex": Delete
      - text: Verification code
      - code: ABCD-EFGH
      - link "Open verification page":
        - /url: https://auth.openai.com/codex/device
      - button "Copy code"
  - button "Add provider" [disabled]:
    - img
    - text: Add provider
  - button "Add a custom provider":
    - img
    - text: Add a custom provider

# Connected through the OAuth event

- dialog "Settings":
  - navigation:
    - text: Settings
    - button "General":
      - img
      - text: General
    - button "Models":
      - img
      - text: Models
    - button "Plugins":
      - img
      - text: Plugins
    - button "Agent presets":
      - img
      - text: Agent presets
  - button "Open configuration file"
  - button "Close":
    - img
    - text: Close
  - heading "Models" [level=2]
  - paragraph: Connect an account or enter API keys to use models from the following providers.
  - list:
    - listitem:
      - text: openai-codex Connected
      - button "Disconnect"
      - button "Delete openai-codex": Delete
  - button "Add provider" [disabled]:
    - img
    - text: Add provider
  - button "Add a custom provider":
    - img
    - text: Add a custom provider

# Connected Codex catalog in the normal picker

- menu "Model and reasoning effort":
  - group "DeepSeek":
    - text: DeepSeek
    - menuitemradio "DeepSeek-V4-Flash" [checked]:
      - text: DeepSeek-V4-Flash
      - img
  - group "openai-codex":
    - text: openai-codex
    - menuitemradio "GPT-5.3 Codex Spark"
    - menuitemradio "GPT-5.4"
    - menuitemradio "GPT-5.4 mini"
    - menuitemradio "GPT-5.5"
    - menuitemradio "GPT-5.6 Luna"
    - menuitemradio "GPT-5.6 Sol"
    - menuitemradio "GPT-5.6 Terra"

# Current session Codex selection

- button "Select model, current GPT-5.4, reasoning effort High":
  - text: GPT-5.4 High
  - img

# Saved default inherited by a later session

- button "Select model, current GPT-5.4, reasoning effort High":
  - text: GPT-5.4 High
  - img

# Later session override remains scoped

- button "Select model, current DeepSeek-V4-Flash":
  - text: DeepSeek-V4-Flash
  - img
