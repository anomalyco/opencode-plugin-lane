import { lstat, readFile, realpath } from "node:fs/promises"
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { Worktree } from "@opencode/plugin"
import type { WorktreeDefinition } from "@opencode/plugin/promise/worktree"
import { CommandError, run } from "./command"

interface Options {
  executable: string
  dirty: boolean
  branchPrefix: string
}

function options(value: Record<string, unknown>): Options {
  for (const key of Object.keys(value)) {
    if (key !== "executable" && key !== "dirty" && key !== "branchPrefix") throw new Error(`Unknown Lane option: ${key}`)
  }
  const executable = value.executable ?? "lane"
  const dirty = value.dirty ?? false
  const branchPrefix = value.branchPrefix ?? ""
  if (typeof executable !== "string" || !executable.trim() || executable.includes("\0")) {
    throw new Error("Lane executable must be a non-empty command name or absolute path")
  }
  if (!isAbsolute(executable) && /[/\\]/.test(executable)) {
    throw new Error("Use an absolute path for the Lane executable")
  }
  if (typeof dirty !== "boolean") throw new Error("Lane dirty must be a boolean")
  if (typeof branchPrefix !== "string" || (branchPrefix !== "" && !/^[a-zA-Z0-9]+(?:[-/][a-zA-Z0-9]+)*$/.test(branchPrefix))) {
    throw new Error("Lane branchPrefix must be empty or alphanumeric words separated by single hyphens or slashes")
  }
  return { executable, dirty, branchPrefix }
}

// Resolve symlinked ancestors even before a destination has been created.
async function canonical(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    const parent = dirname(path)
    if (parent === path) throw error
    return join(await canonical(parent), relative(parent, path))
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
    throw error
  }
}

function laneName(root: string, directory: string): string | undefined {
  const name = relative(join(root, ".lane", "trees"), directory)
  if (!name || isAbsolute(name) || name.split(sep).some((part) => part.startsWith("."))) return
  return name.split(sep).join("/")
}

async function layout(directory: string, signal: AbortSignal) {
  const common = await run("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], directory, signal)
  const root = dirname(await realpath(common))
  // Lane itself assumes the common Git directory is <primary checkout>/.git.
  if (await canonical(join(root, ".git")) !== await realpath(common)) {
    throw new Error("Lane requires a primary checkout with a .git directory (bare and separate-git-dir repositories are unsupported)")
  }
  const checkout = await run("git", ["rev-parse", "--show-toplevel"], directory, signal)
  return { root, checkout: await realpath(checkout) }
}

interface Lane {
  path: string
  branch: string
}

async function inventory(executable: string, root: string, signal: AbortSignal): Promise<Lane[]> {
  const data: unknown = JSON.parse(await run(executable, ["ls", "--json"], root, signal))
  if (!Array.isArray(data) || data.some((row) => !row || typeof row.path !== "string" || typeof row.branch !== "string")) {
    throw new Error("Invalid lane ls --json response: expected an array of paths and branches")
  }
  const lanes: Lane[] = []
  for (const row of data as Lane[]) {
    signal.throwIfAborted()
    let path: string
    try {
      path = await realpath(resolve(root, row.path))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue
      throw error
    }
    // lane ls includes ordinary Git worktrees too. Only claim native, stamped lanes
    // whose branch matches the name lane rm would delete.
    if (laneName(root, path) !== row.branch) continue
    const gitdir = await run("git", ["rev-parse", "--absolute-git-dir"], path, signal)
    try {
      if ((await readFile(join(gitdir, "lane", "id"), "utf8")).trim()) lanes.push({ path, branch: row.branch })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
  }
  return lanes
}

export function makeStrategy(value: Record<string, unknown> = {}): WorktreeDefinition {
  const { executable, dirty, branchPrefix } = options(value)
  return {
    id: "lane",
    async create(input, { signal }) {
      const { root, checkout } = await layout(input.sourceDirectory, signal)
      const task = basename(resolve(input.directory))
      const requested = branchPrefix ? `${branchPrefix}/${task}` : task
      await run("git", ["check-ref-format", "--branch", requested], root, signal)
      // OpenCode's destination is a suggestion. Lane owns the actual path and
      // must check collisions here, including branches without a worktree.
      let name = requested
      let directory = join(root, ".lane", "trees", name)
      let suffix = 1
      while (await exists(directory) || await run("git", ["branch", "--list", "--format=%(refname:short)", "--", name], root, signal)) {
        if (++suffix > 10) throw new Error(`No available Lane destination for ${requested} after 10 attempts`)
        name = `${requested}-${suffix}`
        directory = join(root, ".lane", "trees", name)
      }
      const ref = input.branch ?? "HEAD"
      if (!ref || ref.startsWith("-")) throw new Error("Lane starting ref must be non-empty and must not start with '-'")
      // Resolve HEAD-relative refs in the source checkout before invoking Lane
      // from the primary checkout. Keep local branch names for Lane's merge base.
      const commit = await run("git", ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`], checkout, signal)
      const symbolic = await run("git", ["rev-parse", "--symbolic-full-name", "--verify", "--end-of-options", ref], checkout, signal)
      const base = symbolic.startsWith("refs/heads/") ? symbolic.slice("refs/heads/".length) : commit
      const args = ["new", "--base", base]
      if (dirty) args.push("--dirty")
      args.push("--", name)
      // --base prevents adoption if a same-named branch appears after our checks.
      await run(executable, args, root, signal)
      return { directory: await realpath(directory) }
    },
    async list(sourceDirectory, { signal }) {
      const { root } = await layout(sourceDirectory, signal)
      const lanes = await inventory(executable, root, signal)
      return [{ directory: root, type: "root" }, ...lanes.map((lane) => ({ directory: lane.path, type: "worktree" as const }))]
    },
    async remove(input, { signal }) {
      const directory = await canonical(resolve(input.directory))
      const { root } = await layout(directory, signal)
      const lane = (await inventory(executable, root, signal)).find((lane) => lane.path === directory)
      if (!lane) throw new Error(`Not a Lane-owned worktree: ${input.directory}`)
      const args = ["rm"]
      if (input.force) args.push("--force")
      args.push("--", lane.branch)
      try {
        await run(executable, args, root, signal)
      } catch (error) {
        if (!input.force && error instanceof CommandError && error.code === 1 && error.stderr.includes(`kept lane ${lane.branch}:`)) {
          throw new Worktree.OperationError({ message: error.stderr.trim(), forceRequired: true })
        }
        throw error
      }
    },
  }
}
