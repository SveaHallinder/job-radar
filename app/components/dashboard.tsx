"use client";

import { useActionState, useMemo, useState } from "react";

import {
  addSearchAction,
  deleteSearchAction,
  requestBrowserSyncAction,
  runSyncAction,
} from "../actions";
import type { BrowserSyncActionState, SyncActionState } from "../actions";
import type {
  DashboardStats,
  SearchRecord,
  StoredJob,
  SyncRequest,
} from "@/lib/job-radar/types";

interface DashboardProps {
  jobs: StoredJob[];
  stats: DashboardStats;
  searches: SearchRecord[];
}

const initialSyncState: SyncActionState = {
  status: "idle",
  message: "",
  summary: null,
};

const initialBrowserSyncState: BrowserSyncActionState = {
  status: "idle",
  message: "",
  request: null,
};

function formatDateTime(value: string | null | undefined): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("sv-SE", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/Stockholm",
  }).format(date);
}

// The persisted request (from the DB) tells the visitor where their LinkedIn
// request stands — it survives reloads and reflects what the worker wrote back.
function browserRequestCaption(request: SyncRequest | null): string {
  if (!request) return "Kräver att din dator är igång och inloggad på LinkedIn.";
  switch (request.status) {
    case "pending":
      return "Väntar på att din dator ska köra den…";
    case "running":
      return "Din dator kör LinkedIn-synken just nu…";
    case "done":
      return `Senaste LinkedIn-synk klar ${formatDateTime(request.completedAt)}.`;
    case "failed":
      return `Senaste LinkedIn-synk misslyckades ${formatDateTime(request.completedAt)}.`;
    default:
      return "";
  }
}

function RadarMark() {
  return (
    <span className="radar-mark" aria-hidden="true">
      <span />
      <span />
      <i />
    </span>
  );
}

function ArrowUpRight() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M5 15 15 5M7 5h8v8" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <circle cx="8.5" cy="8.5" r="5.5" />
      <path d="m13 13 4 4" />
    </svg>
  );
}

function formatDate(value: string | null): string {
  if (!value) return "Datum saknas";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Datum saknas";
  return new Intl.DateTimeFormat("sv-SE", {
    day: "numeric",
    month: "short",
    timeZone: "Europe/Stockholm",
  }).format(date);
}

function formatLastRun(value: string | undefined): string {
  if (!value) return "Inte körd ännu";
  const date = new Date(value);
  return new Intl.DateTimeFormat("sv-SE", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/Stockholm",
  }).format(date);
}

