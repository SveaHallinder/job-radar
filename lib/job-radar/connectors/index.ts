import {
  validateActiveJobs,
  type ActiveValidator,
} from "../active-validation";
import { getBrowserDiscoveryConfig } from "../browser/config";
import type { PageSnapshot } from "../browser/page-status";
import { BrowserStateStore } from "../browser/state";
import type { JobConnector } from "../types";
import { ArbeitnowConnector } from "./arbeitnow";
import { GreenhouseConnector } from "./greenhouse";
import { JobTechConnector } from "./jobtech";
import { JoobleConnector } from "./jooble";
import { LeverConnector } from "./lever";

function parseNamedFeeds(value: string | undefined): Array<[string, string]> {
  if (!value?.trim()) return [];

  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .flatMap((entry) => {
      const separator = entry.indexOf(":");
      if (separator < 1 || separator === entry.length - 1) return [];
      return [[entry.slice(0, separator).trim(), entry.slice(separator + 1).trim()]];
    });
}

export interface ConnectorConfiguration {
  connectors: JobConnector[];
  skippedSources: string[];
  activeValidator?: ActiveValidator;
}

export async function getConnectorConfiguration(
  env: NodeJS.ProcessEnv = process.env,
): Promise<ConnectorConfiguration> {
  const connectors: JobConnector[] = [new JobTechConnector(), new ArbeitnowConnector()];
  const skippedSources: string[] = [];

  if (env.JOOBLE_API_KEY?.trim()) {
    connectors.push(new JoobleConnector(env.JOOBLE_API_KEY.trim()));
  } else {
    skippedSources.push("Jooble · missing JOOBLE_API_KEY");
  }

  for (const [company, token] of parseNamedFeeds(env.GREENHOUSE_BOARDS)) {
    connectors.push(new GreenhouseConnector(company, token));
  }

  for (const [company, site] of parseNamedFeeds(env.LEVER_SITES)) {
    connectors.push(new LeverConnector(company, site));
  }

  const browserConfig = getBrowserDiscoveryConfig(env);
  let activeValidator: ActiveValidator | undefined;
  if (!browserConfig.enabled) {
    skippedSources.push("LinkedIn · browser discovery disabled");
    skippedSources.push("Web discovery · browser discovery disabled");
  } else if (browserConfig.linkedinSearchUrls.length === 0) {
    skippedSources.push("LinkedIn · missing LINKEDIN_SEARCH_URLS");
    skippedSources.push("Web discovery · requires configured browser discovery");
  } else {
    // Lazy-import the browser modules so the Playwright dependency they pull in
    // (via BrowserRuntime) stays out of the serverless bundle when browser
    // discovery is disabled — the only environment that reaches this branch.
    const { BrowserRuntime } = await import("../browser/runtime");
    const { createLinkedInConnector } = await import("./linkedin");
    const { createWebDiscoveryConnector } = await import("./web-discovery");
    const state = new BrowserStateStore(browserConfig.statePath);
    const runtime = new BrowserRuntime(browserConfig.profilePath);
    connectors.push(createLinkedInConnector(browserConfig, { runtime, state }));
    connectors.push(createWebDiscoveryConnector(browserConfig, { runtime, state }));

    // Reuse one visible session and page for the whole validation batch,
    // pacing navigations to avoid hammering any single host.
    activeValidator = (repository) =>
      runtime.run(async (context) => {
        const page = await context.newPage();
        let navigated = false;
        const loadPage = async (url: string): Promise<PageSnapshot> => {
          if (navigated) await page.waitForTimeout(1_500);
          navigated = true;
          const response = await page.goto(url, { waitUntil: "domcontentloaded" });
          const text = await page.locator("body").innerText();
          return { status: response?.status() ?? null, url: page.url(), text };
        };
        return validateActiveJobs(repository, state, loadPage);
      });
  }

  return { connectors, skippedSources, activeValidator };
}
