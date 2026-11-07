import { $ } from "bun"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { name } from "../package.json"

const sandbox = await mkdtemp(join(process.cwd(), "node_modules", ".package-test-"))
try {
  const packed = await $`npm pack --json --ignore-scripts --pack-destination ${sandbox}`.quiet().json()
  // npm's JSON result may be indexed or keyed by package name.
  const packages = packed && typeof packed === "object" ? Object.values(packed) : []
  const archive = packages.length === 1 && packages[0]?.name === name ? packages[0] : undefined
  if (typeof archive?.filename !== "string") {
    throw new Error(`npm pack did not return a package filename: ${JSON.stringify(packed)}`)
  }
  const installed = join(sandbox, "node_modules", name)
  await mkdir(installed, { recursive: true })
  await $`tar -xzf ${join(sandbox, archive.filename)} -C ${installed} --strip-components=1`
  // Preserve the node_modules path because OpenCode loads published packages there.
  await $`bun test --conditions=browser --preload @opentui/solid/runtime-plugin-support test/skills-panel.test.tsx test/skill-usage-tui.test.tsx`
    .env({ ...process.env, PLUGIN_TEST_ENTRY: pathToFileURL(join(installed, "tui.tsx")).href })
} finally {
  await rm(sandbox, { recursive: true, force: true })
}
