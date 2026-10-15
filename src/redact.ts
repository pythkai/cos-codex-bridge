import { BridgeError } from './errors.js';

const PATTERNS: RegExp[] = [
  /sk-(?:proj-)?[A-Za-z0-9_-]{10,}/g,
  /Bearer\s+[A-Za-z0-9._\-+/=]{8,}/gi,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g,
  /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|secret)\b\s*[:=]\s*\S+/gi,
  /\b(?:OPENAI_API_KEY|CODEX_ACCESS_TOKEN|GITHUB_TOKEN|GH_TOKEN|AWS_SECRET_ACCESS_KEY)\s*=\s*\S+/g,
];

export function redact(text: string, secrets: readonly string[] = []): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length >= 8) out = out.split(secret).join('[REDACTED]');
  }
  for (const pattern of PATTERNS) out = out.replace(pattern, '[REDACTED]');
  return out;
}

export function excerpt(text: string, max: number): { text: string; truncated: boolean } {
  const clean = redact(text);
  if (clean.length <= max) return { text: clean, truncated: false };
  return { text: clean.slice(0, max), truncated: true };
}

export function assertUtf8(text: string, max: number, label: string): void {
  if (text.includes('\u0000')) throw new BridgeError('INVALID_TEXT', `${label} contains a NUL byte.`);
  if (Buffer.from(text, 'utf8').toString('utf8') !== text) throw new BridgeError('INVALID_TEXT', `${label} contains invalid Unicode.`);
  const bytes = Buffer.byteLength(text);
  if (!bytes || bytes > max) throw new BridgeError('SIZE_LIMIT', `${label} must be 1–${max} UTF-8 bytes.`);
}
