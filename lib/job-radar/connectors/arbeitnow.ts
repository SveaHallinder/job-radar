import { fetchJson, htmlToText } from "../fetch";
import type { JobConnector, SourceJob } from "../types";

export interface ArbeitnowJob {
  slug: string;
  company_name: string;
  title: string;
  description: string;
  remote: boolean;
  url: string;
  tags: string[];
  job_types: string[];
  location: string;
  created_at: number;
}

interface ArbeitnowResponse {
  data: ArbeitnowJob[];
}

export function mapArbeitnowJob(job: ArbeitnowJob): SourceJob {
  return {
    source: "Arbeitnow",
    externalId: job.slug,
    sourceUrl: job.url,
    originalUrl: `${job.url.replace(/\/$/, "")}/apply`,
    title: job.title,
    company: job.company_name,
    location: job.location || "Europe",
    country: null,
    description: htmlToText(job.description),
    engagementType: job.job_types.join(" · ") || null,
    remote: job.remote,
    tags: job.tags,
    postedAt: Number.isFinite(job.created_at)
      ? new Date(job.created_at * 1_000).toISOString()
      : null,
  };
}

export class ArbeitnowConnector implements JobConnector {
  readonly name = "Arbeitnow";

  async fetchJobs(): Promise<SourceJob[]> {
    const responses = await Promise.all(
      ["sales", "marketing"].map((query) => {
        const url = new URL("https://www.arbeitnow.com/api/job-board-api");
        url.searchParams.set("search", query);
        return fetchJson<ArbeitnowResponse>(url.toString(), {}, `Arbeitnow ${query}`);
      }),
    );
    const jobs = responses.flatMap((response) => response.data.map(mapArbeitnowJob));
    return [...new Map(jobs.map((job) => [job.externalId, job])).values()];
  }
}
