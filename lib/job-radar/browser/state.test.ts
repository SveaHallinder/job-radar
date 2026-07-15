import { access, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  BrowserStateStore,
  EMPTY_BROWSER_STATE,
  type BrowserState,
} from "./state";

describe("BrowserStateStore", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "job-radar-browser-state-"));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("returns a fresh copy of the defaults when the state file is missing", async () => {
    const store = new BrowserStateStore(join(directory, "state.json"));

    const first = await store.load();
    first.linkedinBootstrapCompleted = true;
    const second = await store.load();

    expect(second).toEqual(EMPTY_BROWSER_STATE);
    expect(second).not.toBe(first);
  });

  it("atomically writes and reads browser state", async () => {
    const path = join(directory, "nested", "state.json");
    const store = new BrowserStateStore(path);
    const state: BrowserState = {
      linkedinBootstrapCompleted: true,
      linkedinLastSuccessfulAt: "2026-07-15T08:00:00.000Z",
      googleLastSuccessfulAt: "2026-07-15T09:00:00.000Z",
      validationCursor: "linkedin:123",
    };

    await store.save(state);

    expect(await store.load()).toEqual(state);
    expect(await readFile(path, "utf8")).toBe(
      `${JSON.stringify(state, null, 2)}\n`,
    );
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    await expect(access(`${path}.tmp`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("wraps corrupt JSON with a browser state read error", async () => {
    const path = join(directory, "state.json");
    await writeFile(path, "{not-json", "utf8");

    await expect(new BrowserStateStore(path).load()).rejects.toMatchObject({
      message: "[job radar browser] Could not read browser state",
      cause: expect.any(SyntaxError),
    });
  });

  it.each([
    {
      name: "a missing field",
      state: {
        linkedinBootstrapCompleted: false,
        linkedinLastSuccessfulAt: null,
        googleLastSuccessfulAt: null,
      },
    },
    {
      name: "an incorrectly typed field",
      state: {
        linkedinBootstrapCompleted: "false",
        linkedinLastSuccessfulAt: null,
        googleLastSuccessfulAt: null,
        validationCursor: null,
      },
    },
    {
      name: "an extra field",
      state: {
        linkedinBootstrapCompleted: false,
        linkedinLastSuccessfulAt: null,
        googleLastSuccessfulAt: null,
        validationCursor: null,
        unexpected: true,
      },
    },
  ])("wraps invalid browser state with $name", async ({ state }) => {
    const path = join(directory, "state.json");
    await writeFile(path, JSON.stringify(state), "utf8");

    await expect(new BrowserStateStore(path).load()).rejects.toMatchObject({
      message: "[job radar browser] Could not read browser state",
      cause: expect.any(Error),
    });
  });

  it("wraps state write failures with a browser state save error", async () => {
    const parentPath = join(directory, "not-a-directory");
    await writeFile(parentPath, "file", "utf8");
    const store = new BrowserStateStore(join(parentPath, "state.json"));

    await expect(store.save({ ...EMPTY_BROWSER_STATE })).rejects.toMatchObject({
      message: "[job radar browser] Could not save browser state",
      cause: expect.any(Error),
    });
  });
});
