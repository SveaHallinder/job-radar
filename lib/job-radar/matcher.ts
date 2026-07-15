import type { JobCategory, MatchResult, SourceJob } from "./types";

const REMOTE_PATTERN =
  /\b(remote|fully remote|100% remote|work from anywhere|work remotely|distans|distansarbete|hemifran|remote-first)\b/i;
const NOT_REMOTE_PATTERN =
  /\b(hybrid|hybridarbete|on[ -]?site|office[ -]?based|office only|not remote|ej distans|pa plats)\b/i;
const CONTRACT_PATTERN =
  /\b(contract(?:or|ing)?|freelanc(?:e|er)|consult(?:ant|ing|ancy)|konsult|interim|fractional|self-employed|b2b)\b/i;
const MARKETING_PATTERN =
  /\b(marketing|marknadsforing|marknadschef|growth marketing|demand generation|content marketing|seo|sem|paid media|performance marketer|brand manager|communications manager|crm manager|lifecycle marketing|acquisition manager)\b/i;
const SALES_PATTERN =
  /\b(sales|forsaljning|saljare|account executive|account manager|business development|bdr|sdr|partnerships manager|commercial (?:manager|director)|revenue (?:manager|director))\b/i;
const ELIGIBLE_GEOGRAPHY_PATTERN =
  /\b(sweden|sverige|stockholm|romania|bucharest|bucuresti|emea|europe|european union|eu|worldwide|anywhere|global(?:ly)? remote)\b/i;
const EXCLUDED_ONLY_PATTERN =
  /\b(us|u\.s\.|united states|north america|canada|uk|united kingdom)\s+only\b/i;
const SWEDISH_PATTERN = /\b(swedish|svenska|svenskt|svensktalande)\b/i;

function searchableText(job: SourceJob): string {
  return [
    job.title,
    job.company,
    job.location,
    job.country ?? "",
    job.description,
    job.engagementType ?? "",
    ...job.tags,
  ].join(" ");
}

function classifyCategory(job: SourceJob): JobCategory | null {
  const titleAndTags = [job.title, ...job.tags].join(" ");

  if (MARKETING_PATTERN.test(titleAndTags)) {
    return "Marketing";
  }

  if (SALES_PATTERN.test(titleAndTags)) {
    return "Sales";
  }

  return null;
}

function normalizeEngagement(text: string): string {
  if (/\bb2b\b/i.test(text)) return "B2B";
  if (/\bfractional\b/i.test(text)) return "Fractional";
  if (/\binterim\b/i.test(text)) return "Interim";
  if (/\bfreelanc(?:e|er)\b/i.test(text)) return "Freelance";
  if (/\bconsult(?:ant|ing|ancy)\b|\bkonsult\b/i.test(text)) return "Consulting";
  return "Contract";
}

export function matchJob(job: SourceJob): MatchResult {
  const allText = searchableText(job);
  const remote = job.remote === true || REMOTE_PATTERN.test(allText);

  if (!remote || NOT_REMOTE_PATTERN.test(allText)) {
    return { matched: false, rejectionReason: "Not fully remote" };
  }

  if (!CONTRACT_PATTERN.test(allText)) {
    return { matched: false, rejectionReason: "Not contract or freelance" };
  }

  const category = classifyCategory(job);
  if (!category) {
    return { matched: false, rejectionReason: "Outside sales and marketing" };
  }

  const locationText = [job.location, job.country ?? "", job.description].join(" ");
  if (
    EXCLUDED_ONLY_PATTERN.test(locationText) ||
    !ELIGIBLE_GEOGRAPHY_PATTERN.test(locationText)
  ) {
    return { matched: false, rejectionReason: "Outside Sweden / EMEA" };
  }

  const engagementType = normalizeEngagement(
    job.engagementType && CONTRACT_PATTERN.test(job.engagementType)
      ? job.engagementType
      : allText,
  );
  const matchReasons = [
    "Remote",
    "Contract / freelance",
    category,
    "Sweden / EMEA eligible",
  ];

  if (SWEDISH_PATTERN.test(allText)) {
    matchReasons.push("Swedish relevance");
  }

  return {
    matched: true,
    category,
    engagementType,
    matchReasons,
  };
}

export function canonicalizeUrl(value: string): string {
  try {
    const url = new URL(value);
    const trackingKeys = new Set([
      "ref",
      "source",
      "gh_src",
      "lever-source",
      "referrer",
      "tracking",
    ]);

    for (const key of [...url.searchParams.keys()]) {
      if (key.toLowerCase().startsWith("utm_") || trackingKeys.has(key.toLowerCase())) {
        url.searchParams.delete(key);
      }
    }

    url.hash = "";
    url.searchParams.sort();

    if (url.pathname.length > 1) {
      url.pathname = url.pathname.replace(/\/+$/, "");
    }

    return url.toString();
  } catch {
    return value.trim();
  }
}
