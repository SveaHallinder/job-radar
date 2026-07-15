import { describe, expect, it, vi } from "vitest";

import {
  BrowserRuntime,
  type BrowserContextLike,
  type BrowserLauncher,
} from "./runtime";

class FakeContext implements BrowserContextLike {
  closeCalls = 0;

  constructor(private readonly closeError?: unknown) {}

  pages() {
    return [];
  }

  async newPage(): Promise<never> {
    throw new Error("FakeContext.newPage is not used in these tests");
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
    if (this.closeError) throw this.closeError;
  }
}

class FakeLauncher implements BrowserLauncher {
  calls: Array<{
    profilePath: string;
    options: { headless: false; viewport: null };
  }> = [];

  constructor(private readonly context: BrowserContextLike) {}

  async launchPersistentContext(
    profilePath: string,
    options: { headless: false; viewport: null },
  ): Promise<BrowserContextLike> {
    this.calls.push({ profilePath, options });
    return this.context;
  }
}

describe("BrowserRuntime", () => {
  it("launches a visible persistent context, runs the task, and closes", async () => {
    const context = new FakeContext();
    const launcher = new FakeLauncher(context);
    const runtime = new BrowserRuntime("/tmp/job-radar-profile", launcher);

    const result = await runtime.run(async (receivedContext) => {
      expect(receivedContext).toBe(context);
      return "done";
    });

    expect(result).toBe("done");
    expect(launcher.calls).toEqual([
      {
        profilePath: "/tmp/job-radar-profile",
        options: { headless: false, viewport: null },
      },
    ]);
    expect(context.closeCalls).toBe(1);
  });

  it("closes after a task failure and preserves a feature-prefixed error", async () => {
    const context = new FakeContext();
    const runtime = new BrowserRuntime(
      "/tmp/job-radar-profile",
      new FakeLauncher(context),
    );
    const taskError = new Error("[job radar linkedin] Discovery failed");

    await expect(
      runtime.run(async () => {
        throw taskError;
      }),
    ).rejects.toBe(taskError);
    expect(context.closeCalls).toBe(1);
  });

  it("rejects overlap across runtime instances before the second launch", async () => {
    let markStarted: (() => void) | undefined;
    let releaseTask: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const heldTask = new Promise<void>((resolve) => {
      releaseTask = resolve;
    });
    const firstLauncher = new FakeLauncher(new FakeContext());
    const secondLauncher = new FakeLauncher(new FakeContext());
    const firstRuntime = new BrowserRuntime("/tmp/first-profile", firstLauncher);
    const secondRuntime = new BrowserRuntime("/tmp/second-profile", secondLauncher);
    const firstRun = firstRuntime.run(async () => {
      markStarted?.();
      await heldTask;
    });

    await started;
    try {
      await expect(secondRuntime.run(async () => undefined)).rejects.toThrow(
        "[job radar browser] Another browser discovery run is already active",
      );
      expect(secondLauncher.calls).toHaveLength(0);
    } finally {
      releaseTask?.();
      await firstRun;
    }
  });

  it("releases the lock after a launcher failure and reports its cause", async () => {
    const launchError = new Error("launch failed");
    const recoveryContext = new FakeContext();
    let launchCalls = 0;
    const launcher: BrowserLauncher = {
      async launchPersistentContext() {
        launchCalls += 1;
        if (launchCalls === 1) throw launchError;
        return recoveryContext;
      },
    };
    const runtime = new BrowserRuntime("/tmp/job-radar-profile", launcher);

    await expect(runtime.run(async () => undefined)).rejects.toEqual(
      expect.objectContaining({
        message: "[job radar browser] Browser run failed",
        cause: launchError,
      }),
    );
    await expect(runtime.run(async () => "recovered")).resolves.toBe(
      "recovered",
    );
    expect(launchCalls).toBe(2);
    expect(recoveryContext.closeCalls).toBe(1);
  });

  it("preserves a feature-prefixed launcher failure", async () => {
    const launchError = new Error("[job radar linkedin] Launch failed");
    const launcher: BrowserLauncher = {
      async launchPersistentContext() {
        throw launchError;
      },
    };
    const runtime = new BrowserRuntime("/tmp/job-radar-profile", launcher);

    await expect(runtime.run(async () => undefined)).rejects.toBe(launchError);
  });

  it("wraps an unprefixed task failure with its cause", async () => {
    const context = new FakeContext();
    const taskError = new TypeError("page parsing failed");
    const runtime = new BrowserRuntime(
      "/tmp/job-radar-profile",
      new FakeLauncher(context),
    );

    await expect(
      runtime.run(async () => {
        throw taskError;
      }),
    ).rejects.toEqual(
      expect.objectContaining({
        message: "[job radar browser] Browser run failed",
        cause: taskError,
      }),
    );
    expect(context.closeCalls).toBe(1);
  });

  it("releases the lock after a close failure and reports its cause", async () => {
    const closeError = new Error("close failed");
    const failedContext = new FakeContext(closeError);
    const recoveryContext = new FakeContext();
    const contexts: BrowserContextLike[] = [failedContext, recoveryContext];
    const launcher: BrowserLauncher = {
      async launchPersistentContext() {
        const context = contexts.shift();
        if (!context) throw new Error("No fake context available");
        return context;
      },
    };
    const runtime = new BrowserRuntime("/tmp/job-radar-profile", launcher);

    await expect(runtime.run(async () => "completed")).rejects.toEqual(
      expect.objectContaining({
        message: "[job radar browser] Browser run failed",
        cause: closeError,
      }),
    );
    await expect(runtime.run(async () => "recovered")).resolves.toBe(
      "recovered",
    );
    expect(failedContext.closeCalls).toBe(1);
    expect(recoveryContext.closeCalls).toBe(1);
  });

  it("preserves a feature-prefixed standalone close failure", async () => {
    const closeError = new Error("[job radar linkedin] Close failed");
    const context = new FakeContext(closeError);
    const runtime = new BrowserRuntime(
      "/tmp/job-radar-profile",
      new FakeLauncher(context),
    );

    await expect(runtime.run(async () => "completed")).rejects.toBe(closeError);
    expect(context.closeCalls).toBe(1);
  });

  it("keeps the original task error when closing also fails", async () => {
    const closeError = new Error("close failed");
    const context = new FakeContext(closeError);
    const taskError = new Error("[job radar linkedin] Discovery failed");
    const errorLog = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const runtime = new BrowserRuntime(
      "/tmp/job-radar-profile",
      new FakeLauncher(context),
    );

    try {
      await expect(
        runtime.run(async () => {
          throw taskError;
        }),
      ).rejects.toBe(taskError);
      expect(errorLog).toHaveBeenCalledWith(
        "[job radar browser] Browser context cleanup failed",
        closeError,
      );
    } finally {
      errorLog.mockRestore();
    }
    expect(context.closeCalls).toBe(1);
  });
});
