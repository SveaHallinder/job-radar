"use server";

import { revalidatePath } from "next/cache";

import { getJobRepository } from "@/lib/job-radar/db";
import { syncJobs } from "@/lib/job-radar/sync";
import type { SyncRequest, SyncSummary } from "@/lib/job-radar/types";

export interface SyncActionState {
  status: "idle" | "success" | "error";
  message: string;
  summary: SyncSummary | null;
}

export async function runSyncAction(
  _previousState: SyncActionState,
): Promise<SyncActionState> {
  void _previousState;

  try {
    const summary = await syncJobs();
    revalidatePath("/");

    if (summary.status === "failed") {
      return {
        status: "error",
        message:
          "[job radar] Alla aktiva datakällor misslyckades. Befintliga resultat finns kvar; kontrollera serverloggen.",
        summary,
      };
    }

    const sourceNote = summary.sourceErrors.length
      ? ` ${summary.sourceErrors.length} källa kunde inte nås; befintliga resultat finns kvar.`
      : "";

    return {
      status: "success",
      message: `Sökningen är klar: ${summary.newJobs} nya och ${summary.updatedJobs} uppdaterade jobb.${sourceNote}`,
      summary,
    };
  } catch (error) {
    console.error("[job radar] manual sync failed", error);
    return {
      status: "error",
      message:
        "[job radar] Sökningen kunde inte slutföras. Dina befintliga resultat finns kvar; kontrollera serverloggen för källan som felade.",
      summary: null,
    };
  }
}

export interface BrowserSyncActionState {
  status: "idle" | "queued" | "error";
  message: string;
  request: SyncRequest | null;
}

// The hosted app has no browser, so LinkedIn can't run here. Instead we queue a
// request in Postgres; the local worker on a logged-in machine picks it up and
// runs the full sync (incl. LinkedIn), writing results back to the same DB.
export async function requestBrowserSyncAction(
  _previousState: BrowserSyncActionState,
): Promise<BrowserSyncActionState> {
  void _previousState;

  try {
    const repository = getJobRepository();
    const request = await repository.requestBrowserSync(
      "linkedin",
      new Date().toISOString(),
    );
    revalidatePath("/");
    return {
      status: "queued",
      message:
        "LinkedIn-synk begärd. Din dator kör den nästa gång den är igång — resultaten dyker upp här när den är klar.",
      request,
    };
  } catch (error) {
    console.error("[job radar] browser sync request failed", error);
    return {
      status: "error",
      message:
        "[job radar] Kunde inte begära LinkedIn-synk. Försök igen om en stund.",
      request: null,
    };
  }
}
