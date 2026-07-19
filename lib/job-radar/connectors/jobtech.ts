import { fetchJson } from "../fetch";
import { keywordsFromSearches } from "../searches";
import type { JobConnector, SearchSpec, SourceJob } from "../types";

export interface JobTechHit {
  id: string;
  headline: string;
  description?: { text?: string | null } | null;
  employer?: { name?: string | null } | null;
  workplace_address?: {
    city?: string | null;
    region?: string | null;
    country?: string | null;
  } | null;
  application_details?: { url?: string | null } | null;
  publication_date?: string | null;
  occupation?: { label?: string | null } | null;
  duration?: { label?: string | null } | null;
  employment_type?: { label?: string | null } | null;
}

interface JobTechResponse {
  hits: JobTechHit[];
}

export function mapJobTechHit(hit: JobTechHit): SourceJob {
  const locationParts = [
    hit.workplace_address?.city,
    hit.workplace_address?.region,
    hit.workplace_address?.country,
  ].filter((part, index, parts): part is string => Boolean(part) && parts.indexOf(part) === index);
  const fallbackUrl = `https://arbetsformedlingen.se/platsbanken/annonser/${hit.id}`;
  const originalUrl = hit.application_details?.url || fallbackUrl;

  return {
    source: "JobTech",
    externalId: hit.id,
    sourceUrl: fallbackUrl,
    originalUrl,
    title: hit.headline,
    company: hit.employer?.name || "Unknown company",
    location: locationParts.join(", ") || "Sweden",
    country: hit.workplace_address?.country || "Sweden",
    description: hit.description?.text || "",
    engagementType:
      [hit.employment_type?.label, hit.duration?.label].filter(Boolean).join(" · ") || null,
    remote: null,
    tags: hit.occupation?.label ? [hit.occupation.label] : [],
    postedAt: hit.publication_date || null,
  };
}

export class JobTechConnector implements JobConnector {
  readonly name = "JobTech";

  constructor(private readonly searches?: SearchSpec[]) {}

  async fetchJobs(): Promise<SourceJob[]> {
    const responses = await Promise.all(
      keywordsFromSearches(this.searches).map((query) => {
        const url = new URL("https://jobsearch.api.jobtechdev.se/search");
        url.searchParams.set("q", query);
        url.searchParams.set("limit", "100");
        return fetchJson<JobTechResponse>(url.toString(), {}, `JobTech ${query}`);
      }),
    );

    const jobs = responses.flatMap((response) => response.hits.map(mapJobTechHit));
    return [...new Map(jobs.map((job) => [job.externalId, job])).values()];
  }
}
