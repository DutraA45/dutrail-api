import {
  ArgumentsHost,
  BadRequestException,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client.js';
import { AllExceptionsFilter } from './all-exceptions.filter.js';

function createHost(
  req: { method: string; url: string; path: string } = {
    method: 'POST',
    url: '/auth/login',
    path: '/auth/login',
  },
) {
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
  const filter = new AllExceptionsFilter();

  // O filtro loga erros 500 de propósito; não queremos o stack no output do teste.
  const logError = vi
    .spyOn(Logger.prototype, 'error')
    .mockImplementation(() => undefined);
  beforeEach(() => logError.mockClear());
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
});
