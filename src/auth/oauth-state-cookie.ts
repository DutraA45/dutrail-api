import {
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

/**
 * Cookie que liga o redirect para o Google ao callback (A-02): guarda o
 * `state` e o `code_verifier` do PKCE entre GET /auth/google e
 * GET /auth/google/callback, já que a sessão do Express está desligada.
 *
 * Só assinado (HMAC-SHA256), não cifrado: o conteúdo não é segredo para o
 * próprio browser, que é quem precisa provar que iniciou o fluxo. O que importa
 * é que ninguém o forje nem o altere, e que nada além do cookie o carregue.
 */
export const OAUTH_STATE_COOKIE_NAME = 'googleOAuthState';

/** O browser só o envia para /auth/google e /auth/google/callback. */
export const OAUTH_STATE_COOKIE_PATH = '/auth/google';

/** Tempo para passar pela tela de consentimento; vale no cookie e na assinatura. */
export const OAUTH_STATE_TTL_MS = 10 * 60_000;

/**
 * Rótulo do HKDF. Separa a chave deste cookie de qualquer outro uso do
 * JWT_SECRET: um HMAC daqui nunca vale como assinatura de JWT e vice-versa.
 */
export const OAUTH_STATE_KEY_LABEL = 'dutrail-oauth-state';

/** RFC 7636 §4.1: 43 a 128 caracteres de [A-Z a-z 0-9 - . _ ~]. */
const CODE_VERIFIER_PATTERN = /^[A-Za-z0-9\-._~]{43,128}$/;

export interface OAuthState {
  state: string;
  verifier: string;
}

export function deriveOAuthStateKey(jwtSecret: string): Buffer {
  return Buffer.from(
    hkdfSync('sha256', jwtSecret, Buffer.alloc(0), OAUTH_STATE_KEY_LABEL, 32),
  );
}

/** 256 bits aleatórios em base64url (43 caracteres). */
export function generateOAuthState(): string {
  return randomBytes(32).toString('base64url');
}

export function isCodeVerifier(value: unknown): value is string {
  return typeof value === 'string' && CODE_VERIFIER_PATTERN.test(value);
}

/**
 * Comparação em tempo constante, inclusive entre tamanhos diferentes: compara
 * os SHA-256, que sempre têm 32 bytes (o `timingSafeEqual` exige tamanhos
 * iguais e recusar antes vazaria o tamanho).
 */
export function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(sha256(a), sha256(b));
}

/** `<payload base64url>.<HMAC base64url>`, com a expiração dentro do payload. */
export function sealOAuthState(
  key: Buffer,
  value: OAuthState,
  now = Date.now(),
): string {
  const payload = Buffer.from(
    JSON.stringify({
      s: value.state,
      v: value.verifier,
      exp: now + OAUTH_STATE_TTL_MS,
    }),
  ).toString('base64url');
  return `${payload}.${sign(key, payload)}`;
}

/**
 * Devolve o conteúdo se a assinatura confere e não expirou; `undefined` para
 * qualquer outra coisa (ausente, malformado, adulterado, expirado). A
 * expiração assinada vale mesmo que alguém reapresente o cookie depois do
 * Max-Age.
 */
export function openOAuthState(
  key: Buffer,
  sealed: unknown,
  now = Date.now(),
): OAuthState | undefined {
  if (typeof sealed !== 'string') return undefined;
  const parts = sealed.split('.');
  if (parts.length !== 2) return undefined;
  const [payload, signature] = parts;
  if (!safeEqual(signature, sign(key, payload))) return undefined;

  let data: unknown;
  try {
    data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return undefined;
  }
  if (typeof data !== 'object' || data === null) return undefined;

  const { s, v, exp } = data as Record<string, unknown>;
  if (
    typeof s !== 'string' ||
    s.length === 0 ||
    !isCodeVerifier(v) ||
    typeof exp !== 'number' ||
    exp <= now
  ) {
    return undefined;
  }
  return { state: s, verifier: v };
}

function sign(key: Buffer, payload: string): string {
  return createHmac('sha256', key).update(payload).digest('base64url');
}

function sha256(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}
