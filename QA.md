# Localhost QA script

1. Run `nvm use && npm install && cp .env.example .env.local && npm run dev`, then open `http://localhost:3000`. Confirm the editorial dashboard renders and the fixed profile states `REMOTE AND CONTRACT / FREELANCE AND SALES / MARKETING AND SE / RO / EMEA`.
2. With an empty `.data/` directory, confirm the “Radarn är redo” empty state is visible and no premium or disabled product controls appear.
3. Click **Kör sökning nu**. Confirm the button shows a loading state, the page reports a completed or partial sync, and existing results remain visible if one source fails.
4. Enter part of a title or company in search, then switch between Sales and Marketing and between available sources. Confirm the visible count and cards update without navigation.
5. Open **Öppna original** on a result. Confirm it opens a new tab on an employer, ATS, or configured job-source URL rather than LinkedIn.
6. Resize the browser below 760px. Confirm the hero, active profile, statistics, filters, job cards, empty state, and original-link action remain readable with no horizontal scrolling.
