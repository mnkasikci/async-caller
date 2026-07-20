import { TokenBucket, BucketDestroyedError } from "@bakidev/token-bucket";
import type { RetryOptions, TokenBucketOptions, ResultIdentifier, CallHooks } from "./types.js";

/**
 * How a resolved result is classified before deciding whether to retry.
 * `ok` — return it as-is. `rateLimited` — apply global backpressure and retry.
 * `error` — treat exactly as if `fn()` threw `error`.
 */
type ResultClassification =
  | { kind: "ok", }
  | { kind: "rateLimited", retryAfterMs?: number, }
  | { kind: "error", error: Error, };

const defaultTokenBucketOptions: TokenBucketOptions = {
  capacity: 10,
  fillPerWindow: 1,
  windowInMs: 100,
};

const defaultRetryOptions: Required<RetryOptions> = {
  maxRetries: 3,
  minDelayInMs: 1000,
  maxDelayInMs: 10000,
  backoffFactor: 2,
};

/**
 * A class for making asynchronous calls with retry, concurrency, and rate limiting capabilities.
 * Creates an instance of AsyncCaller.
 * @param options - The options for configuring the AsyncCaller.
 * @param options.tokenBucketOptions - The options for configuring the rate limits.
 * @param options.tokenBucketOptions.capacity - The maximum number of requests allowed in a window.
 * @param options.tokenBucketOptions.fillPerWindow - The number of requests to allow per window. This determines the rate at which requests are allowed.
 * @param options.tokenBucketOptions.windowInMs - The size of the window in milliseconds.
 * @param options.tokenBucketOptions.initialTokens - The initial number of allowed requests. If not provided, it defaults to the capacity. Setting it to a lower value can be useful for gradually ramping up the rate.
 * @param options.safetyMarginMs - A safety margin in milliseconds added to `tokenBucketOptions.windowInMs` before it is handed to the token bucket. Useful for compensating for timer drift so the configured rate is never exceeded upstream. Defaults to `0` and is applied uniformly whether or not `tokenBucketOptions` is provided.
 * @param options.retryOptions - The options for configuring the retry behavior.
 * @param options.concurrency - The maximum number of concurrent tasks allowed.
 * @param options.customResultIdentifier - A custom result identifier for identifying the result of the function.
 * @param options.customRetryDelayInMsCalculator - A custom retry delay calculator for calculating the retry delay in milliseconds. This is used to calculate the retry delay in milliseconds based on the result of the function or the error thrown by the function. It computes a delay only — global backpressure on the shared bucket is applied by the caller on the rate-limited path, never by this function.
 * @param options.hooks - Client-level default {@link CallHooks} for classifying resolved results (body-encoded rate limits / errors). Per-call hooks passed to {@link AsyncCaller.call} take precedence.
 * @param options.treatErrorCodeAsStatus - When `true`, a numeric `error.code` is considered when extracting HTTP status codes. Defaults to `false` because non-HTTP numeric codes (gRPC status codes, some DB drivers) can land in the 400–499 range and be misclassified as non-retryable client errors.
 *
 * @example
 * // Create an AsyncCaller with a simple rate limit of 10 requests per second
 * const asyncCaller = new AsyncCaller({
 *   tokenBucketOptions: {
 *     capacity: 10,
 *     fillPerWindow: 10,
 *     windowInMs: 1000,
 *   },
 * });
 *
 * @example
 * // Create an AsyncCaller with a rate limit of 100 requests per minute, with a burst capacity of 20 requests
 * const asyncCaller = new AsyncCaller({
 *   tokenBucketOptions: {
 *     capacity: 20,
 *     fillPerWindow: 100,
 *     windowInMs: 60000,
 *   },
 * });
 */

export class AsyncCaller<U=any> {
  private readonly _tokenBucket: TokenBucket;
  private readonly _retryOptions: Required<RetryOptions>;
  private readonly _concurrency: number;
  private runningTasks: number = 0;
  private readonly queue: Array<() => void>;
  private readonly verbose: boolean;
  private readonly resultIdentifier: ResultIdentifier;
  private readonly getRetryDelay: (attemptCount: number, result: U | Error) => number;
  private readonly _hooks?: CallHooks<U>;
  private readonly _treatErrorCodeAsStatus: boolean;
  constructor (options?: {
    tokenBucketOptions?: TokenBucketOptions;
    safetyMarginMs?: number;
    retryOptions?: RetryOptions;
    concurrency?: number;
    customResultIdentifier?: ResultIdentifier;
    customRetryDelayInMsCalculator?: (attemptCount: number, result: U | Error) => number;
    hooks?: CallHooks<U>;
    treatErrorCodeAsStatus?: boolean;
  }, verbose: boolean = false) {
    this.verbose = verbose;
    // Merge partial options over the defaults so unspecified fields keep their
    // defined defaults instead of becoming `undefined` (which would propagate
    // to NaN in delay/window arithmetic).
    const tokenBucketOptions: TokenBucketOptions = {
      ...defaultTokenBucketOptions,
      ...options?.tokenBucketOptions,
    };
    // Applied uniformly to both the default and explicit paths.
    const safetyMarginMs = options?.safetyMarginMs ?? 0;
    this._tokenBucket = new TokenBucket({
      ...tokenBucketOptions,
      windowInMs: tokenBucketOptions.windowInMs + safetyMarginMs,
    }, this.verbose);
    this._retryOptions = { ...defaultRetryOptions, ...options?.retryOptions };
    this._concurrency = options?.concurrency ?? 5;
    this.queue = [];
    this.resultIdentifier = options?.customResultIdentifier ?? this.defaultIdentifier;
    this.getRetryDelay = options?.customRetryDelayInMsCalculator ?? this.defaultCalculateRetryDelay;
    this._hooks = options?.hooks;
    this._treatErrorCodeAsStatus = options?.treatErrorCodeAsStatus ?? false;
  }

