export class LlmUnavailableError extends Error {
  constructor(message = "LLM is temporarily unavailable (circuit open)", readonly retryAfterMs: number | null = null) {
    super(message);
    this.name = "LlmUnavailableError";
  }
}

export class BudgetExceededError extends Error {
  constructor(readonly used: number, readonly budget: number) {
    super(`Daily LLM call budget exhausted (${used}/${budget})`);
    this.name = "BudgetExceededError";
  }
}

/** The model kept returning output that failed JSON parsing or schema validation. */
export class LlmValidationError extends Error {
  constructor(message: string, readonly task: string) {
    super(message);
    this.name = "LlmValidationError";
  }
}

/** Transport-level failure (network, 5xx, 429, timeout) after all retries. */
export class LlmTransportError extends Error {
  constructor(message: string, readonly status: number | null = null) {
    super(message);
    this.name = "LlmTransportError";
  }
}
