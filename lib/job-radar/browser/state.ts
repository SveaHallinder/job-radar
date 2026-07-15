import { randomUUID } from "node:crypto";
import {
  type FileHandle,
  mkdir,
  open,
  readFile,
  rename,
  unlink,
} from "node:fs/promises";
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

async function writeAndClose(handle: FileHandle, contents: string): Promise<void> {
  let operationError: unknown;
  let operationFailed = false;

  try {
    await handle.writeFile(contents, "utf8");
  } catch (error) {
    operationError = error;
    operationFailed = true;
  }

  try {
    await handle.close();
  } catch (error) {
    if (!operationFailed) {
      operationError = error;
      operationFailed = true;
    }
  }

  if (operationFailed) {
    throw operationError;
  }
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
    let temporaryPath: string | undefined;
    let temporaryCreated = false;

    try {
      if (!isBrowserState(state)) {
        throw new TypeError("Browser state has an invalid shape");
      }

      const contents = `${JSON.stringify(state, null, 2)}\n`;
      await mkdir(dirname(this.path), { recursive: true });
      temporaryPath = `${this.path}.${randomUUID()}.tmp`;
      const handle = await open(temporaryPath, "wx", 0o600);
      temporaryCreated = true;
      await writeAndClose(handle, contents);
      await rename(temporaryPath, this.path);
      temporaryCreated = false;
    } catch (error) {
      if (temporaryCreated && temporaryPath) {
        try {
          await unlink(temporaryPath);
        } catch {
          // Preserve the original save failure as the error cause.
        }
      }

      throw new Error(`${ERROR_PREFIX} Could not save browser state`, {
        cause: error,
      });
    }
  }
}
