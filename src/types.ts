export enum TimeUnit {
  Milliseconds = 1,
  Seconds = 1000,
  Minutes = 60000,
  Hours = 3600000,
  Days = 86400000,
}

export interface RetryOptions {
  /**
   * The maximum number of retries. Default is 3.
   */
  maxRetries?: number;
  /**
   * The minimum delay between retries in milliseconds. Default is 1000.
   */
  minDelayInMs?: number;
  /**
   * The maximum delay between retries in milliseconds. Default is 10000
   */
  maxDelayInMs?: number;
  /**
   * The factor by which the delay should be increased after each retry. Default is 2.
   */
  backoffFactor?: number;
}

export interface TokenBucketOptions {
  capacity: number;
  fillPerWindow: number;
  windowInMs: number;
  initialTokens?: number;
}

/**
 * Per-call (or client-level default) hooks for classifying a **resolved**
 * result whose success/failure lives in the payload rather than an HTTP status
 * code — e.g. a `200` carrying `{"error":{"status":"RESOURCE_EXHAUSTED"}}` or
 * `{"success":false}`.
 *
 * These are a higher-level, ergonomic layer over {@link ResultIdentifier}; they
 * do not replace it. Resolution is **most-specific-first, falling through on
 * `null`**: per-call hook → client-level hook → the built-in HTTP 429 check.
 * The built-in HTTP check always runs last and is unconditional — a real HTTP
 * `429` is a rate limit no matter what the hooks return.
 *
 * Note: unlike the shape sketched in the design notes, a hook receives the
 * already-resolved result `T` (whatever `fn` returned), not a `Response` +
 * parsed `body`. `AsyncCaller` never performs the fetch itself, so it cannot
 * read a body — if you need the body, have `fn` return it (or `{ res, body }`).
 */
export interface CallHooks<T = any> {
  /**
   * Return a non-null object to treat the resolved result exactly as an HTTP
   * `429` with the given delay: global backpressure is applied to the shared
   * bucket and the call is retried. Return `null` to fall through to the next
   * layer (the built-in HTTP 429 check still applies).
   */
  rateLimit?: (result: T) => { retryAfterMs: number, } | null;
  /**
   * Return a non-null `Error` to treat the resolved result exactly as if `fn()`
   * had thrown it: it is retried (or not, per its own non-retryable marking)
   * with **no** effect on other callers. Return `null` to fall through.
   */
  error?: (result: T) => Error | null;
}

/**
 * Should have two functions. One for identifying the result of the function, and one for identifying the error thrown by the function.
 *
 * Based on the determination of the function, the retry logic will be applied.
 *
 */
export interface ResultIdentifier {
  /**
   * Identify the result of the function, in case the function resolves to a value
   * @param result - The result of the function.
   * @returns An object with two properties: isRateLimited and isClientSideError.
   */
  identifyResult: (result: any) => {
    /**
     * If the result is considered rate limited, this should be true. In this case, the next retry (if any) will be delayed according to default logic, or the custom logic provided by the user.
     */
    isRateLimited: boolean;
  };
  /**
   * Identify the error thrown by the function.
   * @param error - The error thrown by the function.
   * @returns An object with two properties: isRateLimited and isClientSideError.
   */
  identifyError: (error: any) => {
    /**
     * If the error is considered rate limited, this should be true. In this case, the next retry (if any) will be delayed according to default logic, or the custom logic provided by the user. **Important**: This property takes precedence over `dontRetry`.
     */
    isRateLimited: boolean;
    /**
     * If the error shows that retrying is pointless (i.e client side error), this should be true. In this case (if this is `true` AND `isRateLimited` is `false`), retry will be stopped and the error will be thrown. **Important**: `isRateLimited` takes precedence over `dontRetry`.
     */
    dontRetry: boolean;
  };
}
