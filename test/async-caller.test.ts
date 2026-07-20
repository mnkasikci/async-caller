import { afterEach, describe, expect, it, vi } from "vitest";
import { AsyncCaller, BucketDestroyedError } from "../src/index.js";
import type { CallHooks, ResultIdentifier } from "../src/index.js";

// A bucket configured so it never meaningfully throttles: 100 tokens available
// immediately, refilling 100 every 10ms. Lets tests exercise concurrency /
// retry / classification logic without waiting on the rate limiter.
const wideOpen = { capacity: 100, fillPerWindow: 100, windowInMs: 10 };

// Small retry delays so retry-driven tests finish quickly under real timers.
const fastRetry = { minDelayInMs: 5, maxDelayInMs: 20, backoffFactor: 2 };

// Every caller created in a test is registered here and torn down in afterEach
// so the token bucket's timers never leak between tests.
const callers: Array<AsyncCaller<any>> = [];
function track<T extends AsyncCaller<any>> (caller: T): T {
  callers.push(caller);
  return caller;
}

afterEach(() => {
  for (const caller of callers.splice(0))
    caller.destroy();
  vi.restoreAllMocks();
});

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
// Spy on the caller's owned bucket. `forceWaitUntilMillisecondsPassed` is the
// one mechanism that pauses the *shared* bucket, so spying on it is a precise
// proxy for "was global backpressure applied?".
const spyPause = (caller: AsyncCaller<any>) =>
  vi.spyOn((caller as any)._tokenBucket, "forceWaitUntilMillisecondsPassed");

// ---------------------------------------------------------------------------
// Construction & options merge (migration item 10 / handoff item 5)
// ---------------------------------------------------------------------------
describe("construction & options merge", () => {
  it("constructs with no options at all (all defaults)", async () => {
    const caller = track(new AsyncCaller());
    await expect(caller.call(() => Promise.resolve("ok"))).resolves.toBe("ok");
  });

  it("merges partial retryOptions over the defaults — no NaN backoff", () => {
    const caller = track(new AsyncCaller({ retryOptions: { maxRetries: 5 } }));
    // Defaults must survive: minDelayInMs=1000, backoffFactor=2.
    // If they had been dropped to `undefined`, this would be NaN (the retry-storm bug).
    expect((caller as any).calculateDefaultDelay(1)).toBe(1000); // 1000 * 2^0
    expect((caller as any).calculateDefaultDelay(2)).toBe(2000); // 1000 * 2^1
    expect(Number.isNaN((caller as any).calculateDefaultDelay(1))).toBe(false);
  });

  it("clamps the default delay by the default maxDelayInMs", () => {
    const caller = track(new AsyncCaller({ retryOptions: { maxRetries: 5 } }));
    // 1000 * 2^9 would be 512000; must clamp to the default 10000.
    expect((caller as any).calculateDefaultDelay(10)).toBe(10000);
  });

  it("merges partial tokenBucketOptions over the defaults — construction does not throw", () => {
    // windowInMs is left to the default (100). Without the merge it would be
    // `undefined` -> NaN and TokenBucket.validate would throw.
    expect(() => track(new AsyncCaller({ tokenBucketOptions: { fillPerWindow: 5 } as any }))).not.toThrow();
  });

  it("applies safetyMarginMs uniformly and still constructs a usable caller", async () => {
    const caller = track(new AsyncCaller({ tokenBucketOptions: wideOpen, safetyMarginMs: 10 }));
    await expect(caller.call(() => Promise.resolve(1))).resolves.toBe(1);
  });

  it("honours a custom result identifier", async () => {
    const identifier: ResultIdentifier = {
      identifyResult: (r: any) => ({ isRateLimited: r === "limited" && false }),
      identifyError: () => ({ isRateLimited: false, dontRetry: false }),
    };
    const caller = track(new AsyncCaller({ tokenBucketOptions: wideOpen, customResultIdentifier: identifier }));
    const spy = vi.spyOn(identifier, "identifyResult");
    await caller.call(() => Promise.resolve("plain"));
    expect(spy).toHaveBeenCalledWith("plain");
  });

  it("honours a custom retry-delay calculator on the rate-limited path", async () => {
    const custom = vi.fn(() => 7);
    const caller = track(new AsyncCaller({
      tokenBucketOptions: wideOpen,
      retryOptions: { maxRetries: 1 },
      customRetryDelayInMsCalculator: custom,
    }));
    const pause = spyPause(caller);
    let n = 0;
    await caller.call(() => Promise.resolve(++n === 1 ? { status: 429 } : { status: 200 }));
    expect(custom).toHaveBeenCalled();
    // The custom delay (7) is what gets applied as global backpressure.
    expect(pause).toHaveBeenCalledWith(7);
  });
});

