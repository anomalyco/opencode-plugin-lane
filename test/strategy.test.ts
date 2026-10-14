import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Worktree } from "@opencode/plugin"
import { makeStrategy } from "../src/strategy"
import { run } from "../src/command"

const executable = process.env.LANE_BIN ?? Bun.which("lane")
const context = () => ({ signal: new AbortController().signal })

test("validates plugin options before registration", () => {
  expect(() => makeStrategy({ dirty: "yes" })).toThrow("boolean")
  expect(() => makeStrategy({ executable: "./lane" })).toThrow("absolute path")
  expect(() => makeStrategy({ executable: "" })).toThrow("non-empty")
  expect(() => makeStrategy({ directory: "/tmp" })).toThrow("Unknown Lane option")
  for (const branchPrefix of [1, "../escape", "/absolute", "trailing/", ".hidden", "two words", "a//b", "a\\b", "a.lock"]) {
    expect(() => makeStrategy({ branchPrefix })).toThrow("Lane branchPrefix must")
  }
  expect(() => makeStrategy({ branchPrefix: "team/review-bot" })).not.toThrow()
})

test("cancellation stops an in-flight command", async () => {
  const controller = new AbortController()
  const reason = new Error("cancelled")
  const pending = run(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], tmpdir(), controller.signal)
  const timer = setTimeout(() => controller.abort(reason), 50)
  try {
    await expect(pending).rejects.toBe(reason)
  } finally {
    clearTimeout(timer)
  }
})

