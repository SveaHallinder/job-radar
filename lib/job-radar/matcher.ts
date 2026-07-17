import type { JobCategory, MatchResult, SourceJob } from "./types";

const REMOTE_PATTERN =
  /\b(remote|fully remote|100% remote|work from anywhere|work remotely|distans|distansarbete|hemifran|remote-first)\b/i;
const NOT_REMOTE_PATTERN =
  /\b(hybrid|hybridarbete|on[ -]?site|office[ -]?based|office only|not remote|ej distans|pa plats)\b/i;
const CONTRACT_ROLE_PATTERN =
  /\b(contract(?:or|ing)?|freelanc(?:e|er)|consultant|konsult|interim|fractional|self-employed)\b/i;
const CONTRACT_DESCRIPTION_PATTERN =
  /\b(freelanc(?:e|er)|contractor|contract (?:role|position|assignment|engagement|basis|opportunity)|on (?:an? )?contract basis|consulting assignment|independent consulting|not a salaried employment|konsultuppdrag|interim (?:role|assignment|position)|fractional (?:role|position)|self-employed)\b/i;
const B2B_ENGAGEMENT_PATTERN =
  /\b(b2b (?:contract|agreement|engagement|basis)|on (?:a )?b2b (?:contract|basis)|(?:contract|agreement|engagement) on (?:a )?b2b basis)\b/i;
const MARKETING_PATTERN =
  /\b(marketing|marknadsforing|marknadschef|growth marketing|demand generation|content marketing|seo|sem|paid media|performance marketer|brand manager|communications manager|crm manager|lifecycle marketing|acquisition manager)\b/i;
const SALES_PATTERN =
  /\b(sales|forsaljning|saljare|account executive|account manager|business development|bdr|sdr|partnerships manager|commercial (?:manager|director)|revenue (?:manager|director))\b/i;
const ELIGIBLE_GEOGRAPHY_PATTERN =
  /\b(sweden|sverige|stockholm|romania|bucharest|bucuresti|emea|europe|european union|eu|worldwide|anywhere|global(?:ly)? remote|germany|deutschland|france|spain|espana|italy|italia|netherlands|nederland|holland|poland|polska|denmark|danmark|norway|norge|finland|suomi|ireland|eire|portugal|belgium|belgie|belgique|austria|osterreich|switzerland|schweiz|czech|czechia|greece|hungary|dach|benelux|nordic|nordics|scandinavia|scandinavian|cet|cest)\b/i;
const EXCLUDED_ONLY_PATTERN =
  /\b(us|u\.s\.|usa|united states|north america|canada|uk|united kingdom)(?:[ -]?(?:only|based)|\s+residents?)\b/i;
const SWEDISH_PATTERN = /\b(swedish|svenska|svenskt|svensktalande)\b/i;

function stripDiacritics(text: string): string {
  return text.normalize("NFKD").replace(/[̀-ͯ]/g, "");
}

function searchableText(job: SourceJob): string {
  return stripDiacritics(
    [
      job.title,
      job.company,
      job.location,
      job.country ?? "",
      job.description,
      job.engagementType ?? "",
      ...job.tags,
    ].join(" "),
  );
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
  if (B2B_ENGAGEMENT_PATTERN.test(text)) return "B2B";
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

  const contractSignalText = [job.title, job.engagementType ?? "", ...job.tags].join(" ");
  const hasContractEngagement =
    CONTRACT_ROLE_PATTERN.test(contractSignalText) ||
    CONTRACT_DESCRIPTION_PATTERN.test(job.description) ||
    B2B_ENGAGEMENT_PATTERN.test(allText);

  if (!hasContractEngagement) {
    return { matched: false, rejectionReason: "Not contract or freelance" };
  }

  const category = classifyCategory(job);
  if (!category) {
    return { matched: false, rejectionReason: "Outside sales and marketing" };
  }

  const locationText = stripDiacritics(
    [job.location, job.country ?? "", job.description].join(" "),
  );
  if (
    EXCLUDED_ONLY_PATTERN.test(locationText) ||
    !ELIGIBLE_GEOGRAPHY_PATTERN.test(locationText)
  ) {
    return { matched: false, rejectionReason: "Outside Sweden / EMEA" };
  }

  const engagementType = normalizeEngagement(
    job.engagementType &&
    (CONTRACT_ROLE_PATTERN.test(job.engagementType) ||
      B2B_ENGAGEMENT_PATTERN.test(job.engagementType))
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