// ---------------------------------------------------------------------------
// Concurrency cap (migration item 9 / handoff item 1)
// ---------------------------------------------------------------------------
describe("concurrency", () => {
  it("never runs more than `concurrency` tasks at once (peak overlap === cap)", async () => {
    const caller = track(new AsyncCaller({ tokenBucketOptions: wideOpen, concurrency: 2 }));
    let active = 0;
    let peak = 0;
    const task = async () => {
      active++;
      peak = Math.max(peak, active);
      await sleep(60);
      active--;
      return "done";
    };
    await Promise.all(Array.from({ length: 6 }, () => caller.call(task)));
    // Without the restored `await` in executeAndHandleErrors this would exceed 2.
    expect(peak).toBe(2);
  });

  it("processes every queued task", async () => {
    const caller = track(new AsyncCaller({ tokenBucketOptions: wideOpen, concurrency: 1 }));
    const results = await Promise.all(
      Array.from({ length: 4 }, (_unused, i) => caller.call(() => Promise.resolve(i))),
    );
    expect(results).toEqual([0, 1, 2, 3]);
  });
});

// ---------------------------------------------------------------------------
// Token-bucket integration: backpressure vs. per-call retry (addendum B1),
// consumeAsync always-resolves, destroy() / BucketDestroyedError
// ---------------------------------------------------------------------------
describe("token-bucket integration", () => {
  it("pauses the shared bucket on a 429 result", async () => {
    const caller = track(new AsyncCaller({ tokenBucketOptions: wideOpen, retryOptions: fastRetry }));
    const pause = spyPause(caller);
    let n = 0;
    await caller.call(() => Promise.resolve(++n === 1 ? { status: 429 } : { status: 200 }));
    expect(pause).toHaveBeenCalled();
    expect(n).toBe(2);
  });

  it("does NOT pause the shared bucket on a non-429 thrown error (B1 regression)", async () => {
    const caller = track(new AsyncCaller({ tokenBucketOptions: wideOpen, retryOptions: fastRetry }));
    const pause = spyPause(caller);
    let n = 0;
    const result = await caller.call(() => {
      if (++n === 1) return Promise.reject(new Error("transient network blip"));
      return Promise.resolve("recovered");
    });
    expect(result).toBe("recovered");
    expect(n).toBe(2); // it retried
    expect(pause).not.toHaveBeenCalled(); // but did NOT freeze the shared bucket
  });

  it("pauses the shared bucket on a 429 *error* but not on a plain error", async () => {
    const caller = track(new AsyncCaller({ tokenBucketOptions: wideOpen, retryOptions: fastRetry }));
    const pause = spyPause(caller);
    let n = 0;
    await caller.call(() => {
      if (++n === 1) return Promise.reject({ status: 429 });
      return Promise.resolve("ok");
    });
    expect(pause).toHaveBeenCalled();
  });

  it("consumeAsync always resolves: a briefly-empty bucket still lets the call through", async () => {
    // Start with 0 tokens; the interval refills fillPerWindow every window. The
    // call must wait and then succeed (never resolve `false`).
    const caller = track(new AsyncCaller({
      tokenBucketOptions: { capacity: 2, fillPerWindow: 2, windowInMs: 15, initialTokens: 0 },
    }));
    await expect(caller.call(() => Promise.resolve("through"))).resolves.toBe("through");
  });

  it("rejects a waiting call with BucketDestroyedError when destroyed mid-wait", async () => {
    const caller = track(new AsyncCaller({
      tokenBucketOptions: { capacity: 1, fillPerWindow: 1, windowInMs: 100000, initialTokens: 0 },
    }));
    const pending = caller.call(() => Promise.resolve("never"));
    await sleep(5); // let the call reach consumeAsync and start waiting
    caller.destroy();
    await expect(pending).rejects.toBeInstanceOf(BucketDestroyedError);
  });

  it("destroy() is idempotent", () => {
    const caller = new AsyncCaller({ tokenBucketOptions: wideOpen });
    expect(() => { caller.destroy(); caller.destroy(); }).not.toThrow();
  });

  it("propagates a non-BucketDestroyedError rejection from consumeAsync without swallowing it", async () => {
    const caller = track(new AsyncCaller({ tokenBucketOptions: wideOpen }));
    (caller as any)._tokenBucket = {
      consumeAsync: () => Promise.reject(new Error("boom")),
      forceWaitUntilMillisecondsPassed: () => {},
      destroy: () => {},
    };
    await expect(caller.call(() => Promise.resolve("x"))).rejects.toThrow("boom");
  });
});

