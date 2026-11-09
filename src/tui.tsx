/** @jsxImportSource @opentui/solid */

import { readFileSync } from "node:fs"
import type { Plugin } from "@opencode/plugin/tui"
import { CliRenderEvents, CodeRenderable, InputRenderable, SyntaxStyle, TextAttributes, isRenderable } from "@opentui/core"
import type { MouseEvent, Renderable } from "@opentui/core"
import { For, Show, batch, createEffect, createMemo, createSignal, onCleanup, untrack } from "solid-js"
import type { Accessor } from "solid-js"
import type { LocationRef } from "@opencode/client"
import { useTerminalDimensions, useRenderer } from "@opentui/solid"
import type { ResolvedTheme } from "@opencode/theme/tui"
import { SkillsPanel } from "./components/skills-panel"
import { SkillsDialog } from "./components/skills-dialog"
import type { SkillsSiderSettings } from "./components/skills-dialog"
import { openUrl, resolveLinkToOpen } from "./open-link"
import {
  backfillLoadedSkills,
  extractSkillLoadState,
  estimateSkillTokens,
  formatTokenCount,
  loadAvailableSkills,
  loadSkillFileSamples,
  mergeSkillUsage,
  messagesAfterSkillCompaction,
  countSkillUsage,
  skillUsageLabel,
  type SkillUsageSummary,
  toSummaries,
  type SkillDisplayMode,
  type SkillSummary,
  type SkillUsage,
  type SkillInvocation,
} from "./skill-data"

const EMPTY_LOADED_SKILLS = new Set<string>()
const EMPTY_SKILL_USAGE: SkillUsage = new Map()

// shortcut: runtime imports of @opencode/plugin/tui or @opencode/client/solid load
// @opencode/schema against the host binary's embedded effect, which broke on the
// effect 4.0.1 isStartsWith → isStartingWith rename (host 2.0.27); keep both local.
const definePlugin = (plugin: Plugin.Definition): Plugin.Definition => plugin

// Same composite key as @opencode/client/solid locationKey.
const locationKey = (location: LocationRef) => JSON.stringify([location.directory, location.workspaceID])

function createMarkdownSyntax(theme: ResolvedTheme, owner: unknown) {
  const markdown = theme.markdown
  // Native selection inverts glyph colors; transparent backgrounds fall back to black.
  const bg = theme.surface("dialog").background.base
  // @opentui/core 0.6 requires an explicit resource owner for style lifetime;
  // older hosts ignore the extra argument, so one call covers both.
  return SyntaxStyle.fromStyles({
    default: { fg: markdown.text, bg },
    "markup.heading": { fg: markdown.heading, bg, bold: true },
    "markup.strong": { fg: markdown.strong, bg, bold: true },
    "markup.italic": { fg: markdown.emphasis, bg, italic: true },
    "markup.list": { fg: markdown.listItem, bg },
    "markup.quote": { fg: markdown.blockQuote, bg, italic: true },
    "markup.raw": { fg: markdown.code, bg },
    "markup.link": { fg: markdown.link, bg, underline: true },
    "markup.link.url": { fg: markdown.link, bg, underline: true },
    "markup.link.label": { fg: markdown.linkText, bg, underline: true },
    "markup.strikethrough": { fg: theme.text.muted, bg, dim: true },
  }, owner as never)
}

function updateMarkdownCode(renderable: Renderable, syntaxStyle: SyntaxStyle) {
  if (renderable instanceof CodeRenderable) {
    renderable.wrapMode = "char"
    renderable.syntaxStyle = syntaxStyle
  }
  for (const child of renderable.getChildren()) {
    if (isRenderable(child)) updateMarkdownCode(child, syntaxStyle)
  }
}

/** Splits a leading `---` frontmatter fence off the body; the fences themselves never render. */
function splitFrontmatter(raw: string): { frontmatter?: string; body: string } {
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(raw)
  if (!match) return { body: raw }
  return { frontmatter: match[1], body: raw.slice(match[0].length) }
}

