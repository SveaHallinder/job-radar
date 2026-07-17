import { describe, expect, it } from "vitest";

import { canonicalizeUrl, matchJob } from "./matcher";

const baseJob = {
  source: "Fixture",
  externalId: "job-1",
  sourceUrl: "https://source.example/jobs/job-1",
  originalUrl: "https://jobs.example.com/job-1",
  title: "Freelance Marketing Consultant",
  company: "Northstar AB",
  location: "Stockholm, Sweden",
  country: "Sweden",
  description:
    "This six-month freelance contract is fully remote. Applicants in Sweden and EMEA are welcome.",
  engagementType: "Contract",
  remote: true,
  tags: ["Marketing", "Freelance"],
  postedAt: "2026-07-15T08:00:00.000Z",
};

describe("matchJob", () => {
  it("accepts a remote contract marketing role available in Sweden", () => {
    expect(matchJob(baseJob)).toMatchObject({
      matched: true,
      category: "Marketing",
      engagementType: "Contract",
      matchReasons: expect.arrayContaining([
        "Remote",
        "Contract / freelance",
        "Marketing",
        "Sweden / EMEA eligible",
      ]),
    });
  });

  it("rejects a permanent remote sales role", () => {
    expect(
      matchJob({
        ...baseJob,
        title: "Remote Sales Manager",
        description: "A permanent full-time remote role based in Sweden.",
        engagementType: "Full-time",
        tags: ["Sales"],
      }),
    ).toMatchObject({ matched: false, rejectionReason: "Not contract or freelance" });
  });

  it("does not treat B2B sales as a B2B contractor engagement", () => {
    expect(
      matchJob({
        ...baseJob,
        title: "B2B Sales Representative",
        description:
          "Build the B2B sales pipeline for our SaaS product. This is a remote permanent position in Sweden.",
        engagementType: "Permanent employment",
        tags: ["Sales"],
      }),
    ).toMatchObject({ matched: false, rejectionReason: "Not contract or freelance" });
  });

  it("accepts B2B when it explicitly describes the engagement basis", () => {
    expect(
      matchJob({
        ...baseJob,
        title: "Remote Account Executive",
        description: "Six-month role in Europe offered on a B2B contract basis.",
        engagementType: null,
        tags: ["Sales"],
      }),
    ).toMatchObject({ matched: true, engagementType: "B2B" });
  });

  it("rejects hybrid work even when the source marks it remote", () => {
    expect(
      matchJob({
        ...baseJob,
        description: "Freelance marketing consultant. Hybrid, three office days in Stockholm.",
      }),
    ).toMatchObject({ matched: false, rejectionReason: "Not fully remote" });
  });

  it("rejects an engineering role that only mentions a sales team", () => {
    expect(
      matchJob({
        ...baseJob,
        title: "Freelance Data Engineer",
        tags: ["Engineering"],
        description:
          "Remote B2B contract in Europe, building analytics for the sales and marketing teams.",
      }),
    ).toMatchObject({ matched: false, rejectionReason: "Outside sales and marketing" });
  });

  it("rejects a remote role limited to the United States", () => {
    expect(
      matchJob({
        ...baseJob,
        title: "Contract Sales Director",
        location: "United States",
        country: "United States",
        tags: ["Sales", "Contract"],
        description: "Remote contract. Candidates must be located in the US only.",
      }),
    ).toMatchObject({ matched: false, rejectionReason: "Outside Sweden / EMEA" });
  });

  it("does not admit an unrelated role just because Swedish is required", () => {
    expect(
      matchJob({
        ...baseJob,
        title: "Swedish Customer Support Contractor",
        tags: ["Customer Support"],
        description: "Fully remote freelance role for Swedish speakers in Europe.",
      }),
    ).toMatchObject({ matched: false, rejectionReason: "Outside sales and marketing" });
  });

  it("matches an accented Swedish remote contract marketing role", () => {
    expect(
      matchJob({
        ...baseJob,
        title: "Frilans Marknadsföringskonsult",
        location: "Sverige",
        country: "Sverige",
        engagementType: "Konsult",
        remote: false,
        tags: ["Marketing"],
        description:
          "Vi söker en marknadsföringskonsult som kan arbeta hemifrån för försäljning och tillväxt.",
      }),
    ).toMatchObject({
      matched: true,
      category: "Marketing",
    });
  });

  it("classifies a standalone accented Swedish category word without a category tag", () => {
    // "Försäljning" as a standalone word only matches the ASCII "forsaljning"
    // pattern once diacritics are stripped in classifyCategory.
    expect(
      matchJob({
        ...baseJob,
        title: "Försäljning Specialist",
        location: "Sverige",
        country: "Sverige",
        engagementType: "Konsult",
        remote: true,
        tags: ["Remote"],
        description: "Distansuppdrag för en självständig konsult.",
      }),
    ).toMatchObject({
      matched: true,
      category: "Sales",
    });
  });

  it("matches a remote freelance marketing role based only in Germany", () => {
    expect(
      matchJob({
        ...baseJob,
        title: "Freelance Marketing Manager",
        location: "Germany",
        country: "Germany",
        engagementType: "Freelance",
        remote: true,
        tags: ["Marketing"],
        description: "Fully remote freelance marketing role.",
      }),
    ).toMatchObject({
      matched: true,
      category: "Marketing",
    });
  });

  it("rejects a remote contract role restricted to US based applicants", () => {
    expect(
      matchJob({
        ...baseJob,
        title: "Contract Marketing Manager",
        location: "Remote, Europe",
        country: null,
        engagementType: "Contract",
        remote: true,
        tags: ["Marketing", "Contract"],
        description: "Remote contract marketing role. US based applicants preferred.",
      }),
    ).toMatchObject({ matched: false, rejectionReason: "Outside Sweden / EMEA" });
  });

  it("still matches an eligible EMEA remote contract role (no regression)", () => {
    expect(
      matchJob({
        ...baseJob,
        title: "Freelance Marketing Consultant",
        location: "Remote - EMEA",
        country: null,
        tags: ["Marketing", "Freelance"],
        description: "Fully remote freelance contract for marketing across EMEA and Europe.",
      }),
    ).toMatchObject({
      matched: true,
      category: "Marketing",
      matchReasons: expect.arrayContaining(["Sweden / EMEA eligible"]),
    });
  });

  it("adds Swedish as a relevance signal for an eligible role", () => {
    expect(
      matchJob({
        ...baseJob,
        title: "Swedish-speaking Freelance Account Executive",
        tags: ["Sales"],
      }),
    ).toMatchObject({
      matched: true,
      category: "Sales",
      matchReasons: expect.arrayContaining(["Swedish relevance"]),
    });
  });
});

describe("canonicalizeUrl", () => {
  it("removes tracking parameters and fragments without removing job identifiers", () => {
    expect(
      canonicalizeUrl(
        "https://jobs.example.com/opening?gh_jid=42&utm_source=arbeitnow&ref=feed#apply",
      ),
    ).toBe("https://jobs.example.com/opening?gh_jid=42");
  });
});
