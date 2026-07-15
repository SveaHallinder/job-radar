"use server";

import { revalidatePath } from "next/cache";

import { syncJobs } from "@/lib/job-radar/sync";
import type { SyncSummary } from "@/lib/job-radar/types";

export interface SyncActionState {
  status: "idle" | "success" | "error";
  message: string;
  summary: SyncSummary | null;
}

export const initialSyncState: SyncActionState = {
  status: "idle",
  message: "",
  summary: null,
};

export async function runSyncAction(
  _previousState: SyncActionState,
): Promise<SyncActionState> {
  try {
    const summary = await syncJobs();
    revalidatePath("/");

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
