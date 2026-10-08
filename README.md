# opencode-unsloth-limits

Keeps OpenCode's model context limits in sync with a local Unsloth server, so OpenCode stops sending prompts the server rejects as too long.

## Add to OpenCode v2

```
opencode plugin add github:hedinfaok/opencode-unsloth-limits
```

## Setup

In `~/.config/opencode/opencode.json`, remove the `limit` block from each model under your Unsloth provider. The plugin sets the limits instead.

By default it expects the server at `http://127.0.0.1:8888` and the provider to be named `unsloth`. It checks every 10 seconds, and shows a desktop notification if it can't reach the server.