describe.skipIf(!executable)("Lane CLI integration", () => {
  let temp: string
  let root: string
  const strategy = makeStrategy({ executable: executable ?? "lane" })
  const git = (...args: string[]) => run("git", args, root, context().signal)
  const destination = (name: string) => join(root, ".lane", "trees", name)
  const create = (name: string, branch?: string) => strategy.create({ sourceDirectory: root, directory: destination(name), branch }, context())

  beforeEach(async () => {
    temp = await mkdtemp(join(process.env.OPENCODE_TEST_TMP ?? tmpdir(), "opencode-plugin-lane-"))
    root = join(temp, "repo with spaces")
    await mkdir(root)
    await git("init", "-qb", "main")
    await git("config", "user.name", "Lane Test")
    await git("config", "user.email", "lane@example.test")
    await git("config", "commit.gpgsign", "false")
    await git("config", "core.hooksPath", "/dev/null")
    await writeFile(join(root, "file.txt"), "original\n")
    await writeFile(join(root, ".gitignore"), "cache/\n")
    await git("add", ".")
    await git("commit", "-qm", "initial")
  })

  afterEach(async () => {
    await rm(temp, { recursive: true, force: true })
  })

  test("creates, discovers from a lane, and removes a native Lane worktree", async () => {
    const result = await create("feature")
    expect(result.directory).toBe(destination("feature"))
    expect(await readFile(join(result.directory, "file.txt"), "utf8")).toBe("original\n")
    expect(await strategy.list(result.directory, context())).toEqual([
      { directory: root, type: "root" },
      { directory: result.directory, type: "worktree" },
    ])
    await strategy.remove({ ...result, force: false }, context())
    expect(await strategy.list(root, context())).toEqual([{ directory: root, type: "root" }])
    expect(await git("branch", "--list", "feature")).toBe("")
  })

  test("uses the requested starting ref and avoids existing branches", async () => {
    const base = await git("rev-parse", "HEAD")
    await writeFile(join(root, "file.txt"), "newer\n")
    await git("commit", "-am", "second")
    await create("older", base)
    expect(await readFile(join(destination("older"), "file.txt"), "utf8")).toBe("original\n")
    await git("branch", "existing")
    const existing = await git("rev-parse", "existing")
    const result = await create("existing", base)
    expect(result.directory).toBe(destination("existing-2"))
    expect(await readFile(join(result.directory, "file.txt"), "utf8")).toBe("original\n")
    expect(await git("rev-parse", "existing")).toBe(existing)
    await expect(create("bad-ref", "missing-ref")).rejects.toThrow()
  })

  test("keeps the current primary branch as the default base", async () => {
    await git("checkout", "-qb", "develop")
    await writeFile(join(root, "file.txt"), "develop\n")
    await git("commit", "-am", "develop")
    await create("from-develop")
    expect(await readFile(join(destination("from-develop"), "file.txt"), "utf8")).toBe("develop\n")
  })

  test("reports only stamped native lanes and refuses to remove other worktrees", async () => {
    const other = join(temp, "ordinary")
    await git("worktree", "add", "-b", "ordinary", other)
    const nativeLookalike = destination("lookalike")
    await git("worktree", "add", "-b", "lookalike", nativeLookalike)
    await create("owned")
    expect(await strategy.list(root, context())).toEqual([
      { directory: root, type: "root" },
      { directory: destination("owned"), type: "worktree" },
    ])
    for (const directory of [root, other, nativeLookalike]) {
      await expect(strategy.remove({ directory, force: true }, context())).rejects.toThrow("Not a Lane-owned worktree")
    }
    await rm(destination("owned"), { recursive: true })
    expect(await strategy.list(root, context())).toEqual([{ directory: root, type: "root" }])
  })

  test("translates Lane's dirty-worktree refusal into force confirmation", async () => {
    const result = await create("dirty")
    await writeFile(join(result.directory, "untracked.txt"), "keep me\n")
    try {
      await strategy.remove({ ...result, force: false }, context())
      throw new Error("Expected removal to fail")
    } catch (error) {
      expect(error).toBeInstanceOf(Worktree.OperationError)
      expect((error as Worktree.OperationError).forceRequired).toBe(true)
    }
    expect(await readFile(join(result.directory, "untracked.txt"), "utf8")).toBe("keep me\n")
    await strategy.remove({ ...result, force: true }, context())
    expect(await strategy.list(root, context())).toHaveLength(1)
  })

  test("protects unmerged commits even in a clean lane", async () => {
    const result = await create("unmerged")
    await writeFile(join(result.directory, "file.txt"), "unmerged\n")
    await run("git", ["commit", "-am", "lane commit"], result.directory, context().signal)
    await expect(strategy.remove({ ...result, force: false }, context())).rejects.toMatchObject({ forceRequired: true })
    await strategy.remove({ ...result, force: true }, context())
  })

  test("optionally carries dirty files and accepts primary-checkout subdirectories", async () => {
    await writeFile(join(root, "file.txt"), "dirty edit\n")
    await writeFile(join(root, "untracked.txt"), "scratch\n")
    await mkdir(join(root, "src"))
    await create("clean")
    expect(await readFile(join(destination("clean"), "file.txt"), "utf8")).toBe("original\n")
    const dirty = makeStrategy({ executable, dirty: true })
    await dirty.create({ sourceDirectory: join(root, "src"), directory: destination("carried") }, context())
    expect(await readFile(join(destination("carried"), "file.txt"), "utf8")).toBe("dirty edit\n")
    expect(await readFile(join(destination("carried"), "untracked.txt"), "utf8")).toBe("scratch\n")
  })

  test("uses Lane's destination, handles collisions there, and resolves linked sources", async () => {
    const input = { sourceDirectory: root, directory: join(temp, "outside") }
    expect(await strategy.create(input, context())).toEqual({ directory: destination("outside") })
    expect(await strategy.create(input, context())).toEqual({ directory: destination("outside-2") })
    await writeFile(destination("outside-3"), "keep me")
    expect(await strategy.create(input, context())).toEqual({ directory: destination("outside-4") })
    expect(await readFile(destination("outside-3"), "utf8")).toBe("keep me")
    await create("source")
    await writeFile(join(destination("source"), "file.txt"), "linked edit\n")
    await run("git", ["commit", "-am", "linked commit"], destination("source"), context().signal)
    await symlink(temp, destination("escape"))
    expect(await create("escape")).toEqual({ directory: destination("escape-2") })
    await mkdir(join(destination("source"), "src"))
    const child = await strategy.create({ sourceDirectory: join(destination("source"), "src"), directory: join(temp, "child") }, context())
    expect(child.directory).toBe(destination("child"))
    expect(await readFile(join(child.directory, "file.txt"), "utf8")).toBe("linked edit\n")
    expect(await git("config", "--get", "lane.child.base")).toBe("source")
    await run("git", ["checkout", "--detach"], destination("source"), context().signal)
    const detached = await strategy.create({ sourceDirectory: destination("source"), directory: join(temp, "detached") }, context())
    expect(await readFile(join(detached.directory, "file.txt"), "utf8")).toBe("linked edit\n")
    const previous = await strategy.create({ sourceDirectory: destination("source"), directory: join(temp, "previous"), branch: "HEAD~1" }, context())
    expect(await readFile(join(previous.directory, "file.txt"), "utf8")).toBe("original\n")
  })

  test("namespaces branches and directories with branchPrefix", async () => {
    const prefixed = makeStrategy({ executable, branchPrefix: "team/review" })
    await git("branch", "team/review/fix")
    const input = { sourceDirectory: root, directory: join(temp, "fix") }
    const first = await prefixed.create(input, context())
    const second = await prefixed.create(input, context())
    expect(first.directory).toBe(destination("team/review/fix-2"))
    expect(second.directory).toBe(destination("team/review/fix-3"))
    expect(await run("git", ["branch", "--show-current"], second.directory, context().signal)).toBe("team/review/fix-3")
    expect(await prefixed.list(root, context())).toEqual([
      { directory: root, type: "root" },
      { directory: first.directory, type: "worktree" },
      { directory: second.directory, type: "worktree" },
    ])
    await prefixed.remove({ ...first, force: false }, context())
    await prefixed.remove({ ...second, force: false }, context())
    expect(await git("branch", "--list", "--format=%(refname:short)", "team/review/*")).toBe("team/review/fix")
  })

  test("lists and removes lanes created with a different prefix", async () => {
    const unprefixed = await create("old-task")
    const prefixed = makeStrategy({ executable, branchPrefix: "team" })
    expect(await prefixed.list(root, context())).toContainEqual({ directory: unprefixed.directory, type: "worktree" })
    await prefixed.remove({ ...unprefixed, force: false }, context())
    expect(await git("branch", "--list", "old-task")).toBe("")
  })

  test("does not reinterpret cancellation as a force-required failure", async () => {
    const result = await create("cancel")
    const signal = AbortSignal.abort(new Error("stop"))
    await expect(strategy.remove({ ...result, force: false }, { signal })).rejects.toThrow("stop")
    expect(await strategy.list(root, context())).toHaveLength(2)
  })
})
