# Carson's Muse + Prime Agent fork

This fork adds two providers to upstream T3 Code:

- **Muse Code**, from Cristian Uibar's upstream PR [#11392](https://github.com/pingdotgg/t3code/pull/11392), plus local fixes.
- **Prime Agent**, adapted from upstream PR [#7291](https://github.com/pingdotgg/t3code/pull/7291). Also see [#13670](https://github.com/pingdotgg/t3code/pull/13670) and [#13801](https://github.com/pingdotgg/t3code/pull/13801) (ACP registry agents).

Everything else follows upstream `AGENTS.md`.

## Branches and remotes

- `carson/muse-local` is the branch you build and run. It tracks `carson/carson/muse-local`.
- `origin` is `pingdotgg/t3code`. `carson` is `carson-olaf/t3code`.
- Upstream is merged in, not rebased. Each merge needs one conflict resolution, and `git rerere` replays it on later merges.

## Updating

```bash
scripts/fork/sync.sh --status   # drift report: upstream lag, installed build, Muse SDK/CLI, Prime CLI
scripts/fork/sync.sh            # merge upstream, install, typecheck, test, build, install the app
```

The script installs one app, `/Applications/T3 Code (Muse + Prime).app`. The previous build goes to the Trash for rollback. Local builds have no update feed (`app-update.yml`). They never auto-update, and upstream releases cannot overwrite them.

If the merge conflicts, the script stops with exit code 2 and lists the files. After you resolve them, commit and rerun with `--no-merge`.

## Things that break on upstream merges

- **Effect API renames.** Upstream upgrades Effect release candidates in place. Fork code that uses a renamed API fails at module load, not only in the typechecker. Examples: `Schema.TaggedErrorClass` became `Schema.TaggedError`, and `FileSystem.Size` became `ByteSize.bytes`. Use the upstream upgrade commit's diff as the rename map.
- **Thread snapshot cache versions.** The web (`apps/web/src/connection/storage.ts`) and mobile (`apps/mobile/src/connection/environment-cache-store.ts`) caches carry a schema version. The fork is at v5 because the fork and upstream each used v4 for different fixes. If upstream bumps the version again, pick a number higher than both.
- **Provider order.** `apps/web/src/components/settings/providerDriverMeta.ts` keeps the fork providers after upstream's providers. Settings auto-selects the first row, and upstream tests expect that row to be Codex.
- **Parallel typecheck.** Runs with parallel `tsc` can be killed for lack of memory (exit 137), and the run summary can then show a false pass. The sync script runs checks one at a time.

## Provider runtimes

- Muse: `@muse-code/sdk` is pinned in `apps/server/package.json`. Read the SDK changelog before you bump it. A schema fingerprint mismatch with a newer `muse` CLI only gives a warning.
- Prime Agent: T3 updates the CLI through `prime-agent update` (Settings → Providers).
