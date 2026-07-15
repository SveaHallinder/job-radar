import { describe, expect, it } from "vitest";

import { mapArbeitnowJob } from "./arbeitnow";
import { mapGreenhouseJob } from "./greenhouse";
import { mapJobTechHit } from "./jobtech";
import { mapJoobleJob } from "./jooble";
import { mapLeverJob } from "./lever";

describe("connector mappers", () => {
  it("maps a JobTech hit", () => {
    expect(
      mapJobTechHit({
        id: "31270000",
        headline: "Freelance Marketing Consultant",
        description: { text: "Remote contract across Sweden." },
        employer: { name: "Example AB" },
        workplace_address: { city: "Stockholm", country: "Sverige" },
        application_details: { url: "https://example.com/jobs/marketing" },
        publication_date: "2026-07-15T08:00:00",
        occupation: { label: "Marknadsförare" },
        duration: { label: "6 månader eller längre" },
        employment_type: { label: "Behovsanställning" },
      }),
    ).toMatchObject({
      source: "JobTech",
      externalId: "31270000",
      title: "Freelance Marketing Consultant",
      company: "Example AB",
      location: "Stockholm, Sverige",
      originalUrl: "https://example.com/jobs/marketing",
      tags: ["Marknadsförare"],
    });
  });

  it("maps an Arbeitnow job and its direct-apply redirect", () => {
    expect(
      mapArbeitnowJob({
        slug: "freelance-growth-marketer",
        company_name: "Bright GmbH",
        title: "Freelance Growth Marketer",
        description: "<p>Remote B2B role in Europe.</p>",
        remote: true,
        url: "https://www.arbeitnow.com/jobs/freelance-growth-marketer",
        tags: ["Marketing"],
        job_types: ["Freelance"],
        location: "Europe",
        created_at: 1_783_555_200,
      }),
    ).toMatchObject({
      source: "Arbeitnow",
      remote: true,
      originalUrl: "https://www.arbeitnow.com/jobs/freelance-growth-marketer/apply",
      engagementType: "Freelance",
      description: "Remote B2B role in Europe.",
    });
  });

  it("maps a Jooble result", () => {
    expect(
      mapJoobleJob({
        id: 987,
        title: "Contract Sales Lead",
        location: "Bucharest, Romania",
        snippet: "Remote contractor role.",
        source: "Company careers",
        type: "Contract",
        link: "https://ro.jooble.org/desc/987",
        company: "North SRL",
        updated: "2026-07-15T08:00:00Z",
      }),
    ).toMatchObject({
      source: "Jooble",
      externalId: "987",
      location: "Bucharest, Romania",
      originalUrl: "https://ro.jooble.org/desc/987",
      engagementType: "Contract",
    });
  });

  it("maps a Greenhouse posting", () => {
    expect(
      mapGreenhouseJob(
        {
          id: 42,
          title: "Freelance Demand Generation Manager",
          absolute_url: "https://job-boards.greenhouse.io/acme/jobs/42",
          location: { name: "Remote, Europe" },
          content: "<p>Six month consulting engagement.</p>",
          updated_at: "2026-07-15T08:00:00Z",
          departments: [{ name: "Marketing" }],
          metadata: [{ name: "Employment type", value: "Contract" }],
        },
        "Acme",
      ),
    ).toMatchObject({
      source: "Greenhouse",
      company: "Acme",
      engagementType: "Contract",
      tags: ["Marketing"],
    });
  });

  it("maps a Lever posting", () => {
    expect(
      mapLeverJob(
        {
          id: "lever-7",
          text: "Contract Account Executive",
          hostedUrl: "https://jobs.lever.co/acme/lever-7",
          applyUrl: "https://jobs.lever.co/acme/lever-7/apply",
          descriptionPlain: "Fully remote across EMEA.",
          categories: {
            location: "Remote - EMEA",
            team: "Sales",
            commitment: "Contract",
          },
          createdAt: 1_783_555_200_000,
        },
        "Acme",
      ),
    ).toMatchObject({
      source: "Lever",
      company: "Acme",
      engagementType: "Contract",
      remote: true,
      tags: ["Sales", "Contract"],
    });
  });
});
