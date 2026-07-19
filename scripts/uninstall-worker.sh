#!/bin/bash
# Stops and removes the Job Radar sync worker LaunchAgent.
set -euo pipefail

LABEL="com.jobradar.worker"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

if [ -f "$PLIST" ]; then
  launchctl unload "$PLIST" 2>/dev/null || true
  rm -f "$PLIST"
  echo "✅ Removed $LABEL"
else
  echo "ℹ️  $LABEL is not installed (no plist at $PLIST)"
fi
