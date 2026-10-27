/**
 * opencode-unsloth-limits
 *
 * Makes OpenCode mirror a local Unsloth server automatically: the models it
 * serves, their names, and their real per-request context windows.
 *
 * OpenCode does not auto-detect anything for a custom `openai-compatible`
 * provider, and an explicit provider/model in opencode.json overrides plugin
 * transforms. So this plugin OWNS the provider: leave it out of your config and
 * let the plugin register it from the server.
 *
 * The usable per-request window is `context_length / total_slots` (llama.cpp
 * splits the context across parallel slots), which changes whenever the server
 * changes its loaded model or settings.
 *
 * Fail closed: when the server can't be read, the plugin keeps the last known
 * good model list (persisted across restarts) instead of guessing. It never
 * registers a model without the full shape OpenCode requires.
 *
 * No imports at module scope: OpenCode v2 loads a default export matching
 * `{ id, setup }`. See README.md.
 */

const DEFAULT_OUTPUT = 32000
const OPENAI_COMPATIBLE = "@opencode/ai/providers/openai-compatible"

// Reasoning effort levels the local llama-server / chat template understands.
// "none" disables thinking on the server; the DeepSeek chat template branches on
// "high" and "max". Any other value falls through to the template default, so
// these are the meaningful ones. Override with the plugin option
// `reasoningVariants`; disable with `reasoningVariants: []`.
const DEFAULT_REASONING_VARIANTS = [
  { id: "off",  body: { reasoning_effort: "none" } },
  { id: "high", body: { reasoning_effort: "high" } },
  { id: "max",  body: { reasoning_effort: "max" } },
]

const resolveVariants = (caps, options) => {
  if (Array.isArray(options.reasoningVariants)) {
    return options.reasoningVariants.map((v) => ({ id: v.id, body: { ...v.body } }))
  }
  if (caps && caps.supports_reasoning_effort === false) return []
  return DEFAULT_REASONING_VARIANTS.map((v) => ({ id: v.id, body: { ...v.body } }))
}

const CONFIG_DIR = process.env.XDG_CONFIG_HOME
  ? `${process.env.XDG_CONFIG_HOME}/opencode`
  : `${process.env.HOME}/.config/opencode`
const STATUS_FILE = `${CONFIG_DIR}/unsloth-limits.status.json`

// OpenCode model ids must be stable and readable; derive one from the server id.
const modelKey = (serverID) => {
  const last = String(serverID).split("/").pop() || String(serverID)
  return last
    .replace(/[-_]?gguf$/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

const displayName = (m) =>
  (typeof m.display_name === "string" && m.display_name.trim()) || modelKey(m.id)

// A complete Model.Info. Missing any of these is what crashed OpenCode before
// (`time.released` was undefined during Model.snapshot's sort).
const toModel = (m, providerID, effective, opts = {}) => {
  const caps = opts.caps
  const modalities = opts.modalities
  const model = {
    id: modelKey(m.id),
    modelID: String(m.id),
    providerID,
    name: displayName(m),
    capabilities: {
      tools: caps ? caps.supports_tools !== false : true,
      input: modalities && modalities.vision ? ["text", "image"] : ["text"],
      output: ["text"],
    },
    variants: Array.isArray(opts.variants) ? opts.variants : [],
    time: { released: typeof m.created === "number" ? m.created * 1000 : Date.now() },
    cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }],
    status: "active",
    enabled: true,
    limit: {
      context: effective,
      output: Math.min(effective, DEFAULT_OUTPUT),
    },
  }
  if (m.quant) model.family = String(m.quant)
  if (opts.defaultBody) model.body = opts.defaultBody
  return model
}

