import { describe, expect, it } from "vitest";

import { classifyPageStatus } from "./page-status";

describe("classifyPageStatus", () => {
  it("classifies HTTP 429 as blocked", () => {
    expect(
      classifyPageStatus({
        status: 429,
        url: "https://jobs.example.com/roles/123",
        text: "Apply now",
      }),
    ).toBe("blocked");
  });

  it.each([
    ["CAPTCHA copy", "https://jobs.example.com/roles/123", "Complete the CAPTCHA to continue."],
    [
      "security verification copy",
      "https://jobs.example.com/roles/123",
      "Security verification required. Verify you are human to continue.",
    ],
    [
      "unusual traffic copy",
      "https://jobs.example.com/roles/123",
      "We detected unusual traffic from your computer network.",
    ],
    [
      "LinkedIn checkpoint challenge URL",
      "https://www.linkedin.com/checkpoint/challenge/abc123",
      "",
    ],
  ])("classifies %s as blocked", (_case, url, text) => {
    expect(classifyPageStatus({ status: 200, url, text })).toBe("blocked");
  });

  it("recognizes the planned unusual-traffic warning without trailing copy", () => {
    expect(
      classifyPageStatus({
        status: 410,
        url: "https://jobs.example.com/roles/123",
        text: "Our systems have detected unusual traffic. This job is no longer available. Apply now.",
      }),
    ).toBe("blocked");
  });

  it("keeps blocked precedence over stale inactive and login signals", () => {
    expect(
      classifyPageStatus({
        status: 410,
        url: "https://www.linkedin.com/login",
        text: "Complete the CAPTCHA. This job is no longer available. Apply now.",
      }),
    ).toBe("blocked");
  });

  it("does not treat a generic challenge as a blocking signal", () => {
    expect(
      classifyPageStatus({
        status: 200,
        url: "https://jobs.example.com/challenge/123",
        text: "Take on an exciting engineering challenge.",
      }),
    ).toBe("unknown");
  });

  it.each([
    "You will improve our CAPTCHA platform. Apply now.",
    "Build unusual traffic detection systems. Apply now.",
  ])("does not block legitimate job copy mentioning protection terms: %s", (text) => {
    expect(
      classifyPageStatus({
        status: 200,
        url: "https://jobs.example.com/roles/123",
        text,
      }),
    ).toBe("active");
  });

  it.each([
    ["LinkedIn login URL", "https://www.linkedin.com/login?fromSignIn=true", ""],
    [
      "clear English login copy",
      "https://jobs.example.com/roles/123",
      "Sign in to continue to this job.",
    ],
    [
      "clear Swedish login copy",
      "https://jobs.example.com/roles/123",
      "Logga in för att fortsätta till jobbet.",
    ],
  ])("classifies %s as login-required", (_case, url, text) => {
    expect(classifyPageStatus({ status: 200, url, text })).toBe(
      "login-required",
    );
  });

  it("keeps login precedence over inactive and apply signals", () => {
    expect(
      classifyPageStatus({
        status: 410,
        url: "https://www.linkedin.com/uas/login",
        text: "This job is no longer available. Apply now.",
      }),
    ).toBe("login-required");
  });

  it("recognizes the LinkedIn join-or-sign-in gate before stale page copy", () => {
    expect(
      classifyPageStatus({
        status: 410,
        url: "https://www.linkedin.com/jobs/view/123",
        text: "Join LinkedIn or sign in. This job is no longer available. Apply now.",
      }),
    ).toBe("login-required");
  });

  it.each([
    "Your account has been temporarily restricted.",
    "Warning: Your LinkedIn account may be restricted until we verify your identity.",
  ])("classifies LinkedIn account warning copy as blocked: %s", (warning) => {
    expect(
      classifyPageStatus({
        status: 410,
        url: "https://www.linkedin.com/jobs/view/123",
        text: `${warning} Sign in to continue. This job is no longer available. Apply now.`,
      }),
    ).toBe("blocked");
  });

  it.each([404, 410])(
    "classifies HTTP %i as inactive even when apply copy is stale",
    (status) => {
      expect(
        classifyPageStatus({
          status,
          url: "https://jobs.example.com/roles/123",
          text: "Apply now",
        }),
      ).toBe("inactive");
    },
  );

  it("classifies a parseable validThrough strictly before now as inactive", () => {
    expect(
      classifyPageStatus(
        {
          status: 200,
          url: "https://jobs.example.com/roles/123",
          text: "Apply now",
          validThrough: "2026-07-15T09:59:59.999Z",
        },
        new Date("2026-07-15T10:00:00.000Z"),
      ),
    ).toBe("inactive");
  });

  it("keeps a date-only validThrough active through its calendar day", () => {
    const snapshot = {
      status: 200,
      url: "https://jobs.example.com/roles/123",
      text: "Apply now",
      validThrough: "2026-07-15",
    };

    expect(
      classifyPageStatus(snapshot, new Date("2026-07-15T23:59:59.999Z")),
    ).toBe("active");
    expect(
      classifyPageStatus(snapshot, new Date("2026-07-16T00:00:00.000Z")),
    ).toBe("inactive");
  });

  it.each([
    ["equal to now", "2026-07-15T10:00:00.000Z"],
    ["after now", "2026-07-15T10:00:00.001Z"],
    ["invalid", "not-a-date"],
    ["invalid calendar date", "2026-02-30"],
    ["invalid leap date", "2025-02-29"],
  ])("does not classify a validThrough %s as inactive", (_case, validThrough) => {
    expect(
      classifyPageStatus(
        {
          status: 200,
          url: "https://jobs.example.com/roles/123",
          text: "",
          validThrough,
        },
        new Date("2026-07-15T10:00:00.000Z"),
      ),
    ).toBe("unknown");
  });

  it.each([
    ["expired English copy", "This job has expired."],
    ["closed English copy", "This job posting is closed."],
    ["filled English copy", "This position has been filled."],
    ["unavailable English copy", "This job is no longer available."],
    ["expired Swedish copy", "Annonsen har gått ut."],
    ["closed Swedish copy", "Ansökan är stängd."],
    ["filled Swedish copy", "Tjänsten är tillsatt."],
    ["unavailable Swedish copy", "Tjänsten är inte längre tillgänglig."],
  ])("classifies %s as inactive before apply copy", (_case, inactiveCopy) => {
    expect(
      classifyPageStatus({
        status: 200,
        url: "https://jobs.example.com/roles/123",
        text: `${inactiveCopy} Apply now. Ansök nu.`,
      }),
    ).toBe("inactive");
  });

  it.each(["Applications are closed", "Application is closed"])(
    "classifies %s as inactive before stale apply copy",
    (text) => {
      expect(
        classifyPageStatus({
          status: 200,
          url: "https://jobs.example.com/roles/123",
          text: `${text}. Apply now.`,
        }),
      ).toBe("inactive");
    },
  );

  it("does not treat non-terminal filled-position prose as inactive", () => {
    expect(
      classifyPageStatus({
        status: 200,
        url: "https://jobs.example.com/roles/123",
        text: "This position is filled with opportunities. Apply now.",
      }),
    ).toBe("active");
  });

  it("requires filled-position copy to be a terminal status", () => {
    expect(
      classifyPageStatus({
        status: 200,
        url: "https://jobs.example.com/roles/123",
        text: "This role is filled to the brim with opportunities. Apply now.",
      }),
    ).toBe("active");
  });

  it.each([
    ["English Apply now action", "Apply now"],
    ["English job application action", "Apply for this job"],
    ["Swedish Ansök nu action", "Ansök nu"],
    ["Swedish application action", "Skicka in din ansökan"],
  ])("classifies %s as active", (_case, text) => {
    expect(
      classifyPageStatus({
        status: 200,
        url: "https://jobs.example.com/roles/123",
        text,
      }),
    ).toBe("active");
  });

  it("returns unknown without a reliable page-state signal", () => {
    expect(
      classifyPageStatus({
        status: 200,
        url: "https://jobs.example.com/roles/123",
        text: "Senior TypeScript engineer in Stockholm",
      }),
    ).toBe("unknown");
  });
});
