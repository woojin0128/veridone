// Veridone — credential / secret detection for content written by the agent.
//
// Precision over recall: every detector is anchored on a vendor-specific
// prefix or on a key=value assignment with a high-entropy value, and known
// documentation placeholders are allow-listed. A false positive here blocks a
// legitimate write, so each rule must be boringly specific.

import { shannonEntropy, splitLines } from './util.mjs';

/** Values published in vendor docs as examples — never real. */
const KNOWN_EXAMPLES = [
  'AKIAIOSFODNN7EXAMPLE',
  'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  'AKIAI44QH8DHBEXAMPLE',
  'je7MtGbClwBF/2Zp9Utk/h3yCo8nvbEXAMPLEKEY',
  'ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
  // Stripe's documented test key, assembled so repository secret scanners don't flag this file
  ['sk', 'test', '4eC39HqLyjWDarjtT1zdp7dc'].join('_'),
  'xoxb-your-token',
];

const PLACEHOLDER_RE = /(example|sample|dummy|fake|placeholder|changeme|change_me|change-me|your[_-]?|xxxx|\*\*\*\*|<[^>]+>|\$\{[^}]+\}|\{\{[^}]+\}\}|todo|redacted|replace[_-]?me|not[_-]?a[_-]?real|test[_-]?key|lorem|0000000000|1234567890|abcdef(ghij)?)/i;

/**
 * @typedef {{id:string, name:string, severity:'high'|'medium', re:RegExp, group?:number, minEntropy?:number, validate?:(m:RegExpExecArray, line:string)=>boolean}} Detector
 */