  private readonly defaultIdentifier: ResultIdentifier = {
    identifyResult: (response) => {
      return {
        isRateLimited: this.isRateLimitedError(response),
      };
    },
    identifyError: (error) => {
      return {
        isRateLimited: this.isRateLimitedError(error),
        dontRetry: this.isClientSideError(error),
      };
    },
  };

  /**
   * Queue `fn` for execution under the caller's concurrency, rate limit, and
   * retry policy.
   *
   * **`fn` must be idempotent and build its own request on every invocation.**
   * It is re-invoked from scratch on each retry, so a closure over an
   * already-consumed stream (a `Request`/`Response` body, a Node stream, a
   * `FormData` holding a file stream) fails the second attempt with a confusing
   * "body already used" error. Construct the request inside `fn`.
   *
   * @param fn The work to perform. Rebuilds its request on every call.
   * @param hooks Optional per-call {@link CallHooks} that take precedence over
   *   any client-level hooks. See {@link CallHooks} for resolution order.
   */
  public async call<T extends U>(fn: () => Promise<T>, hooks?: CallHooks<T>): Promise<T> {
    await new Promise<void>((resolve) => {
      this.queue.push(resolve);
      this.processTaskQueue();
    });
    return this.executeAndHandleErrors(fn, hooks);
  }

  /**
   * Tear down the caller and its owned token bucket. Clears the bucket's
   * internal timers and rejects any tasks currently waiting on tokens with a
   * {@link BucketDestroyedError}. Idempotent — safe to call more than once.
   */
  public destroy () {
    this._tokenBucket.destroy();
  }

  private processTaskQueue () {
    while (this.runningTasks < this._concurrency && this.queue.length > 0) {
      this.runningTasks++;
      const resolve = this.queue.shift();
      if (resolve) {
        this.log(`Running task... Concurrency: (${this.runningTasks} / ${this._concurrency}) (Queue length: ${this.queue.length})`);
        resolve();
      }
    }
  }

  private async executeWithRetry<T extends U> (fn: () => Promise<T>, hooks?: CallHooks<T>, tryCount: number = 1, lastResponse: any = undefined, lastError: any = undefined): Promise<T> {
    try {
      await this._tokenBucket.consumeAsync();
    } catch (err) {
      if (err instanceof BucketDestroyedError)
        this.log("Token bucket was destroyed while awaiting tokens. Aborting task.");
      // Propagate: the caller's promise rejects rather than silently hanging.
      throw err;
    }
    if (tryCount > this._retryOptions.maxRetries + 1) {
      this.log("Max retries exceeded. Rejecting...");
      if (lastError)
        throw lastError;
      else
        return lastResponse;
    }
    return fn()
      .then(async (result) => {
        if (tryCount === this._retryOptions.maxRetries + 1)
          return result;
        const classification = this.classifyResult(result, hooks);
        if (classification.kind === "error")
          // Treat exactly as if fn() threw: rethrow into the shared catch below.
          throw classification.error;
        if (classification.kind === "rateLimited") {
          // A rate limit throttles every caller: apply global backpressure here,
          // on the rate-limited path only. The delay calculator computes a delay;
          // it does not (and must not) touch the shared bucket itself.
          const delay = classification.retryAfterMs ?? this.getRetryDelay(tryCount, result as U);
          this._tokenBucket.forceWaitUntilMillisecondsPassed(delay);
          await this.sleep(delay);
          return this.executeWithRetry(fn, hooks, tryCount + 1, result, lastError);
        }
        return result;
      })
      .catch(async (err) => {
        if (tryCount === this._retryOptions.maxRetries + 1) {
          this.log("Max retries exceeded. Rejecting...");
          throw err;
        }
        const identifiedErrors = this.resultIdentifier.identifyError(err);
        if (identifiedErrors.dontRetry && !identifiedErrors.isRateLimited) {
          this.log("Don't retry. Throwing error...");
          throw err;
        }
        // At this point, it is either a rate limit error, or an unknown error.
        // Either way, we retry with delay — but only a *rate limit* applies
        // global backpressure. An error retries only the call that failed, so a
        // transient network blip in one caller must not freeze the others.
        const delay = this.getRetryDelay(tryCount, err);
        if (identifiedErrors.isRateLimited)
          this._tokenBucket.forceWaitUntilMillisecondsPassed(delay);
        await this.sleep(delay);
        return this.executeWithRetry(fn, hooks, tryCount + 1, lastResponse, err);
      });
  };

