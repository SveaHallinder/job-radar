import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const ERROR_PREFIX = "[job radar browser]";

export interface BrowserState {
  linkedinBootstrapCompleted: boolean;
  linkedinLastSuccessfulAt: string | null;
  googleLastSuccessfulAt: string | null;
  validationCursor: string | null;
}

export const EMPTY_BROWSER_STATE: Readonly<BrowserState> = Object.freeze({
  linkedinBootstrapCompleted: false,
  linkedinLastSuccessfulAt: null,
  googleLastSuccessfulAt: null,
  validationCursor: null,
});

const STATE_KEYS = [
  "linkedinBootstrapCompleted",
  "linkedinLastSuccessfulAt",
  "googleLastSuccessfulAt",
  "validationCursor",
] as const;

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isBrowserState(value: unknown): value is BrowserState {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const state = value as Record<string, unknown>;

  return (
    Object.keys(state).length === STATE_KEYS.length &&
    STATE_KEYS.every((key) => Object.hasOwn(state, key)) &&
    typeof state.linkedinBootstrapCompleted === "boolean" &&
    isNullableString(state.linkedinLastSuccessfulAt) &&
    isNullableString(state.googleLastSuccessfulAt) &&
    isNullableString(state.validationCursor)
  );
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

export class BrowserStateStore {
  constructor(private readonly path: string) {}

  async load(): Promise<BrowserState> {
    let contents: string;

    try {
      contents = await readFile(this.path, "utf8");
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) {
        return { ...EMPTY_BROWSER_STATE };
      }

      throw new Error(`${ERROR_PREFIX} Could not read browser state`, {
        cause: error,
      });
    }

    try {
      const state: unknown = JSON.parse(contents);

      if (!isBrowserState(state)) {
        throw new TypeError("Browser state has an invalid shape");
      }

      return state;
    } catch (error) {
      throw new Error(`${ERROR_PREFIX} Could not read browser state`, {
        cause: error,
      });
    }
  }

  async save(state: BrowserState): Promise<void> {
    try {
      await mkdir(dirname(this.path), { recursive: true });
      const temporaryPath = `${this.path}.tmp`;
      await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      await chmod(temporaryPath, 0o600);
      await rename(temporaryPath, this.path);
    } catch (error) {
      throw new Error(`${ERROR_PREFIX} Could not save browser state`, {
        cause: error,
      });
    }
  }
}
