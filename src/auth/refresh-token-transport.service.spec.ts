import 'reflect-metadata';
import {
  BadRequestException,
  Controller,
  INestApplication,
  Post,
  Res,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { readFileSync } from 'node:fs';
import { parse } from 'dotenv';
import type { Request, Response } from 'express';
import request from 'supertest';
import {
  type EnvironmentVariables,
  validateEnv,
} from '../config/env.validation.js';
import {
  REFRESH_COOKIE_NAME,
  RefreshTokenTransport,
} from './refresh-token-transport.service.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-09-30T12:00:00.000Z');

function createResponse() {
  return { cookie: vi.fn(), clearCookie: vi.fn() } as unknown as Response & {
    cookie: ReturnType<typeof vi.fn>;
    clearCookie: ReturnType<typeof vi.fn>;
  };
}

function createRequest(cookies: Record<string, unknown> = {}) {
  return { cookies } as unknown as Request;
}

/** Refresh token "emitido" com a validade informada, a partir de NOW. */
function issued(ttlMs: number) {
  return {
    refreshToken: 'rt-123',
    refreshTokenExpiresAt: new Date(NOW + ttlMs),
  };
}

/**
 * Config como no boot: o .env.test passa pelo validateEnv, então a ausência
 * de COOKIE_SECURE cai no padrão real da validação. `undefined` remove a
 * variável.
 */
function validatedConfig(overrides: Record<string, string | undefined>) {
  const env = validateEnv({
    ...parse(readFileSync('.env.test')),
    ...overrides,
  });
  return { get: (key: keyof EnvironmentVariables) => env[key] };
}

async function createTransport(
  overrides: Record<string, string | undefined> = {},
) {
  const moduleRef = await Test.createTestingModule({
    providers: [
      RefreshTokenTransport,
      { provide: ConfigService, useValue: validatedConfig(overrides) },
    ],
  }).compile();
  return moduleRef.get(RefreshTokenTransport);
}