// ---------------------------------------------------------------------------
// Hooks (addendum B2/B3/B4)
// ---------------------------------------------------------------------------
describe("call hooks", () => {
  it("per-call rateLimit hook overrides the client-level one", async () => {
    const caller = track(new AsyncCaller({
      tokenBucketOptions: wideOpen,
      retryOptions: { ...fastRetry, maxRetries: 1 },
      hooks: { rateLimit: () => ({ retryAfterMs: 5 }) }, // client-level
    }));
    const pause = spyPause(caller);
    let n = 0;
    const perCall: CallHooks<any> = { rateLimit: () => (++n === 1 ? { retryAfterMs: 42 } : null) };
    await caller.call(() => Promise.resolve({ status: 200 }), perCall);
    // Per-call value (42) wins over the client-level value (5).
    expect(pause).toHaveBeenCalledWith(42);
  });

  it("a per-call hook returning null falls through to the client-level hook", async () => {
    const caller = track(new AsyncCaller({
      tokenBucketOptions: wideOpen,
      retryOptions: { ...fastRetry, maxRetries: 1 },
      hooks: { rateLimit: () => ({ retryAfterMs: 9 }) },
    }));
    const pause = spyPause(caller);
    await caller.call(() => Promise.resolve({ status: 200 }), { rateLimit: () => null });
    expect(pause).toHaveBeenCalledWith(9); // fell through to the client-level hook
  });

  it("uses retryAfterMs directly, with no header round-trip (B4)", async () => {
    const caller = track(new AsyncCaller({
      tokenBucketOptions: wideOpen,
      retryOptions: { ...fastRetry, maxRetries: 1, minDelayInMs: 5 },
    }));
    const pause = spyPause(caller);
    let n = 0;
    const hooks: CallHooks<any> = { rateLimit: () => (++n === 1 ? { retryAfterMs: 33 } : null) };
    await caller.call(() => Promise.resolve({ status: 200 }), hooks);
    // 33 (not the 5ms default delay) proves the body-derived ms is used verbatim.
    expect(pause).toHaveBeenCalledWith(33);
  });

  it("catches a real HTTP 429 even when every hook returns null (layer 3 is unconditional, B3)", async () => {
    const caller = track(new AsyncCaller({
      tokenBucketOptions: wideOpen,
      retryOptions: fastRetry,
      hooks: { rateLimit: () => null, error: () => null },
    }));
    const pause = spyPause(caller);
    let n = 0;
    await caller.call(
      () => Promise.resolve(++n === 1 ? { status: 429 } : { status: 200 }),
      { rateLimit: () => null, error: () => null },
    );
    expect(pause).toHaveBeenCalled(); // built-in 429 check still fired
    expect(n).toBe(2);
  });

  it("an error hook returning an Error is treated as a thrown error (retried, no backpressure)", async () => {
    const caller = track(new AsyncCaller({ tokenBucketOptions: wideOpen, retryOptions: fastRetry }));
    const pause = spyPause(caller);
    let n = 0;
    const hooks: CallHooks<any> = { error: (r: any) => (r.ok === false ? new Error("body said fail") : null) };
    const result = await caller.call(() => Promise.resolve(n++ === 0 ? { ok: false } : { ok: true }), hooks);
    expect(result).toEqual({ ok: true });
    expect(pause).not.toHaveBeenCalled(); // error path never pauses the shared bucket
  });

  it("a non-retryable error hook result stops retrying", async () => {
    const caller = track(new AsyncCaller({ tokenBucketOptions: wideOpen, retryOptions: fastRetry }));
    const clientErr: any = { status: 400 };
    const hooks: CallHooks<any> = { error: () => Object.assign(new Error("client"), clientErr) };
    let n = 0;
    await expect(caller.call(() => { n++; return Promise.resolve({ ok: false }); }, hooks)).rejects.toThrow("client");
    expect(n).toBe(1); // dontRetry (400) => single attempt
  });
});

