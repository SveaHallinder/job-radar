import { fetchJson, htmlToText } from "../fetch";
import type { JobConnector, SourceJob } from "../types";

export interface GreenhouseJob {
  id: number;
  title: string;
  absolute_url: string;
  location?: { name?: string | null } | null;
  content?: string | null;
  updated_at?: string | null;
  departments?: Array<{ name?: string | null }>;
  metadata?: Array<{ name?: string | null; value?: unknown }>;
}

interface GreenhouseResponse {
  jobs: GreenhouseJob[];
}

function metadataText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.filter((item) => typeof item === "string").join(" · ");
  return "";
}

export function mapGreenhouseJob(job: GreenhouseJob, company: string): SourceJob {
  const employmentMetadata = job.metadata?.find((item) =>
    /employment|commitment|job type/i.test(item.name || ""),
  );
  const location = job.location?.name || "Location not specified";

  return {
    source: "Greenhouse",
    externalId: String(job.id),
    sourceUrl: job.absolute_url,
    originalUrl: job.absolute_url,
    title: job.title,
    company,
    location,
    country: null,
    description: htmlToText(job.content || ""),
    engagementType: metadataText(employmentMetadata?.value) || null,
    remote: /\bremote\b/i.test(location) ? true : null,
    tags:
      job.departments?.flatMap((department) => (department.name ? [department.name] : [])) || [],
    postedAt: job.updated_at || null,
  };
}

export class GreenhouseConnector implements JobConnector {
  readonly name: string;

  constructor(
    private readonly company: string,
    private readonly boardToken: string,
  ) {
    this.name = `Greenhouse · ${company}`;
  }

  async fetchJobs(): Promise<SourceJob[]> {
    const url = new URL(
      `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(this.boardToken)}/jobs`,
    );
    url.searchParams.set("content", "true");
    const response = await fetchJson<GreenhouseResponse>(url.toString(), {}, this.name);
    return response.jobs.map((job) => mapGreenhouseJob(job, this.company));
  }
}