export function Dashboard({ jobs, stats, searches }: DashboardProps) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("All");
  const [source, setSource] = useState("All");
  const [syncState, syncAction, syncPending] = useActionState(
    runSyncAction,
    initialSyncState,
  );
  const [browserSyncState, browserSyncAction, browserSyncPending] =
    useActionState(requestBrowserSyncAction, initialBrowserSyncState);

  // Prefer the freshly-queued request from the action; otherwise fall back to
  // the last known request loaded with the page.
  const browserRequest = browserSyncState.request ?? stats.latestBrowserRequest;

  const sources = useMemo(
    () => [...new Set(jobs.map((job) => job.source))].sort((a, b) => a.localeCompare(b)),
    [jobs],
  );
  const filteredJobs = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase("sv");
    return jobs.filter((job) => {
      const searchable = [
        job.title,
        job.company,
        job.location,
        job.category,
        job.source,
        ...job.matchReasons,
      ]
        .join(" ")
        .toLocaleLowerCase("sv");
      return (
        (!normalizedQuery || searchable.includes(normalizedQuery)) &&
        (category === "All" || job.category === category) &&
        (source === "All" || job.source === source)
      );
    });
  }, [category, jobs, query, source]);

  const resetFilters = () => {
    setQuery("");
    setCategory("All");
    setSource("All");
  };

  const lastRunStatus = stats.lastRun?.status;

  return (
    <main className="app-shell">
      <header className="topbar">
        <a className="brand" href="#top" aria-label="Job Radar hem">
          <RadarMark />
          <span>JOB RADAR</span>
          <small>SE / EMEA</small>
        </a>
        <div className="topbar-meta">
          <span className="live-dot" />
          <span>Strikt matchning</span>
          <span className="topbar-separator">Europe/Stockholm</span>
        </div>
      </header>

      <section className="hero" id="top">
        <div className="hero-copy">
          <p className="eyebrow">Remote contract intelligence · 2026</p>
          <h1>
            Färre jobb.
            <br />
            <em>Bättre signal.</em>
          </h1>
          <p className="hero-intro">
            En skoningslöst filtrerad radar för remoteuppdrag inom sales och marketing—
            öppna för Sverige, Bukarest och EMEA.
          </p>
        </div>

        <aside className="logic-card" aria-label="Aktiv matchningslogik">
          <div className="logic-card-head">
            <span>Aktiv profil</span>
            <span className="logic-id">JR—001</span>
          </div>
          <div className="logic-expression">
            <span>REMOTE</span>
            <b>AND</b>
            <span>CONTRACT / FREELANCE</span>
            <b>AND</b>
            <span>SALES / MARKETING</span>
            <b>AND</b>
            <span>SE / RO / EMEA</span>
          </div>
          <div className="logic-card-foot">
            <span>Inga sekundära träffar</span>
            <span className="strict-pill">STRICT</span>
          </div>
        </aside>
      </section>

      <section className="command-strip" aria-label="Synk och statistik">
        <div className="sync-cluster">
          <form action={syncAction} className="sync-form">
            <button className="sync-button" type="submit" disabled={syncPending}>
              <span>{syncPending ? "Skannar källor" : "Kör sökning nu"}</span>
              <span className={syncPending ? "sync-icon is-spinning" : "sync-icon"}>↻</span>
            </button>
          </form>

          <form action={browserSyncAction} className="sync-form">
            <button
              className="sync-button secondary"
              type="submit"
              disabled={browserSyncPending || browserRequest?.status === "pending" || browserRequest?.status === "running"}
              title="Kör en full synk inklusive LinkedIn via din egen dator"
            >
              <span>
                {browserSyncPending
                  ? "Begär…"
                  : browserRequest?.status === "pending"
                    ? "I kö…"
                    : browserRequest?.status === "running"
                      ? "Kör på din dator…"
                      : "Synka LinkedIn via min dator"}
              </span>
              <span className="sync-icon">↯</span>
            </button>
            <span className="sync-caption">{browserRequestCaption(browserRequest)}</span>
          </form>
        </div>

        <div className="stat-cell">
          <span className="stat-label">Aktiva träffar</span>
          <strong>{stats.totalJobs.toString().padStart(2, "0")}</strong>
        </div>
        <div className="stat-cell accent-stat">
          <span className="stat-label">Nya senast</span>
          <strong>+{stats.newJobs.toString().padStart(2, "0")}</strong>
        </div>
        <div className="stat-cell last-run-cell">
          <span className="stat-label">Senaste körning</span>
          <strong>{formatLastRun(stats.lastRun?.completedAt)}</strong>
          <span className={`run-state ${lastRunStatus ?? "idle"}`}>
            {lastRunStatus === "success"
              ? "Alla källor klara"
              : lastRunStatus === "partial"
                ? "Delvis klar"
                : lastRunStatus === "failed"
                  ? "Körning misslyckades"
                  : "Väntar på första körning"}
          </span>
        </div>
      </section>

      {syncState.status !== "idle" ? (
        <div className={`sync-notice ${syncState.status}`} role="status">
          <span>{syncState.status === "success" ? "SYNC COMPLETE" : "SYNC ERROR"}</span>
          <p>{syncState.message}</p>
        </div>
      ) : null}

      {browserSyncState.status !== "idle" ? (
        <div
          className={`sync-notice ${browserSyncState.status === "queued" ? "success" : "error"}`}
          role="status"
        >
          <span>{browserSyncState.status === "queued" ? "LINKEDIN I KÖ" : "SYNC ERROR"}</span>
          <p>{browserSyncState.message}</p>
        </div>
      ) : null}

      <section className="searches-section" aria-label="Sökningar">
        <div className="searches-heading">
          <div>
            <p className="eyebrow">Sökprofiler</p>
            <h2>Vad radarn letar efter</h2>
          </div>
          <p className="searches-note">
            Sökorden styr alla källor (JobTech, Arbeitnow, Jooble och LinkedIn).
            {searches.length === 0
              ? " Inga sökningar ännu — radarn använder standard (sales, marketing)."
              : null}
          </p>
        </div>

        <form action={addSearchAction} className="search-add-form">
          <label className="search-input">
            <span>Sökord</span>
            <input
              type="text"
              name="keywords"
              required
              placeholder="t.ex. account executive"
            />
          </label>
          <label className="search-input">
            <span>Ort (valfritt)</span>
            <input type="text" name="location" placeholder="t.ex. Sverige" />
          </label>
          <label className="search-remote">
            <input type="checkbox" name="remoteOnly" defaultChecked />
            <span>Bara remote</span>
          </label>
          <button type="submit" className="search-add-button">
            Lägg till
          </button>
        </form>

        {searches.length ? (
          <ul className="search-list">
            {searches.map((search) => (
              <li key={search.id} className="search-chip">
                <span className="search-chip-main">
                  <strong>{search.keywords}</strong>
                  {search.location ? <span>· {search.location}</span> : null}
                  {search.remoteOnly ? (
                    <span className="search-chip-remote">remote</span>
                  ) : null}
                </span>
                <form action={deleteSearchAction}>
                  <input type="hidden" name="id" value={search.id} />
                  <button
                    type="submit"
                    className="search-chip-remove"
                    aria-label={`Ta bort sökningen ${search.keywords}`}
                  >
                    ✕
                  </button>
                </form>
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      <section className="results-section">
        <div className="results-heading">
          <div>
            <p className="eyebrow">Opportunity feed</p>
            <h2>Matchade uppdrag</h2>
          </div>
          <p className="results-count">
            Visar <strong>{filteredJobs.length}</strong> av {jobs.length}
          </p>
        </div>

        <div className="filter-bar">
          <label className="search-field">
            <span className="sr-only">Sök jobb</span>
            <SearchIcon />
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Sök titel, bolag eller plats"
            />
          </label>
          <label className="select-field">
            <span>Kategori</span>
            <select value={category} onChange={(event) => setCategory(event.target.value)}>
              <option value="All">Alla</option>
              <option value="Sales">Sales</option>
              <option value="Marketing">Marketing</option>
            </select>
          </label>
          <label className="select-field">
            <span>Källa</span>
            <select value={source} onChange={(event) => setSource(event.target.value)}>
              <option value="All">Alla</option>
              {sources.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
          </label>
        </div>

        {filteredJobs.length ? (
          <div className="job-list">
            {filteredJobs.map((job, index) => (
              <article
                className="job-card"
                key={job.id}
                style={{ "--card-index": Math.min(index, 8) } as React.CSSProperties}
              >
                <div className="job-index">{String(index + 1).padStart(2, "0")}</div>
                <div className="job-main">
                  <div className="job-kicker">
                    <span className={`category-tag ${job.category.toLocaleLowerCase()}`}>
                      {job.category}
                    </span>
                    <span>{job.normalizedEngagementType}</span>
                    <span>{formatDate(job.postedAt)}</span>
                  </div>
                  <h3>{job.title}</h3>
                  <p className="company-line">
                    <strong>{job.company}</strong>
                    <span>{job.location}</span>
                  </p>
                  <p className="job-excerpt">{job.description}</p>
                  <div className="reason-list" aria-label="Matchningsorsaker">
                    {job.matchReasons.map((reason) => (
                      <span key={reason}>{reason}</span>
                    ))}
                  </div>
                </div>
                <div className="job-side">
                  <span className="source-label">Via {job.source}</span>
                  <a href={job.originalUrl} target="_blank" rel="noreferrer">
                    <span>Öppna original</span>
                    <ArrowUpRight />
                  </a>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <div className="empty-state">
            <div className="empty-radar" aria-hidden="true">
              <RadarMark />
            </div>
            <p className="eyebrow">No signal detected</p>
            <h3>{jobs.length ? "Inga jobb matchar den här vyn" : "Radarn är redo"}</h3>
            <p>
              {jobs.length
                ? "Nollställ filtren för att se hela den strikt matchade listan igen."
                : "Kör den första sökningen. JobTech och Arbeitnow fungerar direkt; lokal LinkedIn- och webbsökning aktiveras uttryckligen via miljövariabler."}
            </p>
            {jobs.length ? (
              <button type="button" className="text-button" onClick={resetFilters}>
                Nollställ filter
              </button>
            ) : null}
          </div>
        )}
      </section>

      <footer>
        <span>JOB RADAR / LOCAL MVP</span>
        <span>08:00 + 16:00 · EUROPE/STOCKHOLM</span>
        <span>PERSONAL BROWSER DISCOVERY</span>
      </footer>
    </main>
  );
}
