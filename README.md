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
- SQLite persistence under `.data/job-radar.sqlite`.
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

Open [http://localhost:3000](http://localhost:3000). The dashboard can run its first search without optional credentials.

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

## Commands

```bash
npm run dev        # dashboard on localhost
npm run sync       # run one immediate sync in the terminal
npm run scheduler  # keep a worker alive for 08:00 and 16:00 Stockholm time
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
