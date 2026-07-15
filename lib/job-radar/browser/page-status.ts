export type PageStatus =
  | "active"
  | "inactive"
  | "blocked"
  | "login-required"
  | "unknown";

export interface PageSnapshot {
  status: number | null;
  url: string;
  text: string;
  validThrough?: string | null;
}

function isLinkedInHostname(hostname: string): boolean {
  return hostname === "linkedin.com" || hostname.endsWith(".linkedin.com");
}

function isLinkedInChallengeUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const isChallengePath = ["/checkpoint", "/challenge"].some(
      (path) => url.pathname === path || url.pathname.startsWith(`${path}/`),
    );
    return isLinkedInHostname(url.hostname) && isChallengePath;
  } catch {
    return false;
  }
}

function isLinkedInLoginUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const isLoginPath = ["/login", "/uas/login", "/authwall"].some(
      (path) => url.pathname === path || url.pathname.startsWith(`${path}/`),
    );
    return isLinkedInHostname(url.hostname) && isLoginPath;
  } catch {
    return false;
  }
}

function hasBlockingCopy(text: string): boolean {
  return [
    /\bcaptcha\b/i,
    /\bsecurity verification (?:is )?(?:required|needed)\b/i,
    /\b(?:complete|perform) (?:a |the )?security verification\b/i,
    /\bverify (?:that )?you(?: are|'re) (?:a )?human\b/i,
    /\bunusual traffic\b/i,
  ].some((pattern) => pattern.test(text));
}

function hasLoginCopy(text: string): boolean {
  return [
    /\b(?:sign|log) in (?:to|for) (?:continue|view|see|apply|access)\b/i,
    /\b(?:sign|log) in (?:is )?required\b/i,
    /\blogga in för att (?:fortsätta|visa|se|ansöka|få åtkomst)\b/i,
    /\binloggning (?:krävs|behövs)\b/i,
  ].some((pattern) => pattern.test(text));
}

function hasInactiveCopy(text: string): boolean {
  return [
    /\b(?:this |the )?(?:job(?: posting)?|position|role|vacancy) (?:has expired|is expired|has closed|is closed|has been filled|is filled|was filled)\b/i,
    /\b(?:this |the )?(?:job(?: posting)?|position|role|vacancy) (?:is |was )?no longer available\b/i,
    /\bno longer accepting applications\b/i,
    /\b(?:annonsen|jobbannonsen) har gått ut\b/i,
    /\bansökningstiden har gått ut\b/i,
    /\b(?:annonsen|jobbannonsen|ansökan) är stängd\b/i,
    /\b(?:tjänsten|rollen|jobbet|platsen) (?:är|har blivit) tillsatt\b/i,
    /\b(?:tjänsten|rollen|jobbet|annonsen|jobbannonsen) är inte längre tillgänglig(?:t)?\b/i,
    /\btar inte längre emot ansökningar\b/i,
  ].some((pattern) => pattern.test(text));
}

function hasApplyAction(text: string): boolean {
  return [
    /\bapply now\b/i,
    /\bapply for (?:this|the) (?:job|position|role)\b/i,
    /\bsubmit (?:your )?application\b/i,
    /\bansök nu\b/i,
    /\bansök (?:till|för) (?:den här |denna )?(?:tjänsten|rollen|jobbet)\b/i,
    /\bskicka (?:in )?(?:din )?ansökan\b/i,
    /\bsök (?:den här |denna )?tjänsten\b/i,
  ].some((pattern) => pattern.test(text));
}

export function classifyPageStatus(
  snapshot: PageSnapshot,
  now = new Date(),
): PageStatus {
  if (
    snapshot.status === 429 ||
    isLinkedInChallengeUrl(snapshot.url) ||
    hasBlockingCopy(snapshot.text)
  ) {
    return "blocked";
  }

  if (isLinkedInLoginUrl(snapshot.url) || hasLoginCopy(snapshot.text)) {
    return "login-required";
  }

  if (snapshot.status === 404 || snapshot.status === 410) {
    return "inactive";
  }

  const validThrough = snapshot.validThrough
    ? Date.parse(snapshot.validThrough)
    : Number.NaN;
  if (Number.isFinite(validThrough) && validThrough < now.getTime()) {
    return "inactive";
  }

  if (hasInactiveCopy(snapshot.text)) {
    return "inactive";
  }

  if (hasApplyAction(snapshot.text)) {
    return "active";
  }

  return "unknown";
}
