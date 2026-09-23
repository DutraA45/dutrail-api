import {
  ArgumentsHost,
  BadRequestException,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client.js';
import { AllExceptionsFilter } from './all-exceptions.filter.js';

function createHost() {
  const response = { status: vi.fn().mockReturnThis(), json: vi.fn() };
  const host = {
    switchToHttp: () => ({
      getResponse: () => response,
      getRequest: () => ({ method: 'POST', url: '/auth/login' }),
    }),
  } as unknown as ArgumentsHost;
  return { host, response };
}

describe('AllExceptionsFilter', () => {
  const filter = new AllExceptionsFilter();

  // O filtro loga erros 500 de propósito; não queremos o stack no output do teste.
  beforeAll(() =>
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined),
  );
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

  it('usa o nome do status quando a exceção não traz "error"', () => {
    const { host, response } = createHost();
    filter.catch(new UnauthorizedException(), host);
    expect(response.json.mock.calls[0][0]).toMatchObject({
      statusCode: 401,
      error: 'Unauthorized',
    });
  });
});
