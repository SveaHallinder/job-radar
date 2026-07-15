import { classifyPageStatus, type PageSnapshot } from "./browser/page-status";
import type { BrowserState } from "./browser/state";
import type { JobRepository } from "./types";

const VALIDATION_SOURCES = ["LinkedIn", "Web discovery"] as const;

export interface ActiveValidationResult {
  checked: number;
  deleted: number;
  unknown: number;
}

export type ActiveValidator = (
  repository: JobRepository,
) => Promise<ActiveValidationResult>;

interface BrowserStatePort {
  load(): Promise<BrowserState>;
  save(state: BrowserState): Promise<void>;
}

/**
 * Validates a bounded, rotating batch of browser-discovered jobs and removes
 * only those confirmed inactive. A job is preserved on any ambiguous signal
 * (timeout, CAPTCHA, 429, login-required, parser uncertainty, or network
 * failure) so a transient block never deletes an active posting.
 */
export async function validateActiveJobs(
  repository: JobRepository,
  stateStore: BrowserStatePort,
  loadPage: (url: string) => Promise<PageSnapshot>,
  limit = 50,
): Promise<ActiveValidationResult> {
  const state = await stateStore.load();
  let jobs = repository.listJobsForValidation(
    [...VALIDATION_SOURCES],
    state.validationCursor,
    limit,
  );
  if (jobs.length === 0 && state.validationCursor) {
    // Cursor reached the end; wrap around to the start of the rotation.
    jobs = repository.listJobsForValidation([...VALIDATION_SOURCES], null, limit);
  }

  let deleted = 0;
  let unknown = 0;
  for (const job of jobs) {
    try {
      const status = classifyPageStatus(await loadPage(job.originalUrl));
      if (status === "inactive") {
        repository.deleteJobById(job.id);
        deleted += 1;
      } else if (status !== "active") {
        unknown += 1;
      }
    } catch (error) {
      unknown += 1;
      console.error(
        `[job radar browser] Active validation preserved ${job.id} after an ambiguous failure`,
        error,
      );
    }
  }

  await stateStore.save({ ...state, validationCursor: jobs.at(-1)?.id ?? null });
  return { checked: jobs.length, deleted, unknown };
}
