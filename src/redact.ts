// Shared secret redaction used across every backend: the same patterns apply to
// captured stdout, captured stderr, returned assistant text, and error text.
export const SECRET_PATTERNS: RegExp[] = [
  /(Bearer\s+)[^\s"'`]+/gi,
  /((?:api[-_]?key|token|secret)\s*[:=]\s*)[^\s"'`]+/gi,
];

export function redactSecrets(text: unknown): string {
  return SECRET_PATTERNS.reduce(
    (value: string, pattern: RegExp) => value.replace(pattern, "$1[redacted]"),
    String(text ?? ""),
  );
}
