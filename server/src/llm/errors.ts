export class LLMError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LLMError';
  }
}

export class RateLimitError extends LLMError {
  constructor(message = 'Rate limited by LLM provider') {
    super(message);
    this.name = 'RateLimitError';
  }
}

export class ServerError extends LLMError {
  constructor(message = 'LLM provider returned a server error') {
    super(message);
    this.name = 'ServerError';
  }
}

export class ProviderError extends LLMError {
  constructor(message = 'LLM provider rejected the request') {
    super(message);
    this.name = 'ProviderError';
  }
}

export class QuotaError extends LLMError {
  constructor(message = 'LLM provider quota exhausted or the API key is invalid') {
    super(message);
    this.name = 'QuotaError';
  }
}

export class InvalidJSONError extends LLMError {
  constructor(message = 'LLM returned invalid JSON or failed schema validation') {
    super(message);
    this.name = 'InvalidJSONError';
  }
}

export class DailyCapReachedError extends LLMError {
  constructor(cap: number) {
    super(`Daily LLM call cap reached (${cap})`);
    this.name = 'DailyCapReachedError';
  }
}

export function isRetryable(err: unknown): boolean {
  return err instanceof RateLimitError || err instanceof ServerError;
}