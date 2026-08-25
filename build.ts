/**
 * TUI plugin bundle step.
 *
 * Architecture: build configuration is a typed plan derived from the
 * package manifest, validated before any work happens. The bundle runs
 * inside a function whose failure path is a thrown AggregateError whose
 * causes carry one structured diagnostic each; the top level catches it
 * and exits non-zero. The final gate is an explicit assertion that
 * `dist/index.js` — the artifact `tui.json` loads by path — exists and is
 * non-empty.
 *
 * Externals: the opencode TUI host provides the plugin SDK, the Solid
 * adapter and the opentui runtime at load time, so those packages must
 * stay external in the emitted bundle. The set is derived from the
 * manifest's `peerDependencies` (the contract with the host, including
 * subpath imports like `@opencode-ai/plugin/tui`) plus the opentui
 * runtime packages the Solid adapter renders against (`@opentui/core`,
 * `@opentui/keymap`). Everything else is bundled by Bun.
 */
import { readFileSync, rmSync, statSync } from "node:fs"
import { createSolidTransformPlugin } from "@opentui/solid/bun-plugin"

type PackageManifest = {
  peerDependencies?: Record<string, unknown>
}

type BuildPlan = {
  entry: string
  outputDir: string
  target: "bun"
  format: "esm"
  externals: string[]
  artifactPath: string
}

/** Runtime packages the opencode host provides beyond the peer contract. */
const RUNTIME_PROVIDED = ["@opentui/core", "@opentui/keymap"] as const

function loadManifest(path: string): PackageManifest {
  const text = readFileSync(path, "utf8")
  const parsed: unknown = JSON.parse(text)
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${path} does not contain a JSON object`)
  }
  return parsed as PackageManifest
}

/** Every host-provided package is external wholesale, subpaths included. */
function deriveExternals(manifest: PackageManifest): string[] {
  const peers = Object.keys(manifest.peerDependencies ?? {})
  return [...peers, ...RUNTIME_PROVIDED].flatMap((name) => [name, `${name}/*`])
}

function createPlan(manifest: PackageManifest): BuildPlan {
  return {
    entry: "src/index.tsx",
    outputDir: "dist",
    target: "bun",
    format: "esm",
    externals: deriveExternals(manifest),
    artifactPath: "dist/index.js",
  }
}

/** Independent plan validation; returns one diagnostic string per problem. */
function validatePlan(plan: BuildPlan): string[] {
  const problems: string[] = []
  try {
    if (statSync(plan.entry).size === 0) problems.push(`entry ${plan.entry} is empty`)
  } catch {
    problems.push(`entry ${plan.entry} does not exist`)
  }
  if (plan.externals.length === 0) problems.push("external package list is empty")
  return problems
}

/**
 * Run the bundle. On failure throws an AggregateError whose causes are one
 * Error per structured diagnostic. Also asserts the expected artifact
 * exists and is non-empty.
 */
async function executePlan(plan: BuildPlan): Promise<string> {
  // Start from a clean output directory so renamed/removed modules cannot
  // leave stale artifacts behind (tsc and Bun both only write, never prune).
  rmSync(plan.outputDir, { recursive: true, force: true })

  const result = await Bun.build({
    entrypoints: [plan.entry],
    outdir: plan.outputDir,
    target: plan.target,
    format: plan.format,
    sourcemap: "none",
    external: plan.externals,
    plugins: [createSolidTransformPlugin()],
  })

  if (!result.success) {
    const diagnostics = result.logs.map((log) => {
      const detail = typeof log.message === "string" ? log.message : String(log.message)
      return new Error(`[${log.level}] ${detail}`)
    })
    throw new AggregateError(diagnostics, `bundle failed with ${diagnostics.length} diagnostic(s)`)
  }

  let size = 0
  try {
    size = statSync(plan.artifactPath).size
  } catch {
    size = 0
  }
  if (size <= 0) {
    throw new AggregateError(
      [new Error(`${plan.artifactPath} is missing or empty`)],
      "bundle verification failed",
    )
  }
  return plan.artifactPath
}

try {
  const manifest = loadManifest(new URL("./package.json", import.meta.url).pathname)
  const plan = createPlan(manifest)
  const problems = validatePlan(plan)
  if (problems.length > 0) {
    throw new AggregateError(problems.map((p) => new Error(p)), "invalid build plan")
  }
  const artifact = await executePlan(plan)
  console.log(`built ${artifact}`)
} catch (error) {
  console.error(error instanceof AggregateError ? error.message : error)
  process.exitCode = 1
}