function SkillPreviewDialog(props: {
  ctx: Plugin.Context
  skill: SkillSummary
  raw?: string
  agentUsage: Accessor<SkillUsageSummary | undefined>
  subagentLoaded: Accessor<boolean>
  theme: Accessor<ResolvedTheme>
  renderer: {
    getLinkAt: (x: number, y: number) => string | null
    getSelection: () => unknown
  }
}) {
  const dims = useTerminalDimensions()
  // The host's default modal escape never fires for a dialog shown synchronously
  // from a mouseup handler on 2.1.x (issue #3), so register our own binding like
  // SkillsDialog does; clearSelection keeps the backdrop dismiss guard satisfied.
  props.ctx.keymap.layer(() => ({
    mode: "modal",
    priority: 10,
    commands: [{
      bind: "escape",
      run: () => {
        props.ctx.renderer.clearSelection()
        props.ctx.ui.dialog.clear()
      },
    }],
  }))
  const [separatorWidth, setSeparatorWidth] = createSignal(0)
  const separator = () => {
    const label = " provided by plugin "
    const dashes = Math.max(0, separatorWidth() - label.length)
    const right = Math.min(7, Math.floor(dashes / 2))
    return `${"-".repeat(dashes - right)}${label}${"-".repeat(right)}`
  }
  let markdown: Renderable | undefined
  // The style's resource owner must be the renderer that mounts the markdown
  // (useRenderer inside the dialog), not the panel's renderer reference.
  const scene = useRenderer()
  const syntaxStyle = createMemo(() => createMarkdownSyntax(props.theme(), scene.nativeScene))
  createEffect((previous: SyntaxStyle | undefined) => {
    const style = syntaxStyle()
    // Markdown updates children next frame; detach async highlighters before freeing the old style.
    if (markdown) updateMarkdownCode(markdown, style)
    previous?.destroy()
    return style
  })
  onCleanup(() => syntaxStyle().destroy())
  const background = () => props.theme().surface("dialog").background.base

  // ctrl+click opens links in the browser directly: OSC 8 emission is gated
  // by terminal capability detection and highlight success inside opentui's
  // native renderer, so terminal-native ctrl+click is not reliable. The
  // renderer's screen-coordinate hit test works regardless.
  const onPreviewMouseUp = (event: MouseEvent) => {
    const url = resolveLinkToOpen(
      event,
      () => props.renderer.getSelection() !== null,
      props.renderer.getLinkAt,
    )
    if (url === null) return
    event.stopPropagation()
    openUrl(url)
  }

  let content: string
  if (props.raw) {
    // Verbatim SKILL.md: frontmatter fields stay visible; only the `---`
    // fence lines are dropped so they don't render as an unwanted rule.
    const { frontmatter, body } = splitFrontmatter(props.raw)
    content = frontmatter ? `${frontmatter}\n\n${body.trim()}\n` : props.raw
  } else if (props.skill.description) {
    // Fallback when the file is unreadable: the server strips frontmatter
    // from content, so show the parsed description as a quote.
    content = `> ${props.skill.description}\n\n${props.skill.content}`
  } else {
    content = props.skill.content
  }
  const path = props.skill.path
  // The API's own value, including virtual builtin paths like /builtin/opencode.md.
  const source = path || "-"
  // Count the actual preview Markdown, not the path or model's skill listing.
  const chars = [...content].length.toLocaleString("en-US")
  const tok = (mode: "listing" | "load-delta" | "loaded-total") => {
    const tokens = estimateSkillTokens(props.skill, mode)
    return tokens === undefined ? "-" : `~${formatTokenCount(tokens)} tok`
  }

  return (
    <box
      flexDirection="column"
      paddingBottom={1}
      paddingLeft={2}
      paddingRight={2}
      width="100%"
      height={Math.max(1, dims().height - 4)}
      backgroundColor={background()}
    >
      <scrollbox
        ref={(scrollbox) => {
          // Default-visible bars otherwise draw once before their first layout.
          scrollbox.verticalScrollBar.resetVisibilityControl()
          scrollbox.horizontalScrollBar.resetVisibilityControl()
        }}
        width="100%" flexGrow={1} minHeight={0} paddingRight={1} scrollX={false}
      >
        <text width="100%" flexShrink={0} wrapMode="char" fg={props.theme().text.muted} bg={background()} attributes={TextAttributes.ITALIC}>
          {`id: ${props.skill.id}`}
        </text>
        <text width="100%" flexShrink={0} wrapMode="char" fg={props.theme().text.muted} bg={background()} attributes={TextAttributes.ITALIC}>
          {`stats: chars ${chars} · list entry ${tok("listing")} · load cost ${tok("load-delta")} · total cost ${tok("loaded-total")}`}
        </text>
        <text width="100%" flexShrink={0} wrapMode="char" fg={props.theme().text.muted} bg={background()} attributes={TextAttributes.ITALIC}>
          {`path: ${source}`}
        </text>
        <box id="skills-preview.agents" width="100%" flexShrink={0} flexDirection="column">
          <text width="100%" flexShrink={0} wrapMode="char" fg={props.theme().text.muted} bg={background()} attributes={TextAttributes.ITALIC}>{`agents: ${props.agentUsage() ? skillUsageLabel(props.agentUsage()!) : "-"}${props.subagentLoaded() ? " · subagent load" : ""}`}</text>
          <For each={props.agentUsage()?.agents}>{(agent) => <box width="100%" flexDirection="row" columnGap={1} flexShrink={0}>
            <text flexGrow={1} minWidth={0} flexShrink={1} wrapMode="char" fg={props.theme().text.muted} bg={background()} attributes={TextAttributes.ITALIC}>{agent.agentID ?? "Unknown agent"}</text>
            <text flexShrink={0} fg={props.theme().text.muted} bg={background()} attributes={TextAttributes.ITALIC}>{`×${agent.count}`}</text>
          </box>}</For>
        </box>
        <box id="skills-preview.separator" width="100%" flexShrink={0} marginBottom={1}
          onSizeChange={function () { setSeparatorWidth(this.width) }}>
          <text content={separator()} width="100%" flexShrink={0} wrapMode="char" fg={props.theme().text.muted} bg={background()} attributes={TextAttributes.ITALIC} />
        </box>
        <markdown
          ref={(renderable) => { markdown = renderable; updateMarkdownCode(renderable, syntaxStyle()) }}
          width="100%"
          content={content}
          syntaxStyle={syntaxStyle()}
          fg={props.theme().markdown.text}
          bg={background()}
          tableOptions={{ wrapMode: "char" }}
          onMouseUp={onPreviewMouseUp}
        />
      </scrollbox>
    </box>
  )
}

