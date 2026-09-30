#!/usr/bin/env bash
# Keep Carson's Muse + Prime Agent fork current with upstream T3 Code.
#
#   scripts/fork/sync.sh --status   report drift only; changes nothing
#   scripts/fork/sync.sh            merge upstream, install, typecheck, test, build, install app
#
# Options:
#   --no-merge     skip fetching and merging upstream (rebuild the current commit)
#   --no-tests     skip the test suite (typecheck still runs)
#   --no-build     stop after checks
#   --no-install   build, but leave the app in release/
#   --push         push the branch to the `carson` remote when everything passes
#
# Exit codes: 0 ok, 1 failure, 2 merge conflicts need resolving by hand or by an agent.
set -euo pipefail

UPSTREAM_REMOTE="origin"
UPSTREAM_BRANCH="main"
FORK_REMOTE="carson"
APP_NAME="T3 Code (Muse + Prime)"
APP_PATH="/Applications/${APP_NAME}.app"

status_only=false merge=true tests=true build=true install=true push=false
for arg in "$@"; do
  case "$arg" in
    --status) status_only=true ;;
    --no-merge) merge=false ;;
    --no-tests) tests=false ;;
    --no-build) build=false install=false ;;
    --no-install) install=false ;;
    --push) push=true ;;
    -h | --help) sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 1 ;;
  esac
done

repo_root="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
cd "$repo_root"
branch="$(git branch --show-current)"
log() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

# The repo requires Node 24; the login shell may default to an older nvm version.
use_node_24() {
  if [[ "$(node -v 2>/dev/null)" == v24.* ]]; then return; fi
  local candidate
  candidate="$(ls -d "${NVM_DIR:-$HOME/.nvm}"/versions/node/v24.* 2>/dev/null | sort -V | tail -1 || true)"
  if [[ -z "$candidate" ]]; then
    echo "Node 24 is required (engines: ^24.13.1). Install it with: nvm install 24" >&2
    exit 1
  fi
  export PATH="$candidate/bin:$PATH"
}

pinned_muse_sdk() {
  node -p 'require("./apps/server/package.json").dependencies["@muse-code/sdk"]' 2>/dev/null || echo "?"
}

report_status() {
  git fetch --quiet "$UPSTREAM_REMOTE" "$UPSTREAM_BRANCH"
  local behind ahead
  read -r behind ahead < <(git rev-list --left-right --count "$UPSTREAM_REMOTE/$UPSTREAM_BRANCH...HEAD")
  echo "branch:          $branch ($ahead commits not in upstream, $behind upstream commits missing)"
  echo "upstream:        $(git log -1 --format='%h %cs %s' "$UPSTREAM_REMOTE/$UPSTREAM_BRANCH")"
  if [[ -d "$APP_PATH" ]]; then
    echo "installed app:   $(defaults read "$APP_PATH/Contents/Info" CFBundleShortVersionString 2>/dev/null || echo '?')"
  else
    echo "installed app:   (missing) $APP_PATH"
  fi
  echo "muse sdk:        pinned $(pinned_muse_sdk), npm latest $(npm view @muse-code/sdk version 2>/dev/null || echo '?')"
  echo "muse cli:        $(muse --version 2>/dev/null | head -1 || echo 'not on PATH')"
  echo "prime-agent cli: $(prime-agent --version 2>/dev/null | head -1 || echo 'not on PATH')"
}

use_node_24
# Build scripts shell out to repo tools such as `vp`, which are not installed globally.
export PATH="$repo_root/node_modules/.bin:$PATH"

if $status_only; then
  report_status
  exit 0
fi

if [[ -n "$(git status --porcelain)" ]]; then
  echo "Working tree is dirty; commit or stash first." >&2
  exit 1
fi

if $merge; then
  log "Merging $UPSTREAM_REMOTE/$UPSTREAM_BRANCH into $branch"
  git config rerere.enabled true
  git fetch --quiet "$UPSTREAM_REMOTE" "$UPSTREAM_BRANCH"
  if ! git merge --no-edit "$UPSTREAM_REMOTE/$UPSTREAM_BRANCH"; then
    # rerere may already have replayed earlier resolutions; only real leftovers block.
    if [[ -n "$(git diff --name-only --diff-filter=U)" ]]; then
      echo
      echo "Resolve these conflicts, commit the merge, then rerun with --no-merge:"
      git diff --name-only --diff-filter=U | sed 's/^/  /'
      echo "Lockfile conflicts: git checkout --theirs pnpm-lock.yaml && pnpm install"
      exit 2
    fi
    git commit --no-edit
  fi
fi

log "Installing dependencies"
pnpm install
if [[ -n "$(git status --porcelain pnpm-lock.yaml)" ]]; then
  git commit --quiet -m "chore: refresh lockfile after upstream sync" pnpm-lock.yaml
fi

# Serial runs: parallel tsc and vitest workers exhaust memory on this monorepo and
# a killed task can look like a pass in the summary.
log "Typechecking"
pnpm exec vp run -r --concurrency-limit 1 typecheck

if $tests; then
  log "Testing"
  pnpm exec vp run -r --concurrency-limit 1 test
fi

if $build; then
  upstream_version="$(node -p 'require("./apps/desktop/package.json").version')"
  version="${upstream_version}-muse-prime.$(date +%Y%m%d%H%M)"
  output_dir="$repo_root/release/fork-$version"
  log "Building $version"
  node scripts/build-desktop-artifact.ts --platform mac --target dmg --arch arm64 \
    --build-version "$version" --output-dir "$output_dir"
  built_zip="$(ls "$output_dir"/*.zip | head -1)"
  echo "Built: $built_zip"

  if $install; then
    log "Installing $APP_PATH"
    # Fixed-string match: the "+" in the app name is a regex quantifier to pgrep.
    if ps -Ao command | grep -F "$APP_PATH/Contents/MacOS/" | grep -vq grep; then
      echo "$APP_NAME is running. Quit it (running agent turns stop), then rerun with --no-merge." >&2
      exit 1
    fi
    staging="$(mktemp -d)"
    ditto -x -k "$built_zip" "$staging"
    built_app="$(ls -d "$staging"/*.app | head -1)"
    # Local builds are ad-hoc signed, so macOS treats every build as a new app and
    # asks again for keychain and folder access. A stable signing identity keeps
    # those grants across updates. Override with FORK_SIGN_IDENTITY=- for ad-hoc.
    sign_identity="${FORK_SIGN_IDENTITY:-$(security find-identity -v -p codesigning |
      sed -n 's/.*"\(Apple Development: [^"]*\)".*/\1/p' | head -1)}"
    if [[ -n "$sign_identity" && "$sign_identity" != "-" ]]; then
      codesign --force --deep --sign "$sign_identity" "$built_app"
      codesign --verify --deep --strict "$built_app"
      echo "Signed with $sign_identity"
    fi
    if [[ -d "$APP_PATH" ]]; then
      # Keep the previous build in the Trash so a bad build is one drag away from rollback.
      mv "$APP_PATH" "$HOME/.Trash/${APP_NAME} $(date +%Y%m%d-%H%M%S).app"
    fi
    mv "$built_app" "$APP_PATH"
    rm -rf "$staging"
    echo "Installed $(defaults read "$APP_PATH/Contents/Info" CFBundleShortVersionString)"
  fi
fi

if $push; then
  log "Pushing $branch to $FORK_REMOTE"
  git push "$FORK_REMOTE" "HEAD:$branch"
fi

log "Done"
report_status
