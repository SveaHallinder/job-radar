import { chromium, type Page } from "playwright";

const ACTIVE_RUN_ERROR =
  "[job radar browser] Another browser discovery run is already active";
const BROWSER_RUN_ERROR = "[job radar browser] Browser run failed";

let browserRunActive = false;

function browserRunError(cause: unknown): Error {
  return new Error(BROWSER_RUN_ERROR, { cause });
}

function hasJobRadarPrefix(error: unknown): error is Error {
  return (
    error instanceof Error &&
    /^\[job radar(?: [^\]]+)?\](?:\s|$)/.test(error.message)
  );
}

export interface BrowserContextLike {
  pages(): Page[];
  newPage(): Promise<Page>;
  close(): Promise<void>;
}

export interface BrowserLauncher {
  launchPersistentContext(
    profilePath: string,
    options: { headless: false; viewport: null },
  ): Promise<BrowserContextLike>;
}

export class BrowserRuntime {
  constructor(
    private readonly profilePath: string,
    private readonly launcher: BrowserLauncher = chromium,
  ) {}

  async run<T>(task: (context: BrowserContextLike) => Promise<T>): Promise<T> {
    if (browserRunActive) {
      throw new Error(ACTIVE_RUN_ERROR);
    }

    browserRunActive = true;

    try {
      let context: BrowserContextLike;
      try {
        context = await this.launcher.launchPersistentContext(
          this.profilePath,
          {
            headless: false,
            viewport: null,
          },
        );
      } catch (error) {
        if (hasJobRadarPrefix(error)) throw error;
        throw browserRunError(error);
      }

      let taskFailed = false;
      try {
        try {
          return await task(context);
        } catch (error) {
          taskFailed = true;
          if (hasJobRadarPrefix(error)) throw error;
          throw browserRunError(error);
        }
      } finally {
        try {
          await context.close();
        } catch (error) {
          if (taskFailed) {
            console.error(
              "[job radar browser] Browser context cleanup failed",
              error,
            );
          } else {
            if (hasJobRadarPrefix(error)) throw error;
            throw browserRunError(error);
          }
        }
      }
    } finally {
      browserRunActive = false;
    }
  }
}
