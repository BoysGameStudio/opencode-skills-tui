import { test } from "bun:test"
import assert from "node:assert/strict"
import type { Context } from "@opencode/plugin/tui/context"
import {
  backfillLoadedSkills, extractSkillLoadState, mergeSkillUsage, summarizeSkillUsage,
  type SkillUsage,
} from "../src/skill-data"

const call = (id: string, skill = "ui") => ({
  type: "tool", id, name: "skill", executed: false,
  state: { status: "completed", input: { id: skill }, content: [{ type: "text", text: '<skill_content name="UI">\n# UI' }] },
  time: { created: 1, completed: 2 },
})
const message = (id: string, agent: string | undefined, calls = [call("c1")]) => ({
  id, type: "assistant", agent, content: calls, time: { created: 1 },
})
const usage = (messages: readonly unknown[]) => extractSkillLoadState(messages, true).usage!
const summary = (messages: readonly unknown[]) => summarizeSkillUsage(usage(messages))
const compact = (id: string, status = "completed") => ({ id, type: "compaction", status })
const context = (list: (input: any) => Promise<any>) => ({ client: { message: { list } } }) as unknown as Context

test("counts successful calls by historical agent without changing distinct loaded counts", () => {
  const messages = [
    message("a", "unity-engineer", [call("a1"), call("a2"), call("a3")]),
    message("b", "argus", [call("b1"), call("b2")]),
  ]
  assert.equal(summary(messages).get("ui"), "unity-engineer ×3 · argus ×2")
  assert.deepEqual([...extractSkillLoadState(messages, true).loaded], ["ui"])
})

test("repeated snapshots and live/history overlap never increment an existing call", () => {
  const snapshot = usage([message("m", "build")])
  let merged: SkillUsage = new Map()
  merged = mergeSkillUsage(merged, snapshot)
  for (let i = 0; i < 10; i++) assert.equal(mergeSkillUsage(merged, snapshot), merged)
  assert.equal(summarizeSkillUsage(merged).get("ui"), "build ×1")
})

test("tool identity is scoped to its message; repeated entries within a message count once", () => {
  assert.equal(summary([message("a", "build", [call("c"), call("c"), call("d")])]).get("ui"), "build ×2")
  assert.equal(summary([message("a", "build"), message("b", "build")]).get("ui"), "build ×2")
})

test("new snapshots replace a message rather than append its calls", () => {
  const first = message("m", "build")
  const second = message("m", "build", [call("c1"), call("c2")])
  assert.equal(summary([first, second]).get("ui"), "build ×2")
  const merged = mergeSkillUsage(usage([first]), usage([second]))
  assert.equal(summarizeSkillUsage(merged).get("ui"), "build ×2")
})

test("an empty replacement removes that message's calls but retains other messages", () => {
  const initial = usage([message("a", "build"), message("b", "argus")])
  const merged = mergeSkillUsage(initial, usage([message("a", "build", [])]))
  assert.equal(summarizeSkillUsage(merged).get("ui"), "argus ×1")
  assert.equal(summarizeSkillUsage(initial).get("ui"), "argus ×1 · build ×1")
})

test("direct activation, sent attachment, and plain copied text preserve loads without agent counts", () => {
  const messages = [
    { id: "direct", type: "skill", skill: "direct" },
    { id: "user", type: "user", skills: [{ id: "attached" }] },
    { id: "text", type: "assistant", agent: "build", content: [{ type: "text", text: '<skill_content name="UI">' }] },
  ]
  const state = extractSkillLoadState(messages, true)
  assert.deepEqual([...state.loaded], ["direct", "attached"])
  assert.equal(summarizeSkillUsage(state.usage).size, 0)
})

test("running, failed, non-skill and completed-without-skill-output calls are excluded", () => {
  for (const status of ["running", "streaming", "error"]) {
    const tool = call("c")
    tool.state.status = status
    assert.equal(summary([message("m", "build", [tool])]).size, 0)
  }
  const nonSkill = { ...call("other"), name: "read" }
  const noOutput = call("no-output")
  noOutput.state.content = []
  assert.equal(summary([message("m", "build", [nonSkill, noOutput])]).size, 0)
})

test("missing agent is unknown, never assigned to a selected/default agent", () => {
  assert.equal(summary([message("m", undefined)]).get("ui"), "Unknown agent ×1")
  assert.equal(summary([message("m", "")]).get("ui"), "Unknown agent ×1")
  assert.equal(summary([message("a", "old-agent"), { type: "agent-switched", agent: "new-agent" }]).get("ui"), "old-agent ×1")
})

