import { describe, expect, it } from "@effect/vitest";
import * as NodePath from "@effect/platform-node/NodePath";
import * as Effect from "effect/Effect";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";

import { discoverMuseSkills } from "./MuseSkills.ts";

const listPayload = (skills: ReadonlyArray<unknown>) => JSON.stringify({ skills });

const withListSpawner = (stdout: string, exitCode = 0, spawnCwds?: Array<string | undefined>) =>
  Effect.provideService(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      spawnCwds?.push(command._tag === "StandardCommand" ? command.options.cwd : undefined);
      return Effect.succeed(
        ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exitCode)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          unref: Effect.succeed(Effect.void),
          stdin: Sink.drain,
          stdout: Stream.encodeText(Stream.make(stdout)),
          stderr: Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        }),
      );
    }),
  );

const withTestPath = Effect.provide(NodePath.layerPosix);

describe("discoverMuseSkills", () => {
  it.effect("maps list entries onto provider skills, sorted by name", () =>
    Effect.gen(function* () {
      const skills = yield* discoverMuseSkills(
        { binaryPath: "muse" },
        { HOME: "/home/dev" },
        "/workspaces/demo",
      );

      expect(skills).toEqual([
        {
          name: "deploy",
          description: "Deploy the app.",
          path: "/home/dev/.agents/skills/deploy/SKILL.md",
          scope: "user",
          enabled: true,
        },
        {
          name: "writing-docs",
          description: "Write user docs.",
          shortDescription: "Docs writer.",
          path: "/workspaces/demo/.agents/skills/writing-docs/SKILL.md",
          scope: "project",
          enabled: true,
        },
      ]);
    }).pipe(
      withListSpawner(
        listPayload([
          {
            id: "writing-docs",
            name: "writing-docs",
            display_name: "writing-docs",
            description: "Write user docs.",
            short_description: "Docs writer.",
            scope: "project",
            path: ".agents/skills/writing-docs/SKILL.md",
            activation: "on",
          },
          {
            id: "deploy",
            name: "deploy",
            display_name: "deploy",
            description: "Deploy the app.",
            scope: "user",
            path: "$HOME/.agents/skills/deploy/SKILL.md",
            activation: "on",
          },
        ]),
      ),
      withTestPath,
    ),
  );

  it.effect("lets later entries shadow earlier ones and flags user-only skills", () =>
    Effect.gen(function* () {
      const skills = yield* discoverMuseSkills({ binaryPath: "muse" }, { HOME: "/home/dev" });

      expect(skills).toEqual([
        {
          name: "grill",
          description: "User grill.",
          path: "/home/dev/.agents/skills/grill/SKILL.md",
          scope: "user",
          enabled: true,
        },
        {
          name: "plan-day",
          description: "Plan the day.",
          path: "plugin://journal/skills/plan-day/SKILL.md",
          scope: "plugin",
          enabled: true,
          userInvocationOnly: true,
        },
      ]);
    }).pipe(
      withListSpawner(
        listPayload([
          {
            id: "grill",
            name: "grill",
            description: "Bundled grill.",
            scope: "bundled",
            path: "bundled://muse-core/skills/grill/SKILL.md",
            activation: "on",
          },
          {
            id: "grill",
            name: "grill",
            description: "User grill.",
            scope: "user",
            path: "$HOME/.agents/skills/grill/SKILL.md",
            activation: "on",
          },
          {
            id: "plan-day",
            name: "plan-day",
            description: "Plan the day.",
            scope: "plugin",
            path: "plugin://journal/skills/plan-day/SKILL.md",
            activation: "user-invocable-only",
          },
        ]),
      ),
      withTestPath,
    ),
  );

  it.effect("disables skills the CLI reports as off and skips nameless entries", () =>
    Effect.gen(function* () {
      const skills = yield* discoverMuseSkills({ binaryPath: "muse" }, {});
      expect(skills).toEqual([
        {
          name: "kept",
          path: "/repo/.agents/skills/kept/SKILL.md",
          scope: "project",
          enabled: true,
        },
        {
          name: "sleeping",
          path: "/opt/muse/bundled/skills/sleeping/SKILL.md",
          scope: "bundled",
          enabled: false,
        },
      ]);
    }).pipe(
      withListSpawner(
        listPayload([
          { id: "  ", name: "  ", path: "/tmp/skills/a/SKILL.md" },
          { name: "no-path" },
          "not-an-object",
          {
            id: "sleeping",
            scope: "bundled",
            path: "/opt/muse/bundled/skills/sleeping/SKILL.md",
            activation: "off",
          },
          {
            id: "kept",
            scope: "project",
            path: "/repo/.agents/skills/kept/SKILL.md",
          },
        ]),
      ),
      withTestPath,
    ),
  );

  it.effect("rejects malformed or unexpected output as a decode failure", () =>
    Effect.gen(function* () {
      for (const stdout of ["not json", "null", '{"skills":"nope"}', "{}"]) {
        const error = yield* discoverMuseSkills({ binaryPath: "muse" }, {}).pipe(
          Effect.flip,
          withListSpawner(stdout),
          withTestPath,
        );
        expect(error).toMatchObject({ _tag: "MuseSkillsProbeError", stage: "decode" });
      }
    }),
  );

  it.effect("spawns in the configured cwd and rejects a failed probe", () => {
    const spawnCwds: Array<string | undefined> = [];
    const stdout = listPayload([
      {
        id: "kept",
        scope: "project",
        path: ".agents/skills/kept/SKILL.md",
      },
    ]);

    return Effect.gen(function* () {
      const skills = yield* discoverMuseSkills({ binaryPath: "muse" }, {}, "/workspaces/demo").pipe(
        withListSpawner(stdout, 0, spawnCwds),
        withTestPath,
      );

      expect(spawnCwds).toEqual(["/workspaces/demo"]);
      expect(skills).toEqual([
        {
          name: "kept",
          path: "/workspaces/demo/.agents/skills/kept/SKILL.md",
          scope: "project",
          enabled: true,
        },
      ]);

      const failed = yield* discoverMuseSkills({ binaryPath: "muse" }).pipe(
        Effect.result,
        withListSpawner(stdout, 1),
        withTestPath,
      );
      expect(failed._tag).toBe("Failure");
    });
  });
});
