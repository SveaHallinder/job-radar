import { fetchJson, htmlToText } from "../fetch";
import type { JobConnector, SearchSpec, SourceJob } from "../types";

export interface JoobleJob {
  id: string | number;
  title: string;
  location: string;
  snippet: string;
  source?: string;
  type?: string;
  link: string;
  company?: string;
  updated?: string;
}

interface JoobleResponse {
  jobs: JoobleJob[];
}

export function mapJoobleJob(job: JoobleJob): SourceJob {
  return {
    source: "Jooble",
    externalId: String(job.id),
    sourceUrl: job.link,
    originalUrl: job.link,
    title: job.title,
    company: job.company || "Unknown company",
    location: job.location || "Europe",
    country: null,
    description: htmlToText(job.snippet || ""),
    engagementType: job.type || null,
    remote: null,
    tags: job.source ? [job.source] : [],
    postedAt: job.updated || null,
  };
}

export class JoobleConnector implements JobConnector {
  readonly name = "Jooble";

  constructor(
    private readonly apiKey: string,
    private readonly configuredSearches?: SearchSpec[],
  ) {}

  async fetchJobs(): Promise<SourceJob[]> {
    const configured = (this.configuredSearches ?? [])
      .map((search) => ({
        keywords: search.keywords.trim(),
        location: search.location.trim() || "Europe",
      }))
      .filter((search) => search.keywords);
    const searches = configured.length
      ? configured
      : ["Europe", "Sweden", "Bucharest"].flatMap((location) =>
          ["remote contract sales", "remote freelance marketing"].map((keywords) => ({
            keywords,
            location,
          })),
        );
    const responses = await Promise.all(
      searches.map((body) =>
        fetchJson<JoobleResponse>(
          `https://jooble.org/api/${encodeURIComponent(this.apiKey)}`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ ...body, page: "1", ResultOnPage: "20" }),
          },
          `Jooble ${body.location}`,
        ),
      ),
    );
    const jobs = responses.flatMap((response) => response.jobs.map(mapJoobleJob));
    return [...new Map(jobs.map((job) => [job.externalId, job])).values()];
  }
}
