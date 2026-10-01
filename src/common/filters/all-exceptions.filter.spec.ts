import {
  ArgumentsHost,
  BadRequestException,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import { Prisma } from '../../generated/prisma/client.js';
import type { SecurityLogService } from '../../security/security-log.service.js';
import { AllExceptionsFilter } from './all-exceptions.filter.js';

interface FakeRequest {
  method: string;
  url: string;
  path: string;
  ip?: string;
  headers?: Record<string, string>;
  user?: { userId: string; email: string };
}

function createHost(
  partial: Partial<FakeRequest> = {
    method: 'POST',
    url: '/auth/login',
    path: '/auth/login',
  },
) {
  const req: FakeRequest = {
    method: 'POST',
    url: '/auth/login',
    path: '/auth/login',
    ip: '203.0.113.7',
    headers: {},
    ...partial,
  };
  const response = { status: vi.fn().mockReturnThis(), json: vi.fn() };
  const host = {
    switchToHttp: () => ({
      getResponse: () => response,
      getRequest: () => req,
    }),
  } as unknown as ArgumentsHost;
  return { host, response };
}

describe('AllExceptionsFilter', () => {
  const securityLog = { log: vi.fn(), warn: vi.fn() };
  const filter = new AllExceptionsFilter(
    securityLog as unknown as SecurityLogService,
  );

  // O filtro loga erros 500 de propósito; não queremos o stack no output do teste.
  const logError = vi
    .spyOn(Logger.prototype, 'error')
    .mockImplementation(() => undefined);
  beforeEach(() => {
    logError.mockClear();
    securityLog.log.mockClear();
    securityLog.warn.mockClear();
  });
  afterAll(() => vi.restoreAllMocks());

  it('mantém status e mensagens de uma HttpException (ex.: validação)', () => {
    const { host, response } = createHost();
    filter.catch(new BadRequestException(['email must be an email']), host);

    expect(response.status).toHaveBeenCalledWith(400);
    expect(response.json).toHaveBeenCalledWith({
      statusCode: 400,
      error: 'Bad Request',
      message: ['email must be an email'],
      path: '/auth/login',
      timestamp: expect.any(String),
    });
  });

  it('traduz erro de unique do Prisma (P2002) para 409', () => {
    const { host, response } = createHost();
    const err = new Prisma.PrismaClientKnownRequestError(
      'Unique constraint failed',
      {
        code: 'P2002',
        clientVersion: 'test',
      },
    );
    filter.catch(err, host);

    expect(response.status).toHaveBeenCalledWith(409);
    expect(response.json.mock.calls[0][0]).toMatchObject({
      statusCode: 409,
      error: 'Conflict',
    });
  });

  it('esconde detalhes de erros desconhecidos atrás de um 500 genérico', () => {
    const { host, response } = createHost();
    filter.catch(new Error('senha do banco é 123'), host);

    expect(response.status).toHaveBeenCalledWith(500);
    const body = response.json.mock.calls[0][0];
    expect(body.message).toBe('Internal server error');
    expect(JSON.stringify(body)).not.toContain('123');
  });

  it('loga o 5xx sem a query string (A-19: code/state do callback do Google)', () => {
    // Como o Express monta a request: `url` com a query, `path` sem.
    const { host } = createHost({
      method: 'GET',
      url: '/auth/google/callback?code=abc123&state=st4te987',
      path: '/auth/google/callback',
    });

    filter.catch(new Error('falha inesperada'), host);

    expect(logError).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(logError.mock.calls);
    expect(logged).toContain('GET /auth/google/callback -> 500');
    expect(logged).not.toContain('abc123');
    expect(logged).not.toContain('st4te987');
  });

  it('não loga erros 4xx', () => {
    const { host } = createHost();
    filter.catch(new BadRequestException(), host);
    expect(logError).not.toHaveBeenCalled();
  });

  it('usa o nome do status quando a exceção não traz "error"', () => {
    const { host, response } = createHost();
    filter.catch(new UnauthorizedException(), host);
    expect(response.json.mock.calls[0][0]).toMatchObject({
      statusCode: 401,
      error: 'Unauthorized',
    });
  });

  describe('eventos de segurança (A-07)', () => {
    const callback = {
      method: 'GET',
      url: '/auth/google/callback?code=abc123&state=st4te987',
      path: '/auth/google/callback',
    };

    it('429 vira rate_limited, com ip, user-agent e client type válido', () => {
      const { host, response } = createHost({
        headers: { 'user-agent': 'curl/8', 'x-client-type': 'mobile' },
      });
      filter.catch(new ThrottlerException(), host);

      expect(response.status).toHaveBeenCalledWith(429);
      expect(securityLog.warn).toHaveBeenCalledWith(
        'rate_limited',
        { ip: '203.0.113.7', userAgent: 'curl/8', clientType: 'mobile' },
        { userId: undefined },
      );
    });

    it('429 ignora X-Client-Type inválido e inclui o usuário autenticado', () => {
      const { host } = createHost({
        path: '/activities',
        url: '/activities',
        headers: { 'x-client-type': 'desktop' },
        user: { userId: 'user-1', email: 'ana@example.com' },
      });
      filter.catch(new ThrottlerException(), host);

      expect(securityLog.warn).toHaveBeenCalledWith(
        'rate_limited',
        expect.objectContaining({ clientType: undefined }),
        { userId: 'user-1' },
      );
    });

    it.each([
      ['401', new UnauthorizedException()],
      ['500', new Error('TokenError: bad code')],
    ])(
      'falha %s no callback do Google vira google_exchange_failed/callback_error',
      (_status, error) => {
        const { host } = createHost(callback);
        filter.catch(error, host);

        expect(securityLog.warn).toHaveBeenCalledTimes(1);
        expect(securityLog.warn).toHaveBeenCalledWith(
          'google_exchange_failed',
          expect.objectContaining({ ip: '203.0.113.7' }),
          { reason: 'callback_error' },
        );
        // Nem o code nem o state chegam ao log de segurança.
        const logged = JSON.stringify(securityLog.warn.mock.calls);
        expect(logged).not.toContain('abc123');
        expect(logged).not.toContain('st4te987');
      },
    );

    it('não registra outros erros (400 no callback, 401 fora dele)', () => {
      filter.catch(new BadRequestException(), createHost(callback).host);
      filter.catch(new UnauthorizedException(), createHost().host);

      expect(securityLog.warn).not.toHaveBeenCalled();
      expect(securityLog.log).not.toHaveBeenCalled();
    });

    it('não altera a resposta ao cliente', () => {
      const { host, response } = createHost(callback);
      filter.catch(new UnauthorizedException(), host);

      expect(response.json).toHaveBeenCalledWith({
        statusCode: 401,
        error: 'Unauthorized',
        message: 'Unauthorized',
        path: callback.url,
        timestamp: expect.any(String),
      });
    });
  });
});
