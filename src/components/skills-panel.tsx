/** @jsxImportSource @opentui/solid */

import { For, Show, createMemo, createSignal } from "solid-js"
import type { Accessor } from "solid-js"
import type { MouseEvent, ThemeMode } from "@opentui/core"
import type { ResolvedTheme } from "@opencode/theme/tui"
import type { SkillDisplayMode, SkillSummary, SkillTokenMode, SkillUsageSummary } from "../skill-data"
import { estimateSkillTokens, estimateSkillListingTotal, formatTokenCount, sortSkillsByLoaded } from "../skill-data"

export interface SkillsPanelProps {
  skills: Accessor<SkillSummary[]>
  /** Catalog counts exclude extra rows retained only by successful loading. */
  modelVisibleCount: Accessor<number>
  registeredCount: Accessor<number>
  scope: Accessor<SkillDisplayMode>
  showState: Accessor<boolean>
  tokenMode: Accessor<SkillTokenMode>
  showAgentUsage?: Accessor<boolean>
  agentUsage?: Accessor<ReadonlyMap<string, SkillUsageSummary>>
  sessionID?: Accessor<string>
  subagentLoadedIDs?: Accessor<ReadonlySet<string>>
  /** All IDs loaded in the current stage, including skills hidden from the model listing. */
  loadedIDs: Accessor<Set<string>>
  canToggleRow?: Accessor<boolean>
  hasSelection?: Accessor<boolean>
  emptyMessage: Accessor<string>
  theme: Accessor<ResolvedTheme>
  themeMode: Accessor<ThemeMode>
  collapsed: Accessor<boolean>
  onToggle: () => void
  onSkillClick: (skill: SkillSummary, button: 0 | 1 | 2) => void
}

