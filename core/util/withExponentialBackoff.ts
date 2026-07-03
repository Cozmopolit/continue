export interface APIError extends Error {
  response?: Response;
  code?: string;
}

export const RETRY_AFTER_HEADER = "Retry-After";

/**
 * Network error codes that indicate transient connection issues
 * and should be retried.
 */
const RETRYABLE_NETWORK_ERROR_CODES = new Set([
  "ETIMEDOUT", // Connection timed out
  "ECONNRESET", // Connection reset by peer
  "ECONNREFUSED", // Connection refused
  "ENOTFOUND", // DNS lookup failed
  "ENETUNREACH", // Network unreachable
  "EHOSTUNREACH", // Host unreachable
  "EPIPE", // Broken pipe
  "EAI_AGAIN", // DNS lookup timed out
]);

/**
 * Check if an error is a retryable network error
 */
function isRetryableNetworkError(error: any): boolean {
  // Check error code (Node.js network errors)
  if (error.code && RETRYABLE_NETWORK_ERROR_CODES.has(error.code)) {
    return true;
  }

  // Check for nested cause with error code (e.g., FetchError wrapping system error)
  if (
    error.cause?.code &&
    RETRYABLE_NETWORK_ERROR_CODES.has(error.cause.code)
  ) {
    return true;
  }

  // Check message for common network error patterns
  const lowerMessage = (error.message ?? "").toLowerCase();
  if (
    lowerMessage.includes("etimedout") ||
    lowerMessage.includes("econnreset") ||
    lowerMessage.includes("econnrefused") ||
    lowerMessage.includes("connect etimedout") ||
    lowerMessage.includes("socket hang up") ||
    lowerMessage.includes("network error")
  ) {
    return true;
  }

  return false;
}

/**
 * Check if an error is a retryable rate limit or server error
 */
function isRetryableRateLimitOrServerError(error: any): boolean {
  const lowerMessage = (error.message ?? "").toLowerCase();

  // HTTP 429 (Rate Limit)
  if ((error as APIError).response?.status === 429) {
    return true;
  }

  // Embedded 429 in response body (e.g., Gemini/VertexAI)
  if (/"code"\s*:\s*429/.test(error.message ?? "")) {
    return true;
  }

  // Server overloaded or malformed response
  if (
    lowerMessage.includes("overloaded") ||
    lowerMessage.includes("malformed json")
  ) {
    return true;
  }

  // HTTP 5xx Server Errors
  const status = (error as APIError).response?.status;
  if (status && status >= 500 && status < 600) {
    return true;
  }

  return false;
}

const withExponentialBackoff = async <T>(
  apiCall: () => Promise<T>,
  maxTries = 5,
  initialDelaySeconds = 1,
) => {
  for (let attempt = 0; attempt < maxTries; attempt++) {
    try {
      const result = await apiCall();
      return result;
    } catch (error: any) {
      const isNetworkError = isRetryableNetworkError(error);
      const isRateLimitOrServerError = isRetryableRateLimitOrServerError(error);

      if (isNetworkError || isRateLimitOrServerError) {
        // Don't retry on last attempt
        if (attempt === maxTries - 1) {
          throw error;
        }

        const retryAfter = (error as APIError).response?.headers?.get(
          RETRY_AFTER_HEADER,
        );
        const delay = retryAfter
          ? parseInt(retryAfter, 10)
          : initialDelaySeconds * 2 ** attempt;

        const errorType = isNetworkError
          ? `Network error (${error.code || "connection failed"})`
          : "Rate limit/server error";

        console.log(
          `${errorType}. Retrying in ${delay} seconds (attempt ${
            attempt + 1
          } of ${maxTries}): ${error.message}`,
        );
        await new Promise((resolve) => setTimeout(resolve, delay * 1000));
      } else {
        throw error; // Re-throw non-retryable errors
      }
    }
  }
  throw new Error(`Failed to make API call after ${maxTries} retries`);
};

export { withExponentialBackoff };
