# opencode-unsloth-limits

Makes OpenCode use your local Unsloth server's models, names, and real context
sizes automatically. When the server changes its loaded model or context size,
OpenCode follows.

## Add to OpenCode v2

```
opencode plugin add github:hedinfaok/opencode-unsloth-limits
```

## Setup

Remove the `unsloth` provider block from `~/.config/opencode/opencode.json`. The
plugin creates it from the server.

By default it expects the server at `http://127.0.0.1:8888` and names the
provider `unsloth`. It checks every 15 seconds. If the server can't be reached,
it keeps the last known models and shows a desktop notification.

## Reasoning variants

Each model is registered with effort variants built from the server's
`chat_template_caps` (only when `supports_reasoning_effort` is true):

| Reference | Body |
| --- | --- |
| `unsloth/<model>` | (no `reasoning_effort`; server default) |
| `unsloth/<model>#off` | `reasoning_effort: "none"` (disables thinking) |
| `unsloth/<model>#high` | `reasoning_effort: "high"` |
| `unsloth/<model>#max` | `reasoning_effort: "max"` |

`high`/`max` are the levels the DeepSeek chat template defines; `none` is
handled by llama-server to end thinking. Other values fall through to the
template default.

## Model fields mapped from the server

- `limit.context` — `context_length` (or `max_context_length`), divided by `total_slots`.
- `limit.output` — capped at 8192.
- `capabilities.tools` — `chat_template_caps.supports_tools`.
- `capabilities.input` — `["text", "image"]` when `modalities.vision`, else `["text"]`.
- `family` — the model's quant string.
- `name` — `display_name`; `time.released` — `created`; `cost` — 0.

## Options

```jsonc
{
  "plugins": [
    {
      "package": "github:hedinfaok/opencode-unsloth-limits",
      "options": {
        "server": "http://127.0.0.1:8888",
        "provider": "unsloth",
        "providerName": "Unsloth (local)",
        "refreshMs": 15000,
        "notify": true,
        "defaultReasoningEffort": "high",
        "reasoningVariants": [
          { "id": "off",  "body": { "reasoning_effort": "none" } },
          { "id": "high", "body": { "reasoning_effort": "high" } },
          { "id": "max",  "body": { "reasoning_effort": "max" } }
        ],
        "providerSettings": { "chunkTimeout": 0 }
      }
    }
  ]
}
```

- `reasoningVariants` — override the variant list; `[]` disables variants.
- `defaultReasoningEffort` — add a model-level `body.reasoning_effort` default.
- `providerSettings` — extra provider `settings` (e.g. `headerTimeout`,
  `chunkTimeout`, `timeout`, `transport`). Local generation is slow, so a longer
  or disabled chunk timeout can help.
