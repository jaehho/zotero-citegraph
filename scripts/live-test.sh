#!/usr/bin/env bash
# Run the in-Zotero feature suite against the real library (read-only + OpenAlex).
# Builds the current tree's XPI, installs it over the profile copy, then arms the
# one-shot suite. Zotero runs on a silent Hyprland workspace so the suite does
# not steal focus. Writes /tmp/citegraph-live-test.json. Exit 1 on any fail.
set -euo pipefail
ROOT=/home/jaeho/projects/zotero-citegraph
REPORT=/tmp/citegraph-live-test.json
ARM=/tmp/citegraph-armed
PROFILE=$(echo "$HOME"/.zotero/zotero/*.default*)
ID=$(jq -r .applications.zotero.id "$ROOT/addon/manifest.json")
RULE_NAME=citegraph-live-silent

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

# Zotero must be down to replace the XPI and flip the sentinel
if pgrep -x zotero-bin >/dev/null; then
  pgrep -x zotero-bin | xargs -r kill
  for _ in $(seq 1 20); do pgrep -x zotero-bin >/dev/null || break; sleep 0.5; done
fi

# Test what we ship: rebuild and install the working-tree XPI. Overwriting the
# registered filename keeps the existing plugin-manager entry valid.
echo "building and installing current tree XPI…"
make -C "$ROOT" xpi >/dev/null
XPI=$(ls -t "$ROOT"/build/zotero-citegraph-*.xpi | head -1)
rm -f "$PROFILE/extensions/$ID" "$PROFILE/extensions/$ID.xpi"
cp "$XPI" "$PROFILE/extensions/$ID.xpi"
sed -i '/extensions\.lastAppBuildId\|extensions\.lastAppVersion/d' "$PROFILE/prefs.js"

rm -f "$REPORT"
# one-shot sentinel — the plugin consumes and deletes it (prefs stick and leak)
: >"$ARM"

cleanup() {
  rm -f "$ARM"
  sed -i "/zotero-citegraph\.selftest/d" "$PROFILE/user.js" "$PROFILE/prefs.js" 2>/dev/null || true
  # Drop the silent-workspace rule so the next real Zotero is normal, then stop
  # the hidden test instance (a leftover silent Zotero would block single-instance).
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
  if pgrep -x zotero-bin >/dev/null 2>&1; then
    pkill -x zotero-bin 2>/dev/null || true
    for _ in $(seq 1 20); do
      pgrep -x zotero-bin >/dev/null 2>&1 || break
      sleep 0.2
    done
    pkill -9 -x zotero-bin 2>/dev/null || true
    pkill -x zotero 2>/dev/null || true
  fi
}
trap cleanup EXIT

echo "starting Zotero for live tests…$([[ $have_hypr == 1 ]] && echo ' (silent workspace)' || echo ' (no hyprctl — may steal focus)')"
zotero -purgecaches >/tmp/citegraph-live-zotero.log 2>&1 &
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
  # Confirm the silent-workspace rule took (once the window exists)
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
