/** @jsxImportSource @opentui/solid */
import { test } from "bun:test"
import assert from "node:assert/strict"
import { Show, createComponent, createSignal } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { RGBA } from "@opentui/core"
import { testRender, useRenderer } from "@opentui/solid"
import type { Plugin } from "@opencode/plugin/tui"

const { default: plugin } = await import(process.env.PLUGIN_TEST_ENTRY ?? "../src/tui")
const white = RGBA.fromHex("#ffffff")
const gray = RGBA.fromHex("#888888")
const skill = { id: "ui", name: "UI", description: "UI instructions", content: "Keep the existing interface." }
const message = (id: string, agent: string, count = 1, created = 1) => ({
  id, type: "assistant", agent, time: { created },
  content: Array.from({ length: count }, (_, i) => ({
    type: "tool", id: `call-${i}`, name: "skill", executed: false,
    state: { status: "completed", input: { id: "ui" }, content: [{ type: "text", text: '<skill_content name="UI">\nInstructions' }] },
    time: { created, completed: created + 1 },
  })),
})

/** Minimal host using the same rendered-test primitives as the existing suite. */
async function withUsage(
  check: (view: Awaited<ReturnType<typeof testRender>>, host: any) => Promise<void>,
  options: { width?: number; history?: (input: any) => Promise<any>; prefs?: Record<string, unknown>; initialMessages?: Record<string, any[]> } = {},
) {
  const [messages, setMessages] = createSignal<Record<string, any[]>>(options.initialMessages ?? { s1: [message("m1", "unity-engineer", 3), message("m2", "argus", 2)], s2: [message("m1", "other-agent")] })
  const [selected, select] = createSignal("s1")
  const [dialog, setDialog] = createSignal<(() => any) | undefined>()
  const [themeMode, setThemeMode] = createSignal("dark")
  const events = new Map<string, (event: any) => void>()
  const layers: any[] = []
  let renderPanel!: (input: { sessionID: string }) => any
  let settings: any
  let mutateSettings: any
  const context: any = {
    location: { directory: "/test" },
    get themeMode() { return themeMode() },
    renderer: { clearSelection: () => {}, getSelection: () => null, getLinkAt: () => null },
    storage: {
      memory: (_key: string, options: any) => {
        const [state, setState] = createStore({ ...options.initial })
        return [state, (fn: any) => setState(produce(fn))]
      },
      store: (_key: string, input: any) => {
        const [state, setState] = createStore({ ...input.initial, ...options.prefs })
        settings = state
        mutateSettings = (fn: any) => setState(produce(fn))
        return [state, async (fn: any) => mutateSettings(fn)]
      },
    },
    theme: {
      hue: { accent: { 200: white }, interactive: { 200: white } },
      categorical: [{ 200: white }],
      background: { base: RGBA.fromHex("#111111"), action: { primary: { focused: white } } },
      text: { base: white, muted: gray, action: { primary: { focused: white } }, feedback: { error: { base: white }, success: { base: white } } },
      markdown: { text: white, heading: white, strong: white, emphasis: white, listItem: white, blockQuote: white, code: white, link: white, linkText: white },
      surface: () => context.theme,
    },
    client: {
      message: { list: options.history ?? (async () => ({ data: [], cursor: {} })) },
      file: { list: async () => ({ location: context.location, data: [] }) },
    },
    data: {
      location: {
        default: () => context.location,
        skill: { sync: async () => {}, list: () => [skill], invalidate: () => {} },
        agent: { sync: async () => {}, list: () => [{ id: "build", permissions: [] }] },
      },
      session: {
        get: () => ({ agent: "build", location: context.location }),
        message: { list: (id: string) => messages()[id] ?? [], invalidate: () => {}, sync: async () => {} },
      },
      on: (name: string, callback: (event: any) => void) => { events.set(name, callback); return () => events.delete(name) },
    },
    keymap: { layer: (getLayer: () => any) => { layers.push(getLayer()) }, commands: () => [], dispatch: () => {} },
    ui: {
      slot: (claim: any) => { renderPanel = claim.render; return () => {} },
      dialog: {
        show: (render: () => any) => setDialog(() => () => {
          const renderer = useRenderer()
          Object.assign(context.renderer, {
            nativeScene: renderer.nativeScene ?? context.renderer,
            once: renderer.once.bind(renderer),
            off: renderer.off.bind(renderer),
            requestRender: renderer.requestRender.bind(renderer),
          })
          return render()
        }),
        set: () => {},
        clear: () => setDialog(undefined),
      },
      router: { current: () => ({ type: "session", sessionID: selected() }) },
      toast: { show: () => {} },
    },
  }
  const cleanup = plugin.setup!(context as Plugin.Context) as () => void
  const view = await testRender(() => (
    <box width="100%" flexDirection="column">
      <box height={5} flexShrink={0}>{createComponent(renderPanel, { get sessionID() { return selected() } })}</box>
      <Show when={dialog()}>{(render) => render()()}</Show>
    </box>
  ), { width: options.width ?? 120, height: 40 })
  const host = {
    context, events, layers, settings, mutateSettings, select, setThemeMode,
    setMessages: (id: string, value: any[]) => setMessages((old) => ({ ...old, [id]: value })),
    openSettings: () => layers.flatMap((layer) => layer.commands).find((command) => command.id === "opencode-skills-tui.sider").run(),
    close: () => context.ui.dialog.clear(),
    dialog,
  }
  try { await check(view, host) } finally { cleanup(); view.renderer.destroy() }
}

