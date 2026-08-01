import { fetch as tauriFetch } from "@tauri-apps/plugin-http";

/**
 * Shared request plumbing for the lyrics providers, with one job: keep the
 * difference between "this track has no lyrics" and "we could not find out"
 * intact all the way up to React Query.
 *
 * That distinction used to be lost. Every provider wrapped its requests in
 * `catch { return null }`, so a DNS blip, a Musixmatch captcha gate and a
 * Genius 403 all arrived as the same `null` that a genuinely lyric-less
 * track produces. React Query stores `null` as a *success*, `App.tsx:49`
 * dehydrates successes to IndexedDB, and `query-client.ts:9` keeps them for
 * 24h. One dropped packet was therefore written to disk and replayed as an
 * authoritative "No lyrics found." across restarts, with no way for the user
 * to ask again.
 *
 * The rule here is: throw for anything that might succeed on a retry, return
 * a value only for a real answer. Errored queries are neither cached nor
 * dehydrated, so they retry on their own and can be retried by hand.
 *
 * The second job is bounding the wait. Nothing had a timeout, so a single
 * stalled socket pinned the panel on "Loading lyrics…" until the track
 * changed, even when the other two providers had already answered.
 */

/**
 * Wall-clock budget for one provider's entire lookup, not one request.
 * Musixmatch alone can chain four calls (token, search, subtitle, lyrics),
 * so a per-request timeout would let it run four times longer than the
 * others. Every provider gets one deadline and threads it through.
 */
export const PROVIDER_TIMEOUT_MS = 8_000;

/** Raised when a provider runs out of time. Distinct from a transport
 *  failure so callers and tests can tell the two apart. */
export class LyricsTimeoutError extends Error {
  constructor(ms: number) {
    super(`Lyrics provider exceeded its ${ms} ms budget`);
    this.name = "LyricsTimeoutError";
  }
}

/**
 * Raised when a provider refuses to serve us for now, as opposed to
 * failing. Musixmatch gates hard (roughly 20 requests per IP per two
 * minutes, and the lyrics panel fires on every track change whether or not
 * anyone is looking at it), so this is the common failure in practice.
 *
 * Kept separate from the others for one reason: an immediate retry is the
 * exact wrong response to being told "too often". `sources.ts` skips the
 * automatic retry for these and leaves it to the panel's Try again button.
 */
export class LyricsRateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LyricsRateLimitError";
  }
}

/** Raised when the request never produced a usable HTTP response. */
export class LyricsTransportError extends Error {
  /** The underlying failure. Assigned by hand rather than passed to
   *  `super(message, { cause })`: the project targets ES2020 and the lib
   *  types predate `Error.cause`. The property is what matters, and it is
   *  what makes the original error visible in a devtools stack. */
  readonly cause?: unknown;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "LyricsTransportError";
    this.cause = options?.cause;
  }
}

export type Deadline = {
  signal: AbortSignal;
  /** Clears the timer. Always call this, or the timer keeps the callback
   *  alive for the full budget after the work has already finished. */
  done: () => void;
  /** True once the budget elapsed, as opposed to React Query aborting us
   *  because the track changed. Lets callers report the right error. */
  timedOut: () => boolean;
};

/**
 * One deadline per provider lookup, optionally chained to React Query's own
 * signal so a track switch cancels in-flight work immediately.
 *
 * Deliberately built from a plain AbortController rather than
 * `AbortSignal.any` + `AbortSignal.timeout`: those are recent additions and
 * this runs in whatever WebView2 the user happens to have, plus Node under
 * vitest. The manual version is a dozen lines and has no floor.
 */
export function createDeadline(
  upstream?: AbortSignal,
  ms: number = PROVIDER_TIMEOUT_MS,
): Deadline {
  const controller = new AbortController();
  let expired = false;

  const timer = setTimeout(() => {
    expired = true;
    controller.abort();
  }, ms);

  const onUpstreamAbort = () => controller.abort();
  if (upstream) {
    if (upstream.aborted) controller.abort();
    else upstream.addEventListener("abort", onUpstreamAbort, { once: true });
  }

  return {
    signal: controller.signal,
    done: () => {
      clearTimeout(timer);
      upstream?.removeEventListener("abort", onUpstreamAbort);
    },
    timedOut: () => expired,
  };
}

/**
 * `tauriFetch` with the deadline attached, and transport failures turned
 * into typed errors instead of swallowed. Does NOT inspect the status code:
 * whether a 404 means "no lyrics" or "provider is broken" is per-provider
 * knowledge, so that call stays with the caller.
 */
export async function lyricsFetch(
  url: string,
  deadline: Deadline,
  headers: Record<string, string>,
  /** JSON body. Its presence switches the request to POST. */
  body?: unknown,
): Promise<Response> {
  try {
    return await tauriFetch(url, {
      method: body === undefined ? "GET" : "POST",
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: deadline.signal,
    });
  } catch (e) {
    if (deadline.timedOut()) throw new LyricsTimeoutError(PROVIDER_TIMEOUT_MS);
    // An upstream abort (track changed, component unmounted) is not a
    // failure worth reporting. Re-throw it as-is so React Query recognises
    // the cancellation instead of flagging the query as errored.
    if (deadline.signal.aborted) throw e;
    throw new LyricsTransportError(
      `Request to ${safeHost(url)} failed`,
      { cause: e },
    );
  }
}

/**
 * Status codes worth another attempt: the provider broke rather than
 * refused. 429 is deliberately NOT here — being told "too many requests"
 * and answering with one more request is how a short gate becomes a long
 * one. See `throwForStatus`.
 *
 * Everything else (401, 403, 404) carries provider-specific meaning and is
 * decided by the caller.
 */
export function isTransientStatus(status: number): boolean {
  return status === 408 || status >= 500;
}

/**
 * Raise the right error type for a status the caller has decided is a
 * failure. Centralised so every provider classifies identically: getting
 * this wrong for one of them silently reintroduces the retry amplification
 * this whole layer exists to prevent.
 */
export function throwForStatus(status: number, what: string): never {
  if (status === 429) {
    throw new LyricsRateLimitError(`${what} rate limited (429)`);
  }
  throw new Error(`${what} ${status}`);
}

/** How many times React Query re-runs a failed lyrics query on its own. */
const AUTO_RETRIES = 1;

/**
 * React Query's `retry` predicate for every lyrics source. Lives here
 * rather than in the hook so it can be tested without mounting anything,
 * and because deciding which errors deserve another go is the same
 * knowledge that produced the error types above.
 */
export function shouldRetryLyricsQuery(
  failureCount: number,
  // Typed as `Error`, not `unknown`: React Query infers a query's `TError`
  // from this predicate, and widening it here would widen every consumer of
  // `queries[s].error` along with it.
  error: Error,
): boolean {
  // Never hammer a provider that just told us we are asking too often.
  if (error instanceof LyricsRateLimitError) return false;
  return failureCount < AUTO_RETRIES;
}

/** Host only, so a thrown message never carries the search terms. */
function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "lyrics provider";
  }
}