export default {
  id: "unsloth.limits",
  async setup(ctx) {
    const options = ctx.options ?? {}
    const server =
      typeof options.server === "string" ? options.server.replace(/\/+$/, "") : "http://127.0.0.1:8888"
    const base = server.endsWith("/v1") ? server : `${server}/v1`
    const origin = base.replace(/\/v1$/, "")
    const providerID = typeof options.provider === "string" ? options.provider : "unsloth"
    const providerName =
      typeof options.providerName === "string" ? options.providerName : "Unsloth (local)"
    const refreshMs = typeof options.refreshMs === "number" ? options.refreshMs : 15000
    const notifyEnabled = options.notify !== false

    const fs = () => import("node:fs/promises")

    // The transform callbacks read this live value on every registry rebuild.
    const current = { models: [], slots: 1, loadedID: null }
    let healthy = false
    let lastError = null
    let announcedDown = false
    let lastSignature = null

    const load = async () => {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), 4000)
      try {
        const [modelsRes, propsRes] = await Promise.allSettled([
          fetch(`${base}/models`, { signal: ctrl.signal }),
          fetch(`${origin}/props`, { signal: ctrl.signal }),
        ])
        let slots = 1
        let serverContext
        let caps = null
        let modalities = null
        if (propsRes.status === "fulfilled" && propsRes.value.ok) {
          const props = await propsRes.value.json().catch(() => undefined)
          if (props && typeof props.total_slots === "number" && props.total_slots > 0) {
            slots = props.total_slots
          }
          if (props && typeof props.n_ctx === "number" && props.n_ctx > 0) {
            serverContext = props.n_ctx
          }
          if (props && props.chat_template_caps) caps = props.chat_template_caps
          if (props && props.modalities) modalities = props.modalities
        }
        if (modelsRes.status !== "fulfilled" || !modelsRes.value.ok) {
          throw new Error(`GET ${base}/models failed`)
        }
        const body = await modelsRes.value.json()
        const raw = (body && body.data) || []

        // The per-slot window is a server-wide property (`n_ctx / total_slots`),
        // so unloaded models use the loaded model's context when they report none.
        const advertised = raw.map((m) =>
          typeof m.context_length === "number" && m.context_length > 0
            ? m.context_length
            : m.max_context_length,
        )
        const globalContext =
          serverContext ??
          advertised.filter((n) => typeof n === "number" && n > 0).sort((a, b) => b - a)[0]
        if (typeof globalContext !== "number" || globalContext <= 0) {
          throw new Error("server reported no context size")
        }

        let loadedID = null
        const variants = resolveVariants(caps, options)
        const defaultBody = options.defaultReasoningEffort
          ? { reasoning_effort: String(options.defaultReasoningEffort) }
          : undefined
        const models = []
        for (const m of raw) {
          if (!m.id) continue
          const own =
            typeof m.context_length === "number" && m.context_length > 0
              ? m.context_length
              : typeof m.max_context_length === "number" && m.max_context_length > 0
                ? m.max_context_length
                : globalContext
          if (m.loaded === true) loadedID = modelKey(m.id)
          models.push(
            toModel(m, providerID, Math.floor(Math.min(own, globalContext) / slots), {
              caps,
              modalities,
              variants,
              defaultBody,
            }),
          )
        }
        if (!models.length) throw new Error("server reported no usable models")
        return { models, slots, loadedID }
      } finally {
        clearTimeout(timer)
      }
    }

    const notify = async (title, body, urgency) => {
      if (!notifyEnabled) return
      try {
        const cp = await import("node:child_process")
        cp.execFile("notify-send", ["-a", "opencode", "-u", urgency, title, body], () => {})
      } catch {}
    }

    const persist = async () => {
      const signature = JSON.stringify({
        healthy,
        lastError,
        loadedID: current.loadedID,
        models: current.models,
      })
      if (signature === lastSignature) return
      lastSignature = signature
      try {
        const f = await fs()
        await f.writeFile(
          STATUS_FILE,
          JSON.stringify(
            {
              ok: healthy,
              at: new Date().toISOString(),
              server,
              error: lastError,
              slots: current.slots,
              loadedID: current.loadedID,
              models: current.models,
            },
            null,
            2,
          ) + "\n",
        )
      } catch {}
    }

    // Seed the last known good list so a cold start with the server down is safe.
    try {
      const f = await fs()
      const prev = JSON.parse(await f.readFile(STATUS_FILE, "utf8"))
      if (prev && prev.server === server && Array.isArray(prev.models) && prev.models.length) {
        current.models = prev.models
        if (typeof prev.slots === "number") current.slots = prev.slots
        if (typeof prev.loadedID === "string") current.loadedID = prev.loadedID
      }
    } catch {}

    // Register (and own) the provider. If we have no model list yet, register
    // nothing rather than an empty or invalid provider.
    await ctx.provider.transform((editor) => {
      if (!current.models.length) return
      try {
        editor.add({
          info: {
            id: providerID,
            name: providerName,
            activation: "enabled",
            package: OPENAI_COMPATIBLE,
            settings: {
              baseURL: base,
              apiKey: typeof options.apiKey === "string" ? options.apiKey : "not-needed",
              ...(options.providerSettings && typeof options.providerSettings === "object"
                ? options.providerSettings
                : {}),
            },
          },
          models: current.models,
        })
      } catch (err) {
        lastError = `register failed: ${String(err)}`
      }
    })

    // Keep a usable default: if the configured default points at this provider
    // but at a model that no longer exists, switch it to the loaded model.
    await ctx.model.transform((editor) => {
      if (!current.models.length) return
      const preferred =
        current.models.find((m) => m.id === current.loadedID) ?? current.models[0]
      const def = editor.default.get()
      if (!def) {
        editor.default.set(providerID, preferred.id)
        return
      }
      if (def.providerID !== providerID) return
      if (!current.models.some((m) => m.id === def.modelID)) {
        editor.default.set(providerID, preferred.id)
      }
    })

    const refresh = async () => {
      try {
        const next = await load()
        current.models = next.models
        current.slots = next.slots
        current.loadedID = next.loadedID
        healthy = true
        lastError = null
      } catch (err) {
        healthy = false
        lastError = String(err)
      }

      if (!healthy && !announcedDown) {
        announcedDown = true
        void notify("Unsloth model sync failed", lastError || "unknown error", "critical")
      } else if (healthy && announcedDown) {
        announcedDown = false
        void notify(
          "Unsloth model sync recovered",
          `${current.models.length} model(s) from ${server}`,
          "normal",
        )
      }

      await persist()
      try {
        await ctx.provider.reload()
        await ctx.model.reload()
      } catch {}
    }

    await refresh()

    let inFlight = false
    const poll = setInterval(() => {
      if (inFlight) return
      inFlight = true
      refresh().finally(() => {
        inFlight = false
      })
    }, refreshMs)

    return () => clearInterval(poll)
  },
}
