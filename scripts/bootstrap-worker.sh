#!/bin/bash
# Job Radar — one-shot setup for the LinkedIn sync worker.
#
# Turns the whole WORKER.md checklist into a single run. Safe to re-run: it
# updates an existing checkout instead of failing.
#
# Two ways to use it:
#   1) One-liner (paste in Terminal):
#        curl -fsSL https://raw.githubusercontent.com/SveaHallinder/job-radar/main/scripts/bootstrap-worker.sh | bash
#   2) Double-click: save this file as "Setup Job Radar.command", then double-click it.
#
# It will prompt for the two values it can't guess (the Neon database URL and the
# LinkedIn search URL). You can also pre-set them so it runs unattended:
#   DATABASE_URL="postgres://..." LINKEDIN_SEARCH_URLS="https://www.linkedin.com/jobs/search/?..." bash bootstrap-worker.sh
set -euo pipefail

REPO="https://github.com/SveaHallinder/job-radar.git"
TARGET_DIR="${JOB_RADAR_DIR:-$HOME/job-radar}"

say() { printf "\n\033[1;34m▶ %s\033[0m\n" "$1"; }
die() { printf "\n\033[1;31m❌ %s\033[0m\n" "$1" >&2; exit 1; }

# --- 0. Prerequisites -------------------------------------------------------
command -v git >/dev/null 2>&1 || die "git saknas. Installera Xcode Command Line Tools: kör 'xcode-select --install' och försök igen."
if ! command -v node >/dev/null 2>&1; then
  die "Node.js saknas. Installera Node 20+ från https://nodejs.org (LTS) och kör detta igen."
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] || die "Node $NODE_MAJOR är för gammal. Installera Node 20+ från https://nodejs.org."

# --- 1. Code ----------------------------------------------------------------
if [ -d "$TARGET_DIR/.git" ]; then
  say "Uppdaterar befintlig kopia i $TARGET_DIR"
  git -C "$TARGET_DIR" pull --ff-only
else
  say "Hämtar koden till $TARGET_DIR"
  git clone "$REPO" "$TARGET_DIR"
fi
cd "$TARGET_DIR"

# --- 2. Dependencies --------------------------------------------------------
say "Installerar beroenden (kan ta någon minut)"
npm install
say "Installerar Chromium för LinkedIn"
npx playwright install chromium

# --- 3. Configuration -------------------------------------------------------
if [ ! -f .env.local ]; then
  say "Konfiguration"
  DB_URL="${DATABASE_URL:-}"
  if [ -z "$DB_URL" ]; then
    printf "Klistra in Neon DATABASE_URL (fråga Svea): "
    read -r DB_URL
  fi
  [ -n "$DB_URL" ] || die "DATABASE_URL krävs."
  # Search terms are managed on the website ("Sökprofiler"), so no LinkedIn URL
  # is needed here. LINKEDIN_SEARCH_URLS can be set later as a fallback if wanted.
  cat > .env.local <<ENVEOF
DATABASE_URL=$DB_URL
JOB_RADAR_BROWSER_DISCOVERY=1
LINKEDIN_BOOTSTRAP_MAX_RESULTS=200
LINKEDIN_INCREMENTAL_MAX_RESULTS=100
LINKEDIN_MAX_DETAILS=80
ENVEOF
  echo "  Skrev .env.local — lägg till sökord på sajten under \"Sökprofiler\"."
else
  say ".env.local finns redan — behåller den"
fi

# --- 4. LinkedIn login (the one manual step) --------------------------------
say "Loggar in på LinkedIn — ett Chromium-fönster öppnas."
echo "   Logga in, lös ev. verifiering, kom sedan tillbaka hit och tryck Enter."
npm run linkedin:login

# --- 5. Install the background worker ---------------------------------------
say "Installerar bakgrundstjänsten (startar automatiskt, syns inte)"
bash scripts/install-worker.sh

printf "\n\033[1;32m🎉 Klart! Datorn kör nu LinkedIn-synk när någon klickar på knappen på sajten.\033[0m\n"
echo "   Loggar:  tail -f \"$TARGET_DIR/.data/worker.log\""
echo "   Stoppa:  bash \"$TARGET_DIR/scripts/uninstall-worker.sh\""