function node(view: Awaited<ReturnType<typeof testRender>>, id: string) {
  const found = view.renderer.root.findDescendantById(id)
  assert.ok(found, `missing rendered node: ${id}`)
  return found
}

async function click(view: Awaited<ReturnType<typeof testRender>>, id: string, button: 0 | 1 | 2 = 0) {
  const target = node(view, id)
  await view.mockMouse.click(target.x, target.y, button)
  await view.flush()
}

test("sidebar adds only the usage line; it is not a new click target", async () => {
  await withUsage(async (view, host) => {
    await view.waitForFrame((frame) => frame.includes("unity-engineer ×3 · argus ×2"))
    assert.match(view.captureCharFrame(), /1 loaded · 1 visible/)
    assert.match(view.captureCharFrame(), /• UI/)
    assert.equal(node(view, "skills-panel.ui.agents").height, 1)
    await click(view, "skills-panel.ui.agents")
    assert.equal(host.dialog(), undefined)
    await click(view, "skills-panel.ui")
    await view.waitForFrame((frame) => frame.includes("agents: unity-engineer ×3 · argus ×2"))
    assert.match(view.captureCharFrame(), /Keep the existing interface/)
    assert.deepEqual(host.layers.flatMap((layer: any) => layer.commands).filter((command: any) => command.slash).map((command: any) => command.slash.name), ["skills-sidebar"])
  })
})

test("the new settings toggle hides only the sidebar line, not preview information or counting", async () => {
  await withUsage(async (view, host) => {
    await view.waitForFrame((frame) => frame.includes("unity-engineer ×3"))
    assert.equal(host.settings.usage, "on")
    host.openSettings()
    await view.waitForFrame((frame) => frame.includes("Agent usage"))
    await click(view, "skills-sider.usage")
    assert.equal(host.settings.usage, "off")
    host.close()
    await view.flush()
    assert.ok(!view.renderer.root.findDescendantById("skills-panel.ui.agents"))
    host.setMessages("s1", [message("m1", "unity-engineer", 4)])
    await view.flush()
    await click(view, "skills-panel.ui")
    await view.waitForFrame((frame) => frame.includes("agents: unity-engineer ×4"))
    assert.equal(host.settings.preview, "left-click")
    assert.equal(host.settings.mention, "right-click")
  })
})

