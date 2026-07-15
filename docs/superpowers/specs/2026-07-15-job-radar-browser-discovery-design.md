# Job Radar Browser Discovery Design

## Goal

Extend the personal Job Radar with two zero-subscription browser discovery sources:

- LinkedIn Jobs as the primary source; and
- Google Search as a best-effort fallback for public, active job ads.

Every discovered job must still pass the existing strict AND profile:

```text
remote
AND contract / freelance / consulting
AND sales / marketing
AND Sweden / Romania / Bucharest / EMEA / Europe / worldwide
```

The first successful LinkedIn run searches the previous seven days. Later runs search the previous 24 hours and remain scheduled for 08:00 and 16:00 in `Europe/Stockholm`.

## Product boundary

This extension is personal and local-only. The user has explicitly accepted the risk that LinkedIn or Google may restrict an account, present a CAPTCHA, or block automated access.

It must not become a hidden dependency of a commercial product. A future hosted product must use licensed feeds, approved partnerships, direct ATS APIs, or sources whose terms permit commercial aggregation.

The implementation will not:

- create or use fake LinkedIn accounts;
- copy cookies from Safari or another personal browser profile;
- store a LinkedIn password in code, environment variables, SQLite, or logs;
- bypass CAPTCHA, access controls, rate limits, or account warnings;
- use stealth plugins, fingerprint spoofing, proxy rotation, or challenge-solving services;
- automate applications, messages, likes, profile visits, or other engagement; or
- collect member profiles, applicant data, or recruiter contact data.

LinkedIn's current User Agreement and automation guidance prohibit scraping and unauthorized browser automation. Google HTML search automation is also brittle and may be blocked. These are accepted operational risks for this personal experiment, not guarantees of continued access.

## Approved approach

Add `playwright` as the one new dependency and install its managed Chromium browser. A dedicated persistent Chromium profile lives under `.data/browser-profile/` and is excluded from Git.

The first LinkedIn run opens the visible dedicated Chromium window and pauses until the user has manually completed login. Later runs reuse that browser profile. Browser automation remains visible (`headless: false`) so login, CAPTCHA, restrictions, and unexpected page changes are never hidden.

Both browser sources implement the existing `JobConnector` boundary and return the shared `SourceJob` model. The current matcher, canonical URL normalization, deduplication, SQLite repository, dashboard, manual sync, and scheduler remain the common pipeline.

## Components

### Browser runtime

A server-only browser runtime owns one persistent Chromium context at a time. It provides:

- profile directory creation;
- a visible manual-login handoff;
- navigation with conservative timeouts;
- fixed conservative pacing between navigations;
- a single-run mutex so UI, scheduler, and CLI syncs cannot overlap;
- detection of login pages, CAPTCHA, HTTP 429, challenge pages, and account warnings; and
- guaranteed browser cleanup after success or failure.

The pacing reduces accidental load; it is not an anti-detection mechanism.

### LinkedIn connector

The connector uses a small configured set of LinkedIn Jobs search URLs covering sales and marketing across Sweden, Bucharest/Romania, and EMEA. Searches must already select remote work. Contract language remains broad in discovery because LinkedIn's employment-type filter does not consistently represent freelance, consulting, interim, fractional, or B2B work.

For each search:

1. Apply the seven-day bootstrap window when no successful LinkedIn checkpoint exists; otherwise apply 24 hours.
2. Collect unique job IDs and URLs from a bounded number of result pages.
3. Read title, company, location, posted date, and available list-card metadata.
4. Visit detail pages sequentially only for unique candidates.
5. Extract the description and any structured employment or workplace metadata.
6. Map the result to `SourceJob` with source `LinkedIn`.

Conservative defaults cap discovery at 200 unique result cards on bootstrap, 100 on incremental runs, and 80 detail pages per run. Environment variables may lower these limits but cannot raise them above the hard caps.

### Google discovery connector

Google is a best-effort fallback using the same visible Chromium runtime. It performs at most eight targeted queries and reads no more than two result pages per query.

Queries target original employer and ATS pages, including configured Greenhouse and Lever boards plus common job-page URL patterns. Search results that point only to generic list pages, SEO pages, unrelated aggregators, or non-job content are rejected before detail fetching.

For each candidate URL:

1. Resolve redirects to the final URL.
2. Reject HTTP 404/410 responses and explicit expired, closed, filled, or unavailable messages.
3. Prefer `application/ld+json` `JobPosting` data.
4. Reject a `validThrough` date in the past.
5. Fall back to page title, metadata, and visible job text when structured data is absent.
6. Require enough title, company, location, and description content for the existing matcher.
7. Map the result to `SourceJob` with source `Web discovery` and the original employer/ATS URL.

The connector stops and reports a partial-source error when Google presents a CAPTCHA or block page. It does not retry through another identity or endpoint during that run.

### Checkpoint state

No database schema change is required. Browser-specific state is stored atomically under `.data/browser-state.json`:

- last successful LinkedIn completion time;
- whether the seven-day bootstrap completed;
- last successful Google completion time.

A failed or blocked run never advances its checkpoint.

### Active-job validation