// ---------------------------------------------------------------------------
// Retry-delay calculation (Retry-After parsing — "worth preserving")
// ---------------------------------------------------------------------------
describe("defaultCalculateRetryDelay", () => {
  const caller = () => track(new AsyncCaller({ tokenBucketOptions: wideOpen }));

  it("reads integer seconds from a Headers-like object (.get)", () => {
    const c = caller();
    const headers = { get: (k: string) => (k === "Retry-After" ? "2" : null) };
    expect((c as any).defaultCalculateRetryDelay(1, { headers })).toBe(2000);
  });

  it("reads integer seconds from a plain headers object", () => {
    const c = caller();
    expect((c as any).defaultCalculateRetryDelay(1, { headers: { "Retry-After": "3" } })).toBe(3000);
  });

  it("parses an HTTP-date Retry-After into a forward delay", () => {
    const c = caller();
    const future = new Date(Date.now() + 5000).toUTCString();
    const delay = (c as any).defaultCalculateRetryDelay(1, { headers: { "Retry-After": future } });
    expect(delay).toBeGreaterThan(3000);
    expect(delay).toBeLessThanOrEqual(5000);
  });

  it("falls back to exponential backoff when Retry-After is unparseable", () => {
    const c = caller();
    // minDelay default 1000, attempt 1 -> 1000.
    expect((c as any).defaultCalculateRetryDelay(1, { headers: { "Retry-After": "not-a-date" } })).toBe(1000);
  });

  it("falls back to backoff when headers exist but carry no Retry-After", () => {
    const c = caller();
    expect((c as any).defaultCalculateRetryDelay(2, { headers: { "X-Other": "1" } })).toBe(2000);
  });

  it("falls back to backoff when there are no headers at all", () => {
    const c = caller();
    expect((c as any).defaultCalculateRetryDelay(1, { status: 429 })).toBe(1000);
  });
});

