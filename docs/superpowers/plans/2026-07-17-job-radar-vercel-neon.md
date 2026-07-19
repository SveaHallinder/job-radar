# Plan: Job Radar → Vercel + Neon Postgres (hosted personal use)

**Created:** 2026-07-17
**Goal:** Deploy Job Radar to Vercel so the user can (1) open the hosted URL, (2) click "Kör sökning nu" and have jobs stored, (3) see those jobs on the next visit, and (4) get an automatic sync twice a day (08:00/16:00 Europe/Stockholm — see DST note in Phase 2).
**Basis:** the verified deploy-readiness audit of 2026-07-17 (29 findings). Code health is green today: 408 tests pass, `tsc`/`eslint`/`next build` clean. The gaps are architectural fit for serverless + operational config, not code quality.

**Chosen path:** Vercel + Neon Postgres (HTTP serverless driver). This replaces the local `better-sqlite3` file — which cannot persist on serverless — with a remote DB.

Execute phases consecutively. Each phase is self-contained and ends with a verification checklist. Do NOT start Phase N+1 until Phase N verification passes.

---

## Phase 0 — Allowed APIs & references (read before coding)

All facts below were verified against live official docs on 2026-07-17. **Do not invent APIs beyond this list.**

### Neon serverless driver (`@neondatabase/serverless`)
Source: neon.com/docs/serverless/serverless-driver, driver README + CONFIG.md.
- Create client (module scope is safe for the HTTP driver — it is stateless `fetch`, no connection to leak):
  ```ts
  import { neon } from '@neondatabase/serverless';
  const sql = neon(process.env.DATABASE_URL!);
  ```
- Tagged template (params auto-bound, injection-safe): `` const rows = await sql`SELECT * FROM jobs WHERE id = ${id}` `` → returns **array of objects, keys = column names**.
- Dynamic parameterized query: `await sql.query('SELECT * FROM jobs WHERE source = ANY($1) AND id > $2 LIMIT $3', [sources, afterId, limit])`.
- Upsert: standard `INSERT ... ON CONFLICT (canonical_url) DO UPDATE SET col = EXCLUDED.col ...` works as one statement.
- Batch/transaction (non-interactive, callback must NOT be async): `await sql.transaction([ sql`...`, sql`...` ])`.
- **HTTP driver = one statement per call.** No multi-statement blobs. DDL (`CREATE TABLE IF NOT EXISTS`) works as a *single* statement per call → run each CREATE TABLE as its own `await sql\`...\``.
- **Use the HTTP `neon()` driver** for this workload (single-user, twice-daily sync + reads). Only use `Pool`/`Client` (WebSocket) for interactive transactions — we do not need them.
- Env: `DATABASE_URL` = **pooled** connection string (use for app queries). `DATABASE_URL_UNPOOLED` = direct string (use for migrations/DDL). The Neon–Vercel integration sets both automatically.
- **Type mapping:** `remote` → Postgres `BOOLEAN` (returns JS `true`/`false`/`null` — no more 0/1 compare). Keep the `*_json` columns as `TEXT` (so existing `JSON.parse`/`JSON.stringify` in `db.ts` stays unchanged). `COUNT(*)` returns Postgres `bigint` → arrives as a **string**, wrap in `Number(...)`.

### Vercel Cron + Next.js 16 route config
Source: vercel.com/docs/cron-jobs, project-configuration/vercel-json, functions/duration; nextjs.org route-segment-config.
- `vercel.json` `crons` objects support **only** `path` (must start with `/`) and `schedule`. No `method`, `timezone`, or `name` field. **Schedule is always UTC.**
- Vercel Cron sends an **HTTP GET only** (POST export is never triggered by cron), user-agent `vercel-cron/1.0`. It **auto-sends `Authorization: Bearer <CRON_SECRET>`** when the `CRON_SECRET` env var is set — matches the existing check in `route.ts:13`.
- Delivery is **best-effort, no retry, may double-fire, does not follow redirects** → handler must be idempotent (our upsert-by-`canonical_url` already is).
- **Hobby plan:** cron limited to **once per day**; anything more frequent fails at deploy. Firing is imprecise (±59 min within the scheduled hour). `maxDuration` max = **300s** (also the default). Pro allows hourly+ and up to 800s.
- Route segment config (named exports in `route.ts`): `export const runtime = 'nodejs'`, `export const maxDuration = 300`, `export const dynamic = 'force-dynamic'`. (`dynamic` is a no-op only if the `cacheComponents` flag is enabled — this project does not enable it, so it is valid.)