test("preview counts remain reactive without changing skill stats", async () => {
  await withUsage(async (view, host) => {
    await view.waitForFrame((frame) => frame.includes("unity-engineer ×3"))
    await click(view, "skills-panel.ui")
    await view.waitForFrame((frame) => frame.includes("agents: unity-engineer ×3"))
    const stats = view.captureCharFrame().split("\n").find((line) => line.includes("stats:"))
    host.setMessages("s1", [message("m1", "unity-engineer", 4), message("m2", "argus", 2)])
    await view.waitForFrame((frame) => frame.includes("agents: unity-engineer ×4 · argus ×2"))
    assert.equal(view.captureCharFrame().split("\n").find((line) => line.includes("stats:")), stats)
  })
})

test("compaction clears counts and prevents a late history read from restoring old calls", async () => {
  const pending = Promise.withResolvers<any>()
  let requests = 0
  await withUsage(async (view, host) => {
    await view.waitForFrame((frame) => frame.includes("unity-engineer ×3"))
    host.setMessages("s1", [{ id: "compact", type: "compaction", status: "completed" }, message("after", "argus")])
    await view.waitForFrame((frame) => frame.includes("argus ×1") && !frame.includes("unity-engineer"))
    pending.resolve({ data: [message("old-history", "stale-agent", 9)], cursor: {} })
    await view.flush()
    assert.doesNotMatch(view.captureCharFrame(), /stale-agent|unity-engineer/)
    assert.match(view.captureCharFrame(), /argus ×1/)
  }, { history: async () => ++requests === 1 ? pending.promise : { data: [], cursor: {} } })
})

test("session switching does not aggregate other sessions or reassign historical agents", async () => {
  await withUsage(async (view, host) => {
    await view.waitForFrame((frame) => frame.includes("unity-engineer ×3"))
    host.select("s2")
    await view.waitForFrame((frame) => frame.includes("other-agent ×1"))
    assert.doesNotMatch(view.captureCharFrame(), /unity-engineer|argus/)
    host.select("s1")
    await view.waitForFrame((frame) => frame.includes("unity-engineer ×3 · argus ×2"))
    assert.doesNotMatch(view.captureCharFrame(), /other-agent/)
  })
})

test("narrow rows truncate usage independently and keep the original token column", async () => {
  await withUsage(async (view, host) => {
    await view.waitForFrame((frame) => frame.includes("unity-engineer"))
    const row = node(view, "skills-panel.ui")
    const usage = node(view, "skills-panel.ui.agents")
    const tokens = node(view, "skills-panel.ui.tokens")
    assert.equal(usage.y, row.y + 1)
    assert.equal(usage.height, 1)
    assert.equal(tokens.y, row.y)
    host.setThemeMode("light")
    await view.flush()
    assert.equal(node(view, "skills-panel.ui.agents").height, 1)
    host.mutateSettings((draft: any) => { draft.usage = "off" })
    await view.flush()
    assert.ok(view.renderer.root.findDescendantById("skills-panel.ui.tokens"))
  }, { width: 28, prefs: { token: "listing" } })
})

test("history-discovered compaction cannot be undone by a stale cached stage", async () => {
  let requests = 0
  await withUsage(async (view, host) => {
    await view.waitForFrame((frame) => frame.includes("new-agent ×1"))
    assert.doesNotMatch(view.captureCharFrame(), /old-agent/)
    host.setMessages("s1", [
      { id: "c1", type: "compaction", status: "completed", time: { created: 10 } },
      message("before", "old-agent", 3, 15),
    ])
    await view.flush()
    assert.match(view.captureCharFrame(), /new-agent ×1/)
    assert.doesNotMatch(view.captureCharFrame(), /old-agent/)
    assert.equal(requests, 1)
  }, {
    initialMessages: { s1: [
      { id: "c1", type: "compaction", status: "completed", time: { created: 10 } },
      message("before", "old-agent", 3, 15),
    ] },
    history: async () => {
      requests++
      return { data: [message("after", "new-agent", 1, 30),
        { id: "c2", type: "compaction", status: "completed", time: { created: 20 } }], cursor: {} }
    },
  })
})

test("a marker-less stale cache cannot restore pre-compaction usage", async () => {
  await withUsage(async (view) => {
    await view.waitForFrame((frame) => frame.includes("new-agent ×1"))
    assert.doesNotMatch(view.captureCharFrame(), /old-agent/)
  }, {
    initialMessages: { s1: [message("before", "old-agent", 3, 15)] },
    history: async () => ({ data: [message("after", "new-agent", 1, 30),
      { id: "boundary", type: "compaction", status: "completed", time: { created: 20 } }], cursor: {} }),
  })
})