  /**
   * Classify a resolved result, most-specific-first, falling through on `null`:
   * per-call hook → client-level hook → built-in HTTP 429 check. The built-in
   * check is unconditional and always runs last — a real HTTP 429 is a rate
   * limit no matter what the hooks return.
   */
  private classifyResult<T extends U> (result: T, hooks?: CallHooks<T>): ResultClassification {
    for (const rateLimit of [hooks?.rateLimit, this._hooks?.rateLimit]) {
      if (rateLimit) {
        const verdict = rateLimit(result);
        if (verdict)
          return { kind: "rateLimited", retryAfterMs: verdict.retryAfterMs };
      }
    }
    for (const error of [hooks?.error, this._hooks?.error]) {
      if (error) {
        const verdict = error(result);
        if (verdict)
          return { kind: "error", error: verdict };
      }
    }
    if (this.resultIdentifier.identifyResult(result).isRateLimited)
      return { kind: "rateLimited" };
    return { kind: "ok" };
  }

  private async sleep (ms: number): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, ms));
  }

  private async executeAndHandleErrors<T extends U>(fn: () => Promise<T>, hooks?: CallHooks<T>): Promise<T> {
    try {
      // `return await` is required: without it the `finally` runs when the
      // promise is created, not when it settles, so `runningTasks` is decremented
      // before the task finishes and the concurrency cap is not enforced.
      return await this.executeWithRetry(fn, hooks, 1, undefined);
    } finally {
      this.runningTasks--;
      this.processTaskQueue();
    }
  }

  private isClientSideError (errOrResponse: any): boolean {
    const possibleProperties = this.extractStatusCodeProperties(errOrResponse);
    for (const property of possibleProperties) {
      if (property >= 400 && property < 500 && property !== 429) {
        this.log(`Client side error detected. Status code: ${property}`);
        this.log(JSON.stringify(errOrResponse));
        return true;
      }
    }
    return false;
  }

  private isRateLimitedError (errOrResponse: any): boolean {
    const possibleProperties = this.extractStatusCodeProperties(errOrResponse);
    this.log(`Possible properties: ${possibleProperties.join(", ")}`);
    for (const property of possibleProperties) {
      if (property === 429) {
        this.log("Too many requests detected, you might want to adjust your token bucket options.");
        return true;
      }
    }
    return false;
  }

  private extractStatusCodeProperties (err: any): number[] {
    const statusCodes = [
      err?.status,
      err?.response?.status,
      err?.statuscode,
      err?.response?.statuscode,
      // `err.code` is opt-in: non-HTTP numeric codes (gRPC, some DB drivers) can
      // land in the 400–499 range and be misread as a non-retryable client error.
      ...(this._treatErrorCodeAsStatus ? [err?.code] : []),
    ];

    return statusCodes.map((status) => {
      if (typeof status === "number" && !Number.isNaN(status))
        return status;
      else if (typeof status === "string" && !Number.isNaN(Number.parseInt(status)))
        return Number.parseInt(status);
      else
        return undefined;
    }).filter(Boolean) as number[];
  }

  // Computes a retry delay only. Applying that delay as global backpressure on
  // the shared bucket is the caller's job (see executeWithRetry) and happens on
  // the rate-limited path exclusively, so a custom calculator swapped in here
  // keeps global backpressure automatically without touching the bucket.
  private defaultCalculateRetryDelay (completedTryCount: number, result: U | Error): number {
    const headers = (result as any).headers;
    if (headers) {
      let retryAfterHeader;
      if (typeof headers.get === "function")
        retryAfterHeader = headers.get("Retry-After");
      else
        retryAfterHeader = headers["Retry-After"];

      if (retryAfterHeader) {
        const delay = Number.parseInt(retryAfterHeader) * 1000;
        if (!Number.isNaN(delay))
          return delay;
        else if (Date.parse(retryAfterHeader) > 0) {
          const now = new Date().getTime();
          const retryAfter = new Date(retryAfterHeader).getTime();
          const delay = Math.max(retryAfter - now, 0);
          this.log(`Retry-After header found. Delay: ${delay}ms`);

          return delay;
        } else {
          // If the Retry-After header value cannot be parsed, fall back to the default back-off strategy
          return this.calculateDefaultDelay(completedTryCount);
        }
      } else
        return this.calculateDefaultDelay(completedTryCount);
    } else {
      // If no specific Retry-After header is found, use the default back-off strategy
      return this.calculateDefaultDelay(completedTryCount);
    }
  }

  private calculateDefaultDelay (completedTryCount: number): number {
    // Exponential back-off strategy based on the RetryOptions
    const delay = Math.min(
      this._retryOptions.minDelayInMs * (this._retryOptions.backoffFactor) ** (completedTryCount - 1),
      this._retryOptions.maxDelayInMs,
    );
    return delay;
  }

  private log (message: string) {
    if (this.verbose)
      console.log(`AsyncCaller: ${message}`);
  }
}

export { BucketDestroyedError } from "@bakidev/token-bucket";
export * from "./types";
