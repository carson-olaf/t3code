// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  EventId,
  TurnId,
  PrimeAgentSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  ThreadId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../../config.ts";
import {
  makePrimeAgentAdapter,
  makePrimeSubagentTracker,
  withPrimeAgentToolDetails,
} from "./PrimeAgentAdapter.ts";
import { makeAcpToolCallEvent } from "../acp/AcpCoreRuntimeEvents.ts";

const decodePrimeAgentSettings = Schema.decodeSync(PrimeAgentSettings);
const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../../scripts/acp-mock-agent.ts");

async function makeProbeWrapper(input: {
  readonly argvLogPath: string;
  readonly requestLogPath?: string;
  readonly extraEnv?: Readonly<Record<string, string>>;
}) {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "prime-agent-acp-probe-"));
  const wrapperPath = NodePath.join(dir, "prime-agent");
  const envExports = Object.entries(input.extraEnv ?? {})
    .map(([key, value]) => `export ${key}=${JSON.stringify(value)}`)
    .join("\n");
  const script = `#!/bin/sh
printf '%s\t' "$@" >> ${JSON.stringify(input.argvLogPath)}
printf '\n' >> ${JSON.stringify(input.argvLogPath)}
${input.requestLogPath ? `export T3_ACP_REQUEST_LOG_PATH=${JSON.stringify(input.requestLogPath)}` : ""}
${envExports}
exec node ${JSON.stringify(mockAgentPath)} "$@"
`;
  await NodeFSP.writeFile(wrapperPath, script, "utf8");
  await NodeFSP.chmod(wrapperPath, 0o755);
  return wrapperPath;
}

async function readArgvLog(filePath: string): Promise<ReadonlyArray<ReadonlyArray<string>>> {
  const raw = await NodeFSP.readFile(filePath, "utf8");
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split("\t").filter(Boolean));
}

async function readJsonLines(filePath: string): Promise<ReadonlyArray<Record<string, unknown>>> {
  const raw = await NodeFSP.readFile(filePath, "utf8");
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

const waitForJsonLogMethod = (filePath: string, method: string): Effect.Effect<void> =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const entries = yield* Effect.promise(() => readJsonLines(filePath));
      if (entries.some((entry) => entry.method === method)) return;
      yield* Effect.yieldNow;
    }
    return yield* Effect.die(new Error(`Timed out waiting for ${method} in ${filePath}`));
  });

const primeAgentAdapterTestLayer = it.layer(
  ServerConfig.layerTest(process.cwd(), {
    prefix: "t3code-prime-agent-adapter-test-",
  }).pipe(Layer.provideMerge(NodeServices.layer)),
);

it("exposes executing Python cell source while preserving output and lifecycle", () => {
  const code = 'from pathlib import Path\nprint(Path("README.md").read_text())';
  for (const status of ["inProgress", "completed"] as const) {
    const event = makeAcpToolCallEvent({
      stamp: { eventId: EventId.make("python-event"), createdAt: "2026-09-15T00:00:00.000Z" },
      provider: ProviderDriverKind.make("primeAgent"),
      threadId: ThreadId.make("python-thread"),
      turnId: TurnId.make("python-turn"),
      toolCall: withPrimeAgentToolDetails({
        toolCallId: "python-cell",
        kind: "execute",
        title: "Python cell",
        status,
        detail: "Python cell",
        data: { rawInput: { code }, rawOutput: "README contents" },
      }),
      rawPayload: {},
    });
    assert.equal(event.type, status === "completed" ? "item.completed" : "item.updated");
    if (event.type === "item.completed" || event.type === "item.updated") {
      assert.equal(event.payload.detail, code);
      const data = Schema.decodeUnknownSync(
        Schema.Struct({ command: Schema.String, rawOutput: Schema.String }),
      )(event.payload.data);
      assert.equal(data.command, code);
      assert.equal(data.rawOutput, "README contents");
      assert.equal(event.payload.title, "Python cell");
    }
  }
  const shell = { toolCallId: "shell", kind: "execute", data: { rawInput: { command: "pwd" } } };
  assert.strictEqual(withPrimeAgentToolDetails(shell), shell);
});

