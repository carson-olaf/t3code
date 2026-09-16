/**
 * MuseSkills — skill discovery for the `$` picker via `muse skills list`.
 *
 * Unlike Prime Agent, the Muse CLI reports its full skill catalog itself:
 * `muse skills list --source all --json` returns `skills[]` with `id`,
 * `name`, `description`, `scope` (`user` / `project` / `bundled` / `plugin`),
 * `path`, and `activation` (`on` / `user-invocable-only`). Asking the CLI
 * beats scanning the filesystem because the catalog honors Muse's own skill
 * config (enablement, workspace trust) and includes bundled and plugin
 * skills, which live behind `bundled://` and `plugin://` URIs where a flat
 * scan cannot see them. This mirrors how the Grok CLI reports skills over
 * `grok inspect --json`. Probe failures stay typed so workspace snapshots do
 * not cache an empty catalog; machine-level discovery recovers them to an
 * empty list without degrading the provider.
 *
 * @module provider/Drivers/MuseSkills
 */
import * as NodeOS from "node:os";

import type { MuseSettings, ServerProviderSkill } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ChildProcess } from "effect/unstable/process";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import { spawnAndCollect } from "../providerSnapshot.ts";

const MUSE_SKILLS_PROBE_TIMEOUT_MS = 4_000;
const URI_SCHEME_PATTERN = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;

class MuseSkillsProbeError extends Schema.TaggedErrorClass<MuseSkillsProbeError>()(
  "MuseSkillsProbeError",
  {
    stage: Schema.Literals(["spawn", "timeout", "exit", "decode"]),
    cwd: Schema.optional(Schema.String),
    exitCode: Schema.optional(Schema.Number),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    const location = this.cwd === undefined ? "" : ` for '${this.cwd}'`;
    const exitCode = this.exitCode === undefined ? "" : ` with exit code ${this.exitCode}`;
    return `\`muse skills list --json\` failed during ${this.stage}${location}${exitCode}.`;
  }
}

function resolveMuseSkillPath(
  rawPath: string,
  environment: NodeJS.ProcessEnv,
  path: Path.Path,
  cwd?: string,
): string {
  const trimmed = rawPath.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("$HOME/")) {
    const home = environment.HOME?.trim() || NodeOS.homedir();
    return path.join(home, trimmed.slice("$HOME/".length));
  }
  if (path.isAbsolute(trimmed) || URI_SCHEME_PATTERN.test(trimmed)) return trimmed;
  return cwd ? path.join(cwd, trimmed) : trimmed;
}

/**
 * Map `muse skills list --json` output onto provider skills. Entries without
 * a name or a path are skipped. The CLI lists lower-precedence scopes first,
 * so later entries with the same name win. `user-invocable-only` skills stay
 * enabled but flagged so the model never auto-invokes them.
 */
function decodeMuseSkillsList(
  stdout: string,
  environment: NodeJS.ProcessEnv,
  path: Path.Path,
  cwd?: string,
): ReadonlyArray<ServerProviderSkill> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return undefined;
  }
  const entries = (parsed as Record<string, unknown>).skills;
  if (!Array.isArray(entries)) {
    return undefined;
  }

  const skillsByName = new Map<string, ServerProviderSkill>();
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const name =
      typeof record.name === "string" && record.name.trim()
        ? record.name.trim()
        : typeof record.id === "string"
          ? record.id.trim()
          : "";
    const skillPath = resolveMuseSkillPath(
      typeof record.path === "string" ? record.path : "",
      environment,
      path,
      cwd,
    );
    if (!name || !skillPath) {
      continue;
    }
    const scope = typeof record.scope === "string" ? record.scope.trim() : "";
    const description = typeof record.description === "string" ? record.description.trim() : "";
    const shortDescription =
      typeof record.short_description === "string" ? record.short_description.trim() : "";
    const displayName = typeof record.display_name === "string" ? record.display_name.trim() : "";
    const activation = typeof record.activation === "string" ? record.activation.trim() : "";
    skillsByName.set(name, {
      name,
      path: skillPath,
      enabled: activation !== "off" && activation !== "disabled",
      ...(scope ? { scope } : {}),
      ...(description ? { description } : {}),
      ...(shortDescription ? { shortDescription } : {}),
      ...(displayName && displayName !== name ? { displayName } : {}),
      ...(activation === "user-invocable-only" ? { userInvocationOnly: true } : {}),
    });
  }

  return [...skillsByName.values()].sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * Run `muse skills list --source all --json` and map the reported catalog
 * onto provider skills. Callers that need best-effort discovery can recover
 * this effect to an empty list; workspace callers leave failures typed so
 * they are not cached.
 */
export const discoverMuseSkills = Effect.fn("discoverMuseSkills")(function* (
  museSettings: Pick<MuseSettings, "binaryPath">,
  environment: NodeJS.ProcessEnv = process.env,
  cwd?: string,
) {
  const command = museSettings.binaryPath || "muse";
  const path = yield* Path.Path;
  const listResult = yield* Effect.gen(function* () {
    const spawnCommand = yield* resolveSpawnCommand(
      command,
      ["skills", "list", "--source", "all", "--json"],
      { env: environment },
    );
    return yield* spawnAndCollect(
      command,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        ...(cwd ? { cwd } : {}),
        env: environment,
        shell: spawnCommand.shell,
      }),
    );
  }).pipe(
    Effect.mapError(
      (cause) =>
        new MuseSkillsProbeError({
          stage: "spawn",
          ...(cwd ? { cwd } : {}),
          cause,
        }),
    ),
    Effect.timeoutOption(MUSE_SKILLS_PROBE_TIMEOUT_MS),
  );

  if (Option.isNone(listResult)) {
    return yield* new MuseSkillsProbeError({
      stage: "timeout",
      ...(cwd ? { cwd } : {}),
    });
  }
  const output = listResult.value;
  if (output.code !== 0) {
    return yield* new MuseSkillsProbeError({
      stage: "exit",
      ...(cwd ? { cwd } : {}),
      exitCode: output.code,
    });
  }
  const skills = decodeMuseSkillsList(output.stdout, environment, path, cwd);
  if (!skills) {
    return yield* new MuseSkillsProbeError({
      stage: "decode",
      ...(cwd ? { cwd } : {}),
    });
  }
  return skills;
});
