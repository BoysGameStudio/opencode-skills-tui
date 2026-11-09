# 🧩 opencode-skills-tui

<p align="center">
  <a href="README.md">English</a> | <a href="README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/opencode-skills-tui"><img src="https://img.shields.io/npm/v/opencode-skills-tui" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/opencode-skills-tui"><img src="https://img.shields.io/npm/dm/opencode-skills-tui" alt="npm downloads per month"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License: MIT"></a>
</p>

Browse skills, track loaded state, preview SKILL.md, and insert skill attachments from the [OpenCode](https://opencode.ai) terminal sidebar.

![Skills panel demo](assets/demo.gif)

## 📦 Install / update / remove

Requires **OpenCode ≥ 2.0**. Terminal UI (TUI) only.

```bash
opencode plugin add opencode-skills-tui
```

- Update: `opencode plugin update opencode-skills-tui`
- Remove: `opencode plugin remove opencode-skills-tui`

On V1, see the [V1 guide](https://github.com/aihaipeng/opencode-skills-tui/blob/v0.4.4/README.md).

## ⚙️ Parameters

Run `/skills-sidebar` to open the settings panel.

| Setting | Description | Available values |
| --- | --- | --- |
| Show sidebar | Show or hide the panel | `on` / `off` |
| Display scope | Choose which skills to show (see below) | `model-visible` / `registered` / `loaded-only` |
| Token estimation | Show static token estimates | `list entry` / `load cost` / `total cost` / `off` |
| Header counts | Show skill counts in the header | `on` / `off` |
| Agent usage | Show per-agent invocation counts beneath each skill (default: `on`) | `on` / `off` |
| Skill overview | Choose the mouse button for a read-only preview | `left-click` / `middle-click` / `right-click` / `off` |
| Insert @mention | Choose the mouse button for inserting a native skill attachment into the prompt | `left-click` / `middle-click` / `right-click` / `off` |

- **Display scope:**
  - `model-visible`: skills the model can discover and invoke automatically.
  - `loaded-only`: only skills successfully loaded in the current stage, including hidden skills.
  - `registered`: all skills registered for the host's current directory, including hidden skills.

  **Hidden skills:** omitted from the model's available list by metadata or permission rules, **not offered for automatic discovery/invocation**, but can be explicitly loaded with `@skill-id`. Hidden does not mean loading is disabled.

  Every scope retains current-stage loaded IDs. Loaded skills, including hidden ones, are pinned to the top. Automatic invocation still follows the host's permission rules. Display scope does not change permissions, and hiding the panel does not disable skills.
- **Sidebar colors:**

  | Item | Color |
  | --- | --- |
  | Skills title and expand/collapse arrow | White in dark mode; black in light mode |
  | Unloaded, model-visible skill names and bullets | White in dark mode; black in light mode |
  | Loaded skill names and bullets, including hidden skills | Theme selection highlight |
  | Unloaded hidden skills, header counts, and token estimates | Theme muted color |

  Colors update when the active mode or theme changes. Unloaded model-visible skills do not use the theme's body text color, which can resemble the loaded highlight in themes such as `tokyonight light`.
- **Token estimation:**
  - `list entry`: estimated tokens for a model-visible listing entry (ID, name, description), without the skill body; hidden entries cost `0`.
  - `load cost`: estimated additional tokens for one ordinary load, including the body and host-added information.
  - `total cost`: per-skill `list entry + load cost`, regardless of whether the skill is currently loaded.

  These are static estimates, not live context usage, cumulative consumption or billing; unavailable values show `-`.

Settings persist across sessions and restarts and sync across local TUI instances; collapse stays per-terminal.

## 💡 Notes

- **Agent usage:** a line such as `unity-engineer ×3 · argus ×2` shows successful skill-tool calls by their historical invoking agents. Counts include the viewed session and its recursive descendants (including background, completed and resumed subagents), not ancestors, siblings or unrelated sessions. Each session uses its own latest successful compaction/revert boundary. Repeated updates of the same session/message/call are counted once. Failed/unfinished calls, previews, and direct user attachments/activations do not add agent calls (their existing loaded-state behavior is unchanged). A missing historical agent is shown as `Unknown agent`; records without stable message/call IDs are not counted.

  Descendant loads remain visible even when the parent's model permissions/catalog would hide them. A child-only row is marked `(subagent)` and is not highlighted or counted as loaded here. The usage line and preview append `subagent` when descendant load evidence exists, including attachments without attributed calls. Header loaded counts and loaded-scope token totals remain local to the viewed session; row token estimates are still static costs, not evidence of instructions in the parent context. Child discovery uses paginated native parent-ID queries and current-stage history; unavailable history cannot prove a load.

  The sidebar line is informational and truncates to fit. The existing Skill overview popup shows the complete, wrapping breakdown in its `agents` metadata field. Turning **Agent usage** off hides only the sidebar line, not tracking or the preview field. Counts are rebuilt from available current-stage history after reopening and after committed reverts; reverted calls no longer count, and reverting across compaction restores the earlier stage. They are not a separate persistent log or proof that an agent is still following the instructions. Header counts remain distinct loaded skills, not calls. This fork feature requires a local build as described below; the upstream npm install command does not install unpublished fork changes.

- **Unloaded after compaction:** OpenCode's context compaction (`/compact`) is [lossy](https://opencode.ai/v2/docs/compaction/) and does not guarantee continued adherence to skill instructions. Successful compaction resets load marks; a new successful load highlights the skill again. `loaded` counts distinct successfully loaded skills since session start or the latest successful compaction, not invocations. Unloaded does not mean all skill text is absent from context.
- **Preview:** locally readable SKILL.md takes priority; otherwise the host's registered body is shown. Preview text may differ from model input. Colors follow the active theme, including changes while the preview is open; Markdown styling, text selection, and copying are preserved. Ctrl+click rendered HTTP(S) links to open them in your browser.

## 📁 Source structure

```text
opencode-skills-tui/
├── src/
│   ├── tui.tsx                 # Plugin setup, preview, and native skill attachments
│   ├── skill-data.ts           # Skill visibility, load state, and token estimates
│   ├── open-link.ts            # Ctrl+click link opening
│   └── components/
│       ├── skills-panel.tsx    # Sidebar panel
│       └── skills-dialog.tsx   # Sidebar settings dialog
├── scripts/                    # Build and package validation
├── test/                       # Regression tests
├── assets/                     # Demo media
├── dist/                       # Generated TUI bundle
├── index.ts                    # Required no-op server entry
└── tui.tsx                     # Forwards to the compiled TUI bundle
```

## 🛠️ Local development

In a local checkout, use [Bun](https://bun.sh):

```bash
bun install
bun run build
bun run test
```

Replace the npm entry with the checkout's absolute `file://` URL in the existing `plugins` array in `opencode.json(c)`. Rebuild and restart the TUI after code changes.

[OpenCode plugin docs](https://opencode.ai/v2/docs/plugins) · [MIT license](LICENSE)
