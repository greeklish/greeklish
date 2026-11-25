export async function withRetries(
  task,
  {
    maxRetries = 2,
    shouldRetry = defaultShouldRetry,
    delayMs = defaultDelayMs,
    onRetry = null,
  } = {}
) {
  let attempt = 1;

  for (;;) {
    try {
      return await task({ attempt });
    } catch (error) {
      if (attempt >= maxRetries || !shouldRetry(error, attempt, maxRetries)) {
        throw error;
      }

      const waitMs = delayMs(attempt, error);
      if (onRetry) {
        await onRetry({ attempt, error, waitMs });
      }
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      attempt += 1;
    }
  }
}

export function defaultShouldRetry(error, attempt, maxRetries) {
  if (attempt >= maxRetries) {
    return false;
  }

  if (/Operation aborted|aborted/i.test(error.message)) {
    return false;
  }

  if (/No proxy available/i.test(error.message)) {
    return false;
  }

  const retryablePatterns = [
    /ERR_NETWORK_CHANGED/i,
    /ERR_SOCKS_CONNECTION_FAILED/i,
    /ERR_PROXY_CONNECTION_FAILED/i,
    /Target closed/i,
    /Page has been closed/i,
    /Browser no longer accessible/i,
    /timeout/i,
    /NO_CONNECTIVITY/i,
    /HTTP 429/i,
    /HTTP 403/i,
    /rate limit/i,
  ];

  return retryablePatterns.some((pattern) => pattern.test(error.message));
}

function defaultDelayMs(attempt) {
  const exponential = 1_000 * 2 ** (attempt - 1);
  const jitter = Math.random() * 500;
  return Math.min(exponential + jitter, 10_000);
}
