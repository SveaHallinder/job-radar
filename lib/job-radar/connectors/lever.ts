import { fetchJson } from "../fetch";
import type { JobConnector, SourceJob } from "../types";

export interface LeverJob {
  id: string;
  text: string;
  hostedUrl: string;
  applyUrl?: string;
  descriptionPlain?: string;
  categories?: {
    location?: string;
    team?: string;
    commitment?: string;
  };
  createdAt?: number;
}

export function mapLeverJob(job: LeverJob, company: string): SourceJob {
  const location = job.categories?.location || "Location not specified";
  const tags = [job.categories?.team, job.categories?.commitment].filter(
    (value): value is string => Boolean(value),
  );

  return {
    source: "Lever",
    externalId: job.id,
    sourceUrl: job.hostedUrl,
    originalUrl: job.applyUrl || job.hostedUrl,
    title: job.text,
    company,
    location,
    country: null,
    description: job.descriptionPlain || "",
    engagementType: job.categories?.commitment || null,
    remote: /\bremote\b/i.test(location) ? true : null,
    tags,
    postedAt: Number.isFinite(job.createdAt)
      ? new Date(job.createdAt as number).toISOString()
      : null,
  };
}

export class LeverConnector implements JobConnector {
  readonly name: string;

  constructor(
    private readonly company: string,
    private readonly site: string,
  ) {
    this.name = `Lever · ${company}`;
  }

  async fetchJobs(): Promise<SourceJob[]> {
    const url = `https://api.lever.co/v0/postings/${encodeURIComponent(this.site)}?mode=json`;
    const response = await fetchJson<LeverJob[]>(url, {}, this.name);
    return response.map((job) => mapLeverJob(job, this.company));
  }
}
