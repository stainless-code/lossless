const SECRET_PATTERNS: RegExp[] = [
  // OpenAI / Anthropic / OpenRouter
  /\bsk-(?:ant-)?[A-Za-z0-9_-]{16,}\b/g,
  /\bsk-or-v1-[A-Za-z0-9]{16,}\b/g,
  // GitHub
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  // AWS
  /\bAKIA[0-9A-Z]{16}\b/g,
  // Slack
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  // Google
  /\bAIza[0-9A-Za-z_-]{30,}\b/g,
  // Bearer / authorization headers
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi,
  // npm automation/publish tokens
  /\bnpm_[A-Za-z0-9]{20,}\b/g,
  // GCP OAuth access / refresh tokens
  /\bya29\.[A-Za-z0-9._-]{20,}\b/g,
  /\b1\/\/0[A-Za-z0-9_-]{20,}\b/g,
  // PEM private key blocks (marker-anchored; body + markers)
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  // Bare JWTs (three base64url segments) outside Bearer headers
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
];

/** A quoted value is a literal, so either separator is safe. */
const QUOTED_ASSIGNMENT =
  /(\b[a-z0-9_-]*(?:key|token|secret|password|passwd|credential)[a-z0-9_-]*\b["']?\s*[:=]\s*["'])([^\s"']{8,})/gi;

/** A bare value must be one unbroken run of credential characters, so code
 * punctuation stops the match before an expression like `items.reduce(` does. */
const BARE_ASSIGNMENT =
  /(\b[a-z0-9_-]*(?:key|token|secret|password|passwd|credential)[a-z0-9_-]*\b["']?\s*[:=]\s*)([A-Za-z0-9_+/\-@#$%^&*!~]{8,})/gi;

const REDACTED = "[REDACTED]";

/** `ENV_KEY=value`, the way an env file or shell export writes it: code assigns
 * as `key = value`, so the missing space separates the two. */
function isEnvAssignment(prefix: string): boolean {
  return /[^\s]=["']?\s*$/.test(prefix);
}

/** A generated key carries a digit; a config string, a model id, a file path
 * and a bare identifier do not, which keeps the pattern off them. */
function hasDigit(value: string): boolean {
  return /[0-9]/.test(value);
}

/** Redactor that re-reads the flag on every call, so a cockpit toggle takes
 * effect immediately: a getter, because patchConfig replaces the config object
 * and closing over it would pin the session-start value. */
export function makeRedact(getConfig: () => { redactSecrets?: boolean }): (text: string) => string {
  return (text: string): string =>
    getConfig().redactSecrets === false ? text : redactSecrets(text);
}

export function redactSecrets(text: string): string {
  let out = text;
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, REDACTED);
  }
  out = out.replace(QUOTED_ASSIGNMENT, (match, prefix: string, value: string) =>
    isEnvAssignment(prefix) || hasDigit(value) ? `${prefix}${REDACTED}` : match,
  );
  return out.replace(BARE_ASSIGNMENT, (match, prefix: string, value: string) =>
    isEnvAssignment(prefix) || hasDigit(value) ? `${prefix}${REDACTED}` : match,
  );
}
