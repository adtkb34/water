const DOMAIN_ERROR = Symbol.for("agentNative.DomainError");

export class DomainError extends Error {
  readonly field?: string;
  readonly [DOMAIN_ERROR] = true;

  constructor(message: string, field?: string) {
    super(message);
    this.name = "DomainError";
    this.field = field;
  }
}

export function isDomainError(error: unknown): error is DomainError {
  return (
    typeof error === "object" &&
    error !== null &&
    DOMAIN_ERROR in error &&
    (error as DomainError)[DOMAIN_ERROR] === true
  );
}
