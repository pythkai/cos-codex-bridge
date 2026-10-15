const RATE_PATTERNS: RegExp[] = [
  /rate[\s_-]?limit/,
  /usage[\s_-]?limit/,
  /quota (?:exceeded|reached)/,
  /insufficient[_\s-]?quota/,
  /too many requests/,
  /plan limit/,
  /hit your usage/,
  /reached your (?:codex )?usage/,
  /exceeded your (?:current )?quota/,
  /billing hard limit/,
];

const INPUT_PATTERNS: RegExp[] = [
  /approval required/,
  /waiting for (?:user |approval|input)/,
  /request_user_input/,
  /needs user input/,
  /requires user input/,
];

export function isRateLimited(text: string): boolean {
  const sample = text.toLowerCase();
  return RATE_PATTERNS.some((pattern) => pattern.test(sample));
}

export function isNeedsInput(text: string): boolean {
  if (isRateLimited(text)) return false;
  return INPUT_PATTERNS.some((pattern) => pattern.test(text.toLowerCase()));
}

export function collectText(value: unknown, depth = 0): string {
  if (depth > 6 || value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map((item) => collectText(item, depth + 1)).join('\n');
  if (typeof value === 'object') return Object.values(value).map((item) => collectText(item, depth + 1)).join('\n');
  return '';
}
