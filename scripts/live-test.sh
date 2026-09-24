#!/usr/bin/env bash
# Run the in-Zotero feature suite against the real library (read-only + OpenAlex).
# Builds the current tree's XPI, installs it over the profile copy, then arms the
# one-shot suite. Writes /tmp/citegraph-live-test.json. Exit 1 on any fail.
set -euo pipefail
ROOT=/home/jaeho/projects/zotero-citegraph
REPORT=/tmp/citegraph-live-test.json
ARM=/tmp/citegraph-armed
PROFILE=$(echo "$HOME"/.zotero/zotero/*.default*)
ID=$(jq -r .applications.zotero.id "$ROOT/addon/manifest.json")

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
}
trap cleanup EXIT

echo "starting Zotero for live tests…"
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
