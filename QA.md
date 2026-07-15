# Localhost QA script

1. Run `nvm use && npm install && cp .env.example .env.local && npm run dev`, then open `http://localhost:3000`. Confirm the editorial dashboard renders and the fixed profile states `REMOTE AND CONTRACT / FREELANCE AND SALES / MARKETING AND SE / RO / EMEA`.
2. With an empty `.data/` directory, confirm the “Radarn är redo” empty state is visible and no premium or disabled product controls appear.
3. Click **Kör sökning nu**. Confirm the button shows a loading state, the page reports a completed or partial sync, and existing results remain visible if one source fails.
4. Enter part of a title or company in search, then switch between Sales and Marketing and between available sources. Confirm the visible count and cards update without navigation.
5. Open **Öppna original** on a result. Confirm it opens a new tab on an employer, ATS, or configured job-source URL rather than LinkedIn.
6. Resize the browser below 760px. Confirm the hero, active profile, statistics, filters, job cards, empty state, and original-link action remain readable with no horizontal scrolling.

## Personal browser discovery QA (opt-in, local-only)

1. Set `JOB_RADAR_BROWSER_DISCOVERY=1`, one `LINKEDIN_SEARCH_URLS` entry, and low limits (`LINKEDIN_BOOTSTRAP_MAX_RESULTS=10`, `LINKEDIN_INCREMENTAL_MAX_RESULTS=5`, `LINKEDIN_MAX_DETAILS=5`, `GOOGLE_MAX_QUERIES=1`, `GOOGLE_MAX_PAGES=1`) in `.env.local`.
2. Run `npm run linkedin:login`, sign in manually in the dedicated Chromium window, return to Terminal, and press Enter.
3. Run `npm run dev`, open `http://localhost:3000`, and click **Kör sökning nu**.
4. Confirm the first successful LinkedIn source result uses the seven-day bootstrap and any accepted card says `Via LinkedIn` or `Via Web discovery`.
5. Open one result and confirm it reaches the original active job page; test dashboard search and source filters.
6. Run sync again and confirm the LinkedIn connector uses the 24-hour window. If Google shows CAPTCHA, confirm the run is partial and existing jobs remain.
7. Run `npm run scheduler` only after manual QA, keep the Mac awake, and confirm the next 08:00/16:00 Stockholm calculation in Terminal.