test("late history preserves live updates that have left the current message window", async () => {
  const pending = Promise.withResolvers<any>()
  await withUsage(async (view, host) => {
    await view.waitForFrame((frame) => frame.includes("unity-engineer ×3"))
    host.setMessages("s1", [message("m1", "unity-engineer", 4), message("m2", "argus", 2)])
    await view.waitForFrame((frame) => frame.includes("unity-engineer ×4"))
    host.setMessages("s1", [message("m2", "argus", 2)])
    await view.flush()
    pending.resolve({ data: [message("m2", "argus", 2), message("m1", "unity-engineer", 3)], cursor: {} })
    await Bun.sleep(0)
    await view.flush()
    assert.match(view.captureCharFrame(), /unity-engineer ×4 · argus ×2/)
  }, { history: () => pending.promise })
})

test("late history cannot resurrect an emptied message after it leaves the live window", async () => {
  const pending = Promise.withResolvers<any>()
  await withUsage(async (view, host) => {
    await view.waitForFrame((frame) => frame.includes("unity-engineer ×3"))
    host.setMessages("s1", [message("m1", "unity-engineer", 0), message("m2", "argus", 2)])
    await view.waitForFrame((frame) => !frame.includes("unity-engineer") && frame.includes("argus ×2"))
    host.setMessages("s1", [message("m2", "argus", 2)])
    await view.flush()
    pending.resolve({ data: [message("m2", "argus", 2), message("m1", "unity-engineer", 3)], cursor: {} })
    await Bun.sleep(0)
    await view.flush()
    assert.doesNotMatch(view.captureCharFrame(), /unity-engineer/)
    assert.match(view.captureCharFrame(), /argus ×2/)
  }, { history: () => pending.promise })
})

test("unchanged cached snapshots cannot overwrite fresher history on a later update", async () => {
  await withUsage(async (view, host) => {
    await view.waitForFrame((frame) => frame.includes("unity-engineer ×4"))
    host.setMessages("s1", [message("m1", "unity-engineer", 3), message("m2", "argus", 2), message("m3", "argus")])
    await view.waitForFrame((frame) => frame.includes("argus ×3"))
    assert.match(view.captureCharFrame(), /unity-engineer ×4/)
  }, { history: async () => ({ data: [message("m2", "argus", 2), message("m1", "unity-engineer", 4)], cursor: {} }) })
})

test("deleting a session discards both counts and an in-flight history response", async () => {
  const pending = Promise.withResolvers<any>()
  await withUsage(async (view, host) => {
    await view.waitForFrame((frame) => frame.includes("unity-engineer ×3"))
    host.events.get("session.deleted")({ data: { sessionID: "s1" } })
    await view.flush()
    pending.resolve({ data: [message("m1", "unity-engineer", 3)], cursor: {} })
    await Bun.sleep(0)
    await view.flush()
    assert.ok(!view.renderer.root.findDescendantById("skills-panel.ui.agents"))
  }, { history: () => pending.promise })
})

test.each([false, true])("history-discovered compaction retains evicted calls observed before the request: %s", async (beforeRequest) => {
  const pending = Promise.withResolvers<any>()
  const after = message("evicted", "build", 2, 30)
  await withUsage(async (view, host) => {
    await view.waitForFrame((frame) => frame.includes(beforeRequest ? "build ×2" : "old-agent ×1"))
    if (!beforeRequest) {
      host.setMessages("s1", [after])
      await view.waitForFrame((frame) => frame.includes("build ×2"))
    }
    host.setMessages("s1", [message("current", "argus", 1, 40)])
    await view.waitForFrame((frame) => frame.includes("argus ×1"))
    // The snapshot predates both post-compaction calls, and neither the old
    // marker nor the evicted build message remains in the current live window.
    pending.resolve({ data: [{ id: "boundary", type: "compaction", status: "completed", time: { created: 20 } }], cursor: {} })
    await Bun.sleep(0)
    await view.flush()
    assert.match(view.captureCharFrame(), /build ×2 · argus ×1/)
    assert.doesNotMatch(view.captureCharFrame(), /old-agent/)
    assert.match(view.captureCharFrame(), /1 loaded · 1 visible/)
  }, { initialMessages: { s1: [beforeRequest ? after : message("before", "old-agent", 1, 5)] }, history: () => pending.promise })
})

