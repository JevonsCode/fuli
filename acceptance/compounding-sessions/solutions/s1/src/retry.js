// Retry policy for every outbound channel: at most 3 attempts, 200 ms before the second and 400 ms before the
// third; retry a 5xx answer or a thrown (network) error, never a 4xx.
export const RETRY_POLICY = Object.freeze({ attempts: 3, delays: Object.freeze([200, 400]) });

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const retryable = (result) => result.status >= 500;

export async function withRetry(attempt, {
  sleep = wait,
  attempts = RETRY_POLICY.attempts,
  delays = RETRY_POLICY.delays,
  shouldRetry = retryable
} = {}) {
  for (let n = 1; ; n += 1) {
    let result;
    try {
      result = await attempt(n);
    } catch (error) {
      if (n >= attempts) throw error;
      await sleep(delays[n - 1]);
      continue;
    }
    if (n >= attempts || !shouldRetry(result)) return result;
    await sleep(delays[n - 1]);
  }
}