### Next.js 16 auth middleware & tracing
Source: nextjs.org proxy file-convention, upgrade/version-16, config/output; @vercel/nft README.
- **In Next.js 16 `middleware` is renamed to `proxy`.** Use `proxy.ts` at project root, `export function proxy(request: NextRequest)`. It runs on the **Node.js runtime** by default (NOT Edge) and `runtime` cannot be reconfigured. → `process.env` and `node:crypto.timingSafeEqual` are available.
- 401 with browser prompt: return `new NextResponse('...', { status: 401, headers: { 'WWW-Authenticate': 'Basic realm="Restricted", charset="UTF-8"' } })`.
- `config.matcher` must be static; use a negative-lookahead to protect everything except static assets and the cron route.
- `outputFileTracingExcludes` is a **top-level** `next.config` key (not under `experimental`/`turbopack`), shape `{ '<routeGlob>': ['<excludeGlob>', ...] }`.
- A literal-string `await import('playwright')` is **still traced by nft** — dynamic import alone does NOT shrink the bundle; you also need `outputFileTracingExcludes`, and the excluded module must never be imported at runtime on the hosted path.

### Exact current-code facts (from repo extraction)
- `JobRepository` interface: `lib/job-radar/types.ts:80-89` — 8 synchronous methods.
- Repository call sites to `await` after making the interface async:
  - `app/page.tsx:7-9` — `HomePage` is **NOT async today**; make it `async function HomePage()` and await lines 8-9.
  - `lib/job-radar/sync.ts:76, 139, 183, 232` — already inside `async syncJobs`.
  - `lib/job-radar/active-validation.ts:35, 42, 51` — already inside `async validateActiveJobs`.
  - `app/actions.ts:20` and `app/api/cron/sync/route.ts:20` call only `await syncJobs(...)` — **no change needed** (they don't touch the repo directly).
- Implementation to port: `lib/job-radar/db.ts:103-317` (class 103-304, singleton factory 306-317). Schema `db.ts:110-146`. `upsertJob` is currently SELECT-then-UPDATE/INSERT (`db.ts:157-226`) → collapse to one `ON CONFLICT`. `listJobsForValidation` builds dynamic `?` placeholders (`db.ts:234-251`) → use `source = ANY($1)`.
- `id` derivation (keep): `createHash("sha256").update(job.canonicalUrl).digest("hex").slice(0, 20)` (`db.ts:162-164`). `description` truncated to 1200 chars (`db.ts:174`).
- Tests touching `JobRepository`: `lib/job-radar/sync.test.ts:13-50` (fake `MemoryRepository`) and `lib/job-radar/active-validation.test.ts:36-67` (fake) + `123-175` (uses **real** `new SqliteJobRepository(":memory:")`). See Phase 1 test decision.
- Versions: next 16.2.10, react 19.2.7, better-sqlite3 12.11.1, playwright 1.61.1.

**Anti-patterns to avoid across all phases:**
- Do NOT keep any code path that writes a SQLite file to `process.cwd()` on serverless.
- Do NOT use `middleware.ts` on Edge for auth (use Node `proxy.ts`).
- Do NOT assume a lazy `import()` removes Playwright from the bundle — it also needs `outputFileTracingExcludes`.
- Do NOT send cron via POST (Vercel only issues GET).
- Do NOT schedule more than once/day on Hobby.

---

## Phase 1 — Persistence: Neon Postgres + async repository  (BLOCKER)

**What to implement**

1. Add dependency `@neondatabase/serverless`. Remove `better-sqlite3` from `dependencies` **and** from `serverExternalPackages` in `next.config.ts` (unless kept dev-only for tests — see test decision). Remove `@types/better-sqlite3` if fully dropped.
2. In `lib/job-radar/types.ts:80-89`, wrap every `JobRepository` return type in `Promise<...>` (8 methods).
3. Rewrite `lib/job-radar/db.ts`: replace `SqliteJobRepository` with `PostgresJobRepository` holding `private readonly sql = neon(process.env.DATABASE_URL!)`. **No `mkdirSync`, no WAL, no DDL in the constructor.** Port each method to `async`, translating SQL:
   - `startSyncRun`: `` await sql`INSERT INTO sync_runs (run_id, status, started_at) VALUES (${runId}, 'failed', ${startedAt})` ``.
   - `upsertJob`: single statement (copy-ready target):
     ```sql
     INSERT INTO jobs (id, canonical_url, source, external_id, source_url, original_url,
       title, company, location, country, description, category, engagement_type, remote,
       tags_json, match_reasons_json, posted_at, first_seen_at, last_seen_at)
     VALUES ($1,$2,...,$18,$18)
     ON CONFLICT (canonical_url) DO UPDATE SET
       source=EXCLUDED.source, external_id=EXCLUDED.external_id, ... ,
       last_seen_at=EXCLUDED.last_seen_at
     RETURNING (xmax = 0) AS inserted
     ```
     Return `"created"` when `inserted` is true, else `"updated"` (replaces the SELECT-first logic). **Do not overwrite `first_seen_at` on conflict.** Bind `remote` as JS boolean|null (column is `BOOLEAN`).
   - `listJobsForValidation`: `` await sql.query('SELECT * FROM jobs WHERE source = ANY($1)' + (afterId ? ' AND id > $2' : '') + ' ORDER BY id ASC LIMIT $' + (afterId?3:2), afterId ? [sources, afterId, limit] : [sources, limit]) ``.
   - `getDashboardStats`: parse count with `Number(row.count)`.
   - `mapJobRow`: change `remote` to `row.remote` (already boolean|null); keep `parseJsonArray(row.tags_json)` etc. unchanged (columns stay TEXT).
   - Keep the singleton factory `getJobRepository()` (stateless `sql` is safe to reuse).
4. Add `await` at the product call sites listed in Phase 0 and make `HomePage` async (`app/page.tsx`).
5. Create `scripts/migrate.ts` that runs the schema as **separate single-statement calls** against `process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL`:
   - `CREATE TABLE IF NOT EXISTS jobs (... remote BOOLEAN, ... )` (port from `db.ts:110-131`, `remote INTEGER`→`BOOLEAN`, keep TEXT timestamps + `*_json TEXT`).
   - `CREATE TABLE IF NOT EXISTS sync_runs (...)` (port from `db.ts:133-145`).
   Add script `"db:migrate": "tsx scripts/migrate.ts"` to `package.json`.

**Test decision (make explicitly):** `active-validation.test.ts` currently tests real SQL via `new SqliteJobRepository(":memory:")`. Choose one:
- **(Recommended)** Add dev-dependency `@electric-sql/pglite` (in-memory Postgres, WASM) and point the real-DB test block at a `PostgresJobRepository` backed by pglite — keeps genuine SQL coverage of the `ANY($1)` + `id > $n` cursor. Make the `it(...)` callback async + `await` the calls.
- **(Fallback)** Delete the real-DB block and rely on the `MemoryRepository` fake; loses cursor-SQL coverage. Simpler, acceptable for a solo tool.
Either way: both `MemoryRepository` fakes (`sync.test.ts:13-50`, `active-validation.test.ts:36-67`) must return `Promise`s to satisfy the async interface; make their method bodies `async`.

**Documentation references:** Phase 0 "Neon serverless driver" + "Exact current-code facts". Copy SQL shapes from `db.ts` line ranges cited above; copy `neon()`/`sql.query`/`ON CONFLICT` forms from Phase 0.

**Verification checklist:**
- [ ] `grep -rn "better-sqlite3\|mkdirSync\|journal_mode" lib app scripts` returns nothing in product code (or only the dev-test path if fallback SQLite kept).
- [ ] `npx tsc --noEmit` clean (proves every call site is awaited and interface matches).
- [ ] `npm test` green (fakes async-compatible; real-DB test uses pglite or removed).
- [ ] With a real Neon `DATABASE_URL` in `.env.local`: `npm run db:migrate` creates both tables; `npm run dev` → open `/` (renders empty state, no 500); click "Kör sökning nu" → jobs appear; **restart `npm run dev` and reload → jobs still present** (proves durable persistence).

**Anti-pattern guards:** no `?`/`@named` params left (Postgres uses `$1`); `first_seen_at` not overwritten on conflict; `remote` bound as boolean not 1/0; no DDL in the request path.

---

## Phase 2 — Scheduling: vercel.json crons + CRON_SECRET  (BLOCKER)

**What to implement**

1. Create `vercel.json` at repo root (copy-ready):
   ```json
   {
     "$schema": "https://openapi.vercel.sh/vercel.json",
     "crons": [
       { "path": "/api/cron/sync", "schedule": "0 7 * * *" },
       { "path": "/api/cron/sync", "schedule": "0 15 * * *" }
     ]
   }
   ```
   `07:00`/`15:00` UTC = `08:00`/`16:00` Stockholm **in winter (CET)**. In summer (CEST) they fire at 09:00/17:00 local.
2. Add route segment config to `app/api/cron/sync/route.ts`: `export const runtime = 'nodejs'`, `export const maxDuration = 300`, `export const dynamic = 'force-dynamic'`. Keep the existing `GET` handler and Bearer check as-is (already correct).
3. Set `CRON_SECRET` in Vercel project env (generate: `openssl rand -hex 32`). Keep `scripts/scheduler.ts` for local use only.

**DST decision (make explicitly):**
- **(Recommended for Hobby)** Accept the ±1h seasonal drift above. Simplest; fine for a personal radar. (Hobby also can't schedule hourly.)
- **(Precise, needs Vercel Pro)** Schedule hourly `0 * * * *` and gate inside the handler using `Intl.DateTimeFormat('en-US',{timeZone:'Europe/Stockholm',hour:'numeric',hour12:false})` — run only when the Stockholm hour is 8 or 16 (reuse the logic in `lib/job-radar/schedule.ts`). Note: Hobby rejects sub-daily crons at deploy, so this requires Pro.

**Documentation references:** Phase 0 "Vercel Cron + Next.js 16 route config".

**Verification checklist:**
- [ ] `vercel.json` validates (no extra fields beyond `path`/`schedule`).
- [ ] After deploy: Vercel dashboard → Cron Jobs lists both schedules.
- [ ] Manually hit `curl -H "Authorization: Bearer $CRON_SECRET" https://<app>/api/cron/sync` → 200 with a summary; without header → 401; with `CRON_SECRET` unset → 503.
- [ ] Confirm a scheduled run appears in Vercel cron logs the next day.

**Anti-pattern guards:** UTC-only schedule (no `timezone` field); once/day on Hobby; GET handler (not POST); handler stays idempotent.

---

## Phase 3 — Security & robustness  (do before exposing the URL)

**What to implement**

1. **Basic Auth via `proxy.ts`** (Next 16, Node runtime). Create `proxy.ts` at repo root:
   ```ts
   import { NextResponse } from 'next/server';
   import type { NextRequest } from 'next/server';
   import { timingSafeEqual } from 'node:crypto';

   function safeEqual(a: string, b: string): boolean {
     const x = Buffer.from(a), y = Buffer.from(b);
     return x.length === y.length && timingSafeEqual(x, y);
   }
   export function proxy(request: NextRequest) {
     const h = request.headers.get('authorization');
     if (h?.startsWith('Basic ')) {
       const [user, pass] = Buffer.from(h.slice(6), 'base64').toString('utf8').split(/:(.*)/s);
       const ok = safeEqual(user ?? '', process.env.BASIC_AUTH_USER ?? '');
       const pk = safeEqual(pass ?? '', process.env.BASIC_AUTH_PASSWORD ?? '');
       if (ok && pk) return NextResponse.next();
     }
     return new NextResponse('Authentication required', {
       status: 401,
       headers: { 'WWW-Authenticate': 'Basic realm="Restricted", charset="UTF-8"' },
     });
   }
   export const config = {
     matcher: ['/((?!api/cron|_next/static|_next/image|favicon.ico|robots.txt).*)'],
   };
   ```
   This protects `/` (and its server action) while leaving `/api/cron/*` for Vercel's Bearer auth. Add `BASIC_AUTH_USER` / `BASIC_AUTH_PASSWORD` to Vercel env + `.env.example`. (Alternative: Vercel's built-in Deployment Password protection — no code, but a Pro feature.)
2. **Fix the sync-timeout blocker** (`lib/job-radar/sync.ts:143-145`). Today matched Arbeitnow/Jooble jobs each do a sequential 15s-cap redirect GET; enough jobs × 15s can exceed the 300s function limit and kill the run before `finishSyncRun`. Change to **bounded-concurrency** resolution (e.g. resolve redirects for all matched jobs of a source with a pool of ~6-8 in parallel, preserving order), and optionally lower `REQUEST_TIMEOUT_MS` for `resolveRedirect` to ~8s. Keep `maxDuration=300` on the route (Phase 2) and add the same to the server action's route if needed.
3. **(Optional hygiene — audit severity LOW)** Trim Playwright from the hosted bundle. Only worth doing if you want a clean build with no NFT warning; the app deploys fine without it (~15 MB ≪ 250 MB limit). If done, do BOTH:
   - Make `lib/job-radar/browser/runtime.ts` use `const { chromium } = await import('playwright')` inside `run()` (remove the top-level import), and make `lib/job-radar/connectors/index.ts` `await import(...)` the browser modules only inside the `browserConfig.enabled` branch (make `getConnectorConfiguration` async; `await` it at `sync.ts:71`).
   - Add to `next.config.ts`:
     ```ts
     outputFileTracingExcludes: {
       '/*': ['node_modules/playwright/**', 'node_modules/playwright-core/**'],
     },
     ```
   - Guard: the excluded module must never be imported on the hosted path — safe because `JOB_RADAR_BROWSER_DISCOVERY` is unset on Vercel, so the enabled branch never runs.
4. **(Optional, LOW)** Enforce the "hosted = no browser" invariant in code: default `browserDiscovery` to `false` unless `JOB_RADAR_BROWSER_DISCOVERY==='1'`, so the manual UI action can't invoke Playwright server-side.

**Documentation references:** Phase 0 "Next.js 16 auth middleware & tracing"; audit findings on sequential redirect resolution and Playwright import chain.

**Verification checklist:**
- [ ] Local: request `/` without credentials → browser shows Basic-Auth prompt (401); with correct creds → dashboard loads. `/api/cron/sync` still reachable with Bearer (not prompted for Basic).
- [ ] `npx tsc --noEmit` + `npm test` clean; `next build` succeeds.
- [ ] If step 3 done: `next build` no longer prints the "whole project traced" warning; `.next/server/app/api/cron/sync/route.js.nft.json` has 0 playwright refs.
- [ ] Manual sync with many Arbeitnow/Jooble results completes well under 300s (time it).

**Anti-pattern guards:** don't exclude Playwright from the trace while keeping a top-level static import (breaks module load); don't put auth only in the component (server actions POST to the route — proxy matcher must cover `/`).

---

## Phase 4 — Matcher quality (optional but recommended; you lose real jobs without it)

Audit-confirmed silent drops in `lib/job-radar/matcher.ts`:
1. **Geography gate too strict** (`matcher.ts:82-87`): accepting requires an explicit geo keyword, so bare "Remote" and many EMEA-city postings are rejected. Loosen: treat a clearly-remote+eligible role as pass unless an EXCLUDED-only region is present, rather than requiring a positive geo term.
2. **Accented Swedish never matches**: patterns are ASCII but source text isn't normalized. Normalize `searchableText` with `.normalize('NFKD').replace(/[̀-ͯ]/g,'')` (or add accented variants) so "hemifrån" etc. match.
3. **Connectors fail-fast**: `Promise.all` in the fan-out (worst in Jooble's 6-query) discards all good sub-results if one times out → switch to `Promise.allSettled` and keep the successes.
4. **(LOW)** `consultant`/`konsult` alone admits some permanent roles; tighten if false positives annoy you.

**Verification:** add/extend unit tests in `matcher.test.ts` for a bare-"Remote" EMEA job (now accepted), an accented Swedish title (now matched), and a connector where one sub-query rejects (others still returned). `npm test` green.

---

## Phase 5 — Deployment docs & env

1. Create `DEPLOYMENT.md`: step-by-step Vercel deploy — connect repo, add the Neon integration (or set `DATABASE_URL`/`DATABASE_URL_UNPOOLED`), run `npm run db:migrate` once against the unpooled URL, set env vars, deploy, confirm cron.
2. Env-var table (dashboard): `DATABASE_URL` (pooled, required), `DATABASE_URL_UNPOOLED` (migrations), `CRON_SECRET` (required for cron; `openssl rand -hex 32`), `BASIC_AUTH_USER`/`BASIC_AUTH_PASSWORD` (required to protect the URL), plus the existing optional source vars (`JOOBLE_API_KEY`, `GREENHOUSE_BOARDS`, `LEVER_SITES`). Note that `JOB_RADAR_BROWSER_DISCOVERY` and all `LINKEDIN_*`/`GOOGLE_*` vars are **local-only** and must stay unset on Vercel.
3. Update `.env.example` with `DATABASE_URL`, `DATABASE_URL_UNPOOLED`, `BASIC_AUTH_USER`, `BASIC_AUTH_PASSWORD`; drop `JOB_RADAR_DB_PATH` (obsolete). Update `README.md` to point at `DEPLOYMENT.md` for hosting.

**Verification:** a fresh reader can follow `DEPLOYMENT.md` end-to-end; `.env.example` lists every var the code reads and nothing it doesn't.

---

## Phase 6 — Final verification & first deploy

1. `npx tsc --noEmit`, `npm run lint`, `npm test`, `npm run build` — all clean.
2. `grep -rn "better-sqlite3\|process.cwd()\|mkdirSync\|\.data/" lib app` — no serverless-incompatible persistence in product code.
3. Deploy to Vercel; run `npm run db:migrate` against Neon (unpooled).
4. End-to-end on the hosted URL:
   - [ ] Opening `/` prompts Basic Auth, then renders (no 500).
   - [ ] "Kör sökning nu" completes; jobs appear; **reopen the URL from a fresh session → jobs persist.**
   - [ ] `curl` the cron route with the Bearer secret → 200; unauthorized → 401.
   - [ ] Next day: Vercel cron log shows the scheduled sync ran and stored jobs.
5. Confirm the build has no unexpected NFT/trace warnings (clean if Phase 3 step 3 done).

**Definition of done:** all four goal criteria met on the hosted URL — open, sync-and-store, persist across visits, scheduled twice-daily sync (within the accepted DST window).

---

## Effort & sequencing summary
- **Phase 1** (persistence) — largest; the async refactor + SQL port. Unblocks "jobs persist".
- **Phase 2** (cron) — small; config only. Unblocks "twice a day".
- **Phase 3** (auth + timeout) — medium; needed before the URL is public.
- **Phase 4** (matcher) — optional; improves recall/precision.
- **Phase 5–6** (docs + deploy) — small; ship.

Phases 1+2+3 are the minimum for a safe, working personal deploy. Phase 4 is quality. Each phase is independently committable.