The personal dashboard should show active opportunities rather than an archive. During each sync, the service validates a bounded rotating batch of stored LinkedIn and web-discovery URLs using the existing jobs table.

Confirmed 404/410, expired, closed, filled, or unavailable jobs are deleted through repository methods. Temporary network failures, login failures, CAPTCHAs, timeouts, or ambiguous page changes preserve the existing row. This avoids a schema migration and prevents transient source problems from erasing results.

## Data flow

1. UI, CLI, or the 08:00/16:00 scheduler requests a sync.
2. A process-level mutex rejects or skips an overlapping browser sync.
3. Public API and ATS connectors continue independently.
4. The browser runtime opens the dedicated profile.
5. LinkedIn discovers seven-day or 24-hour candidates.
6. Google performs its bounded best-effort discovery.
7. Both sources return normalized `SourceJob` objects.
8. Existing strict matching rejects non-remote, non-contract, non-sales/marketing, or geographically ineligible jobs.
9. Existing canonical URL and company-title deduplication merges overlap between LinkedIn, Google, ATS feeds, JobTech, and Arbeitnow.
10. Confirmed inactive stored jobs are removed; ambiguous jobs remain.
11. Checkpoints advance only for sources that completed successfully.
12. The dashboard shows source-level counts and errors without hiding successful results.

## Scheduling behavior

The existing local scheduler remains responsible for 08:00 and 16:00 Stockholm time. Browser connectors are enabled only when a graphical macOS user session is available.

If the computer is asleep, logged out, or the scheduler process is not running, that occurrence is missed. The next successful run still uses the 24-hour LinkedIn window, so a single missed occurrence does not normally create a gap. A hosted cron route skips local browser sources because it has neither the dedicated local profile nor an approved graphical login session.

## Configuration

The implementation adds documented environment configuration for:

- enabling personal browser discovery;
- LinkedIn saved-search URLs;
- bootstrap and incremental result limits;
- Google query and page limits; and
- the dedicated browser profile path.

Safe defaults keep browser discovery disabled until the user explicitly enables it and completes the manual LinkedIn login. The current public connectors continue to work when browser discovery is disabled.

## Dashboard behavior

No dashboard redesign is required. Existing source filtering and cards already support new source labels.

Small additions are limited to:

- `LinkedIn` and `Web discovery` source labels;
- a visible “LinkedIn login required” sync error when applicable;
- distinct blocked/CAPTCHA copy that says existing results were preserved; and
- source counts in the existing sync summary.

There is no hidden premium state or unavailable commercial control.

## Errors and logging

Browser errors use clear feature prefixes:

- `[job radar linkedin]` for LinkedIn login, parsing, restriction, and checkpoint errors;
- `[job radar google]` for Google CAPTCHA, parsing, and navigation errors; and
- `[job radar browser]` for profile, mutex, launch, and cleanup errors.

Logs may include a source, job ID, hostname, status code, or query fingerprint. They must never include cookies, authorization headers, session storage, passwords, full browser state, or page HTML captured from an authenticated session.

One browser source failing produces a partial sync. Existing jobs remain visible. A total failure remains an explicit dashboard error through the current sync behavior.

## Testing

Automated tests must not contact LinkedIn or Google.

- Parser tests use sanitized static fixtures for LinkedIn result cards and detail pages.
- Web-job tests cover JSON-LD `JobPosting`, expired `validThrough`, closed-page copy, redirects, and insufficient metadata.
- Checkpoint tests cover bootstrap, incremental runs, failed runs, and atomic state replacement.
- Browser-state tests cover login-required, CAPTCHA, 429, account-warning, timeout, and mutex behavior through a fake browser adapter.
- Sync tests verify cross-source deduplication, partial browser failure, preservation of ambiguous existing jobs, and deletion of confirmed inactive jobs.
- Existing matcher, connector, scheduler, lint, typecheck, and production-build checks remain required.

Manual localhost QA will:

1. launch the dedicated visible Chromium profile;
2. complete manual LinkedIn login without entering credentials into Job Radar;
3. run a deliberately low-limit seven-day dry run;
4. verify LinkedIn and web-discovery jobs pass the strict matcher;
5. confirm source filters and original URLs in the dashboard;
6. simulate or observe a blocked source and confirm existing jobs remain; and
7. verify a second run selects the 24-hour window.

## Success criteria

- A manually logged-in local Chromium profile can complete a bounded LinkedIn discovery run.
- The first successful run uses seven days; later successful runs use 24 hours.
- Google can contribute public original job pages without a paid API, while CAPTCHA or blocking fails safely.
- Browser sources never bypass access controls or automate engagement.
- All discovered jobs pass the existing strict matcher and deduplication pipeline.
- Confirmed inactive jobs disappear; temporary failures never erase jobs.
- Existing non-browser sources, manual UI sync, and the local scheduler continue to work.
- The complete flow remains testable through the dashboard on localhost.

## Accepted trade-offs

- LinkedIn and Google browser markup can change without notice and break parsers.
- Either service may block automation or restrict an account.
- Google discovery is incomplete and best effort, not a complete web index export.
- Runs require a running, awake Mac with a graphical user session.
- No-cost browser discovery is suitable for personal experimentation but not a reliable commercial data contract.
