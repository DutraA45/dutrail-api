import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import {
  deriveOAuthStateKey,
  generateOAuthState,
  isCodeVerifier,
  OAUTH_STATE_TTL_MS,
  openOAuthState,
  safeEqual,
  sealOAuthState,
} from './oauth-state-cookie.js';

// timingSafeEqual vira espião (com a implementação real) para o teste de
// comparação em tempo constante.
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return { ...actual, timingSafeEqual: vi.fn(actual.timingSafeEqual) };
});

const JWT_SECRET = 'segredo-de-teste-com-pelo-menos-32-caracteres';
const key = deriveOAuthStateKey(JWT_SECRET);
const value = {
  state: generateOAuthState(),
  verifier: 'v'.repeat(43),
};

const NOW = 1_800_000_000_000;

function decodePayload(sealed: string): Record<string, unknown> {
  return JSON.parse(
    Buffer.from(sealed.split('.')[0], 'base64url').toString('utf8'),
  ) as Record<string, unknown>;
}

/** Re-sela um payload arbitrário com uma chave (para forjar casos). */
function sealRaw(payload: unknown, withKey: Buffer): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = createHmac('sha256', withKey).update(encoded).digest('base64url');
  return `${encoded}.${mac}`;
}

describe('cookie de state do Google (A-02)', () => {
  beforeEach(() => {
    vi.mocked(timingSafeEqual).mockClear();
  });

  describe('deriveOAuthStateKey', () => {
    it('gera 32 bytes determinísticos, diferentes do segredo e de outro segredo', () => {
      expect(key).toHaveLength(32);
      expect(deriveOAuthStateKey(JWT_SECRET).equals(key)).toBe(true);
      expect(key.toString('utf8')).not.toContain(JWT_SECRET);
      expect(deriveOAuthStateKey(`${JWT_SECRET}x`).equals(key)).toBe(false);
    });
  });

  describe('generateOAuthState', () => {
    it('tem 256 bits (43 caracteres base64url) e não se repete', () => {
      const states = new Set(Array.from({ length: 100 }, generateOAuthState));
      expect(states.size).toBe(100);
      for (const state of states) {
        expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(Buffer.from(state, 'base64url')).toHaveLength(32);
      }
    });
  });

  describe('isCodeVerifier (RFC 7636)', () => {
    it.each([
      ['43 caracteres', 'a'.repeat(43), true],
      ['128 caracteres', 'a'.repeat(128), true],
      ['charset completo', 'AZaz09-._~'.repeat(5), true],
      ['42 caracteres', 'a'.repeat(42), false],
      ['129 caracteres', 'a'.repeat(129), false],
      ['caractere fora do charset', `${'a'.repeat(42)}+`, false],
      ['não string', 42, false],
    ])('%s -> %s', (_label, verifier, expected) => {
      expect(isCodeVerifier(verifier)).toBe(expected);
    });
  });

  describe('sealOAuthState / openOAuthState', () => {
    it('gera e valida: devolve o state e o verifier dentro do prazo', () => {
      const sealed = sealOAuthState(key, value, NOW);
      expect(openOAuthState(key, sealed, NOW)).toEqual(value);
      expect(openOAuthState(key, sealed, NOW + OAUTH_STATE_TTL_MS - 1)).toEqual(
        value,
      );
    });

    it('é assinado com HMAC-SHA256 da chave derivada e expira em 10 minutos', () => {
      const sealed = sealOAuthState(key, value, NOW);
      const [payload, mac] = sealed.split('.');
      expect(mac).toBe(
        createHmac('sha256', key).update(payload).digest('base64url'),
      );
      expect(decodePayload(sealed).exp).toBe(NOW + 10 * 60_000);
    });

    it('rejeita expirado (a expiração assinada vale além do Max-Age)', () => {
      const sealed = sealOAuthState(key, value, NOW);
      expect(openOAuthState(key, sealed, NOW + OAUTH_STATE_TTL_MS)).toBe(
        undefined,
      );
      expect(openOAuthState(key, sealed, NOW + 3_600_000)).toBeUndefined();
    });

    it('rejeita payload adulterado (state, verifier ou exp trocados sem re-assinar)', () => {
      const sealed = sealOAuthState(key, value, NOW);
      const [, mac] = sealed.split('.');
      for (const change of [
        { s: 'state-do-atacante' },
        { v: 'w'.repeat(43) },
        { exp: NOW + 365 * 86_400_000 },
      ]) {
        const forged = Buffer.from(
          JSON.stringify({ ...decodePayload(sealed), ...change }),
        ).toString('base64url');
        expect(openOAuthState(key, `${forged}.${mac}`, NOW)).toBeUndefined();
      }
    });

    it('rejeita assinatura adulterada, de outra chave ou ausente', () => {
      const sealed = sealOAuthState(key, value, NOW);
      const [payload, mac] = sealed.split('.');
      const flipped = `${mac.slice(0, -1)}${mac.endsWith('A') ? 'B' : 'A'}`;
      const otherKey = deriveOAuthStateKey('outro-segredo-com-32-caracteres!!');

      expect(openOAuthState(key, `${payload}.${flipped}`, NOW)).toBeUndefined();
      expect(
        openOAuthState(key, sealOAuthState(otherKey, value, NOW), NOW),
      ).toBeUndefined();
      expect(openOAuthState(key, payload, NOW)).toBeUndefined();
      expect(openOAuthState(key, `${payload}.`, NOW)).toBeUndefined();
      expect(openOAuthState(key, `${sealed}.extra`, NOW)).toBeUndefined();
    });

    it.each([
      ['undefined', undefined],
      ['vazio', ''],
      ['lixo', 'nao-e-um-cookie'],
      ['array', ['a', 'b']],
    ])('rejeita valor %s', (_label, raw) => {
      expect(openOAuthState(key, raw, NOW)).toBeUndefined();
    });

    it('rejeita conteúdo bem assinado mas inválido (verifier fora da RFC, state vazio, sem exp, não JSON)', () => {
      const exp = NOW + 60_000;
      for (const payload of [
        { s: value.state, v: 'curto', exp },
        { s: '', v: value.verifier, exp },
        { s: value.state, v: value.verifier },
        { s: value.state, v: value.verifier, exp: String(exp) },
        null,
        'texto',
      ]) {
        expect(openOAuthState(key, sealRaw(payload, key), NOW)).toBeUndefined();
      }
      const notJson = Buffer.from('{').toString('base64url');
      const mac = createHmac('sha256', key).update(notJson).digest('base64url');
      expect(openOAuthState(key, `${notJson}.${mac}`, NOW)).toBeUndefined();
    });

    it('confere a assinatura em tempo constante', () => {
      const sealed = sealOAuthState(key, value, NOW);
      const [payload] = sealed.split('.');
      openOAuthState(key, `${payload}.x`, NOW);
      expect(timingSafeEqual).toHaveBeenCalledTimes(1);
    });
  });

  describe('safeEqual', () => {
    const sha = (s: string) => createHash('sha256').update(s).digest();

    it('compara em tempo constante os SHA-256, inclusive com tamanhos diferentes', () => {
      expect(safeEqual(value.state, value.state)).toBe(true);
      expect(safeEqual(value.state, `${value.state.slice(0, -1)}x`)).toBe(
        false,
      );
      expect(safeEqual(value.state, 'curto')).toBe(false);
      expect(safeEqual('', value.state)).toBe(false);

      // Toda comparação passa pelo timingSafeEqual, sem atalho por tamanho.
      expect(timingSafeEqual).toHaveBeenCalledTimes(4);
      expect(vi.mocked(timingSafeEqual).mock.calls[2]).toEqual([
        sha(value.state),
        sha('curto'),
      ]);
    });
  });
});
