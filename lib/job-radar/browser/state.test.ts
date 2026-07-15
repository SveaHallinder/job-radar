import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  BrowserStateStore,
  EMPTY_BROWSER_STATE,
  type BrowserState,
} from "./state";

async function findTemporaryArtifacts(path: string): Promise<string[]> {
  const prefix = `${basename(path)}.`;
  return (await readdir(dirname(path))).filter(
    (entry) => entry.startsWith(prefix) && entry.endsWith(".tmp"),
  );
}

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
    const path = join(directory, "state.json");
    const store = new BrowserStateStore(path);
    const oldState: BrowserState = {
      ...EMPTY_BROWSER_STATE,
      validationCursor: "old-cursor",
    };
    const state: BrowserState = {
      linkedinBootstrapCompleted: true,
      linkedinLastSuccessfulAt: "2026-07-15T08:00:00.000Z",
      googleLastSuccessfulAt: "2026-07-15T09:00:00.000Z",
      validationCursor: "linkedin:123",
    };
    await writeFile(path, `${JSON.stringify(oldState, null, 2)}\n`, {
      mode: 0o600,
    });

    await store.save(state);

    expect(await store.load()).toEqual(state);
    expect(await readFile(path, "utf8")).toBe(
      `${JSON.stringify(state, null, 2)}\n`,
    );
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await findTemporaryArtifacts(path)).toEqual([]);
  });

  it("enforces mode 0600 under a restrictive process umask", async () => {
    const path = join(directory, "state.json");
    const previousUmask = process.umask(0o277);

    try {
      await new BrowserStateStore(path).save({ ...EMPTY_BROWSER_STATE });
    } finally {
      process.umask(previousUmask);
    }

    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("does not reuse a predictable stale temp file", async () => {
    const path = join(directory, "state.json");
    const temporaryPath = `${path}.tmp`;
    await writeFile(temporaryPath, "stale", { mode: 0o644 });
    await chmod(temporaryPath, 0o644);

    await new BrowserStateStore(path).save({ ...EMPTY_BROWSER_STATE });

    expect((await stat(path)).mode & 0o777).toBe(0o600);
    await expect(readFile(temporaryPath, "utf8")).resolves.toBe("stale");
    expect((await stat(temporaryPath)).mode & 0o777).toBe(0o644);
  });

  it("allows concurrent saves without temp file collisions", async () => {
    const path = join(directory, "state.json");
    const store = new BrowserStateStore(path);
    const linkedinState: BrowserState = {
      ...EMPTY_BROWSER_STATE,
      linkedinBootstrapCompleted: true,
      linkedinLastSuccessfulAt: "2026-07-15T08:00:00.000Z",
    };
    const googleState: BrowserState = {
      ...EMPTY_BROWSER_STATE,
      googleLastSuccessfulAt: "2026-07-15T09:00:00.000Z",
      validationCursor: "google:456",
    };

    const results = await Promise.allSettled([
      store.save(linkedinState),
      store.save(googleState),
    ]);

    expect(results.map((result) => result.status)).toEqual([
      "fulfilled",
      "fulfilled",
    ]);
    expect([linkedinState, googleState]).toContainEqual(await store.load());
    expect(await findTemporaryArtifacts(path)).toEqual([]);
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

  it.each([
    {
      name: "an extra field",
      state: { ...EMPTY_BROWSER_STATE, unexpected: true },
    },
    {
      name: "an incorrectly typed field",
      state: {
        ...EMPTY_BROWSER_STATE,
        linkedinBootstrapCompleted: "false",
      },
    },
  ])("rejects saving state with $name", async ({ state }) => {
    const path = join(directory, "state.json");
    const store = new BrowserStateStore(path);

    await expect(store.save(state as BrowserState)).rejects.toMatchObject({
      message: "[job radar browser] Could not save browser state",
      cause: expect.any(TypeError),
    });
    await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await findTemporaryArtifacts(path)).toEqual([]);
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

  it("removes its temp file after a rename failure", async () => {
    const path = join(directory, "state.json");
    await mkdir(path);
    const store = new BrowserStateStore(path);

    await expect(store.save({ ...EMPTY_BROWSER_STATE })).rejects.toMatchObject({
      message: "[job radar browser] Could not save browser state",
      cause: expect.objectContaining({ syscall: "rename" }),
    });
    expect(await findTemporaryArtifacts(path)).toEqual([]);
  });
});
