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
