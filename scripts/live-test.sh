#!/usr/bin/env bash
# Run the in-Zotero feature suite against the real library (read-only + OpenAlex).
# Writes /tmp/citegraph-live-test.json and prints a summary. Exit 1 on any fail.
set -euo pipefail
ROOT=/home/jaeho/projects/zotero-citegraph
REPORT=/tmp/citegraph-live-test.json
PROFILE=$(echo "$HOME"/.zotero/zotero/*.default*)
PREF=extensions.zotero-citegraph.selftest

# Zotero must be down to flip the pref and pick up source
if pgrep -x zotero-bin >/dev/null; then
  pgrep -x zotero-bin | xargs -r kill
  for _ in $(seq 1 20); do pgrep -x zotero-bin >/dev/null || break; sleep 0.5; done
fi

rm -f "$REPORT"
# turn the suite on (user.js wins over prefs.js until first run rewrites)
echo "user_pref(\"$PREF\", true);" >>"$PROFILE/user.js"

cleanup() {
  # strip the one-shot pref from BOTH files — Zotero copies user.js → prefs.js
  # and a leftover true auto-opens the Chiappe graph on every launch.
  sed -i "/$PREF/d" "$PROFILE/user.js" "$PROFILE/prefs.js" 2>/dev/null || true
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