test("missing message or call IDs are not replaced with invented identities", () => {
  const noMessage = { ...message("m", "build"), id: undefined }
  const noCall = { ...call("c"), id: undefined }
  const state = extractSkillLoadState([noMessage, { ...message("m", "build"), content: [noCall] }], true)
  assert.equal(summarizeSkillUsage(state.usage).size, 0)
  assert.deepEqual([...state.loaded], ["ui"])
})

test("canonical skill IDs stay distinct even when output display names match", () => {
  const result = summary([message("m", "build", [call("a", "skill-a"), call("b", "skill-b")])])
  assert.equal(result.get("skill-a"), "build ×1")
  assert.equal(result.get("skill-b"), "build ×1")
  assert.equal(result.size, 2)
})

test("only the latest successful compaction resets usage and loaded marks", () => {
  const messages = [message("a", "before"), compact("first"), message("b", "middle"), compact("last"), message("c", "after")]
  assert.equal(summary(messages).get("ui"), "after ×1")
  assert.equal(extractSkillLoadState(messages, true).compactionID, "last")
  assert.equal(summary([message("a", "build"), compact("failed", "failed"), message("b", "build")]).get("ui"), "build ×2")
  assert.equal(summary([message("a", "build"), compact("running", "running")]).get("ui"), "build ×1")
  assert.equal(summary([message("a", "build"), compact("done")]).size, 0)
})

test("legacy load-only projection keeps its return shape and tolerates malformed input", () => {
  assert.deepEqual(extractSkillLoadState([null, undefined, message("m", "build")]), { loaded: new Set(["ui"]), compactionID: undefined })
  assert.equal(summarizeSkillUsage(undefined).size, 0)
})

test("summary ordering is deterministic, by count then ID, with unknown last", () => {
  const result = summary([message("z", "zeta"), message("a", "alpha"), message("u", undefined, [call("u1"), call("u2")])])
  assert.equal(result.get("ui"), "alpha ×1 · zeta ×1 · Unknown agent ×2")
})

test("history uses the existing pages and stops at the compaction boundary", async () => {
  const requests: any[] = []
  const ctx = context(async (input) => {
    requests.push(input)
    return input.cursor
      ? { data: [message("old-current", "argus"), compact("boundary"), message("excluded", "old")], cursor: { next: "must-not-read" } }
      : { data: [message("new", "build"), message("new", "build")], cursor: { next: "older" } }
  })
  const state = (await backfillLoadedSkills(ctx, "session", undefined, true))!
  assert.deepEqual(requests, [{ sessionID: "session", limit: 200, order: "desc" }, { sessionID: "session", limit: 200, cursor: "older" }])
  assert.equal(state.compactionID, "boundary")
  assert.equal(summarizeSkillUsage(state.usage).get("ui"), "argus ×1 · build ×1")
})

test("newest-first history keeps the first copy of a message", async () => {
  const ctx = context(async () => ({ data: [message("m", "build", [call("a"), call("b")]), message("m", "build", [call("a")])], cursor: {} }))
  const state = (await backfillLoadedSkills(ctx, "s", undefined, true))!
  assert.equal(summarizeSkillUsage(state.usage).get("ui"), "build ×2")
})

test("rebuilding after restart agrees with the live current-stage projection", async () => {
  const messages = [message("before", "old"), compact("boundary"), message("a", "build"), message("b", "argus")]
  const ctx = context(async () => ({ data: [...messages].reverse(), cursor: {} }))
  const rebuilt = (await backfillLoadedSkills(ctx, "s", undefined, true))!
  assert.deepEqual(summarizeSkillUsage(rebuilt.usage), summary(messages))
})

test("an aborted late history response cannot publish stale usage", async () => {
  const pending = Promise.withResolvers<any>()
  const controller = new AbortController()
  const result = backfillLoadedSkills(context(() => pending.promise), "s", controller.signal, true)
  controller.abort()
  pending.resolve({ data: [message("stale", "before-compaction")], cursor: {} })
  assert.equal(await result, undefined)
})

test("partial live windows retain other current-stage messages without duplicating overlap", () => {
  const old = usage([message("a", "build"), message("b", "argus")])
  const merged = mergeSkillUsage(old, usage([message("b", "argus"), message("c", "argus")]))
  assert.equal(summarizeSkillUsage(merged).get("ui"), "argus ×2 · build ×1")
})

test("separate session collections do not leak even with identical message/call IDs", () => {
  const sessions = new Map<string, SkillUsage>([["a", usage([message("m", "agent-a")])], ["b", usage([message("m", "agent-b")])]])
  assert.equal(summarizeSkillUsage(sessions.get("a")).get("ui"), "agent-a ×1")
  assert.equal(summarizeSkillUsage(sessions.get("b")).get("ui"), "agent-b ×1")
})
