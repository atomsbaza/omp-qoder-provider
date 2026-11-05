#!/usr/bin/env bash
# Install/uninstall the omp qoder-provider extension.
#
# Usage:
#   ./install.sh            install to ~/.omp/agent/extensions
#   ./install.sh --uninstall
#
# Overrides:
#   OMP_EXTENSIONS_DIR      target extensions directory
#                           (named omp profiles use ~/.omp/profiles/<name>/agent/extensions)
#   QODER_BIN               qodercli binary to check (default "qodercli")
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXT_FILE="$SCRIPT_DIR/qoder-provider.ts"
TARGET_DIR="${OMP_EXTENSIONS_DIR:-$HOME/.omp/agent/extensions}"
TARGET="$TARGET_DIR/qoder-provider.ts"
QODER_BIN="${QODER_BIN:-qodercli}"

if [[ ! -f "$EXT_FILE" ]]; then
	echo "error: qoder-provider.ts not found next to install.sh" >&2
	exit 1
fi

if [[ "${1:-}" == "--uninstall" ]]; then
	if [[ -f "$TARGET" ]]; then
		rm "$TARGET"
		echo "removed $TARGET"
	else
		echo "not installed: $TARGET"
	fi
	exit 0
fi

have_bin=false
if command -v "$QODER_BIN" >/dev/null 2>&1; then
	have_bin=true
	echo "qodercli: found at $(command -v "$QODER_BIN") ($("$QODER_BIN" --version 2>/dev/null || echo 'version unknown'))"
else
	echo "warning: '$QODER_BIN' not on PATH — the extension loads but every request will fail until you install Qoder CLI and run 'qodercli login'" >&2
fi

mkdir -p "$TARGET_DIR"
cp -f "$EXT_FILE" "$TARGET"
echo "installed: $TARGET"

cat <<'EOF'

Next steps:
  1. Sign in once if you have not:  qodercli login
  2. Restart any running omp session, then pick a model:
       /model qoder/auto
     or run headless:
       omp -p --model qoder/auto "Reply with exactly: PONG"

Optional knobs (environment variables):
  QODER_BRIDGE_BIN              qodercli binary path      (default: qodercli)
  QODER_BRIDGE_PERMISSION_MODE  child permission mode     (default: dont_ask;
                                use accept_edits to let the child edit files)
  QODER_BRIDGE_LOG              append spawn/result diagnostics to a file
EOF

if [[ "$have_bin" == true ]]; then
	echo
	echo "Smoke test (bills a few Qoder credits):"
	echo "  omp -p --model qoder/auto \"Reply with exactly: PONG\""
fi