it("tracks native subagents once and retains their owning turn after foreground completion", () => {
  const track = makePrimeSubagentTracker();
  const update = (status: string, error?: string) => ({
    sessionUpdate: "session_info_update",
    _meta: {
      "ai.primeintellect.prime-agent": {
        subagents: [{ id: "child-1", sessionName: "Review", status, ...(error ? { error } : {}) }],
      },
    },
  });
  const turnId = TurnId.make("parent-turn");
  const queued = track(update("queued"), turnId);
  assert.deepEqual(
    queued.map((event) => event.type),
    ["task.started", "task.progress"],
  );
  assert.equal(
    queued[1] && "status" in queued[1].payload ? queued[1].payload.status : undefined,
    "pending",
  );
  assert.deepEqual(track(update("queued"), turnId), []);
  const running = track(update("running"), turnId);
  assert.lengthOf(running, 1);
  assert.equal(
    running[0] && "status" in running[0].payload ? running[0].payload.status : undefined,
    "running",
  );
  // A foreground turn ending emits no child event. A later native child update
  // belongs to the original turn even while another foreground turn is active.
  const finished = track(update("done"), TurnId.make("next-turn"));
  assert.equal(finished[0]?.type, "task.completed");
  assert.equal(finished[0]?.turnId, turnId);
  assert.equal(
    finished[0] && "status" in finished[0].payload ? finished[0].payload.status : undefined,
    "completed",
  );
  assert.deepEqual(track(update("done")), []);
  assert.deepEqual(track(update("running")), []);
  for (const [native, expected] of [
    ["error", "failed"],
    ["cancelled", "stopped"],
  ]) {
    const events = makePrimeSubagentTracker()(update(native!, "Native failure"));
    assert.equal(
      events[1] && "status" in events[1].payload ? events[1].payload.status : undefined,
      expected,
    );
  }
  assert.deepEqual(track(update("future-status")), []);
  assert.deepEqual(track({ sessionUpdate: "session_info_update", _meta: {} }), []);
  assert.equal(makePrimeSubagentTracker()(update("running"))[0]?.type, "task.started");
});

