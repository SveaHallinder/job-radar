# Job Radar MVP Design

## Goal

Build a demo-ready local dashboard that collects job ads from supported public APIs and company ATS feeds, then shows only jobs that satisfy all of these rules:

- remote work is explicitly allowed;
- the engagement is freelance, consulting, contract, interim, fractional, or B2B;
- the role belongs to sales or marketing; and
- the applicant can work from Sweden, Romania/Bucharest, EMEA/Europe, or worldwide.

The product starts as a single-user tool. Its filters and source connectors remain configuration-driven so a later commercial version can support saved searches per customer.

## Non-goals

- No automated LinkedIn access, browser automation, or LinkedIn scraping.
- No authentication, billing, multi-tenancy, applications, email digests, or candidate profiles.
- No AI dependency in the MVP. Matching is deterministic and explainable.
- No local, hybrid, on-site, or permanent-employment fallback results.

## Architecture

Use one Next.js 16 and TypeScript application. Server-only modules own connectors, normalization, filtering, deduplication, persistence, and scheduled sync. SQLite is the local persistence layer through `better-sqlite3`; the database is stored under `.data/` and excluded from Git.

Connectors implement one small interface and return a shared `SourceJob` model. The first connector set is:

- JobTech for Swedish job ads without credentials;
- Arbeitnow for remote and Europe-focused ads without credentials;
- Jooble for broader EMEA/Romania discovery when `JOOBLE_API_KEY` is configured;
- Greenhouse and Lever for configured company career sites.

Jooble is appropriate for personal evaluation through its documented API. Commercial reuse must be separately licensed before a public SaaS release, so no product logic may depend on Jooble-specific fields.

## Data flow

1. A manual dashboard action, the protected cron route, or the scheduler process starts a sync.
2. Enabled connectors fetch independently. One failed source is recorded and logged but does not discard successful sources.
3. Source-specific fields are normalized to `SourceJob`.
4. The matcher evaluates remote, engagement type, category, and geographic eligibility.
5. Rejected jobs are counted but not stored in the visible jobs table.
6. Accepted jobs are deduplicated by canonical original URL, with a normalized company-and-title fallback.
7. Accepted jobs are upserted and annotated with human-readable match reasons.
8. The dashboard reads accepted jobs and the latest sync summary from SQLite.

## Match rules

Remote, contract/freelance, sales/marketing, and geography are hard requirements. Structured source data takes precedence; explicit phrases provide fallback classification. Hybrid and on-site phrases override a generic remote mention.

The category is inferred from the title plus source-provided category tags. Description-only mentions of sales or marketing do not turn an unrelated role into a match. Swedish-language relevance is shown as an additional match reason but is not a category and cannot admit unrelated roles.

Worldwide, Europe, EU, and EMEA remote roles are eligible. Sweden, Stockholm, Romania, Bucharest, and Bucuresti are eligible. Roles explicitly limited to other regions are rejected.

## Persistence

The `jobs` table stores the canonical URL, source metadata, normalized title/company/location, category, engagement type, dates, description excerpt, match reasons, and first/last-seen timestamps. `sync_runs` stores status, source counts, accepted/rejected counts, error summaries, and timestamps.

No source response body, personal data, application form, or candidate data is persisted.

## Dashboard

The dashboard uses a polished editorial operations-console style rather than a generic admin template. It contains:

- a compact brand header and a “Run search now” primary action;
- summary cards for total matches, newly seen jobs, and last sync state;
- a visible active-filter strip showing the strict AND logic;
- text search and category/source selectors;
- responsive job cards with title, company, location, source, posted date, match reasons, and original-link action;
- a clear empty state explaining how to run the first sync and enable optional sources;
- an inline error state that preserves existing results when a sync fails.

The initial UI has no premium gates or unavailable controls.

## Scheduling

`npm run scheduler` runs a long-lived local worker that calculates the next 08:00 or 16:00 occurrence in `Europe/Stockholm`, including daylight-saving changes, then invokes the same sync service used by the UI. `npm run sync` performs one immediate CLI sync. A protected `/api/cron/sync` route supports a future external scheduler through `CRON_SECRET`.

The dashboard remains fully testable on localhost without the worker through “Run search now”.

## Errors and logging

Server routes, server actions, CLI scripts, and connector failures use the `[job radar]` prefix. User-visible errors state which action failed and whether existing results remain available. Missing optional credentials skip the corresponding connector and appear in the sync summary instead of failing the full run.

## Testing

- Unit tests cover strict matcher acceptance and rejection, category classification, geography, canonical URL normalization, and deduplication.
- Connector mapping tests use fixed response fixtures and no network.
- Sync orchestration tests verify partial-source failure and aggregate counts.
- The production build verifies server/client boundaries and SQLite bundling.
- Manual QA runs the dashboard on localhost, triggers sync, filters visible jobs, checks the empty/error state, and opens an original URL.

## Assumptions

- Node.js 20.19 or newer is available.
- The personal MVP may use the public JobTech and Arbeitnow endpoints.
- Jooble, Greenhouse boards, and Lever sites are optional configuration, not launch blockers.
- A source can return zero strict matches without indicating an error.
