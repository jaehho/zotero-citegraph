#!/usr/bin/env bash
# Run the in-Zotero feature suite against an isolated copy of the real library.
# Never touches the user's profile, installed plugin, or running Zotero.
#
#   scripts/test-zotero-setup.sh   # create/refresh the copy (once, and after big library changes)
#
# Builds the current tree's XPI into the test profile, arms the one-shot suite,
# launches on a silent Hyprland workspace (no focus steal). Writes
# /tmp/citegraph-live-test.json. Exit 1 on any fail.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPORT=/tmp/citegraph-live-test.json
ARM=/tmp/citegraph-armed
TEST_ROOT="${CITEGRAPH_TEST_ROOT:-$HOME/.local/share/citegraph-test}"
DATA="$TEST_ROOT/data"
PROFILE="$TEST_ROOT/profile"
ID=$(jq -r .applications.zotero.id "$ROOT/addon/manifest.json")
RULE_NAME=citegraph-live-silent

if [[ ! -f "$DATA/zotero.sqlite" || ! -f "$PROFILE/user.js" ]]; then
  echo "test Zotero env missing — running scripts/test-zotero-setup.sh"
  "$ROOT/scripts/test-zotero-setup.sh"
fi

# Hyprland: park the test Zotero on a silent workspace (no focus, still renders).
# grim cannot see hidden workspaces; the suite captures via canvas.toDataURL.
have_hypr=0
if [[ -n "${HYPRLAND_INSTANCE_SIGNATURE:-}" ]] && command -v hyprctl >/dev/null; then
  have_hypr=1
  hyprctl eval "
    hl.window_rule({
      name = '${RULE_NAME}',
      match = { class = 'Zotero' },
      workspace = 'name:citegraph-live silent',
      no_initial_focus = true,
      render_unfocused = true,
    })
  " >/dev/null 2>&1 || have_hypr=0
fi

# Test what we ship: rebuild and install into the TEST profile only.
echo "building and installing current tree XPI into test profile…"
make -C "$ROOT" xpi >/dev/null
XPI=$(ls -t "$ROOT"/build/zotero-citegraph-*.xpi | head -1)
cp "$XPI" "$PROFILE/extensions/$ID.xpi"

rm -f "$REPORT"
# one-shot sentinel — the plugin consumes and deletes it (prefs stick and leak)
: >"$ARM"

cleanup() {
  rm -f "$ARM"
  # Drop the silent-workspace rule and stop only the TEST instance.
  if [[ "$have_hypr" == 1 ]]; then
    hyprctl eval "
      hl.window_rule({
        name = '${RULE_NAME}',
        match = { class = 'NoSuchClassXYZ' },
        workspace = 'current',
        no_initial_focus = true,
        render_unfocused = true,
      })
    " >/dev/null 2>&1 || true
  fi
  # Kill by profile command-line match, not by name — the user's real Zotero
  # (if running) uses a different -profile and must survive.
  local pids
  pids=$(pgrep -f "zotero.*-profile ${PROFILE}" 2>/dev/null || true)
  if [[ -n "$pids" ]]; then
    # shellcheck disable=SC2086
    kill $pids 2>/dev/null || true
    for _ in $(seq 1 20); do
      pgrep -f "zotero.*-profile ${PROFILE}" >/dev/null 2>&1 || break
      sleep 0.2
    done
    pids=$(pgrep -f "zotero.*-profile ${PROFILE}" 2>/dev/null || true)
    # shellcheck disable=SC2086
    [[ -n "$pids" ]] && kill -9 $pids 2>/dev/null || true
  fi
}
trap cleanup EXIT

echo "starting test Zotero on silent workspace (real Zotero left alone)…"
# -no-remote: second instance; does not signal the user's Zotero.
zotero -profile "$PROFILE" -datadir "$DATA" -no-remote -purgecaches \
  >/tmp/citegraph-live-zotero.log 2>&1 &
ZPID=$!

for i in $(seq 1 60); do
  if [[ -f "$REPORT" ]]; then
    break
  fi
  if ! kill -0 $ZPID 2>/dev/null && [[ ! -f "$REPORT" ]]; then
    echo "Zotero exited before writing $REPORT"
    tail -40 /tmp/citegraph-live-zotero.log || true
    exit 1
  fi
  if [[ $have_hypr == 1 && $i == 4 ]]; then
    ws=$(hyprctl clients -j 2>/dev/null | jq -r '.[] | select(.class=="Zotero") | .workspace.name' | head -1)
    echo "Zotero workspace: ${ws:-not-yet}"
  fi
  sleep 1
done

if [[ ! -f "$REPORT" ]]; then
  echo "timeout waiting for $REPORT"
  tail -40 /tmp/citegraph-live-zotero.log || true
  exit 1
fi

python3 - <<'PY'
import json, sys
r = json.load(open("/tmp/citegraph-live-test.json"))
print(f"{r['passed']} passed, {len(r['failed'])} failed  ({r['at']})")
for c in r["checks"]:
    mark = "ok  " if c["pass"] else "FAIL"
    print(f"  {mark} {c['name']}" + (f"  — {c['detail']}" if c["detail"] else ""))
if r["failed"]:
    print("\nfailed:")
    for f in r["failed"]:
        print(" ", f)
    sys.exit(1)
print("ALL FEATURES OK")
PY
