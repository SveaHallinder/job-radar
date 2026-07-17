# Job Radar

A local-first dashboard for one deliberately narrow opportunity profile:

```text
remote
AND contract / freelance / consulting
AND sales / marketing
AND Sweden / Romania / Bucharest / EMEA / Europe / worldwide
```

The matcher has no secondary results. Hybrid, on-site, permanent, unrelated Swedish-language, and region-locked non-EMEA roles are rejected.

## What is included

- A responsive dashboard with search, category and source filters.
- Manual sync from the UI.
- JobTech and Arbeitnow connectors that work without credentials.
- Optional Jooble, Greenhouse, and Lever connectors.
- Explainable match reasons and original application links.
- Postgres persistence: a zero-config local database (pglite under `.data/pg`) in development, and Neon when hosted (see [DEPLOYMENT.md](DEPLOYMENT.md)).
- A timezone-aware worker for 08:00 and 16:00 Europe/Stockholm.
- A protected cron route for an external scheduler.

LinkedIn is not accessed or scraped.

## Local setup

Use Node 20.19 or Node 22.13 and newer. The repository includes an `.nvmrc` for Node 20.19.4.

```bash
nvm use
npm install
cp .env.example .env.local
npm run dev
```

Local development needs **no database setup**: when `DATABASE_URL` is unset the app uses a local pglite Postgres persisted under `.data/pg` (created automatically, survives restarts). Set `DATABASE_URL` in `.env.local` only if you want to point local dev at a real Neon branch. Basic-auth is skipped locally (`NODE_ENV !== production`).

Open [http://localhost:3000](http://localhost:3000). The dashboard can run its first search immediately, without optional credentials.

## Optional source configuration

Add only the sources you want to `.env.local`:

```dotenv
JOOBLE_API_KEY=your-jooble-key
GREENHOUSE_BOARDS=Acme:acme,Northstar:northstar
LEVER_SITES=Acme:acme,Northstar:northstar
CRON_SECRET=replace-with-a-long-random-value
```

`GREENHOUSE_BOARDS` and `LEVER_SITES` use comma-separated `Company:token` pairs. The company name becomes the dashboard label; the token or site is the public ATS identifier.

| Source | Credentials | Original-link behavior |
| --- | --- | --- |
| JobTech | None | Uses the employer application URL when provided |
| Arbeitnow | None | Resolves the public `/apply` redirect after a job passes the strict filter |
| Jooble | API key | Resolves the returned tracking link after a job passes the strict filter |
| Greenhouse | Public board token | Uses `absolute_url` from the Job Board API |
| Lever | Public site name | Uses `applyUrl`, falling back to the hosted posting |

Jooble is optional for personal evaluation. Confirm commercial reuse and display terms with each provider before selling a hosted version.

## Personal browser discovery (optional, local-only)

Browser discovery adds two local connectors — a personal LinkedIn reader and a
best-effort free web/Google search — that run in a **visible** Chromium profile
on your own machine. It is opt-in and off by default.

```bash
npx playwright install chromium   # one-time browser download
cp .env.example .env.local
npm run linkedin:login            # sign in to LinkedIn by hand, then press Enter
npm run dev
```

Enable it in `.env.local`:

```dotenv
JOB_RADAR_BROWSER_DISCOVERY=1
# Pipe-separated LinkedIn saved-search URLs (https://www.linkedin.com/jobs/search...)
LINKEDIN_SEARCH_URLS=https://www.linkedin.com/jobs/search/?keywords=sales|https://www.linkedin.com/jobs/search/?keywords=marketing
```

`LINKEDIN_BOOTSTRAP_MAX_RESULTS`, `LINKEDIN_INCREMENTAL_MAX_RESULTS`,
`LINKEDIN_MAX_DETAILS`, `GOOGLE_MAX_QUERIES`, and `GOOGLE_MAX_PAGES` are optional
hard caps with safe defaults. `JOB_RADAR_BROWSER_PROFILE_PATH` and
`JOB_RADAR_BROWSER_STATE_PATH` default to ignored paths under `.data`; the login
session lives in that local profile and is never committed.

The first run backfills the last **7 days** on LinkedIn, then each 08:00 and
16:00 Stockholm run only reads the last **24 hours**. Confirmed-inactive jobs are
removed on a bounded rotating recheck; any ambiguous signal preserves the row.

**Risk boundary — read before enabling.** LinkedIn and Google may block
automation at any time. This project contains **no** CAPTCHA, rate-limit, or
access-control bypass: it stops on a CAPTCHA, `429`, or account warning and lets
the rest of the run continue as partial. It reads only jobs — no applications,
messages, or profile visits. It requires an awake, logged-in Mac to run the
visible browser, so browser discovery is **skipped entirely in hosted cron**
(`/api/cron/sync`). It is a personal tool, not a reliable or commercial data
source.

## Commands

```bash
npm run dev        # dashboard on localhost
npm run sync       # run one immediate sync in the terminal
npm run scheduler  # keep a worker alive for 08:00 and 16:00 Stockholm time
npm run linkedin:login  # open Chromium to sign in to LinkedIn once (opt-in browser discovery)
npm run lint       # lint the project
npm test           # run unit tests
npm run build      # create a production build
npm start          # serve the production build
```

The scheduler must stay running to trigger local scheduled jobs. It recalculates Stockholm time before every run, so daylight-saving changes do not require configuration changes.

For a hosted scheduler, call either `GET` or `POST /api/cron/sync` with:

```text
Authorization: Bearer <CRON_SECRET>
```

The route returns `503` when `CRON_SECRET` is missing, `401` for invalid authorization, and `502` when every configured source fails.

## Data and errors

Only accepted job metadata is stored. Source response bodies, applications, and candidate data are not persisted. Delete `.data/job-radar.sqlite` to clear the local radar.

Server and CLI messages use the `[job radar]` prefix. A single failed connector produces a partial sync and preserves successful results; a total source failure becomes a visible dashboard error while existing jobs remain available.