/** @type {Detector[]} */
export const DETECTORS = [
  { id: 'private-key', name: 'Private key block', severity: 'high', re: /-----BEGIN ((?:RSA|EC|DSA|OPENSSH|PGP|ENCRYPTED)\s+)?PRIVATE KEY( BLOCK)?-----/ },
  { id: 'aws-access-key-id', name: 'AWS access key ID', severity: 'high', re: /\b((?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16})\b/, group: 1 },
  { id: 'aws-secret-key', name: 'AWS secret access key', severity: 'high', re: /aws_?secret_?(?:access_?)?key["']?\s*[:=]\s*["']?([A-Za-z0-9/+=]{40})(?![A-Za-z0-9/+=])/i, group: 1, minEntropy: 3.5 },
  { id: 'github-token', name: 'GitHub token', severity: 'high', re: /\b((?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,255})\b/, group: 1, minEntropy: 3.0 },
  { id: 'github-fine-grained', name: 'GitHub fine-grained token', severity: 'high', re: /\b(github_pat_[A-Za-z0-9_]{60,255})\b/, group: 1 },
  { id: 'gitlab-token', name: 'GitLab token', severity: 'high', re: /\b(glpat-[A-Za-z0-9_-]{20,})\b/, group: 1 },
  { id: 'slack-token', name: 'Slack token', severity: 'high', re: /\b(xox[baprse]-[A-Za-z0-9-]{10,})\b/, group: 1, minEntropy: 3.0 },
  { id: 'slack-webhook', name: 'Slack webhook URL', severity: 'high', re: /(https:\/\/hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9]{20,})/, group: 1 },
  { id: 'discord-webhook', name: 'Discord webhook URL', severity: 'high', re: /(https:\/\/(?:canary\.|ptb\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[A-Za-z0-9_-]{50,})/, group: 1 },
  { id: 'stripe-live-key', name: 'Stripe live secret key', severity: 'high', re: /\b((?:sk|rk)_live_[0-9a-zA-Z]{20,})\b/, group: 1 },
  { id: 'stripe-test-key', name: 'Stripe test secret key', severity: 'medium', re: /\b(sk_test_[0-9a-zA-Z]{20,})\b/, group: 1, minEntropy: 3.5 },
  { id: 'google-api-key', name: 'Google API key', severity: 'high', re: /\b(AIza[0-9A-Za-z_-]{35})\b/, group: 1 },
  { id: 'gcp-service-account', name: 'GCP service account key', severity: 'high', re: /"type"\s*:\s*"service_account"/, validate: (_m, _l, text) => /"private_key"\s*:\s*"-----BEGIN/.test(text ?? '') },
  { id: 'openai-key', name: 'OpenAI API key', severity: 'high', re: /\b(sk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}T3BlbkFJ[A-Za-z0-9_-]{20,}|sk-proj-[A-Za-z0-9_-]{48,})\b/, group: 1 },
  { id: 'anthropic-key', name: 'Anthropic API key', severity: 'high', re: /\b(sk-ant-(?:api|admin|oat)\d{2}-[A-Za-z0-9_-]{40,})\b/, group: 1 },
  { id: 'huggingface-token', name: 'Hugging Face token', severity: 'high', re: /\b(hf_[A-Za-z0-9]{34,})\b/, group: 1, minEntropy: 3.5 },
  { id: 'npm-token', name: 'npm access token', severity: 'high', re: /\b(npm_[A-Za-z0-9]{36})\b/, group: 1, minEntropy: 3.5 },
  { id: 'pypi-token', name: 'PyPI token', severity: 'high', re: /\b(pypi-AgEIcHlwaS5vcmc[A-Za-z0-9_-]{50,})\b/, group: 1 },
  { id: 'sendgrid-key', name: 'SendGrid API key', severity: 'high', re: /\b(SG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43})\b/, group: 1 },
  { id: 'twilio-key', name: 'Twilio API key', severity: 'medium', re: /\b(SK[0-9a-f]{32})\b/, group: 1, minEntropy: 3.3, validate: (_m, line) => /twilio/i.test(line) },
  { id: 'mailgun-key', name: 'Mailgun API key', severity: 'medium', re: /\b(key-[0-9a-zA-Z]{32})\b/, group: 1, minEntropy: 3.5 },
  { id: 'telegram-bot-token', name: 'Telegram bot token', severity: 'high', re: /\b(\d{8,10}:AA[A-Za-z0-9_-]{33})\b/, group: 1 },
  { id: 'shopify-token', name: 'Shopify access token', severity: 'high', re: /\b(shp(?:at|ca|pa|ss)_[a-fA-F0-9]{32})\b/, group: 1 },
  { id: 'digitalocean-token', name: 'DigitalOcean token', severity: 'high', re: /\b(do[por]_v1_[a-f0-9]{64})\b/, group: 1 },
  { id: 'azure-storage-key', name: 'Azure storage account key', severity: 'high', re: /AccountKey=([A-Za-z0-9+/=]{86,88})/, group: 1 },
  { id: 'jwt', name: 'JSON Web Token', severity: 'medium', re: /\b(eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{20,})\b/, group: 1 },
  {
    id: 'db-url-credentials',
    name: 'Database URL with embedded password',
    severity: 'high',
    re: /\b((?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis|rediss|amqps?|mssql|sqlserver):\/\/[^:\s/"'@]+:([^@\s"'/]{6,})@[^\s"'`]+)/i,
    group: 2,
    minEntropy: 2.5,
    validate: (m) => !/^(password|pass|pwd|secret|postgres|root|admin|user|guest|test|dev|local)$/i.test(m[2]) && !/[$%{}]/.test(m[2]),
  },
  {
    id: 'generic-secret-assignment',
    name: 'Hard-coded secret in assignment',
    severity: 'medium',
    // key names that strongly imply a credential, assigned a quoted literal
    re: /\b([A-Za-z0-9_.-]*(?:secret|passwd|password|api[_-]?key|apikey|access[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?key|signing[_-]?key|bearer)[A-Za-z0-9_.-]*)["']?\s*(?::=|=|:|=>)\s*["'`]([^"'`\s]{12,})["'`]/i,
    group: 2,
    minEntropy: 3.6,
    validate: (m) => /[0-9]/.test(m[2]) && /[A-Za-z]/.test(m[2]) && !/^(true|false|null|none|undefined)$/i.test(m[2]) && !/^(process\.env|os\.environ|env\.|getenv|config\.)/.test(m[2]),
  },
];

/**
 * Scan text for secrets.
 * @param {string} text
 * @param {{maxFindings?:number}} [opts]
 * @returns {{id:string, name:string, severity:'high'|'medium', line:number, preview:string}[]}
 */
export function scanSecrets(text, opts = {}) {
  const max = opts.maxFindings ?? 20;
  const findings = [];
  if (!text || typeof text !== 'string') return findings;
  const lines = splitLines(text);
  for (let li = 0; li < lines.length && findings.length < max; li++) {
    const line = lines[li];
    if (line.length > 4000) continue; // minified blobs: skip, not our job
    if (/veridone-allow(?:-secret)?\b/.test(line)) continue;
    for (const d of DETECTORS) {
      const re = new RegExp(d.re.source, d.re.flags.includes('g') ? d.re.flags : d.re.flags + 'g');
      let m;
      while ((m = re.exec(line)) && findings.length < max) {
        const value = d.group ? m[d.group] : m[0];
        if (!value) continue;
        if (KNOWN_EXAMPLES.some((ex) => value.includes(ex))) continue;
        if (d.id !== 'private-key' && PLACEHOLDER_RE.test(value)) continue;
        if (d.minEntropy && shannonEntropy(value) < d.minEntropy) continue;
        if (d.validate && !d.validate(m, line, text)) continue;
        findings.push({ id: d.id, name: d.name, severity: d.severity, line: li + 1, preview: redact(value) });
      }
    }
  }
  return dedupe(findings);
}

function dedupe(findings) {
  const seen = new Set();
  return findings.filter((f) => {
    const k = `${f.id}:${f.line}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export function redact(value) {
  const v = String(value);
  if (v.length <= 8) return '****';
  return `${v.slice(0, 4)}…${v.slice(-2)} (${v.length} chars)`;
}

/** Files where secrets legitimately live (usually git-ignored). */
export function isSecretStoreFile(relPath) {
  const base = String(relPath).split(/[\\/]/).pop() || '';
  if (/^\.env(\..+)?$/.test(base) && !/\.(example|sample|template|dist|defaults|schema)$/i.test(base)) return true;
  if (/^(secrets?|credentials)\.(local\.)?(json|ya?ml|toml)$/i.test(base)) return true;
  if (/\.(pem|key|p12|pfx|jks|keystore)$/i.test(base)) return true;
  if (/^\.dev\.vars$|^\.envrc$/.test(base)) return true;
  return false;
}
