# Job Radar — LinkedIn sync worker (local machine)

The hosted site on Vercel can run JobTech, Arbeitnow and Jooble on its own, but it
**cannot** run LinkedIn: LinkedIn needs a real logged-in browser on a normal home
internet connection, which a serverless host doesn't have (and a datacenter IP would
get blocked and risk the account).

So LinkedIn runs on **one always-on machine at home**. This worker:

1. Watches the shared Neon database for LinkedIn sync requests.
2. When someone clicks **"Synka LinkedIn via min dator"** on the website, a request
   row is created.
3. The worker picks it up (next time the machine is awake), runs the full sync
   including LinkedIn using the saved browser session, and writes the jobs straight
   into the same database the website reads from.

The person clicking the button can be anywhere. The only requirement is that this
machine is **on, awake, and logged into LinkedIn** at some point after the click.

---

## One-time setup on the machine that will run LinkedIn

Use whichever machine will be left on (a laptop that's on daily is fine — the worker
catches up the next time it's awake).

### 1. Get the code and dependencies

```bash
git clone https://github.com/SveaHallinder/job-radar.git
cd job-radar
npm install
npx playwright install chromium
```

### 2. Create `.env.local`

```bash
cp .env.example .env.local
```

Then edit `.env.local` and set:

```ini
# Shared Neon database — MUST match the hosted site, or results won't show up there.
DATABASE_URL=postgresql://...pooler...neon.tech/neondb?sslmode=require

# Turn LinkedIn (and web discovery) on for this machine.
JOB_RADAR_BROWSER_DISCOVERY=1

# The real LinkedIn Jobs search(es) to scrape. Pipe-separate multiple URLs.
# Open the search you want on linkedin.com/jobs, copy the URL from the address bar.
LINKEDIN_SEARCH_URLS=https://www.linkedin.com/jobs/search/?keywords=...&location=...

# Optional: raise the low QA defaults so it actually pulls a useful batch.
LINKEDIN_BOOTSTRAP_MAX_RESULTS=200
LINKEDIN_INCREMENTAL_MAX_RESULTS=100
LINKEDIN_MAX_DETAILS=80
```

> The `DATABASE_URL` is the pooled Neon string — the same one the Vercel deploy uses.
> Ask Svea for it, or copy it from the Vercel project's environment variables.

### 3. Log in to LinkedIn once

```bash
npm run linkedin:login
```

A Chromium window opens. Log in to LinkedIn (solve any checkpoint), then return to
the terminal and press **Enter**. The session is saved under `.data/browser-profile`
and reused on every future run — you won't need to log in again unless LinkedIn logs
the session out.

### 4. Install the background worker

```bash
bash scripts/install-worker.sh
```

That's it. The worker now:

- starts automatically on login,
- restarts itself if it crashes,
- runs invisibly (no terminal window),
- checks Neon for new requests every ~20 seconds.

---

## Daily use

Nothing. Whoever wants fresh LinkedIn jobs clicks **"Synka LinkedIn via min dator"**
on the website. This machine runs it next time it's awake, and the jobs appear on the
site. The button shows the status: *väntar på din dator* → *kör* → *klar HH:MM*.

## Useful commands

```bash
# Is the worker running?
launchctl list | grep jobradar

# Watch what it's doing
tail -f .data/worker.log

# Run one sync by hand (foreground, for testing)
npm run worker      # Ctrl-C to stop

# Stop / remove the background worker
bash scripts/uninstall-worker.sh
```

## Notes & limits

- **The machine must be awake when the sync runs.** Sleep prevents it. Either open the
  lid / wake it after clicking, or set the machine to not sleep (System Settings →
  Displays / Battery). Clicks are not lost — a request waits in the database until the
  worker is next awake, and repeated clicks collapse into one pending request.
- **Keep the LinkedIn session fresh.** If the worker log shows a LinkedIn login/blocked
  error, re-run `npm run linkedin:login`.
- **This does not replace the cloud cron.** Vercel still syncs JobTech + Arbeitnow +
  Jooble twice a day on its own; the worker adds LinkedIn on demand.
- **Web discovery (Google)** often hits a CAPTCHA and is reported as a failed source —
  that's expected and doesn't affect LinkedIn or the API sources.