test("retaining evicted calls does not revive pre-boundary or unproven timestamps", async () => {
  const pending = Promise.withResolvers<any>()
  const stale = [5, 20, Number.NaN, Infinity].map((created, i) => message(`stale-${i}`, "stale-agent", 1, created))
  stale.push({ ...message("missing-time", "stale-agent"), time: {} as any })
  await withUsage(async (view, host) => {
    await view.waitForFrame((frame) => frame.includes("stale-agent ×5"))
    host.setMessages("s1", [message("current", "argus", 1, 40)])
    await view.waitForFrame((frame) => frame.includes("argus ×1"))
    pending.resolve({ data: [{ id: "boundary", type: "compaction", status: "completed", time: { created: 20 } }], cursor: {} })
    await Bun.sleep(0)
    await view.flush()
    assert.match(view.captureCharFrame(), /argus ×1/)
    assert.doesNotMatch(view.captureCharFrame(), /stale-agent/)
  }, { initialMessages: { s1: stale }, history: () => pending.promise })
})

test("evicted empty replacements still override history when it first reveals a boundary", async () => {
  const pending = Promise.withResolvers<any>()
  await withUsage(async (view, host) => {
    await view.waitForFrame((frame) => frame.includes("build ×2"))
    host.setMessages("s1", [message("evicted", "build", 0, 30)])
    await view.waitForFrame((frame) => !frame.includes("build ×"))
    host.setMessages("s1", [message("current", "argus", 1, 40)])
    await view.waitForFrame((frame) => frame.includes("argus ×1"))
    pending.resolve({ data: [message("evicted", "build", 2, 30),
      { id: "boundary", type: "compaction", status: "completed", time: { created: 20 } }], cursor: {} })
    await Bun.sleep(0)
    await view.flush()
    assert.match(view.captureCharFrame(), /argus ×1/)
    assert.doesNotMatch(view.captureCharFrame(), /build ×/)
  }, { initialMessages: { s1: [message("evicted", "build", 2, 30)] }, history: () => pending.promise })
})

test("newer history wins over an evicted pre-request cache snapshot without double counting", async () => {
  const pending = Promise.withResolvers<any>()
  await withUsage(async (view, host) => {
    await view.waitForFrame((frame) => frame.includes("build ×2"))
    host.setMessages("s1", [message("current", "argus", 1, 40)])
    await view.waitForFrame((frame) => frame.includes("argus ×1"))
    pending.resolve({ data: [message("evicted", "build", 3, 30),
      { id: "boundary", type: "compaction", status: "completed", time: { created: 20 } }], cursor: {} })
    await Bun.sleep(0)
    await view.flush()
    assert.match(view.captureCharFrame(), /build ×3 · argus ×1/)
  }, { initialMessages: { s1: [message("evicted", "build", 2, 30)] }, history: () => pending.promise })
})

test("retained post-boundary invocations restore their loaded mark even with an empty current window", async () => {
  const pending = Promise.withResolvers<any>()
  await withUsage(async (view, host) => {
    await view.waitForFrame((frame) => frame.includes("build ×2"))
    host.setMessages("s1", [])
    await view.flush()
    pending.resolve({ data: [{ id: "boundary", type: "compaction", status: "completed", time: { created: 20 } }], cursor: {} })
    await Bun.sleep(0)
    await view.flush()
    assert.match(view.captureCharFrame(), /build ×2/)
    assert.match(view.captureCharFrame(), /1 loaded · 1 visible/)
  }, { initialMessages: { s1: [message("evicted", "build", 2, 30)] }, history: () => pending.promise })
})
