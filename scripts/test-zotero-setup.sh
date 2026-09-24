#!/usr/bin/env bash
# Build/refresh an isolated Zotero profile+data copy for live tests.
# Storage/ PDFs are hardlinked from the real library (no 1.1G duplicate);
# sqlite is always a real copy so the two instances never share a database.
#
#   scripts/test-zotero-setup.sh          # create or refresh
#   scripts/test-zotero-setup.sh --fresh  # wipe and rebuild
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REAL_DATA=/home/jaeho/Zotero
TEST_ROOT="${CITEGRAPH_TEST_ROOT:-$HOME/.local/share/citegraph-test}"
DATA="$TEST_ROOT/data"
PROFILE="$TEST_ROOT/profile"
ID=$(jq -r .applications.zotero.id "$ROOT/addon/manifest.json")

if [[ "${1:-}" == "--fresh" ]]; then
  echo "wiping $TEST_ROOT"
  rm -rf "$TEST_ROOT"
fi

if pgrep -x zotero-bin >/dev/null 2>&1; then
  echo "zotero is running — quit it (or stop the real instance) so the sqlite copy is consistent" >&2
  echo "test instances use their own profile/data and do not need the real one down." >&2
  echo "refusing to copy a live database." >&2
  exit 1
fi

echo "test root: $TEST_ROOT"
mkdir -p "$PROFILE/extensions" "$DATA"

# 1) databases — real copies (never share inodes with the live library)
for db in zotero.sqlite fulltext.sqlite; do
  if [[ -f "$REAL_DATA/$db" ]]; then
    cp -a "$REAL_DATA/$db" "$DATA/$db"
  fi
done
# discard any leftover WAL from a hardlink era
rm -f "$DATA"/zotero.sqlite-wal "$DATA"/zotero.sqlite-shm "$DATA"/zotero.sqlite.tmp-wal

# 2) bulky trees — hardlink where possible (ext4: same filesystem required)
for dir in storage styles translators locate; do
  [[ -d "$REAL_DATA/$dir" ]] || continue
  if [[ -e "$DATA/$dir" ]]; then
    # refresh: pick up newly added files via hardlink; do not delete user-side
    # files the test copy already has (hardlinks share content anyway)
    cp -aln "$REAL_DATA/$dir/." "$DATA/$dir/" 2>/dev/null || true
  else
    cp -al "$REAL_DATA/$dir" "$DATA/$dir" 2>/dev/null || cp -a "$REAL_DATA/$dir" "$DATA/$dir"
  fi
done

# 3) plugin cache / misc — real copies, cheap
for extra in citegraph zotero-citation-graph logs; do
  [[ -e "$REAL_DATA/$extra" ]] || continue
  rm -rf "$DATA/$extra"
  cp -a "$REAL_DATA/$extra" "$DATA/$extra"
done

# 4) profile prefs (throwaway; never the real ~/.zotero profile)
cat >"$PROFILE/user.js" <<EOF
user_pref("extensions.autoDisableScopes", 0);
user_pref("extensions.startupScanScopes", 15);
user_pref("extensions.zotero.dataDir", "$DATA");
user_pref("extensions.zotero.useDataDir", true);
user_pref("extensions.zotero.citegraph.selftest", false);
EOF

# 5) install the working-tree XPI into the test profile only
make -C "$ROOT" xpi >/dev/null
XPI=$(ls -t "$ROOT"/build/zotero-citegraph-*.xpi | head -1)
cp "$XPI" "$PROFILE/extensions/$ID.xpi"
echo "installed $(basename "$XPI") → $PROFILE/extensions/$ID.xpi"

# how much is real disk vs shared
echo "data dir:"
du -sh "$DATA" 2>/dev/null || true
echo "test profile ready. launch with:"
echo "  zotero -profile $PROFILE -datadir $DATA -no-remote"