// ---------------------------------------------------------------------------
// Status extraction & classification (migration item 14 / handoff item 6)
// ---------------------------------------------------------------------------
describe("status extraction & classification", () => {
  it("detects 429 across the various status shapes", () => {
    const c = track(new AsyncCaller({ tokenBucketOptions: wideOpen }));
    expect((c as any).isRateLimitedError({ status: 429 })).toBe(true);
    expect((c as any).isRateLimitedError({ response: { status: 429 } })).toBe(true);
    expect((c as any).isRateLimitedError({ statuscode: "429" })).toBe(true); // string -> parseInt
    expect((c as any).isRateLimitedError({ response: { statuscode: 429 } })).toBe(true);
    expect((c as any).isRateLimitedError({ status: 200 })).toBe(false);
  });

  it("classifies 4xx (non-429) as client-side, but not other ranges", () => {
    const c = track(new AsyncCaller({ tokenBucketOptions: wideOpen }));
    expect((c as any).isClientSideError({ status: 400 })).toBe(true);
    expect((c as any).isClientSideError({ status: 429 })).toBe(false); // 429 is retryable
    expect((c as any).isClientSideError({ status: 500 })).toBe(false);
    expect((c as any).isClientSideError({ status: "abc" })).toBe(false); // unparseable -> filtered
    expect((c as any).isClientSideError({ status: null })).toBe(false); // non-number/string -> undefined
  });

  it("ignores numeric error.code by default (treatErrorCodeAsStatus off)", async () => {
    const caller = track(new AsyncCaller({ tokenBucketOptions: wideOpen, retryOptions: fastRetry }));
    let n = 0;
    // A gRPC-style numeric code of 404 must NOT be read as an HTTP client error by default.
    const result = await caller.call(() => {
      if (++n === 1) return Promise.reject({ code: 404 });
      return Promise.resolve("retried-through");
    });
    expect(result).toBe("retried-through");
    expect(n).toBe(2); // retried, because code was not treated as a 4xx status
  });

  it("treats numeric error.code as status when treatErrorCodeAsStatus is on", async () => {
    const caller = track(new AsyncCaller({
      tokenBucketOptions: wideOpen,
      retryOptions: fastRetry,
      treatErrorCodeAsStatus: true,
    }));
    let n = 0;
    await expect(caller.call(() => { n++; return Promise.reject({ code: 404 }); })).rejects.toBeDefined();
    expect(n).toBe(1); // treated as a client-side 4xx => no retry
  });
});

// ---------------------------------------------------------------------------
// Retry exhaustion
// ---------------------------------------------------------------------------
describe("retry exhaustion", () => {
  it("throws the last error after exhausting retries", async () => {
    const caller = track(new AsyncCaller({ tokenBucketOptions: wideOpen, retryOptions: { ...fastRetry, maxRetries: 2 } }));
    let n = 0;
    await expect(caller.call(() => { n++; return Promise.reject(new Error("always")); })).rejects.toThrow("always");
    expect(n).toBe(3); // initial + 2 retries
  });

  it("returns the last (still rate-limited) result after exhausting retries", async () => {
    const caller = track(new AsyncCaller({ tokenBucketOptions: wideOpen, retryOptions: { ...fastRetry, maxRetries: 2 } }));
    let n = 0;
    const result = await caller.call(() => { n++; return Promise.resolve({ status: 429 }); });
    expect(result).toEqual({ status: 429 });
    expect(n).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Verbose logging
// ---------------------------------------------------------------------------
describe("verbose logging", () => {
  it("logs when verbose is enabled", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const caller = track(new AsyncCaller({ tokenBucketOptions: wideOpen, retryOptions: fastRetry }, true));
    let n = 0;
    await caller.call(() => Promise.resolve(++n === 1 ? { status: 429 } : { status: 200 }));
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("AsyncCaller:"));
  });
});

// ---------------------------------------------------------------------------
// Defensive / white-box guards (unreachable in normal flow, covered directly)
// ---------------------------------------------------------------------------
describe("defensive guards", () => {
  it("returns lastResponse when tryCount is already past the ceiling and there is no error", async () => {
    const caller = track(new AsyncCaller({ tokenBucketOptions: wideOpen })); // maxRetries default 3 -> ceiling 4
    const out = await (caller as any).executeWithRetry(() => Promise.resolve("fresh"), undefined, 5, "stale", undefined);
    expect(out).toBe("stale");
  });

  it("throws lastError when tryCount is already past the ceiling and an error is carried", async () => {
    const caller = track(new AsyncCaller({ tokenBucketOptions: wideOpen }));
    await expect(
      (caller as any).executeWithRetry(() => Promise.resolve("fresh"), undefined, 5, undefined, new Error("carried")),
    ).rejects.toThrow("carried");
  });

  it("skips a falsy queue entry without admitting a task", () => {
    const caller = track(new AsyncCaller({ tokenBucketOptions: wideOpen }));
    (caller as any).queue.push(undefined);
    expect(() => (caller as any).processTaskQueue()).not.toThrow();
  });
});