describe('RefreshTokenTransport', () => {
  let transport: RefreshTokenTransport;

  beforeEach(async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    transport = await createTransport({ COOKIE_SECURE: undefined });
  });

  afterEach(() => vi.restoreAllMocks());

  describe('deliver', () => {
    it('web: seta cookie httpOnly/lax/secure com escopo /auth e não devolve token para o corpo', () => {
      const res = createResponse();

      const bodyToken = transport.deliver('web', res, issued(7 * DAY_MS));

      expect(bodyToken).toBeUndefined();
      expect(res.cookie).toHaveBeenCalledWith(REFRESH_COOKIE_NAME, 'rt-123', {
        httpOnly: true,
        secure: true, // padrão, sem COOKIE_SECURE
        sameSite: 'lax',
        path: '/auth',
        maxAge: 7 * DAY_MS,
      });
    });

    it('web: sem Secure só com COOKIE_SECURE=false', async () => {
      const devTransport = await createTransport({ COOKIE_SECURE: 'false' });
      const res = createResponse();

      devTransport.deliver('web', res, issued(7 * DAY_MS));

      expect(res.cookie.mock.calls[0][2]).toMatchObject({ secure: false });
    });

    it('web: o Secure não depende de NODE_ENV', async () => {
      for (const nodeEnv of ['development', 'test']) {
        const t = await createTransport({
          NODE_ENV: nodeEnv,
          COOKIE_SECURE: undefined,
        });
        const res = createResponse();

        t.deliver('web', res, issued(DAY_MS));

        expect(res.cookie.mock.calls[0][2]).toMatchObject({ secure: true });
      }
    });

    it.each([
      ['15m', 15 * 60 * 1000],
      ['3d', 3 * DAY_MS],
      ['30d', 30 * DAY_MS],
    ])(
      'web: maxAge acompanha a validade do token emitido (%s)',
      (_ttl, ttlMs) => {
        const res = createResponse();

        transport.deliver('web', res, issued(ttlMs));

        expect(res.cookie.mock.calls[0][2]).toMatchObject({ maxAge: ttlMs });
      },
    );

    it('web: token já vencido vira maxAge 0 (nunca negativo)', () => {
      const res = createResponse();

      transport.deliver('web', res, issued(-1000));

      expect(res.cookie.mock.calls[0][2]).toMatchObject({ maxAge: 0 });
    });

    it('mobile: devolve o token para o corpo e não seta cookie algum', () => {
      const res = createResponse();

      expect(transport.deliver('mobile', res, issued(7 * DAY_MS))).toBe(
        'rt-123',
      );
      expect(res.cookie).not.toHaveBeenCalled();
    });
  });

  describe('clear', () => {
    it.each([undefined, 'false'])(
      'web: limpa o cookie com as MESMAS opções do set, menos maxAge (COOKIE_SECURE=%s)',
      async (cookieSecure) => {
        const t = await createTransport({ COOKIE_SECURE: cookieSecure });
        const res = createResponse();

        t.deliver('web', res, issued(7 * DAY_MS));
        t.clear('web', res);

        const { maxAge: _maxAge, ...setOptions } = res.cookie.mock
          .calls[0][2] as Record<string, unknown>;
        expect(res.clearCookie).toHaveBeenCalledWith(
          REFRESH_COOKIE_NAME,
          setOptions,
        );
        expect(setOptions).toMatchObject({ secure: cookieSecure !== 'false' });
      },
    );

    it('mobile: não faz nada', () => {
      const res = createResponse();
      transport.clear('mobile', res);
      expect(res.clearCookie).not.toHaveBeenCalled();
    });
  });

  /**
   * O header de verdade, serializado pelo Express: garante que as opções acima
   * viram os atributos esperados no Set-Cookie.
   */
  describe('Set-Cookie real (Express)', () => {
    @Controller()
    class CookieProbeController {
      constructor(private readonly transport: RefreshTokenTransport) {}

      @Post('deliver')
      deliver(@Res({ passthrough: true }) res: Response): void {
        this.transport.deliver('web', res, {
          refreshToken: 'rt-123',
          refreshTokenExpiresAt: new Date(Date.now() + 3 * DAY_MS),
        });
      }

      @Post('clear')
      clear(@Res({ passthrough: true }) res: Response): void {
        this.transport.clear('web', res);
      }
    }

    async function createApp(
      overrides: Record<string, string | undefined>,
    ): Promise<INestApplication> {
      const moduleRef = await Test.createTestingModule({
        controllers: [CookieProbeController],
        providers: [
          RefreshTokenTransport,
          { provide: ConfigService, useValue: validatedConfig(overrides) },
        ],
      }).compile();
      const app = moduleRef.createNestApplication({ logger: false });
      await app.init();
      return app;
    }

    async function setCookieOf(app: INestApplication, path: string) {
      const res = await request(app.getHttpServer()).post(path);
      return (res.headers['set-cookie'] as unknown as string[])[0];
    }

    // O relógio real: o Express também usa Date.now() para o Expires.
    beforeEach(() => vi.restoreAllMocks());

    it('por padrão traz Secure, e o Max-Age é a validade do token', async () => {
      const app = await createApp({ COOKIE_SECURE: undefined });
      try {
        const cookie = await setCookieOf(app, '/deliver');

        expect(cookie).toMatch(/^refreshToken=rt-123;/);
        expect(cookie).toMatch(/;\s*Secure/);
        expect(cookie).toMatch(/;\s*HttpOnly/);
        expect(cookie).toMatch(/;\s*SameSite=Lax/);
        expect(cookie).toMatch(/;\s*Path=\/auth/);
        const maxAge = Number(/Max-Age=(\d+)/.exec(cookie)![1]);
        expect(maxAge).toBeLessThanOrEqual(3 * 24 * 60 * 60);
        expect(maxAge).toBeGreaterThanOrEqual(3 * 24 * 60 * 60 - 2);

        const cleared = await setCookieOf(app, '/clear');
        expect(cleared).toMatch(/^refreshToken=;/);
        expect(cleared).toMatch(/;\s*Secure/);
        expect(cleared).toMatch(/;\s*HttpOnly/);
        expect(cleared).toMatch(/;\s*SameSite=Lax/);
        expect(cleared).toMatch(/;\s*Path=\/auth/);
        expect(cleared).toContain('Expires=Thu, 01 Jan 1970');
      } finally {
        await app.close();
      }
    });

    it('com COOKIE_SECURE=false não traz Secure (nem no clear)', async () => {
      const app = await createApp({ COOKIE_SECURE: 'false' });
      try {
        expect(await setCookieOf(app, '/deliver')).not.toMatch(/Secure/i);
        expect(await setCookieOf(app, '/clear')).not.toMatch(/Secure/i);
      } finally {
        await app.close();
      }
    });
  });

  describe('read', () => {
    it('web: lê do cookie e ignora a ausência de corpo', () => {
      const req = createRequest({ [REFRESH_COOKIE_NAME]: 'rt-cookie' });
      expect(transport.read('web', req, undefined)).toBe('rt-cookie');
    });

    it('web: rejeita com 400 o token enviado no corpo (canal errado)', () => {
      const req = createRequest({ [REFRESH_COOKIE_NAME]: 'rt-cookie' });

      expect(() => transport.read('web', req, 'rt-body')).toThrow(
        BadRequestException,
      );
      // Não cai em fallback: nem usa o cookie, nem o corpo.
      expect(() => transport.read('web', req, 'rt-body')).toThrow(
        /must not be sent in the request body/,
      );
    });

    it('web: devolve undefined quando o cookie não veio (canal certo, vazio)', () => {
      expect(transport.read('web', createRequest(), undefined)).toBeUndefined();
    });

    it('mobile: lê do corpo', () => {
      expect(transport.read('mobile', createRequest(), 'rt-body')).toBe(
        'rt-body',
      );
    });

    it('mobile: rejeita com 400 quando um cookie de refresh acompanha a request', () => {
      const req = createRequest({ [REFRESH_COOKIE_NAME]: 'rt-cookie' });

      expect(() => transport.read('mobile', req, 'rt-body')).toThrow(
        BadRequestException,
      );
      expect(() => transport.read('mobile', req, undefined)).toThrow(
        /must not be sent when/,
      );
    });

    it('mobile: devolve undefined quando o corpo não trouxe o campo', () => {
      expect(
        transport.read('mobile', createRequest(), undefined),
      ).toBeUndefined();
    });

    it('trata cookie vazio como ausente', () => {
      expect(
        transport.read(
          'web',
          createRequest({ [REFRESH_COOKIE_NAME]: '' }),
          undefined,
        ),
      ).toBeUndefined();
      // E, para mobile, um cookie vazio não dispara o erro de canal errado.
      expect(
        transport.read(
          'mobile',
          createRequest({ [REFRESH_COOKIE_NAME]: '' }),
          'rt-body',
        ),
      ).toBe('rt-body');
    });

    it('tolera req.cookies ausente (cookie-parser não instalado)', () => {
      const req = { headers: {} } as unknown as Request;
      expect(transport.read('web', req, undefined)).toBeUndefined();
    });
  });
});
