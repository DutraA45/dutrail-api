import type { ArgumentsHost } from '@nestjs/common';
import {
  InternalServerErrorException,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TokenError } from 'passport-oauth2';
import type { EnvironmentVariables } from '../../config/env.validation.js';
import type { SecurityLogService } from '../../security/security-log.service.js';
import {
  GOOGLE_CALLBACK_ERROR_CODES,
  GoogleCallbackError,
  GoogleEmailNotVerifiedException,
} from '../google-callback.js';
import { GoogleCallbackFilter } from './google-callback.filter.js';

const FRONTEND_URL = 'http://localhost:4200';

function createHost() {
  const request = {
    method: 'GET',
    url: '/auth/google/callback?code=abc123&state=st4te987',
    path: '/auth/google/callback',
    ip: '203.0.113.7',
    headers: { 'user-agent': 'Mozilla/5.0' },
  };
  const response = { redirect: vi.fn(), status: vi.fn(), json: vi.fn() };
  const host = {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => response,
    }),
  } as unknown as ArgumentsHost;
  return { host, response };
}

describe('GoogleCallbackFilter (A-13)', () => {
  const securityLog = { warn: vi.fn(), log: vi.fn() };
  const config = {
    get: (name: string) => (name === 'FRONTEND_URL' ? FRONTEND_URL : undefined),
  } as unknown as ConfigService<EnvironmentVariables, true>;
  const filter = new GoogleCallbackFilter(
    config,
    securityLog as unknown as SecurityLogService,
  );
  const logError = vi
    .spyOn(Logger.prototype, 'error')
    .mockImplementation(() => undefined);

  beforeEach(() => {
    securityLog.warn.mockClear();
    logError.mockClear();
  });
  afterAll(() => vi.restoreAllMocks());

  it.each([
    ['access_denied', 'access_denied'],
    ['email_not_verified', 'email_not_verified'],
    ['state_mismatch', 'state_mismatch'],
    ['oauth_failed', 'callback_error'],
  ] as const)(
    '%s: 302 para o frontend com ?error= e google_exchange_failed/%s',
    (code, reason) => {
      const { host, response } = createHost();
      filter.catch(new GoogleCallbackError(code), host);

      expect(response.redirect).toHaveBeenCalledWith(
        302,
        `${FRONTEND_URL}/auth/callback?error=${code}`,
      );
      expect(response.json).not.toHaveBeenCalled();
      expect(securityLog.warn).toHaveBeenCalledWith(
        'google_exchange_failed',
        { ip: '203.0.113.7', userAgent: 'Mozilla/5.0', clientType: undefined },
        { reason },
      );
    },
  );

  it('cobre todos os códigos', () => {
    expect(GOOGLE_CALLBACK_ERROR_CODES).toEqual([
      'access_denied',
      'email_not_verified',
      'state_mismatch',
      'oauth_failed',
    ]);
  });

  it.each([
    ['TokenError', new TokenError('Malformed auth code.', 'invalid_grant')],
    ['401 do Nest', new UnauthorizedException()],
    ['email não verificado', new GoogleEmailNotVerifiedException()],
    ['sem causa', undefined],
  ])('desfecho esperado (%s): sem stack no log', (_label, cause) => {
    filter.catch(
      new GoogleCallbackError('oauth_failed', cause),
      createHost().host,
    );
    expect(logError).not.toHaveBeenCalled();
  });

  it.each([
    ['Error comum (banco, bug)', new Error('connection refused')],
    ['5xx do Nest', new InternalServerErrorException()],
  ])(
    'erro inesperado (%s): redireciona, mas loga o stack só com o path',
    (_label, cause) => {
      const { host, response } = createHost();
      filter.catch(new GoogleCallbackError('oauth_failed', cause), host);

      expect(response.redirect).toHaveBeenCalledWith(
        302,
        `${FRONTEND_URL}/auth/callback?error=oauth_failed`,
      );
      expect(logError).toHaveBeenCalledTimes(1);
      const logged = JSON.stringify(logError.mock.calls);
      expect(logged).toContain('GET /auth/google/callback -> oauth_failed');
      expect(logged).not.toContain('abc123');
      expect(logged).not.toContain('st4te987');
    },
  );

  it('nada vindo do Google chega ao redirect nem ao log', () => {
    const { host, response } = createHost();
    const cause = new TokenError('descricao-do-google', 'invalid_grant');
    filter.catch(new GoogleCallbackError('oauth_failed', cause), host);

    const out = JSON.stringify([
      response.redirect.mock.calls,
      securityLog.warn.mock.calls,
    ]);
    expect(out).not.toContain('descricao-do-google');
    expect(out).not.toContain('invalid_grant');
  });
});
