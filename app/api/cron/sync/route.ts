import { syncJobs } from "@/lib/job-radar/sync";

async function handleCron(request: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    console.error("[job radar] CRON_SECRET is not configured");
    return Response.json(
      { error: "[job radar] CRON_SECRET is not configured" },
      { status: 503 },
    );
  }

  if (request.headers.get("authorization") !== `Bearer ${secret}`) {
    console.warn("[job radar] Unauthorized cron request");
    return Response.json({ error: "[job radar] Unauthorized cron request" }, { status: 401 });
  }

  try {
    // Hosted cron has no visible browser; local browser connectors are skipped.
    const summary = await syncJobs({ browserDiscovery: false });
    console.info("[job radar] cron sync complete", {
      status: summary.status,
      fetched: summary.fetched,
      accepted: summary.accepted,
      newJobs: summary.newJobs,
    });

    if (summary.status === "failed") {
      return Response.json(
        { error: "[job radar] All configured job sources failed", summary },
        { status: 502 },
      );
    }

    return Response.json({ summary });
  } catch (error) {
    console.error("[job radar] cron sync failed", error);
    return Response.json(
      { error: "[job radar] Scheduled sync failed; inspect the server log for the source error" },
      { status: 500 },
    );
  }
}

export const GET = handleCron;
export const POST = handleCron;
