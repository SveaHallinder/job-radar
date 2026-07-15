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
}

export function getConnectorConfiguration(
  env: NodeJS.ProcessEnv = process.env,
): ConnectorConfiguration {
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

  return { connectors, skippedSources };
}
