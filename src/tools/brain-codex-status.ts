import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

interface CodexAuthJson {
  auth_mode?: string;
  tokens?: {
    id_token?: string;
    access_token?: string;
    refresh_token?: string;
    account_id?: string;
  };
  last_refresh?: string;
}

interface JwtClaims {
  aud?: string | string[];
  exp?: number;
  iat?: number;
  email?: string;
  'https://api.openai.com/auth'?: {
    chatgpt_account_id?: string;
    chatgpt_plan_type?: string;
  };
}

async function main(): Promise<void> {
  const authPath = process.argv[2] ?? path.join(os.homedir(), '.codex', 'auth.json');
  const auth = JSON.parse(await readFile(authPath, 'utf8')) as CodexAuthJson;
  const accessClaims = decodeJwt(auth.tokens?.access_token);
  const idClaims = decodeJwt(auth.tokens?.id_token);
  const now = Math.floor(Date.now() / 1000);
  const exp = accessClaims?.exp;

  console.log(JSON.stringify({
    ok: auth.auth_mode === 'chatgpt' && Boolean(auth.tokens?.access_token) && Boolean(auth.tokens?.refresh_token),
    authPath,
    authMode: auth.auth_mode,
    hasAccessToken: Boolean(auth.tokens?.access_token),
    hasRefreshToken: Boolean(auth.tokens?.refresh_token),
    accountIdPresent: Boolean(auth.tokens?.account_id ?? accessClaims?.['https://api.openai.com/auth']?.chatgpt_account_id),
    planType: idClaims?.['https://api.openai.com/auth']?.chatgpt_plan_type,
    accessTokenExpiresAt: exp ? new Date(exp * 1000).toISOString() : undefined,
    accessTokenSecondsRemaining: exp ? exp - now : undefined,
    lastRefresh: auth.last_refresh,
  }, null, 2));
}

function decodeJwt(token?: string): JwtClaims | undefined {
  if (!token) {
    return undefined;
  }
  const part = token.split('.')[1];
  if (!part) {
    return undefined;
  }
  try {
    const normalized = part.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf8')) as JwtClaims;
  } catch {
    return undefined;
  }
}

main().catch((error: unknown) => {
  console.error('brain codex status failed');
  console.error(error);
  process.exitCode = 1;
});
