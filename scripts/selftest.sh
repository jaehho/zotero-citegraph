#!/usr/bin/env bash
# Smoke-open Zotero with a throwaway profile. Never touches the real library.
set -euo pipefail
ROOT=/tmp/citegraph-selftest
rm -rf "$ROOT"
mkdir -p "$ROOT/profile/extensions" "$ROOT/data"
XPI=$(ls "$(dirname "$0")/../build"/zotero-citegraph-*.xpi | tail -1)
cp "$XPI" "$ROOT/profile/extensions/citegraph@jaeho.dev.xpi"
cat > "$ROOT/profile/user.js" <<'EOF'
user_pref("extensions.autoDisableScopes", 0);
user_pref("extensions.startupScanScopes", 15);
user_pref("extensions.zotero.dataDir", "/tmp/citegraph-selftest/data");
user_pref("extensions.zotero.useDataDir", true);
EOF
echo "Launching throwaway Zotero (profile $ROOT/profile)."
echo "Right-click any collection → Show Citation Graph."
echo "Close the window when done. Real library is not loaded."
zotero -profile "$ROOT/profile" -datadir "$ROOT/data" -no-remote
