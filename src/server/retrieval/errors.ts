import type { EvidenceFailureCode } from "./types";

/**
 * Evidence failures describe a problem with scope, sources or citations. They
 * are intentionally not AiError: a provider outage must never be confused with
 * "the permitted sources do not support this answer", and vice versa.
 */
export class EvidenceContractError extends Error {
  readonly code: EvidenceFailureCode;

  constructor(code: EvidenceFailureCode, message: string) {
    super(message);
    this.name = "EvidenceContractError";
    this.code = code;
  }

  toJSON() {
    return { code: this.code, message: this.message };
  }
}

export function isEvidenceContractError(error: unknown): error is EvidenceContractError {
  return error instanceof EvidenceContractError;
}
