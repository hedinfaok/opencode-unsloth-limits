/**
 * opencode-unsloth-limits
 *
 * Keeps OpenCode's model context limits in sync with a local Unsloth server.
 * See README.md.
 */

const FALLBACK_CONTEXT = 8192

const CONFIG_DIR = process.env.XDG_CONFIG_HOME
  ? `${process.env.XDG_CONFIG_HOME}/opencode`
  : `${process.env.HOME}/.config/opencode`
const STATUS_FILE = `${CONFIG_DIR}/unsloth-limits.status.json`

const stripQuant = (id) => {
  const s = String(id)
  const i = s.indexOf(":")
  return i === -1 ? s : s.slice(0, i)
}
const normalize = (s) => stripQuant(s).toLowerCase().replace(/[^a-z0-9]/g, "")

const matchWindow = (candidates, windows) => {
  const norms = [...new Set(candidates.filter(Boolean).map(normalize).filter(Boolean))]
  for (const w of windows) {
    const full = normalize(w.base)
    const short = normalize(String(w.base).split("/").pop())
    for (const n of norms) {
      if (n === full || n === short) return w.effective
      if (n.length >= 6 && (full.startsWith(n) || short.startsWith(n))) return w.effective
      if (short.length >= 6 && n.startsWith(short)) return w.effective
    }
  }
  return undefined
}

export default {
  id: "unsloth.limits",
  async setup(ctx) {
    const options = ctx.options ?? {}
    const server = typeof options.server === "string" ? options.server : "http://127.0.0.1:8888"
    const providerID = typeof options.provider === "string" ? options.provider : "unsloth"
    const refreshMs = typeof options.refreshMs === "number" ? options.refreshMs : 10000
    const fallback = typeof options.fallback === "number" ? options.fallback : FALLBACK_CONTEXT
    const notifyEnabled = options.notify !== false

    const fs = () => import("node:fs/promises")

    let windows = []
    let providerModelIDs = {}
    let healthy = false
    let lastError = null
    let announcedDown = false
    let lastSignature = null

    const readConfig = async () => {
      const map = {}
      try {
        const f = await fs()
        for (const file of ["opencode.json", "opencode.jsonc"]) {
          const path = `${CONFIG_DIR}/${file}`
          try {
            const cfg = JSON.parse(await f.readFile(path, "utf8"))
            const models = (cfg.providers?.[providerID]?.models) ?? {}
            for (const [key, val] of Object.entries(models)) {
              if (val && val.modelID) map[key] = val.modelID
            }
            break
          } catch {}
        }
      } catch {}
      return map
    }

    const load = async () => {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), 4000)
      try {
        const [modelsRes, propsRes] = await Promise.allSettled([
          fetch(`${server}/v1/models`, { signal: ctrl.signal }),
          fetch(`${server}/props`, { signal: ctrl.signal }),
        ])
        let slots = 1
        if (propsRes.status === "fulfilled" && propsRes.value.ok) {
          const props = await propsRes.value.json().catch(() => undefined)
          if (props && typeof props.total_slots === "number" && props.total_slots > 0) {
            slots = props.total_slots
          }
        }
        if (modelsRes.status !== "fulfilled" || !modelsRes.value.ok) {
          throw new Error(`GET ${server}/v1/models failed`)
        }
        const body = await modelsRes.value.json()
        const out = []
        for (const m of (body && body.data) || []) {
          const total = typeof m.context_length === "number" ? m.context_length : m.max_context_length
          if (typeof total === "number" && total > 0 && m.id) {
            out.push({ base: String(m.id), effective: Math.floor(total / slots) })
          }
        }
        return out
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
      const signature = JSON.stringify({ healthy, lastError, windows })
      if (signature === lastSignature) return
      lastSignature = signature
      try {
        const f = await fs()
        await f.writeFile(
          STATUS_FILE,
          JSON.stringify(
            { ok: healthy, at: new Date().toISOString(), server, error: lastError, windows, providerModelIDs },
            null,
            2,
          ) + "\n",
        )
      } catch {}
    }

    const refresh = async () => {
      try {
        providerModelIDs = await readConfig()
        const next = await load()
        if (next.length) {
          windows = next
          healthy = true
          lastError = null
        } else {
          healthy = false
          lastError = "server reported no context_length"
        }
      } catch (err) {
        healthy = false
        lastError = String(err)
      }

      if (!healthy && !announcedDown) {
        announcedDown = true
        void notify("Unsloth limits sync failed", lastError || "unknown error", "critical")
      } else if (healthy && announcedDown) {
        announcedDown = false
        void notify("Unsloth limits sync recovered", `${windows.length} window(s) from ${server}`, "normal")
      }

      await persist()
    }

    try {
      const f = await fs()
      const prev = JSON.parse(await f.readFile(STATUS_FILE, "utf8"))
      if (prev && prev.server === server && Array.isArray(prev.windows) && prev.windows.length) {
        windows = prev.windows
        providerModelIDs = prev.providerModelIDs || {}
      }
    } catch {}

    await refresh()

    const clamp = (editor) => {
      const known = windows.map((w) => w.effective)
      const floor = known.length ? Math.min(...known) : fallback
      for (const model of editor.list()) {
        if (model.providerID !== providerID) continue
        const exact = matchWindow([providerModelIDs[model.id], model.modelID, model.id], windows)
        const target = exact ?? floor
        editor.update(providerID, model.id, (draft) => {
          draft.limit.context = Math.min(draft.limit.context, target)
          draft.limit.output = Math.min(draft.limit.output, target)
        })
      }
    }

    await ctx.model.transform(clamp)

    let inFlight = false
    const poll = setInterval(() => {
      if (inFlight) return
      inFlight = true
      refresh()
        .then(() => ctx.model.reload())
        .catch(() => {})
        .finally(() => {
          inFlight = false
        })
    }, refreshMs)

    return () => clearInterval(poll)
  },
}