export function SkillsPanel(props: SkillsPanelProps) {
  const normalColor = () => props.themeMode() === "light" ? "#000000" : "#ffffff"
  const displayedSkills = createMemo(() => {
    const loaded = props.loadedIDs()
    return sortSkillsByLoaded(props.skills(), loaded)
  })
  const loadedSkills = createMemo(() => {
    const local = props.loadedIDs()
    const descendants = props.subagentLoadedIDs?.()
    return [...new Map(displayedSkills().filter((skill) => local.has(skill.id) || descendants?.has(skill.id)).map((skill) => [skill.id, skill])).values()]
  })
  const loadedCount = () => loadedSkills().length
  const [stateWidth, setStateWidth] = createSignal(0)
  const [expanded, setExpanded] = createSignal(new Set<string>())
  const totalCount = () => props.scope() === "registered" ? props.registeredCount() : props.modelVisibleCount()
  const fullState = () => props.scope() === "loaded" ? `(${loadedCount()} loaded)`
    : `(${loadedCount()} loaded · ${totalCount()} ${props.scope() === "registered" ? "registered" : "visible"})`
  const state = () => fullState().length <= stateWidth() ? fullState()
    : props.scope() === "loaded" ? `(${loadedCount()})` : `(${loadedCount()}/${totalCount()})`
  const estimates = createMemo(() => {
    const mode = props.tokenMode()
    return new Map(mode === "off" ? [] : displayedSkills().map((skill) => [skill.id, estimateSkillTokens(skill, mode)]))
  })
  const tokenLabel = (tokens: number | undefined) => tokens === undefined ? "-" : `~${formatTokenCount(tokens)} tok`
  const totalTokens = createMemo(() => {
    const loaded = loadedSkills()
    const mode = props.tokenMode()
    if (mode === "off") return tokenLabel(0)
    if (mode === "listing") return tokenLabel(estimateSkillListingTotal(loaded))
    const counts = loaded.map((skill) => estimateSkillTokens(skill, "load-delta"))
    if (counts.some((count) => count === undefined)) return tokenLabel(undefined)
    const load = counts.reduce<number>((sum, count) => sum + count!, 0)
    const listing = mode === "loaded-total" ? estimateSkillListingTotal(loaded) : 0
    return tokenLabel(listing === undefined ? undefined : listing + load)
  })
  const tokenWidth = createMemo(() => Math.max(totalTokens().length, ...[...estimates().values()].map((count) => tokenLabel(count).length)))

  return (
    <box flexDirection="column" paddingRight={1}>
      <box id="skills-panel.header" width="100%" flexDirection="row" gap={1} onMouseUp={(event: MouseEvent) => {
        if (event.button !== 0 && event.button !== 2) return
        event.preventDefault()
        event.stopPropagation()
        props.onToggle()
      }}>
        {/* Compact the counts before truncating; keep the title and token column visible. */}
        <text flexShrink={0} fg={normalColor()}>
          {props.collapsed() ? "▶" : "▼"}
        </text>
        <text flexShrink={0} fg={normalColor()}><b>Skills</b></text>
        <Show when={props.showState()} fallback={<box flexGrow={1} />}>
          {/* TextBufferRenderable skips onSizeChange; measure its allocated box. */}
          <box onSizeChange={function () { setStateWidth(this.width) }} flexGrow={1} minWidth={0} height={1} flexShrink={1}>
            {/* content updates before painting; JSX text nodes wait another frame. */}
            <text content={state()} width="100%" height={1} wrapMode="none" truncate fg={props.theme().text.muted} />
          </box>
        </Show>
        <Show when={props.tokenMode() !== "off"}>
          <text id="skills-panel.total-tokens" width={tokenWidth()} height={1} flexShrink={0} textAlign="right" fg={props.theme().text.muted}>{totalTokens()}</text>
        </Show>
      </box>

      <Show when={!props.collapsed()}>
        <Show
          when={displayedSkills().length > 0}
          fallback={<text width="100%" flexShrink={0} wrapMode="char" fg={props.theme().text.muted}>{props.emptyMessage()}</text>}
        >
          <For each={displayedSkills()}>
            {(skill) => {
              const usage = () => props.agentUsage?.().get(skill.id)
              const hasUsage = () => props.showAgentUsage?.() && !!usage()?.total
              const key = () => JSON.stringify([props.sessionID?.(), skill.id])
              const isExpanded = () => expanded().has(key())
              const [hovered, setHovered] = createSignal(false)
              const color = () => hovered() ? props.theme().text.action.primary.focused : props.theme().text.muted
              const toggle = () => setExpanded((current) => {
                const next = new Set(current)
                if (next.has(key())) next.delete(key())
                else next.add(key())
                return next
              })
              // Open on mouseUp, not mouseDown: the host dialog's full-screen
              // backdrop closes the dialog on any mouseup it receives, so a
              // dialog opened during mousedown is dismissed by the release.
              const onRowMouseUp = (event: MouseEvent) => {
                if (event.button !== 0 && event.button !== 1 && event.button !== 2) return
                event.preventDefault()
                event.stopPropagation()
                if (event.button === 0 && hasUsage() && (props.canToggleRow?.() ?? true)) {
                  if (!props.hasSelection?.()) toggle()
                  return
                }
                props.onSkillClick(skill, event.button)
              }

              return (
                <>
                  <box id={`skills-panel.${skill.id}`} width="100%" flexDirection="row" columnGap={1} onMouseOver={() => setHovered(true)} onMouseOut={() => setHovered(false)} backgroundColor={hovered() ? props.theme().background.action.primary.focused : undefined} onMouseUp={onRowMouseUp}>
                    <text
                      flexShrink={0}
                      fg={color()}
                    >
                      •
                    </text>
                    <box flexDirection="row" flexGrow={1} minWidth={0} flexShrink={1} columnGap={1}>
                    {/* Numeric height resets flexShrink; restore it afterwards. */}
                    <text
                      minWidth={0}
                      height={1}
                      flexShrink={1}
                      wrapMode="none"
                      truncate
                      fg={color()}
                    >
                      {skill.name ?? skill.id}
                    </text>
                    <Show when={hasUsage()}>
                      <text id={`skills-panel.${skill.id}.toggle`} selectable={false} flexShrink={0} fg={color()} onMouseUp={(event: MouseEvent) => {
                        if (event.button !== 0 && event.button !== 1 && event.button !== 2) return
                        event.preventDefault()
                        event.stopPropagation()
                        if (event.button !== 0 || props.hasSelection?.()) return
                        toggle()
                      }}>{`${isExpanded() ? "▾" : "▸"}${usage()!.total}`}</text>
                    </Show>
                    </box>
                    <Show when={props.tokenMode() !== "off"}>
                      <text id={`skills-panel.${skill.id}.tokens`} width={tokenWidth()} height={1} flexShrink={0} textAlign="right" fg={color()}>
                        {tokenLabel(estimates().get(skill.id))}
                      </text>
                    </Show>
                  </box>
                  <Show when={hasUsage() && isExpanded()}>
                    {/* A sibling, not a child of the clickable row: no new mouse action. */}
                    <box width="100%" paddingLeft={2} flexShrink={0}>
                      <box id={`skills-panel.${skill.id}.agents`} width="100%" flexDirection="column">
                        <For each={usage()?.sources ?? usage()?.agents.map((agent) => ({ label: agent.agentID ?? "Unknown agent", count: agent.count }))}>
                          {(entry) => <box width="100%" flexDirection="row" columnGap={1} flexShrink={0}>
                            <text flexGrow={1} minWidth={0} flexShrink={1} wrapMode="none" truncate fg={props.theme().text.muted}>{entry.label}</text>
                            <text flexShrink={0} fg={props.theme().text.muted}>{`×${entry.count}`}</text>
                          </box>}
                        </For>
                      </box>
                    </box>
                  </Show>
                </>
              )
            }}
          </For>
        </Show>
      </Show>
    </box>
  )
}
