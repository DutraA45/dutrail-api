import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type { Request, Response } from 'express';
import { NodeEnv } from '../config/env.validation.js';
import {
  REFRESH_COOKIE_NAME,
  RefreshTokenTransport,
} from './refresh-token-transport.service.js';

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

function createResponse() {
  return { cookie: vi.fn(), clearCookie: vi.fn() } as unknown as Response & {
    cookie: ReturnType<typeof vi.fn>;
    clearCookie: ReturnType<typeof vi.fn>;
  };
}

function createRequest(cookies: Record<string, unknown> = {}) {
  return { cookies } as unknown as Request;
}

async function createTransport(nodeEnv: NodeEnv) {
  const moduleRef = await Test.createTestingModule({
    providers: [
      RefreshTokenTransport,
      { provide: ConfigService, useValue: { get: () => nodeEnv } },
    ],
  }).compile();
  return moduleRef.get(RefreshTokenTransport);
}

describe('RefreshTokenTransport', () => {
  let transport: RefreshTokenTransport;

  beforeEach(async () => {
    transport = await createTransport(NodeEnv.Development);
  });

  describe('deliver', () => {
    it('web: seta cookie httpOnly/lax com escopo /auth e 7 dias, e não devolve token para o corpo', () => {
      const res = createResponse();

      const bodyToken = transport.deliver('web', res, 'rt-123');

      expect(bodyToken).toBeUndefined();
      expect(res.cookie).toHaveBeenCalledWith(REFRESH_COOKIE_NAME, 'rt-123', {
        httpOnly: true,
        secure: false, // NODE_ENV=development
        sameSite: 'lax',
        path: '/auth',
        maxAge: SEVEN_DAYS_MS,
      });
    });

    it('web: marca o cookie como secure em produção', async () => {
      const prodTransport = await createTransport(NodeEnv.Production);
      const res = createResponse();

      prodTransport.deliver('web', res, 'rt-123');

      expect(res.cookie.mock.calls[0][2]).toMatchObject({ secure: true });
    });

    it('mobile: devolve o token para o corpo e não seta cookie algum', () => {
      const res = createResponse();

      expect(transport.deliver('mobile', res, 'rt-123')).toBe('rt-123');
      expect(res.cookie).not.toHaveBeenCalled();
    });
  });

  describe('clear', () => {
    it('web: limpa o cookie com as MESMAS opções do set (menos maxAge)', () => {
      const res = createResponse();

      transport.clear('web', res);

      expect(res.clearCookie).toHaveBeenCalledWith(REFRESH_COOKIE_NAME, {
        httpOnly: true,
        secure: false,
        sameSite: 'lax',
        path: '/auth',
      });
    });

    it('mobile: não faz nada', () => {
      const res = createResponse();
      transport.clear('mobile', res);
      expect(res.clearCookie).not.toHaveBeenCalled();
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
