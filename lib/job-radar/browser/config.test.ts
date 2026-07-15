import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { getBrowserDiscoveryConfig } from "./config";

describe("getBrowserDiscoveryConfig", () => {
  const cwd = "/tmp/job-radar";

  it("returns safe disabled defaults", () => {
    expect(getBrowserDiscoveryConfig({}, cwd)).toEqual({
      enabled: false,
      profilePath: resolve(cwd, ".data/browser-profile"),
      statePath: resolve(cwd, ".data/browser-state.json"),
      linkedinSearchUrls: [],
      linkedinBootstrapMaxResults: 200,
      linkedinIncrementalMaxResults: 100,
      linkedinMaxDetails: 80,
      googleMaxQueries: 8,
      googleMaxPages: 2,
    });
  });

  it("parses explicit opt-in configuration", () => {
    expect(
      getBrowserDiscoveryConfig(
        {
          JOB_RADAR_BROWSER_DISCOVERY: "1",
          JOB_RADAR_BROWSER_PROFILE_PATH: "profiles/linkedin",
          JOB_RADAR_BROWSER_STATE_PATH: "/var/tmp/job-radar-state.json",
          LINKEDIN_SEARCH_URLS:
            "https://www.linkedin.com/jobs/search?keywords=typescript|https://www.linkedin.com/jobs/search/?keywords=nextjs",
          LINKEDIN_BOOTSTRAP_MAX_RESULTS: "150",
          LINKEDIN_INCREMENTAL_MAX_RESULTS: "75",
          LINKEDIN_MAX_DETAILS: "40",
          GOOGLE_MAX_QUERIES: "5",
          GOOGLE_MAX_PAGES: "1",
        },
        cwd,
      ),
    ).toEqual({
      enabled: true,
      profilePath: resolve(cwd, "profiles/linkedin"),
      statePath: "/var/tmp/job-radar-state.json",
      linkedinSearchUrls: [
        "https://www.linkedin.com/jobs/search?keywords=typescript",
        "https://www.linkedin.com/jobs/search/?keywords=nextjs",
      ],
      linkedinBootstrapMaxResults: 150,
      linkedinIncrementalMaxResults: 75,
      linkedinMaxDetails: 40,
      googleMaxQueries: 5,
      googleMaxPages: 1,
    });
  });

  it("rejects LinkedIn URLs outside the approved jobs search path", () => {
    expect(() =>
      getBrowserDiscoveryConfig(
        {
          LINKEDIN_SEARCH_URLS:
            "https://www.linkedin.com/jobs/search?keywords=typescript|https://www.linkedin.com/feed/",
        },
        cwd,
      ),
    ).toThrowError(
      "[job radar browser] LINKEDIN_SEARCH_URLS must contain only https://www.linkedin.com/jobs/search URLs.",
    );
  });

  it("rejects LinkedIn search URLs on a non-standard origin", () => {
    expect(() =>
      getBrowserDiscoveryConfig(
        {
          LINKEDIN_SEARCH_URLS:
            "https://www.linkedin.com:444/jobs/search?keywords=typescript",
        },
        cwd,
      ),
    ).toThrowError(
      "[job radar browser] LINKEDIN_SEARCH_URLS must contain only https://www.linkedin.com/jobs/search URLs.",
    );
  });

  it("rejects limit values above their hard caps", () => {
    expect(() =>
      getBrowserDiscoveryConfig(
        { LINKEDIN_BOOTSTRAP_MAX_RESULTS: "201" },
        cwd,
      ),
    ).toThrowError(
      "[job radar browser] LINKEDIN_BOOTSTRAP_MAX_RESULTS must be between 1 and 200.",
    );
  });
});
