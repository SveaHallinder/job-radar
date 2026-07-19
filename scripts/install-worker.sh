#!/bin/bash
# Installs the Job Radar sync worker as a macOS launchd LaunchAgent so it runs
# invisibly in the background, starts on login, and restarts if it crashes.
# Run once, from the project root:  bash scripts/install-worker.sh
set -euo pipefail

LABEL="com.jobradar.worker"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

# Resolve absolute paths so the agent never depends on a shell PATH / nvm setup.
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
NODE_BIN="$(command -v node || true)"
TSX_CLI="$PROJECT_DIR/node_modules/tsx/dist/cli.mjs"

if [ -z "$NODE_BIN" ]; then
  echo "❌ node not found on PATH. Install Node 20+ and re-run." >&2
  exit 1
fi
if [ ! -f "$TSX_CLI" ]; then
  echo "❌ $TSX_CLI missing. Run 'npm install' in $PROJECT_DIR first." >&2
  exit 1
fi
if [ ! -f "$PROJECT_DIR/.env.local" ]; then
  echo "⚠️  No .env.local in $PROJECT_DIR — the worker needs DATABASE_URL and the"
  echo "    LinkedIn/browser vars. See WORKER.md. Continuing to install anyway."
fi

NODE_DIR="$(dirname "$NODE_BIN")"
mkdir -p "$HOME/Library/LaunchAgents" "$PROJECT_DIR/.data"

cat > "$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$TSX_CLI</string>
    <string>$PROJECT_DIR/scripts/worker.ts</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$PROJECT_DIR</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>$NODE_DIR:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$PROJECT_DIR/.data/worker.log</string>
  <key>StandardErrorPath</key>
  <string>$PROJECT_DIR/.data/worker.log</string>
</dict>
</plist>
PLISTEOF

# Reload cleanly if it was already installed.
launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"

echo "✅ Installed and started $LABEL"
echo "   plist:  $PLIST"
echo "   logs:   $PROJECT_DIR/.data/worker.log"
echo
echo "   Status:  launchctl list | grep jobradar"
echo "   Stop:    bash scripts/uninstall-worker.sh"