export default definePlugin({
  id: "opencode-skills-tui",
  setup(ctx) {
    // Keep collapse per-terminal. Old in-memory settings seed the durable store on reload.
    const [ui, mutateUI] = ctx.storage.memory<Omit<SkillsSiderSettings, "token"> & { token: SkillsSiderSettings["token"] | "metadata" | "instructions"; collapsed: boolean; displayMode?: SkillDisplayMode }>("prefs", {
      initial: { collapsed: false, switch: "on", scope: "model", preview: "left-click", mention: "right-click", token: "off", state: "on", usage: "on" },
    })
    const normalizeSettings = (value: Omit<typeof ui, "collapsed">): SkillsSiderSettings => ({
      switch: value.switch ?? "on",
      scope: value.scope ?? value.displayMode ?? "model",
      preview: value.preview ?? "left-click",
      mention: value.mention ?? "right-click",
      token: value.token === "metadata" ? "listing" : value.token === "instructions" ? "load-delta" : value.token ?? "off",
      state: value.state ?? "on",
      usage: value.usage ?? "on",
    })
    const [prefs, mutatePrefs] = ctx.storage.store<Omit<typeof ui, "collapsed">>("settings", {
      initial: normalizeSettings(ui),
    })
    const settings = () => normalizeSettings(prefs)
    const changeSettings = (update: Partial<SkillsSiderSettings>) => {
      void mutatePrefs((draft) => {
        // Mutate the latest disk values, not a possibly stale TUI snapshot.
        const next = { ...normalizeSettings(draft), ...update }
        if (next.preview !== "off" && next.preview === next.mention) throw new Error("Mouse button conflict")
        Object.assign(draft, next)
      }).catch((error) => {
        if (disposed) return
        ctx.ui.toast.show({
          variant: "error",
          title: "Skills Sidebar",
          message: `Failed to save skills sidebar settings: ${error instanceof Error ? error.message : String(error)}`,
          duration: 5000,
        })
      })
    }

    const [loadedBySession, setLoadedBySession] = createSignal(new Map<string, Set<string>>())
    const [usageBySession, setUsageBySession] = createSignal(new Map<string, SkillUsage>())
    const observedUsageBySession = new Map<string, SkillUsage>()
    const observedMessageTimeBySession = new Map<string, Map<string, number>>()
    const [fileSamples, setFileSamples] = createSignal(new Map<string, readonly string[] | undefined>())
    const sampling = new Map<string, AbortController>()
    const backfilled = new Set<string>()
    const backfilling = new Map<string, AbortController>()
    const backfillUsage = new Map<string, Map<string, readonly SkillInvocation[]>>()
    const [refreshByLocation, setRefreshByLocation] = createSignal(
      new Map<string, { id: number; failure?: { skills: unknown; agents: unknown } }>(),
    )
    const compactionBySession = new Map<string, string>()
    const compactionTimeBySession = new Map<string, number>()
    const deletedSessions = new Set<string>()
    const [parents, setParents] = createSignal(new Map<string, string>())
    const discovering = new Map<string, AbortController>()
    const discovered = new Set<string>()
    const watched = new Map<string, number>()
    const dirtyHistory = new Set<string>()
    let disposed = false
    let refreshID = 0
    let initialRefreshTimer: ReturnType<typeof setTimeout> | undefined
    let stopNativeSelection: (() => void) | undefined

    const rememberParents = (sessions: readonly { id: string; parentID?: string }[]) => {
      setParents((current) => {
        const next = new Map(current)
        for (const session of sessions) {
          if (session.parentID && !deletedSessions.has(session.id)) next.set(session.id, session.parentID)
        }
        return next.size === current.size && [...next].every(([id, parent]) => current.get(id) === parent) ? current : next
      })
    }
    const descendants = (root: string) => {
      const result = new Set<string>()
      const visit = (id: string) => {
        if (result.has(id) || deletedSessions.has(id)) return
        result.add(id)
        for (const [child, parent] of parents()) if (parent === id) visit(child)
      }
      visit(root)
      return result
    }
    // family() includes ancestors/siblings and only cached sessions. Query the
    // native parentID index, one bounded page at a time, for each reachable node.
    const discoverChildren = (sessionID: string) => {
      if (disposed || deletedSessions.has(sessionID) || discovered.has(sessionID) || discovering.has(sessionID)) return
      const controller = new AbortController()
      discovering.set(sessionID, controller)
      void (async () => {
        let cursor: string | undefined
        const cursors = new Set<string>()
        do {
          const page = await ctx.client.session.list({ parentID: sessionID, limit: 200, ...(cursor ? { cursor } : { order: "desc" as const }) })
          if (disposed || controller.signal.aborted || discovering.get(sessionID) !== controller) return
          rememberParents(page.data.filter((child) => child.parentID === sessionID))
          cursor = page.cursor?.next ?? undefined
          if (cursor && cursors.has(cursor)) throw new Error("Repeated session cursor")
          if (cursor) cursors.add(cursor)
        } while (cursor)
        discovered.add(sessionID)
      })().catch(() => {
        // Keep known descendants; a later view/activity can retry discovery.
      }).finally(() => {
        if (discovering.get(sessionID) === controller) discovering.delete(sessionID)
      })
    }
    const familyUsage = (sessionID: string) => {
      const usage = new Map<string, readonly SkillInvocation[]>()
      for (const id of descendants(sessionID)) {
        for (const [message, calls] of usageBySession().get(id) ?? []) usage.set(JSON.stringify([id, message]), calls)
      }
      const localCallers = new Set<string>()
      for (const calls of usageBySession().get(sessionID)?.values() ?? []) {
        for (const call of calls) if (call.agentID !== null) localCallers.add(call.agentID)
      }
      const session = ctx.data.session.get(sessionID)
      const location = session?.location ?? ctx.location ?? ctx.data.location.default()
      const modes = new Map(ctx.data.location.agent.list(location)?.map((agent) => [agent.id, agent.mode]))
      return countSkillUsage(usage, modes, localCallers)
    }
    const childLoads = (sessionID: string) => {
      const loaded = new Set<string>()
      for (const id of descendants(sessionID)) {
        if (id !== sessionID) for (const skill of loadedBySession().get(id) ?? []) loaded.add(skill)
      }
      return loaded
    }

    const sampleKey = (skill: SkillSummary, location: LocationRef) => `${locationKey(location)}\0${skill.path}`
    const clearFileSamples = (location: LocationRef) => {
      const prefix = `${locationKey(location)}\0`
      for (const [key, controller] of sampling) {
        if (!key.startsWith(prefix)) continue
        controller.abort()
        sampling.delete(key)
      }
      setFileSamples((current) => {
        const next = new Map([...current].filter(([key]) => !key.startsWith(prefix)))
        return next.size === current.size ? current : next
      })
    }
    const ensureFileSamples = (skill: SkillSummary, location: LocationRef, refresh = false) => {
      if (disposed || skill.name === undefined || !skill.path || !/(?:^|[\\/])SKILL\.md$/.test(skill.path)) return
      const key = sampleKey(skill, location)
      if (sampling.has(key) || (!refresh && fileSamples().has(key))) return
      const controller = new AbortController()
      sampling.set(key, controller)
      // ponytail: samples refresh with the catalog or preview; no directory watcher. Reads stop after 5s.
      void loadSkillFileSamples(ctx, skill, location, AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]))
        .catch(() => undefined) // Unavailable paths remain unknown, not an invented empty sample.
        .then((files) => {
          if (disposed || controller.signal.aborted || sampling.get(key) !== controller) return
          setFileSamples((current) => new Map(current).set(key, files))
        })
        .finally(() => { if (sampling.get(key) === controller) sampling.delete(key) })
    }

    const markLoaded = (sessionID: string, skillID: string) => {
      if (disposed || deletedSessions.has(sessionID)) return
      setLoadedBySession((current) => {
        const loaded = current.get(sessionID)
        if (loaded?.has(skillID)) return current

        const next = new Map(current)
        next.set(sessionID, new Set(loaded).add(skillID))
        return next
      })
    }

    const resetLoaded = (sessionID: string) => {
      backfilling.get(sessionID)?.abort()
      backfilling.delete(sessionID)
      backfillUsage.delete(sessionID)
      backfilled.delete(sessionID)
      setUsageBySession((current) => {
        if (!current.has(sessionID)) return current
        const next = new Map(current)
        next.delete(sessionID)
        return next
      })
      setLoadedBySession((current) => {
        if (!current.has(sessionID)) return current
        const next = new Map(current)
        next.delete(sessionID)
        return next
      })
    }

    const liveLoadState = (sessionID: string) => {
      if (disposed || deletedSessions.has(sessionID)) return extractSkillLoadState([], true)
      const id = compactionBySession.get(sessionID)
      const messages = messagesAfterSkillCompaction(ctx.data.session.message.list(sessionID),
        id ? { id, created: compactionTimeBySession.get(sessionID) } : undefined)
      // Keep timestamp evidence independently of the host's sliding window.
      // Without it a later backfill cannot place evicted calls in a new stage.
      for (const message of messages) {
        const entry = message as { id?: unknown; type?: unknown; time?: { created?: unknown } } | null
        const created = entry?.time?.created
        if (entry?.type !== "assistant" || typeof entry.id !== "string" || !entry.id ||
          typeof created !== "number" || !Number.isFinite(created)) continue
        let times = observedMessageTimeBySession.get(sessionID)
        if (!times) observedMessageTimeBySession.set(sessionID, times = new Map())
        times.set(entry.id, created)
      }
      return extractSkillLoadState(messages, true)
    }

    const applyLoads = (sessionID: string, state: ReturnType<typeof extractSkillLoadState>, fromHistory = false) => {
      if (disposed || deletedSessions.has(sessionID)) return
      let resetStage = false
      if (state.compactionID && state.compactionID !== compactionBySession.get(sessionID)) {
        const currentTime = compactionTimeBySession.get(sessionID)
        if (currentTime !== undefined && state.compactionTime !== undefined && state.compactionTime < currentTime) return
        compactionBySession.set(sessionID, state.compactionID)
        compactionTimeBySession.delete(sessionID)
        if (state.compactionTime !== undefined) compactionTimeBySession.set(sessionID, state.compactionTime)
        resetLoaded(sessionID)
        resetStage = true
        // Keep already observed snapshots only when they belong to the new stage.
        // Forgetting them would make an unchanged stale cache look like an update.
        const valid = new Set(state.usage?.keys() ?? [])
        const observed = observedUsageBySession.get(sessionID) ?? EMPTY_SKILL_USAGE
        observedUsageBySession.set(sessionID, new Map([...observed].filter(([id]) => valid.has(id))))
        const times = observedMessageTimeBySession.get(sessionID)
        if (times) observedMessageTimeBySession.set(sessionID, new Map([...times].filter(([id]) => valid.has(id))))
      }
      if (state.compactionID && state.compactionTime !== undefined) compactionTimeBySession.set(sessionID, state.compactionTime)
      for (const id of state.loaded) markLoaded(sessionID, id)
      if (state.usage) {
        let incoming = state.usage
        if (!fromHistory) {
          const previous = observedUsageBySession.get(sessionID) ?? EMPTY_SKILL_USAGE
          const observed = mergeSkillUsage(previous, incoming)
          // A repeated cache snapshot is not newer evidence than a history read.
          if (!resetStage) incoming = new Map([...incoming].filter(([id]) => observed.get(id) !== previous.get(id)))
          observedUsageBySession.set(sessionID, observed)
          // Retain actual changes during this read even if their messages later
          // leave the live window. Empty arrays are deliberate replacements.
          const overlay = backfillUsage.get(sessionID)
          if (overlay) for (const [id, calls] of incoming) overlay.set(id, calls)
        }
        setUsageBySession((current) => {
          const previous = current.get(sessionID) ?? EMPTY_SKILL_USAGE
          // Replace snapshots by identity. Absence from a page/window alone is
          // not evidence that a previously observed live message was deleted.
          const next = mergeSkillUsage(previous, incoming)
          return next === previous ? current : new Map(current).set(sessionID, next)
        })
      }
    }

    const ensureBackfill = (sessionID: string) => {
      if (
        disposed || deletedSessions.has(sessionID) ||
        backfilled.has(sessionID) || backfilling.has(sessionID)
      ) return

      const controller = new AbortController()
      const overlay = new Map<string, readonly SkillInvocation[]>()
      const stage = compactionBySession.get(sessionID)
      backfilling.set(sessionID, controller)
      backfillUsage.set(sessionID, overlay)
      void backfillLoadedSkills(ctx, sessionID, controller.signal, true)
        .then((state) => {
          if (disposed || controller.signal.aborted || !state || backfilling.get(sessionID) !== controller) return
          // Detach this read before a newly discovered boundary invalidates older reads.
          backfilling.delete(sessionID)
          backfillUsage.delete(sessionID)
          batch(() => {
            // Only post-request live changes in the same stage override history.
            // This also preserves replacements no longer in the live window.
            const currentMessages = ctx.data.session.message.list(sessionID)
            const verifiedLive = extractSkillLoadState(messagesAfterSkillCompaction(currentMessages,
              state.compactionID ? { id: state.compactionID, created: state.compactionTime } : undefined), true)
            const valid = new Set([...(state.usage?.keys() ?? []), ...(verifiedLive.usage?.keys() ?? [])])
            const times = observedMessageTimeBySession.get(sessionID)
            const belongsToStage = (id: string) => state.compactionID === stage || valid.has(id) ||
              (state.compactionTime !== undefined && (times?.get(id) ?? -Infinity) > state.compactionTime)
            // Retain proven post-boundary calls even after their messages leave
            // both the live window and this older history snapshot. History wins
            // over pre-request cache copies; actual mid-request updates win last.
            const retained = new Map([...(usageBySession().get(sessionID) ?? EMPTY_SKILL_USAGE)]
              .filter(([id]) => belongsToStage(id)))
            const changes = new Map([...overlay].filter(([id]) => belongsToStage(id)))
            const usage = state.usage ? mergeSkillUsage(mergeSkillUsage(retained, state.usage), changes) : undefined
            const loaded = new Set(state.loaded)
            for (const calls of usage?.values() ?? []) for (const call of calls) loaded.add(call.skillID)
            applyLoads(sessionID, { ...state, loaded, usage }, true)
            // Do not replay a stale cache across a newer boundary found in history.
            applyLoads(sessionID, liveLoadState(sessionID))
            // Set before batch flush, so reactive effects cannot start a second read.
            backfilled.add(sessionID)
          })
        })
        .catch(() => {
          // History unreachable: live message scans still mark loads.
        })
        .finally(() => {
          if (backfilling.get(sessionID) === controller) {
            backfilling.delete(sessionID)
            backfillUsage.delete(sessionID)
          }
          if (!disposed && dirtyHistory.delete(sessionID)) {
            backfilled.delete(sessionID)
            ensureBackfill(sessionID)
          }
        })
    }

    const toggleCollapsed = () => {
      mutateUI((draft) => {
        draft.collapsed = !draft.collapsed
      })
    }

    const renderSkillPreview = (skill: SkillSummary, location: LocationRef, sessionID: string) => {
      // Read the SKILL.md from disk and render it verbatim; normalize CRLF so
      // Windows line endings can't leak into the rendered lines. Unreadable
      // files fall back to the stripped server content.
      let raw: string | undefined
      if (skill.path) {
        try {
          raw = readFileSync(skill.path, "utf8").replace(/\r\n/g, "\n")
        } catch {
          // Unreadable (missing, permissions, remote skill): fall back below.
        }
      }
      const previewSkill = createMemo(() => ({ ...skill, fileSamples: fileSamples().get(sampleKey(skill, location)) }))
      const agentUsage = createMemo(() => familyUsage(sessionID).get(skill.id))
      return <SkillPreviewDialog ctx={ctx} skill={previewSkill()} raw={raw} agentUsage={agentUsage} subagentLoaded={() => childLoads(sessionID).has(skill.id)} theme={() => ctx.theme} renderer={ctx.renderer} />
    }

    const openSkillPreview = (skill: SkillSummary, location: LocationRef, sessionID: string) => {
      ensureFileSamples(skill, location, true)
      // The host backdrop swallows the first dismiss click while a selection
      // exists (mousedown sets dismiss=!!getSelection()), so a zero-width
      // selection left over from the opening click would force users to
      // click outside twice. Clear it before the dialog mounts.
      ctx.renderer.clearSelection()
      // dialog.set() targets the active dialog, so show it first.
      ctx.ui.dialog.show(() => renderSkillPreview(skill, location, sessionID))
      ctx.ui.dialog.set({ size: "xlarge", centered: true })
    }

    const refreshSkills = async (location: LocationRef): Promise<boolean> => {
      if (disposed) return true
      const requestID = ++refreshID
      const key = locationKey(location)
      setRefreshByLocation((current) => new Map(current).set(key, { id: requestID }))
      try {
        const available = await loadAvailableSkills(ctx, location)
        if (disposed || refreshByLocation().get(key)?.id !== requestID) return true
        return available.length > 0
      } catch (error) {
        if (disposed || refreshByLocation().get(key)?.id !== requestID) return true
        // A host-owned cache refresh can recover without another plugin refresh.
        setRefreshByLocation((current) => new Map(current).set(key, {
          id: requestID,
          failure: {
            skills: ctx.data.location.skill.list(location),
            agents: ctx.data.location.agent.list(location),
          },
        }))
        if (requestID !== refreshID) return true
        ctx.ui.toast.show({
          variant: "error",
          title: "Skills",
          message: `Failed to load skills: ${error instanceof Error ? error.message : String(error)}`,
          duration: 5000,
        })
        return false
      }
    }

    // Retry only an empty/failed initial discovery. Do not race a slow first
    // request or repeat a successful refresh triggered by a host event.
    const initialLocation = ctx.location ?? ctx.data.location.default()
    void refreshSkills(initialLocation).then((ready) => {
      if (ready || disposed || refreshID !== 1) return
      initialRefreshTimer = setTimeout(() => {
        if (refreshID !== 1) return
        ctx.data.location.skill.invalidate(initialLocation)
        void refreshSkills(initialLocation)
      }, 250)
    })

    const unregisterSkillUpdated = ctx.data.on("skill.updated", (event) => {
      const location = event.location ?? initialLocation
      clearFileSamples(location)
      void refreshSkills(location)
    })

    const unregisterProjectUpdated = ctx.data.on("project.updated", () => {
      const location = ctx.location ?? ctx.data.location.default()
      clearFileSamples(location)
      void refreshSkills(location)
    })

    // v2.0.24 does not project direct skill activations into the live client cache.
    // Refresh messages, not load flags: a later compaction must still win.
    const unregisterSkillActivated = ctx.data.on("session.skill.activated", (event) => {
      const sessionID = event.data.sessionID
      if (disposed || deletedSessions.has(sessionID)) return
      ctx.data.session.message.invalidate(sessionID)
      void ctx.data.session.message.sync(sessionID).catch(() => {
        // Keep existing marks; later message syncs/backfills can recover.
      })
    })

    // OpenCode 2.0.16 does not emit durable skill activations for skill-tool
    // loads (session event logs stay empty), so loads are detected from
    // message data.
    const unregisterSessionDeleted = ctx.data.on("session.deleted", (event) => {
      const sessionID = event.data.sessionID
      deletedSessions.add(sessionID)
      // Tombstones alone are nonreactive. Publish topology even when this
      // empty session has no load/usage entry to remove (it may bridge workers).
      setParents((current) => {
        const next = new Map(current)
        next.delete(sessionID)
        return next
      })
      discovering.get(sessionID)?.abort()
      discovering.delete(sessionID)
      dirtyHistory.delete(sessionID)
      resetLoaded(sessionID)
      compactionBySession.delete(sessionID)
      compactionTimeBySession.delete(sessionID)
      observedUsageBySession.delete(sessionID)
      observedMessageTimeBySession.delete(sessionID)
    })

    const unregisterCreated = ctx.data.on("session.created", (event) => {
      rememberParents([{ id: event.data.sessionID, parentID: event.data.parentID }])
    })
    const unregisterActivity = ctx.data.listen(({ details }) => {
      if (!["session.tool.success", "session.tool.failed", "session.skill.activated", "session.idle", "session.execution.started"].includes(details.type)) return
      const sessionID = (details.data as { sessionID?: string }).sessionID
      if (!sessionID || !watched.has(sessionID) || disposed || deletedSessions.has(sessionID)) return
      if (details.type === "session.tool.success" || details.type === "session.tool.failed") {
        const message = ctx.data.session.message.list(sessionID).find((message) => message.id === details.data.assistantMessageID)
        const tool = message?.type === "assistant" ? message.content.find((part) => part.type === "tool" && part.id === details.data.id) : undefined
        // The success/failure event has no tool name. Skip only proven non-skill
        // calls; an uncached background call still needs a durable read.
        if (tool?.type === "tool" && tool.name !== "skill") return
      }
      // Inactive/background sessions need durable reads too. Coalesce activity
      // during an in-flight read into one follow-up, rather than losing resumes.
      backfilled.delete(sessionID)
      if (backfilling.has(sessionID)) dirtyHistory.add(sessionID)
      else ensureBackfill(sessionID)
      if (details.type === "session.idle" || details.type === "session.execution.started") {
        discovered.delete(sessionID)
        discoverChildren(sessionID)
      }
    })

    const unregisterRevertCommitted = ctx.data.on("session.revert.committed", (event) => {
      const sessionID = event.data.sessionID
      if (disposed || deletedSessions.has(sessionID)) return
      // The host has removed reverted messages. A missing window entry alone
      // cannot distinguish removal from eviction, so rebuild on this explicit event.
      batch(() => {
        resetLoaded(sessionID)
        compactionBySession.delete(sessionID)
        compactionTimeBySession.delete(sessionID)
        observedUsageBySession.delete(sessionID)
        observedMessageTimeBySession.delete(sessionID)
        applyLoads(sessionID, liveLoadState(sessionID))
        ensureBackfill(sessionID)
      })
    })

    const unregisterCompactionEnded = ctx.data.on("session.compaction.ended", (event) => {
      const sessionID = event.data.sessionID
      if (disposed || deletedSessions.has(sessionID)) return
      // The host projects ended events into completed messages, even for inactive sessions.
      const state = liveLoadState(sessionID)
      if (state.compactionID) applyLoads(sessionID, state)
      else resetLoaded(sessionID)
      ensureBackfill(sessionID)
    })

    const skillsView = (sessionID: string | undefined, mode: SkillDisplayMode, loaded: ReadonlySet<string>) => {
      const current = sessionID ? ctx.data.session.get(sessionID) : undefined
      const empty = { skills: [], modelVisibleCount: 0, registeredCount: 0, emptyMessage: "Loading skills…" }
      if (disposed || (sessionID && !current)) return empty
      const location = current?.location ?? ctx.location ?? ctx.data.location.default()
      const registered = ctx.data.location.skill.list(location)
      const agents = ctx.data.location.agent.list(location)
      const failure = refreshByLocation().get(locationKey(location))?.failure
      const failed = failure && (
        registered === undefined || agents === undefined ||
        (registered === failure.skills && agents === failure.agents)
      )
      const emptyMessage = failed ? "Failed to load skills" : "Loading skills…"
      if (registered === undefined || (mode === "model" && agents === undefined)) return { ...empty, emptyMessage }
      // V2 returns the effective default agent first when Session.agent is unset.
      const agent = current?.agent === undefined ? agents?.[0] : agents?.find((item) => item.id === current.agent)
      if (!agent && mode === "model") return {
        ...empty,
        emptyMessage: failed ? emptyMessage : `Agent unavailable${current?.agent === undefined ? "" : `: ${current.agent}`}`,
      }
      const permissions = [...(agent?.permissions ?? []), ...(current?.permissions ?? [])]
      return {
        skills: toSummaries(registered, permissions, new Set([...loaded, ...(sessionID ? childLoads(sessionID) : [])]), mode).map((skill) => {
          const files = fileSamples().get(sampleKey(skill, location))
          return files === undefined ? skill : { ...skill, fileSamples: files }
        }),
        modelVisibleCount: agent ? toSummaries(registered, permissions).length : 0,
        registeredCount: toSummaries(registered, [], undefined, "registered").length,
        emptyMessage: failed ? emptyMessage : mode === "loaded" ? "No skills loaded" : mode === "registered" || registered.length === 0
          ? "No skills registered" : "No model-visible skills",
      }
    }

    const insertSkill = (skill: SkillSummary, location: LocationRef) => {
      if (disposed) return
      const registered = ctx.data.location.skill.list(location)
      const index = registered?.findIndex((entry) => entry.id === skill.id) ?? -1
      const warn = (message: string) => ctx.ui.toast.show({ title: "Skills", variant: "warning", message })
      if (!registered || index < 0) return warn("Skill is no longer registered")
      const ids = registered.map((entry) => entry.id)
      const route = JSON.stringify(ctx.ui.router.current())
      stopNativeSelection?.()
      let prompt: typeof ctx.renderer.currentFocusedEditor | undefined
      let active = true
      // The native filter focuses on a timer, after a frame may already be drawn.
      // Hold only that rendering transaction; keep the native attachment callback.
      let releaseFrame!: () => void
      const gate = new Promise<void>((resolve) => { releaseFrame = resolve })
      const beforeFrame = () => gate

      // Reuse /skills itself: it owns typed attachments, extmarks and duplicate handling.
      // ponytail: O(n) navigation and <=5s frame wait; replace with a host prompt attachment API.
      const ready = () => {
        if (!active || disposed) return
        const currentRoute = ctx.ui.router.current()
        const currentLocation = currentRoute.type === "session" ? ctx.data.session.get(currentRoute.sessionID)?.location
          : ctx.location ?? ctx.data.location.default()
        if (JSON.stringify(currentRoute) !== route || !currentLocation || locationKey(currentLocation) !== locationKey(location)) {
          stopNativeSelection?.()
          return warn("Session changed; try again")
        }
        const editor = ctx.renderer.currentFocusedEditor
        if (!prompt) {
          // These host traits distinguish the composer from unrelated editors.
          const traits = editor?.traits as { owner?: string; role?: string; status?: string } | undefined
          if (traits?.owner !== "opencode" || traits.role !== "prompt") return
          if (traits.status === "SHELL") {
            stopNativeSelection?.()
            return warn("Prompt busy; try again")
          }
          if (!ctx.keymap.commands().some((command) => command.id === "prompt.skills")) return
          prompt = editor
          ctx.renderer.setFrameCallback(beforeFrame)
          ctx.keymap.dispatch("prompt.skills")
          return
        }
        if (editor === prompt) { stopNativeSelection?.(); return } // Native picker cancelled.
        if (!(editor instanceof InputRenderable) || editor.traits.status !== "FILTER") return
        stopNativeSelection?.()
        const current = ctx.data.location.skill.list(location)
        if (disposed || prompt.isDestroyed ||
          !current || current.length !== ids.length || current.some((entry, i) => entry.id !== ids[i])) {
          if (!disposed) warn("Skills changed; pick the skill again")
          return
        }
        ctx.keymap.dispatch("dialog.select.home")
        for (let i = 0; i < index; i++) ctx.keymap.dispatch("dialog.select.next")
        ctx.keymap.dispatch("dialog.select.submit")
      }
      const timer = setTimeout(() => {
        stopNativeSelection?.()
        if (!disposed) warn("Skill picker unavailable; close and try again")
      }, 5000)
      stopNativeSelection = () => {
        active = false
        clearTimeout(timer)
        ctx.renderer.off(CliRenderEvents.FOCUSED_EDITOR, ready)
        ctx.renderer.removeFrameCallback(beforeFrame)
        releaseFrame()
        stopNativeSelection = undefined
      }
      ctx.renderer.on(CliRenderEvents.FOCUSED_EDITOR, ready)
      ctx.ui.dialog.clear()
      queueMicrotask(ready)
    }

    const openSettings = () => {
      if (disposed) return
      stopNativeSelection?.()
      ctx.renderer.clearSelection()
      ctx.ui.dialog.show(() => <SkillsDialog ctx={ctx} settings={settings} onChange={changeSettings} />)
      ctx.ui.dialog.set({ size: "medium", centered: true })
    }

    ctx.keymap.layer(() => ({
      mode: "global",
      commands: [{
        id: "opencode-skills-tui.sider",
        title: "Skills Sidebar",
        description: "Configure the skills sidebar",
        group: "Skills",
        palette: true,
        slash: { name: "skills-sidebar" },
        run: openSettings,
      }],
    }))

    const unregisterSlot = ctx.ui.slot({
      append: "sidebar.content",
      render: (input) => {
        const session = createMemo(() => ctx.data.session.get(input.sessionID))
        createEffect(() => {
          const location: LocationRef | undefined = session()?.location
          if (!location || disposed) return
          // Read directory/workspace fields so moving the same Session also syncs.
          void refreshSkills({ directory: location.directory, workspaceID: location.workspaceID })
        })
        const agentUsage = createMemo(() => familyUsage(input.sessionID))
        const subagentLoaded = createMemo(() => childLoads(input.sessionID))
        const panel = createMemo(() => skillsView(input.sessionID, settings().scope, loadedBySession().get(input.sessionID) ?? EMPTY_LOADED_SKILLS))
        createEffect(() => {
          const location = session()?.location
          const token = settings().token
          if (!location || disposed || settings().switch !== "on" || (token !== "load-delta" && token !== "loaded-total")) return
          for (const skill of panel().skills) ensureFileSamples(skill, location)
        })

        // Slot renders run once, untracked. Effects follow its reactive Session
        // input and the message window instead of relying on claim re-renders.
        createEffect(() => {
          const root = input.sessionID
          untrack(() => {
            for (const id of descendants(root)) {
              discovered.delete(id)
              backfilled.delete(id)
            }
          })
        })
        createEffect(() => rememberParents(ctx.data.session.list()))
        createEffect(() => {
          const ids = descendants(input.sessionID)
          for (const id of ids) {
            watched.set(id, (watched.get(id) ?? 0) + 1)
            discoverChildren(id)
            applyLoads(id, liveLoadState(id))
            ensureBackfill(id)
          }
          onCleanup(() => {
            for (const id of ids) {
              const count = (watched.get(id) ?? 1) - 1
              if (count) watched.set(id, count)
              else watched.delete(id)
            }
          })
        })

        return (
          <Show when={settings().switch === "on"}><SkillsPanel
            skills={() => panel().skills}
            modelVisibleCount={() => panel().modelVisibleCount}
            registeredCount={() => panel().registeredCount}
            scope={() => settings().scope}
            showState={() => settings().state === "on"}
            tokenMode={() => settings().token}
            showAgentUsage={() => settings().usage === "on"}
            agentUsage={agentUsage}
            sessionID={() => input.sessionID}
            subagentLoadedIDs={subagentLoaded}
            emptyMessage={() => panel().emptyMessage}
            loadedIDs={() => loadedBySession().get(input.sessionID) ?? EMPTY_LOADED_SKILLS}
            theme={() => ctx.theme}
            themeMode={() => ctx.themeMode}
            collapsed={() => ui.collapsed}
            onToggle={toggleCollapsed}
            onSkillClick={(skill, button) => {
              const click = (["left-click", "middle-click", "right-click"] as const)[button]
              if (settings().mention === click) {
                const location = session()?.location
                if (location) insertSkill(skill, location)
              } else if (settings().preview === click) {
                openSkillPreview(skill, session()?.location ?? ctx.location ?? ctx.data.location.default(), input.sessionID)
              }
            }}
          /></Show>
        )
      },
    })

    return () => {
      disposed = true
      stopNativeSelection?.()
      if (initialRefreshTimer !== undefined) clearTimeout(initialRefreshTimer)
      for (const controller of backfilling.values()) controller.abort()
      for (const controller of discovering.values()) controller.abort()
      discovering.clear()
      dirtyHistory.clear()
      backfilling.clear()
      backfillUsage.clear()
      observedUsageBySession.clear()
      observedMessageTimeBySession.clear()
      compactionTimeBySession.clear()
      for (const controller of sampling.values()) controller.abort()
      sampling.clear()

      unregisterSlot()
      unregisterSkillUpdated()
      unregisterProjectUpdated()
      unregisterSkillActivated()
      unregisterSessionDeleted()
      unregisterRevertCommitted()
      unregisterCompactionEnded()
      unregisterCreated()
      unregisterActivity()
    }
  },
})
