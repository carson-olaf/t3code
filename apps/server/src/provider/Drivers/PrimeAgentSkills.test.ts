import * as NodeOS from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { describe, expect, it } from "vite-plus/test";

import { discoverPrimeAgentSkills, probePrimeAgentSkills } from "./PrimeAgentSkills.ts";

const runNode = <A, E>(
  effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
): Promise<A> => Effect.runPromise(effect.pipe(Effect.provide(NodeServices.layer)));

describe("discoverPrimeAgentSkills", () => {
  it("discovers Prime roots with project precedence and ancestor levels", async () =>
    await runNode(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const userHomeUnresolved = yield* fileSystem.makeTempDirectory({
          directory: NodeOS.tmpdir(),
          prefix: "prime-skills-home-",
        });
        const workspaceUnresolved = yield* fileSystem.makeTempDirectory({
          directory: NodeOS.tmpdir(),
          prefix: "prime-skills-workspace-",
        });
        // The probe reports canonical paths; resolve the symlinked temp root first.
        const userHome = yield* fileSystem.realPath(userHomeUnresolved);
        const workspace = yield* fileSystem.realPath(workspaceUnresolved);
        const writeSkill = Effect.fn("writePrimeSkill")(function* (
          root: string,
          name: string,
          contents: string,
        ) {
          const skillDirectory = path.join(root, name);
          yield* fileSystem.makeDirectory(skillDirectory, { recursive: true });
          yield* fileSystem.writeFileString(path.join(skillDirectory, "SKILL.md"), contents);
        });

        yield* fileSystem.makeDirectory(path.join(workspace, ".git"), { recursive: true });
        yield* writeSkill(
          path.join(userHome, ".prime", "agent", "skills"),
          "deploy",
          "---\ndescription: user deploy\ndisable-model-invocation: true\n---\n",
        );
        yield* writeSkill(
          path.join(userHome, ".agents", "skills"),
          "review",
          "---\ndescription: user review\n---\n",
        );
        yield* writeSkill(
          path.join(workspace, ".prime", "agent", "skills"),
          "local",
          "---\nname: Local helper\ndescription: project local\n---\n",
        );
        yield* writeSkill(
          path.join(workspace, ".agents", "skills"),
          "review",
          "---\ndescription: project review\n---\n",
        );
        // Invalid frontmatter never surfaces as a skill.
        yield* writeSkill(
          path.join(workspace, ".agents", "skills"),
          "bad",
          "---\ndescription: bad\n\tbad-tab: 1\n---\n",
        );
        // Direct root .md files count in .prime roots but are ignored in .agents roots.
        yield* fileSystem.writeFileString(
          path.join(workspace, ".prime", "agent", "skills", "notes.md"),
          "---\ndescription: project notes\n---\n",
        );
        yield* fileSystem.writeFileString(
          path.join(workspace, ".agents", "skills", "ignored.md"),
          "---\ndescription: must not appear\n---\n",
        );

        // Ancestor levels resolve from a nested cwd up to the git root.
        const nested = path.join(workspace, "nested", "deep");
        yield* fileSystem.makeDirectory(nested, { recursive: true });

        const skills = yield* discoverPrimeAgentSkills(nested, { HOME: userHome });
        expect(skills).toEqual([
          {
            name: "deploy",
            description: "user deploy",
            path: path.join(userHome, ".prime", "agent", "skills", "deploy", "SKILL.md"),
            scope: "user",
            enabled: true,
            userInvocationOnly: true,
          },
          {
            name: "local",
            displayName: "Local helper",
            description: "project local",
            path: path.join(workspace, ".prime", "agent", "skills", "local", "SKILL.md"),
            scope: "project",
            enabled: true,
          },
          {
            name: "notes",
            description: "project notes",
            path: path.join(workspace, ".prime", "agent", "skills", "notes.md"),
            scope: "project",
            enabled: true,
          },
          {
            name: "review",
            description: "project review",
            path: path.join(workspace, ".agents", "skills", "review", "SKILL.md"),
            scope: "project",
            enabled: true,
          },
        ]);
        expect(
          (yield* probePrimeAgentSkills(nested, { HOME: userHome }).pipe(Effect.result))._tag,
        ).toBe("Success");
      }),
    ));

  it("reports a filesystem failure while still returning discovered skills", async () =>
    await runNode(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const userHome = yield* fileSystem.makeTempDirectory({
          directory: NodeOS.tmpdir(),
          prefix: "prime-skills-home-",
        });
        const workspace = yield* fileSystem.makeTempDirectory({
          directory: NodeOS.tmpdir(),
          prefix: "prime-skills-workspace-",
        });
        // A file where a skills directory should be makes that root unreadable.
        yield* fileSystem.makeDirectory(path.join(userHome, ".prime", "agent"), {
          recursive: true,
        });
        yield* fileSystem.writeFileString(
          path.join(userHome, ".prime", "agent", "skills"),
          "not a directory",
        );
        const skillDirectory = path.join(workspace, ".agents", "skills", "review");
        yield* fileSystem.makeDirectory(skillDirectory, { recursive: true });
        yield* fileSystem.writeFileString(
          path.join(skillDirectory, "SKILL.md"),
          "---\ndescription: project review\n---\n",
        );

        const skills = yield* discoverPrimeAgentSkills(workspace, { HOME: userHome });
        expect(skills.map((skill) => skill.name)).toEqual(["review"]);
        expect(
          (yield* probePrimeAgentSkills(workspace, { HOME: userHome }).pipe(Effect.result))._tag,
        ).toBe("Failure");
      }),
    ));
});