primeAgentAdapterTestLayer("PrimeAgentAdapterLive", (it) => {
  it.effect("launches deterministic ACP sessions and maps prompt events and images", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const serverConfig = yield* ServerConfig;
        const tempDir = yield* Effect.promise(() =>
          NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "prime-agent-adapter-flow-")),
        );
        const argvLogPath = NodePath.join(tempDir, "argv.txt");
        const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
        yield* Effect.promise(() => NodeFSP.writeFile(requestLogPath, "", "utf8"));
        const wrapperPath = yield* Effect.promise(() =>
          makeProbeWrapper({ argvLogPath, requestLogPath }),
        );
        const instanceId = ProviderInstanceId.make("prime_work");
        const threadId = ThreadId.make("prime-agent-flow");
        const adapter = yield* makePrimeAgentAdapter(
          decodePrimeAgentSettings({ enabled: true, binaryPath: wrapperPath }),
          { instanceId },
        );
        const events: ProviderRuntimeEvent[] = [];
        const turnCompleted = yield* Deferred.make<void>();
        const eventFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
          Effect.gen(function* () {
            if (event.threadId !== threadId) return;
            events.push(event);
            if (event.type === "turn.completed") {
              yield* Deferred.succeed(turnCompleted, undefined).pipe(Effect.ignore);
            }
          }),
        ).pipe(Effect.forkChild);

        const session = yield* adapter.startSession({
          threadId,
          provider: ProviderDriverKind.make("primeAgent"),
          providerInstanceId: instanceId,
          cwd: process.cwd(),
          runtimeMode: "full-access",
          modelSelection: {
            instanceId,
            model: "openai/gpt-5.4",
            options: [{ id: "thinking", value: "high" }],
          },
        });
        assert.equal(session.provider, "primeAgent");
        assert.equal(session.providerInstanceId, instanceId);
        assert.deepStrictEqual(session.resumeCursor, { schemaVersion: 1 });
        assert.equal(adapter.capabilities.sessionModelSwitch, "unsupported");
        const modelChangeResult = yield* adapter
          .sendTurn({
            threadId,
            input: "switch model",
            modelSelection: { instanceId, model: "anthropic/claude-sonnet-4-6" },
          })
          .pipe(Effect.result);
        assert.equal(modelChangeResult._tag, "Failure");
        if (modelChangeResult._tag === "Failure") {
          assert.include(modelChangeResult.failure.message, "new thread");
        }

        const attachment = {
          type: "image" as const,
          id: "prime-image",
          name: "prime-image.png",
          mimeType: "image/png",
          sizeBytes: 4,
        };
        yield* Effect.promise(() =>
          NodeFSP.writeFile(
            NodePath.join(serverConfig.attachmentsDir, `${attachment.id}.png`),
            Buffer.from([1, 2, 3, 4]),
          ),
        );
        yield* adapter.sendTurn({
          threadId,
          input: "hello Prime",
          attachments: [attachment],
        });
        yield* Deferred.await(turnCompleted);

        assert.includeMembers(
          events.map((event) => event.type),
          [
            "session.started",
            "session.state.changed",
            "thread.started",
            "turn.started",
            "turn.plan.updated",
            "item.started",
            "content.delta",
            "item.completed",
            "turn.completed",
          ],
        );
        assert.isTrue(events.every((event) => event.providerInstanceId === instanceId));
        const delta = events.find((event) => event.type === "content.delta");
        assert.isDefined(delta);
        if (delta?.type === "content.delta") {
          assert.equal(delta.payload.streamKind, "assistant_text");
          assert.equal(delta.payload.delta, "hello from mock");
        }

        const sessionDir = NodePath.join(
          serverConfig.stateDir,
          "provider-sessions",
          "prime-agent",
          instanceId,
          `thread-${Buffer.from(threadId, "utf8").toString("base64url")}`,
        );
        const argv = yield* Effect.promise(() => readArgvLog(argvLogPath));
        assert.deepStrictEqual(argv[0], [
          "--mode",
          "acp",
          "--offline",
          "--cwd",
          process.cwd(),
          "--session-dir",
          sessionDir,
          "--model",
          "openai/gpt-5.4",
          "--thinking",
          "high",
        ]);

        const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
        const promptRequest = requests.find((entry) => entry.method === "session/prompt");
        const prompt = (promptRequest?.params as { readonly prompt?: ReadonlyArray<unknown> })
          ?.prompt;
        const imagePrompt = prompt?.find(
          (entry): entry is Record<string, unknown> =>
            typeof entry === "object" &&
            entry !== null &&
            "type" in entry &&
            entry.type === "image",
        );
        assert.deepInclude(imagePrompt, {
          type: "image",
          mimeType: "image/png",
          data: Buffer.from([1, 2, 3, 4]).toString("base64"),
        });

        const snapshot = yield* adapter.readThread(threadId);
        assert.lengthOf(snapshot.turns, 1);
        assert.lengthOf(yield* adapter.listSessions(), 1);
        assert.isTrue(yield* adapter.hasSession(threadId));
        assert.isFalse("supportsConversationRollback" in adapter.capabilities);
        assert.deepStrictEqual(adapter.compaction, { type: "slash-command", command: "/compact" });
        const rolledBack = yield* adapter.rollbackThread(threadId, 1);
        assert.lengthOf(rolledBack.turns, 0);
        assert.lengthOf((yield* adapter.readThread(threadId)).turns, 0);
        // Rewinding past the transcript start is a no-op, not an error.
        assert.lengthOf((yield* adapter.rollbackThread(threadId, 5)).turns, 0);
        const invalidRollback = yield* adapter.rollbackThread(threadId, 0).pipe(Effect.result);
        assert.equal(invalidRollback._tag, "Failure");
        if (invalidRollback._tag === "Failure") {
          assert.include(invalidRollback.failure.message, "numTurns must be an integer >= 1");
        }
        yield* adapter.stopSession(threadId);
        assert.isFalse(yield* adapter.hasSession(threadId));
        yield* Fiber.interrupt(eventFiber);
      }),
    ),
  );

  it.effect("reports the underlying prompt failure detail on turn completion", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const tempDir = yield* Effect.promise(() =>
          NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "prime-agent-adapter-failure-")),
        );
        const wrapperPath = yield* Effect.promise(() =>
          makeProbeWrapper({
            argvLogPath: NodePath.join(tempDir, "argv.txt"),
            extraEnv: { T3_ACP_FAIL_PROMPT: "1" },
          }),
        );
        const adapter = yield* makePrimeAgentAdapter(
          decodePrimeAgentSettings({ enabled: true, binaryPath: wrapperPath }),
        );
        const threadId = ThreadId.make("prime-agent-failure");
        const completed = yield* Deferred.make<ProviderRuntimeEvent>();
        yield* Stream.runForEach(adapter.streamEvents, (event) => {
          if (event.threadId !== threadId || event.type !== "turn.completed") return Effect.void;
          return Deferred.succeed(completed, event).pipe(Effect.ignore);
        }).pipe(Effect.forkChild);
        yield* adapter.startSession({
          threadId,
          provider: ProviderDriverKind.make("primeAgent"),
          cwd: process.cwd(),
          runtimeMode: "full-access",
        });
        const result = yield* adapter
          .sendTurn({ threadId, input: "fail please" })
          .pipe(Effect.result);
        assert.equal(result._tag, "Failure");
        const event = yield* Deferred.await(completed);
        assert.equal(event.type, "turn.completed");
        if (event.type === "turn.completed") {
          assert.equal(event.payload.state, "failed");
          assert.include(event.payload.errorMessage ?? "", "Mock prompt failure");
        }
        const session = (yield* adapter.listSessions())[0];
        assert.equal(session?.status, "error");
        assert.include(session?.lastError ?? "", "Mock prompt failure");
        yield* adapter.stopSession(threadId);
      }),
    ),
  );

  it.effect("maps native thought updates to reasoning text", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const tempDir = yield* Effect.promise(() =>
          NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "prime-agent-thought-")),
        );
        const wrapperPath = yield* Effect.promise(() =>
          makeProbeWrapper({
            argvLogPath: NodePath.join(tempDir, "argv.txt"),
            extraEnv: { T3_ACP_COMPLETE_FIRST_PROMPT_ON_CANCEL: "1" },
          }),
        );
        const adapter = yield* makePrimeAgentAdapter(
          decodePrimeAgentSettings({ enabled: true, binaryPath: wrapperPath }),
        );
        const threadId = ThreadId.make("prime-agent-thought");
        const toolStarted = yield* Deferred.make<void>();
        const thought = yield* Deferred.make<ProviderRuntimeEvent>();
        yield* Stream.runForEach(adapter.streamEvents, (event) => {
          if (event.threadId !== threadId) return Effect.void;
          if (event.type === "item.updated" && event.itemId === "native-cancel-tool")
            return Deferred.succeed(toolStarted, undefined).pipe(Effect.ignore);
          if (event.type === "content.delta")
            return Deferred.succeed(thought, event).pipe(Effect.ignore);
          return Effect.void;
        }).pipe(Effect.forkChild);
        yield* adapter.startSession({
          threadId,
          provider: ProviderDriverKind.make("primeAgent"),
          cwd: process.cwd(),
          runtimeMode: "full-access",
        });
        const prompt = yield* adapter.sendTurn({ threadId, input: "wait" }).pipe(Effect.forkChild);
        yield* Deferred.await(toolStarted);
        yield* adapter.interruptTurn(threadId);
        const event = yield* Deferred.await(thought);
        assert.equal(event.type, "content.delta");
        if (event.type === "content.delta") {
          assert.equal(event.payload.streamKind, "reasoning_text");
          assert.equal(event.payload.delta, "native-cancel-received");
        }
        yield* Fiber.interrupt(prompt);
        yield* adapter.stopSession(threadId);
      }),
    ),
  );

  it.effect("uses the same session directory and --continue for a versioned resume cursor", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const tempDir = yield* Effect.promise(() =>
          NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "prime-agent-adapter-resume-")),
        );
        const argvLogPath = NodePath.join(tempDir, "argv.txt");
        const wrapperPath = yield* Effect.promise(() => makeProbeWrapper({ argvLogPath }));
        const adapter = yield* makePrimeAgentAdapter(
          decodePrimeAgentSettings({ enabled: true, binaryPath: wrapperPath }),
        );
        const threadId = ThreadId.make("prime-agent-resume");
        const startInput = {
          threadId,
          provider: ProviderDriverKind.make("primeAgent"),
          cwd: process.cwd(),
          runtimeMode: "full-access" as const,
        };

        const first = yield* adapter.startSession(startInput);
        yield* adapter.stopSession(threadId);
        yield* adapter.startSession({
          ...startInput,
          resumeCursor: first.resumeCursor,
        });
        yield* adapter.stopSession(threadId);

        const argv = yield* Effect.promise(() => readArgvLog(argvLogPath));
        assert.lengthOf(argv, 2);
        assert.notInclude(argv[0] ?? [], "--continue");
        assert.include(argv[1] ?? [], "--continue");
        const firstSessionDirIndex = argv[0]?.indexOf("--session-dir") ?? -1;
        const secondSessionDirIndex = argv[1]?.indexOf("--session-dir") ?? -1;
        assert.equal(argv[0]?.[firstSessionDirIndex + 1], argv[1]?.[secondSessionDirIndex + 1]);
      }),
    ),
  );

  it.effect("rejects non-full-access runtime modes before spawning Prime Agent", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const adapter = yield* makePrimeAgentAdapter(
          decodePrimeAgentSettings({
            enabled: true,
            binaryPath: "/definitely/not/a/prime-agent",
          }),
        );
        const result = yield* adapter
          .startSession({
            threadId: ThreadId.make("prime-agent-invalid-runtime"),
            provider: ProviderDriverKind.make("primeAgent"),
            cwd: process.cwd(),
            runtimeMode: "approval-required",
          })
          .pipe(Effect.result);

        assert.equal(result._tag, "Failure");
        if (result._tag === "Failure") {
          assert.equal(result.failure._tag, "ProviderAdapterValidationError");
          assert.include(result.failure.message, "full-access");
        }
      }),
    ),
  );

  it.effect(
    "rejects overlapping sends without disturbing the active turn and settles interruption",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const tempDir = yield* Effect.promise(() =>
            NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "prime-agent-adapter-interrupt-")),
          );
          const wrapperPath = yield* Effect.promise(() =>
            makeProbeWrapper({
              argvLogPath: NodePath.join(tempDir, "argv.txt"),
              extraEnv: { T3_ACP_EMIT_XAI_PROMPT_COMPLETE_THEN_HANG: "1" },
            }),
          );
          const adapter = yield* makePrimeAgentAdapter(
            decodePrimeAgentSettings({ enabled: true, binaryPath: wrapperPath }),
          );
          const threadId = ThreadId.make("prime-agent-send-turn-interrupt");
          const contentDelta = yield* Deferred.make<void>();
          const turnCompleted = yield* Deferred.make<void>();
          const eventFiber = yield* Stream.runForEach(adapter.streamEvents, (event) => {
            if (event.threadId !== threadId) return Effect.void;
            if (event.type === "content.delta") {
              return Deferred.succeed(contentDelta, undefined).pipe(Effect.ignore);
            }
            if (event.type === "turn.completed") {
              return Deferred.succeed(turnCompleted, undefined).pipe(Effect.ignore);
            }
            return Effect.void;
          }).pipe(Effect.forkChild);

          yield* adapter.startSession({
            threadId,
            provider: ProviderDriverKind.make("primeAgent"),
            cwd: process.cwd(),
            runtimeMode: "full-access",
          });
          const sendTurnFiber = yield* adapter
            .sendTurn({ threadId, input: "interrupt me", attachments: [] })
            .pipe(Effect.forkChild);
          yield* Deferred.await(contentDelta);
          const runningSession = (yield* adapter.listSessions())[0];
          const overlap = yield* adapter
            .sendTurn({ threadId, input: "second message", attachments: [] })
            .pipe(Effect.result);
          assert.equal(overlap._tag, "Failure");
          if (overlap._tag === "Failure") {
            assert.include(overlap.failure.message, "already running a turn");
          }
          assert.deepStrictEqual((yield* adapter.listSessions())[0], runningSession);
          assert.equal(runningSession?.status, "running");
          yield* Fiber.interrupt(sendTurnFiber);
          yield* Deferred.await(turnCompleted);

          const session = (yield* adapter.listSessions())[0];
          assert.equal(session?.status, "ready");
          assert.isUndefined(session?.activeTurnId);

          yield* Fiber.interrupt(eventFiber);
          yield* adapter.stopSession(threadId);
        }),
      ),
  );

  it.effect("auto-approves standard permissions and cancels an active ACP prompt", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const tempDir = yield* Effect.promise(() =>
          NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "prime-agent-adapter-permission-")),
        );
        const permissionArgvLogPath = NodePath.join(tempDir, "permission-argv.txt");
        const permissionRequestLogPath = NodePath.join(tempDir, "permission-requests.ndjson");
        yield* Effect.promise(() => NodeFSP.writeFile(permissionRequestLogPath, "", "utf8"));
        const permissionWrapper = yield* Effect.promise(() =>
          makeProbeWrapper({
            argvLogPath: permissionArgvLogPath,
            requestLogPath: permissionRequestLogPath,
            extraEnv: { T3_ACP_EMIT_TOOL_CALLS: "1" },
          }),
        );
        const adapter = yield* makePrimeAgentAdapter(
          decodePrimeAgentSettings({ enabled: true, binaryPath: permissionWrapper }),
        );
        const permissionThread = ThreadId.make("prime-agent-permission");
        const permissionEvents: ProviderRuntimeEvent[] = [];
        const permissionEventFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
          Effect.sync(() => {
            if (event.threadId === permissionThread) permissionEvents.push(event);
          }),
        ).pipe(Effect.forkChild);

        yield* adapter.startSession({
          threadId: permissionThread,
          provider: ProviderDriverKind.make("primeAgent"),
          cwd: process.cwd(),
          runtimeMode: "full-access",
        });
        yield* adapter.sendTurn({
          threadId: permissionThread,
          input: "run a tool",
          attachments: [],
        });
        const permissionRequests = yield* Effect.promise(() =>
          readJsonLines(permissionRequestLogPath),
        );
        assert.isDefined(
          permissionRequests.find((entry) => {
            const result = entry.result as
              | { readonly outcome?: { readonly outcome?: string; readonly optionId?: string } }
              | undefined;
            return (
              result?.outcome?.outcome === "selected" && result.outcome.optionId === "allow-always"
            );
          }),
        );
        assert.notInclude(
          permissionEvents.map((event) => event.type),
          "request.opened",
        );
        yield* adapter.stopSession(permissionThread);
        yield* Fiber.interrupt(permissionEventFiber);

        const cancelArgvLogPath = NodePath.join(tempDir, "cancel-argv.txt");
        const cancelRequestLogPath = NodePath.join(tempDir, "cancel-requests.ndjson");
        yield* Effect.promise(() => NodeFSP.writeFile(cancelRequestLogPath, "", "utf8"));
        const cancelWrapper = yield* Effect.promise(() =>
          makeProbeWrapper({
            argvLogPath: cancelArgvLogPath,
            requestLogPath: cancelRequestLogPath,
            extraEnv: { T3_ACP_HANG_PROMPT_FOREVER: "1" },
          }),
        );
        const cancelAdapter = yield* makePrimeAgentAdapter(
          decodePrimeAgentSettings({ enabled: true, binaryPath: cancelWrapper }),
        );
        const cancelThread = ThreadId.make("prime-agent-cancel");
        const turnStarted = yield* Deferred.make<void>();
        const turnCompleted = yield* Deferred.make<void>();
        const cancelEventFiber = yield* Stream.runForEach(cancelAdapter.streamEvents, (event) =>
          Effect.gen(function* () {
            if (event.threadId !== cancelThread) return;
            if (event.type === "turn.started") {
              yield* Deferred.succeed(turnStarted, undefined).pipe(Effect.ignore);
            }
            if (event.type === "turn.completed") {
              yield* Deferred.succeed(turnCompleted, undefined).pipe(Effect.ignore);
            }
          }),
        ).pipe(Effect.forkChild);

        yield* cancelAdapter.startSession({
          threadId: cancelThread,
          provider: ProviderDriverKind.make("primeAgent"),
          cwd: process.cwd(),
          runtimeMode: "full-access",
        });
        const promptFiber = yield* cancelAdapter
          .sendTurn({ threadId: cancelThread, input: "wait", attachments: [] })
          .pipe(Effect.forkChild);
        yield* Deferred.await(turnStarted);
        yield* waitForJsonLogMethod(cancelRequestLogPath, "session/prompt");
        yield* cancelAdapter.interruptTurn(cancelThread);
        yield* Fiber.join(promptFiber);
        yield* Deferred.await(turnCompleted);
        yield* cancelAdapter.stopSession(cancelThread);
        yield* Fiber.interrupt(cancelEventFiber);
      }),
    ),
  );
});
