const REQUEST_TIMEOUT_MS = 15_000;

export async function fetchJson<T>(
  url: string,
  init: RequestInit = {},
  label = "Job source",
): Promise<T> {
  try {
    const response = await fetch(url, {
      ...init,
      headers: {
        accept: "application/json",
        "user-agent": "JobRadar/0.1 (+local job search dashboard)",
        ...init.headers,
      },
      signal: init.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }

    return (await response.json()) as T;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown request error";
    throw new Error(`[job radar] ${label} request failed: ${message}`, { cause: error });
  }
}

export async function resolveRedirect(url: string): Promise<string> {
  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "follow",
      headers: {
        "user-agent": "JobRadar/0.1 (+local job search dashboard)",
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    return response.ok ? response.url : url;
  } catch {
    return url;
  }
}

export function htmlToText(value: string): string {
  return value
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#(?:39|x27);/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}
