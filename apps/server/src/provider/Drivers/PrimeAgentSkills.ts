/**
 * PrimeAgentSkills — workspace-aware discovery for Prime Agent skills.
 *
 * Prime Agent loads Agent Skills from user and project roots without starting
 * an agent session. Scanning the same roots populates the composer menu
 * without spawning the CLI and its Python kernel.
 *
 * Roots follow the prime-agent skill locations: `~/.prime/agent/skills/` and
 * `~/.agents/skills/` globally, plus `.prime/agent/skills/` and
 * `.agents/skills/` in the working directory and its ancestors up to the git
 * root (or filesystem root outside a repo). Directories containing SKILL.md
 * are discovered recursively everywhere; in `.prime/...` locations direct
 * root `.md` files are individual skills, while `.agents/...` ignores them.
 * Settings, package, `--skill`, and built-in skills are intentionally out of
 * scope: they need CLI state or install paths this probe cannot see.
 *
 * @module provider/Drivers/PrimeAgentSkills
 */
import * as NodeOS from "node:os";

import type { ServerProviderSkill } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import { parse as parseYamlDocument } from "yaml";

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
const ROOT_MARKDOWN_PATTERN = /\.md$/i;
const MAX_SKILL_DEPTH = 10;
const MAX_SKILL_BYTES = FileSystem.Size(1_000_000);
const MAX_SKILL_SCAN_ENTRIES = 10_000;
const MAX_SKILL_SCAN_BYTES = FileSystem.Size(8_000_000);

interface PrimeAgentSkillFrontmatter {
  readonly description?: string;
  readonly displayName?: string;
  readonly userInvocationOnly?: boolean;
  readonly userInvocable?: boolean;
}

interface PrimeAgentSkillScanBudget {
  remainingEntries: number;
  remainingBytes: bigint;
  exhausted: boolean;
  incomplete: boolean;
}

class PrimeAgentSkillsProbeError extends Schema.TaggedErrorClass<PrimeAgentSkillsProbeError>()(
  "PrimeAgentSkillsProbeError",
  {
    reason: Schema.Literals(["scan-budget-exhausted", "filesystem-error"]),
    cwd: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    const location = this.cwd === undefined ? "" : ` for '${this.cwd}'`;
    return `Prime Agent skill discovery${location} was incomplete (${this.reason}).`;
  }
}

const orUndefined = <A, R>(
  effect: Effect.Effect<A, PlatformError.PlatformError, R>,
  budget?: PrimeAgentSkillScanBudget,
): Effect.Effect<A | undefined, never, R> =>
  effect.pipe(
    Effect.map((value): A | undefined => value),
    Effect.catchTags({
      PlatformError: (error) => {
        if (error.reason._tag !== "NotFound" && budget) budget.incomplete = true;
        return Effect.void.pipe(Effect.as(undefined));
      },
    }),
  );

function parseFrontmatterBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value === 1 ? true : value === 0 ? false : undefined;
  if (typeof value !== "string") return undefined;
  switch (value.trim().toLowerCase()) {
    case "true":
    case "yes":
    case "on":
      return true;
    case "false":
    case "no":
    case "off":
      return false;
    default:
      return undefined;
  }
}

