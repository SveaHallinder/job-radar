# Deploying Job Radar to Vercel + Neon

Job Radar is designed for personal, hosted use on **Vercel** with a **Neon Postgres**
database. Local development uses a zero-config pglite database (`.data/pg`) when
`DATABASE_URL` is unset; a hosted serverless deploy has a read-only filesystem and
ephemeral `/tmp`, so it needs a real managed database (Neon).

Browser discovery (LinkedIn / web search via Playwright) is **local-only** and is
never enabled on the hosted deploy — leave all `JOB_RADAR_BROWSER_DISCOVERY` /
`LINKEDIN_*` / `GOOGLE_*` variables unset in Vercel.

## 1. Create the database (Neon)

1. Create a free Neon project (neon.tech). Either use the **Vercel-native Neon
   integration** (Vercel dashboard → Integrations → Neon), which sets `DATABASE_URL`
   (pooled) and `DATABASE_URL_UNPOOLED` for you, or copy both connection strings
   manually from the Neon dashboard.
2. `DATABASE_URL` must be the **pooled** string (host contains `-pooler`).
   `DATABASE_URL_UNPOOLED` is the direct string, used only for the one-off migration.

## 2. Create the schema (run once)

From your machine, with the Neon strings in `.env.local`:

```bash
cp .env.example .env.local          # fill in DATABASE_URL and DATABASE_URL_UNPOOLED
npm install
npm run db:migrate                  # creates the jobs + sync_runs tables
```

`db:migrate` uses `DATABASE_URL_UNPOOLED` (falling back to `DATABASE_URL`). It is
idempotent — the tables use `CREATE TABLE IF NOT EXISTS`.

## 3. Set environment variables in Vercel

Project → Settings → Environment Variables (Production):

| Variable | Required | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | **Yes** | Pooled Neon connection string for the app |
| `DATABASE_URL_UNPOOLED` | Recommended | Direct string for migrations |
| `CRON_SECRET` | **Yes** (for scheduled sync) | Protects `/api/cron/sync`. Generate with `openssl rand -hex 32`. Vercel auto-sends it as `Authorization: Bearer <CRON_SECRET>` to cron invocations |
| `BASIC_AUTH_USER` | **Yes** | Dashboard login user. Without both auth vars the hosted app fails closed (401 on everything) |
| `BASIC_AUTH_PASSWORD` | **Yes** | Dashboard login password |
| `JOOBLE_API_KEY` | Optional | Enables the Jooble source |
| `GREENHOUSE_BOARDS` | Optional | `Company:token` pairs, comma-separated |
| `LEVER_SITES` | Optional | `Company:site` pairs, comma-separated |

Do **not** set `JOB_RADAR_BROWSER_DISCOVERY`, `LINKEDIN_*`, `GOOGLE_*`, or the old
`JOB_RADAR_DB_PATH` on Vercel — they are local-only / obsolete.

## 4. Deploy

Push the branch / connect the repo in Vercel and deploy. The included `vercel.json`
registers two daily cron jobs that call `/api/cron/sync`:

```
0 7  * * *   → 08:00 Europe/Stockholm in winter (09:00 in summer)
0 15 * * *   → 16:00 Europe/Stockholm in winter (17:00 in summer)
```

**DST note:** Vercel cron schedules are fixed **UTC**, so the local trigger time
drifts by one hour across daylight-saving changes. This is expected and fine for a
personal radar. For exact local times you would need Vercel **Pro** (hourly cron +
an in-handler Stockholm-hour gate) — the Hobby plan only allows once-per-day cron.

## 5. Verify the deploy

- Open the app URL → browser prompts for Basic Auth → dashboard renders (no 500).
- Click **Kör sökning nu** → jobs appear. Reopen the URL in a fresh session →
  **jobs are still there** (durable persistence).
- Cron auth check:
  ```bash
  curl -i -H "Authorization: Bearer $CRON_SECRET" https://<your-app>/api/cron/sync   # 200
  curl -i https://<your-app>/api/cron/sync                                            # 401
  ```
- After the next scheduled time, confirm the run in Vercel → Cron Jobs logs.

## Notes & limits

- Hobby function timeout is 300s (`maxDuration` is set to 300 on the cron route).
  A creds-free sync (JobTech + Arbeitnow) completes well within that; redirect
  resolution runs with bounded concurrency to stay fast.
- Cron delivery on Hobby is best-effort (±59 min within the hour, no retries). The
  sync is idempotent (upsert by canonical URL), so an occasional double-fire is safe.
- `scripts/scheduler.ts` (`npm run scheduler`) is for **local** twice-daily runs only;
  it is not used on Vercel.
