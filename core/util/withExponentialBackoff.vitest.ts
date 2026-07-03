import { describe, expect, it, vi } from "vitest";

import {
  withExponentialBackoff,
  APIError,
  RETRY_AFTER_HEADER,
} from "./withExponentialBackoff";

describe("withExponentialBackoff", () => {
  it("should return result when apiCall succeeds on first attempt", async () => {
    const apiCall = vi.fn().mockResolvedValue("Success");

    const result = await withExponentialBackoff(apiCall);

    expect(result).toBe("Success");
    expect(apiCall).toHaveBeenCalledTimes(1);
  });

  it("should throw error when apiCall fails with non-retryable error", async () => {
    const error = new Error("Some client error");
    const apiCall = vi.fn().mockRejectedValue(error);

    await expect(withExponentialBackoff(apiCall)).rejects.toThrow(
      "Some client error",
    );
    expect(apiCall).toHaveBeenCalledTimes(1);
  });

  it("should retry when apiCall fails with 429 and no Retry-After header", async () => {
    const apiCall = vi.fn();

    const firstError: APIError = new Error("Rate limit");
    firstError.response = {
      status: 429,
      headers: {
        get: () => null,
      },
    } as unknown as Response;

    apiCall.mockRejectedValueOnce(firstError).mockResolvedValueOnce("Success");

    const result = await withExponentialBackoff(apiCall, 5, 0.01);

    expect(result).toBe("Success");
    expect(apiCall).toHaveBeenCalledTimes(2);
  });

  it("should retry when apiCall fails with 429 and Retry-After header", async () => {
    const apiCall = vi.fn();

    const firstError: APIError = new Error("Rate limit");
    firstError.response = {
      status: 429,
      headers: {
        get: (headerName: string) => {
          if (headerName === RETRY_AFTER_HEADER) {
            return "0.02";
          }
          return null;
        },
      },
    } as unknown as Response;

    apiCall.mockRejectedValueOnce(firstError).mockResolvedValueOnce("Success");

    const result = await withExponentialBackoff(apiCall, 5, 0.01);

    expect(result).toBe("Success");
    expect(apiCall).toHaveBeenCalledTimes(2);
  });

  it("should throw error after maxTries reached", async () => {
    const apiCall = vi.fn();

    const error: APIError = new Error("Rate limit");
    error.response = {
      status: 429,
      headers: {
        get: () => null,
      },
    } as unknown as Response;

    apiCall.mockRejectedValue(error);

    const maxTries = 3;
    const initialDelaySeconds = 0.01;

    // Should throw the original error after maxTries
    await expect(
      withExponentialBackoff(apiCall, maxTries, initialDelaySeconds),
    ).rejects.toThrow("Rate limit");

    expect(apiCall).toHaveBeenCalledTimes(maxTries);
  });

  it("should not call if maxTries is 0", async () => {
    const apiCall = vi.fn();

    const error: APIError = new Error("Rate limit");
    error.response = {
      status: 429,
      headers: {
        get: () => null,
      },
    } as unknown as Response;

    apiCall.mockRejectedValue(error);

    const maxTries = 0;
    const initialDelaySeconds = 0.01;

    await expect(
      withExponentialBackoff(apiCall, maxTries, initialDelaySeconds),
    ).rejects.toThrow("Failed to make API call after 0 retries");

    expect(apiCall).toHaveBeenCalledTimes(0);
  });

  describe("network error retries", () => {
    it("should retry on ETIMEDOUT error", async () => {
      const apiCall = vi.fn();

      const networkError: APIError = new Error(
        "request to https://api.example.com failed, reason: connect ETIMEDOUT 1.2.3.4:443",
      );
      (networkError as any).code = "ETIMEDOUT";

      apiCall
        .mockRejectedValueOnce(networkError)
        .mockResolvedValueOnce("Success");

      const result = await withExponentialBackoff(apiCall, 5, 0.01);

      expect(result).toBe("Success");
      expect(apiCall).toHaveBeenCalledTimes(2);
    });

    it("should retry on ECONNRESET error", async () => {
      const apiCall = vi.fn();

      const networkError: APIError = new Error("socket hang up");
      (networkError as any).code = "ECONNRESET";

      apiCall
        .mockRejectedValueOnce(networkError)
        .mockResolvedValueOnce("Success");

      const result = await withExponentialBackoff(apiCall, 5, 0.01);

      expect(result).toBe("Success");
      expect(apiCall).toHaveBeenCalledTimes(2);
    });

    it("should retry on ECONNREFUSED error", async () => {
      const apiCall = vi.fn();

      const networkError: APIError = new Error("connect ECONNREFUSED");
      (networkError as any).code = "ECONNREFUSED";

      apiCall
        .mockRejectedValueOnce(networkError)
        .mockResolvedValueOnce("Success");

      const result = await withExponentialBackoff(apiCall, 5, 0.01);

      expect(result).toBe("Success");
      expect(apiCall).toHaveBeenCalledTimes(2);
    });

    it("should retry when ETIMEDOUT is in error message but not code", async () => {
      const apiCall = vi.fn();

      // Sometimes the error code is in the message but not the code property
      const networkError: APIError = new Error(
        "request failed, reason: connect ETIMEDOUT 51.12.73.214:443",
      );

      apiCall
        .mockRejectedValueOnce(networkError)
        .mockResolvedValueOnce("Success");

      const result = await withExponentialBackoff(apiCall, 5, 0.01);

      expect(result).toBe("Success");
      expect(apiCall).toHaveBeenCalledTimes(2);
    });

    it("should retry when error has nested cause with network error code", async () => {
      const apiCall = vi.fn();

      const innerError = new Error("connect timed out");
      (innerError as any).code = "ETIMEDOUT";

      const networkError: APIError = new Error("FetchError: request failed");
      (networkError as any).cause = innerError;

      apiCall
        .mockRejectedValueOnce(networkError)
        .mockResolvedValueOnce("Success");

      const result = await withExponentialBackoff(apiCall, 5, 0.01);

      expect(result).toBe("Success");
      expect(apiCall).toHaveBeenCalledTimes(2);
    });

    it("should throw network error after maxTries reached", async () => {
      const apiCall = vi.fn();

      const networkError: APIError = new Error("connect ETIMEDOUT");
      (networkError as any).code = "ETIMEDOUT";

      apiCall.mockRejectedValue(networkError);

      const maxTries = 3;

      await expect(
        withExponentialBackoff(apiCall, maxTries, 0.01),
      ).rejects.toThrow("connect ETIMEDOUT");

      expect(apiCall).toHaveBeenCalledTimes(maxTries);
    });

    it("should retry on HTTP 500 server error", async () => {
      const apiCall = vi.fn();

      const serverError: APIError = new Error("Internal Server Error");
      serverError.response = {
        status: 500,
        headers: {
          get: () => null,
        },
      } as unknown as Response;

      apiCall
        .mockRejectedValueOnce(serverError)
        .mockResolvedValueOnce("Success");

      const result = await withExponentialBackoff(apiCall, 5, 0.01);

      expect(result).toBe("Success");
      expect(apiCall).toHaveBeenCalledTimes(2);
    });

    it("should NOT retry on HTTP 400 client error", async () => {
      const apiCall = vi.fn();

      const clientError: APIError = new Error("Bad Request");
      clientError.response = {
        status: 400,
        headers: {
          get: () => null,
        },
      } as unknown as Response;

      apiCall.mockRejectedValue(clientError);

      await expect(withExponentialBackoff(apiCall, 5, 0.01)).rejects.toThrow(
        "Bad Request",
      );

      // Should NOT retry - only 1 call
      expect(apiCall).toHaveBeenCalledTimes(1);
    });
  });
});