function parseSkillFrontmatter(contents: string): PrimeAgentSkillFrontmatter | undefined {
  const match = FRONTMATTER_PATTERN.exec(contents);
  if (!match) return {};

  let parsed: unknown;
  try {
    parsed = parseYamlDocument(match[1] ?? "");
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;

  const record = parsed as Record<string, unknown>;
  const description = typeof record.description === "string" ? record.description.trim() : "";
  const displayName = typeof record.name === "string" ? record.name.trim() : "";
  return {
    ...(description ? { description } : {}),
    ...(displayName ? { displayName } : {}),
    ...(parseFrontmatterBoolean(record["disable-model-invocation"]) === true
      ? { userInvocationOnly: true }
      : {}),
    ...(parseFrontmatterBoolean(record["user-invocable"]) === false
      ? { userInvocable: false }
      : {}),
  };
}

const readSkillFile = Effect.fn("readPrimeAgentSkillFile")(function* (
  skillPath: string,
  budget: PrimeAgentSkillScanBudget,
): Effect.fn.Return<PrimeAgentSkillFrontmatter | undefined, never, FileSystem.FileSystem> {
  const fileSystem = yield* FileSystem.FileSystem;
  const skillInfo = yield* orUndefined(fileSystem.stat(skillPath), budget);
  if (skillInfo?.type !== "File") return undefined;
  let frontmatter: PrimeAgentSkillFrontmatter | undefined = {};
  if (skillInfo.size <= MAX_SKILL_BYTES && skillInfo.size <= budget.remainingBytes) {
    const contents = yield* orUndefined(fileSystem.readFileString(skillPath));
    if (contents !== undefined) {
      budget.remainingBytes -= skillInfo.size;
      frontmatter = parseSkillFrontmatter(contents);
    }
  }
  return frontmatter;
});

const discoverSkillsInRoot = Effect.fn("discoverPrimeAgentSkillsInRoot")(function* (input: {
  readonly directory: string;
  readonly scope: "user" | "project";
  readonly rootMarkdownAsSkills: boolean;
  readonly budget: PrimeAgentSkillScanBudget;
}): Effect.fn.Return<ReadonlyArray<ServerProviderSkill>, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const skills: ServerProviderSkill[] = [];
  if (input.budget.exhausted) return skills;
  const rootDirectory = yield* orUndefined(fileSystem.realPath(input.directory), input.budget);
  if (!rootDirectory) return skills;
  const visitedDirectories = new Set<string>();

  const pushSkill = (
    name: string,
    skillPath: string,
    frontmatter: PrimeAgentSkillFrontmatter | undefined,
  ) => {
    const trimmed = name.trim();
    if (!frontmatter || !trimmed) return;
    skills.push({
      name: trimmed,
      path: skillPath,
      scope: input.scope,
      enabled: true,
      ...(frontmatter.displayName && frontmatter.displayName !== trimmed
        ? { displayName: frontmatter.displayName }
        : {}),
      ...(frontmatter.description ? { description: frontmatter.description } : {}),
      ...(frontmatter.userInvocationOnly ? { userInvocationOnly: true } : {}),
      ...(frontmatter.userInvocable === false ? { userInvocable: false } : {}),
    });
  };

  const visit = Effect.fn("visitPrimeAgentSkillDirectory")(function* (
    directory: string,
    depth: number,
  ): Effect.fn.Return<void, never, FileSystem.FileSystem> {
    if (input.budget.exhausted) return;
    const resolvedDirectory = yield* orUndefined(fileSystem.realPath(directory), input.budget);
    if (!resolvedDirectory) {
      return;
    }
    if (visitedDirectories.has(resolvedDirectory)) {
      return;
    }
    visitedDirectories.add(resolvedDirectory);
    // A symlink whose target lives outside the root is a skill package
    // boundary: read its own SKILL.md so linked skill libraries show up, but
    // never walk the target tree.
    const insideRoot =
      resolvedDirectory === rootDirectory ||
      resolvedDirectory.startsWith(`${rootDirectory}${path.sep}`);

    const skillPath = path.join(directory, "SKILL.md");
    const skillInfo = yield* orUndefined(fileSystem.stat(skillPath), input.budget);
    if (skillInfo?.type === "File") {
      const frontmatter = yield* readSkillFile(skillPath, input.budget);
      pushSkill(path.basename(directory), skillPath, frontmatter);
    }

    if (!insideRoot) {
      return;
    }
    const entries = yield* orUndefined(fileSystem.readDirectory(directory), input.budget);
    if (!entries) {
      return;
    }
    for (const entry of [...entries].sort()) {
      if (input.budget.remainingEntries === 0) {
        input.budget.exhausted = true;
        return;
      }
      input.budget.remainingEntries -= 1;
      const child = path.join(directory, entry);
      const info = yield* orUndefined(fileSystem.stat(child), input.budget);
      if (
        depth === 0 &&
        input.rootMarkdownAsSkills &&
        info?.type === "File" &&
        !entry.startsWith(".") &&
        ROOT_MARKDOWN_PATTERN.test(entry)
      ) {
        const frontmatter = yield* readSkillFile(child, input.budget);
        pushSkill(entry.replace(ROOT_MARKDOWN_PATTERN, ""), child, frontmatter);
        continue;
      }
      if (info?.type !== "Directory") continue;
      if (depth >= MAX_SKILL_DEPTH) {
        input.budget.exhausted = true;
        return;
      }
      yield* visit(child, depth + 1);
    }
  });

  yield* visit(rootDirectory, 0);
  return skills;
});

const ancestorLevels = Effect.fn("primeAgentSkillAncestorLevels")(function* (
  cwd: string,
): Effect.fn.Return<ReadonlyArray<string>, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const levels: Array<string> = [];
  let current = path.resolve(cwd);
  for (;;) {
    levels.push(current);
    const gitMarker = yield* orUndefined(fileSystem.stat(path.join(current, ".git")));
    if (gitMarker) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return levels;
});

const inspectPrimeAgentSkills = Effect.fn("inspectPrimeAgentSkills")(function* (
  cwd?: string,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const path = yield* Path.Path;
  const userHome = environment.HOME?.trim() || environment.USERPROFILE?.trim() || NodeOS.homedir();
  const rootsBelow = (base: string, scope: "user" | "project") => [
    { directory: path.join(base, ".prime", "agent", "skills"), scope, rootMarkdownAsSkills: true },
    { directory: path.join(base, ".agents", "skills"), scope, rootMarkdownAsSkills: false },
  ];
  const levels = cwd ? yield* ancestorLevels(cwd) : [];
  const roots = [
    ...levels.flatMap((level) => rootsBelow(level, "project")),
    ...rootsBelow(userHome, "user"),
  ];

  const skillsByName = new Map<string, ServerProviderSkill>();
  const budget: PrimeAgentSkillScanBudget = {
    remainingEntries: MAX_SKILL_SCAN_ENTRIES,
    remainingBytes: MAX_SKILL_SCAN_BYTES,
    exhausted: false,
    incomplete: false,
  };
  for (const root of roots) {
    if (budget.exhausted) break;
    const skills = yield* discoverSkillsInRoot({ ...root, budget });
    for (const skill of skills) {
      if (!skillsByName.has(skill.name)) skillsByName.set(skill.name, skill);
    }
  }
  return {
    skills: [...skillsByName.values()].sort((left, right) => left.name.localeCompare(right.name)),
    failureReason: budget.exhausted
      ? ("scan-budget-exhausted" as const)
      : budget.incomplete
        ? ("filesystem-error" as const)
        : undefined,
  };
});

export const discoverPrimeAgentSkills = Effect.fn("discoverPrimeAgentSkills")(function* (
  cwd?: string,
  environment: NodeJS.ProcessEnv = process.env,
) {
  return (yield* inspectPrimeAgentSkills(cwd, environment)).skills;
});

export const probePrimeAgentSkills = Effect.fn("probePrimeAgentSkills")(function* (
  cwd?: string,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const inspection = yield* inspectPrimeAgentSkills(cwd, environment);
  if (inspection.failureReason) {
    return yield* new PrimeAgentSkillsProbeError({
      reason: inspection.failureReason,
      ...(cwd ? { cwd } : {}),
    });
  }
  return inspection.skills;
});
