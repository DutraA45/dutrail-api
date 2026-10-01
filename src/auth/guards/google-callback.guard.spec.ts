import type { ExecutionContext } from '@nestjs/common';
import { UnauthorizedException } from '@nestjs/common';
import { TokenError } from 'passport-oauth2';
import {
  GoogleCallbackError,
  GoogleEmailNotVerifiedException,
} from '../google-callback.js';
import { OAUTH_STATE_MISMATCH, OAuthStateStore } from '../oauth-state.store.js';
import { GoogleCallbackGuard } from './google-callback.guard.js';

function createContext(query: Record<string, unknown>) {
  const response = {};
  const context = {
    switchToHttp: () => ({
      getRequest: () => ({ query }),
      getResponse: () => response,
    }),
  } as unknown as ExecutionContext;
  return { context, response };
}

describe('GoogleCallbackGuard (A-13)', () => {
  const stateStore = { clear: vi.fn() };
  const guard = new GoogleCallbackGuard(
    stateStore as unknown as OAuthStateStore,
  );

  beforeEach(() => {
    stateStore.clear.mockClear();
  });

  /** Código com que o handleRequest recusa o desfecho do passport. */
  function codeFor(
    query: Record<string, unknown>,
    err: unknown,
    info?: unknown,
  ): string {
    try {
      guard.handleRequest(err, false, info, createContext(query).context);
    } catch (thrown) {
      expect(thrown).toBeInstanceOf(GoogleCallbackError);
      return (thrown as GoogleCallbackError).code;
    }
    throw new Error('handleRequest não lançou');
  }

  it('sucesso devolve o usuário', () => {
    const user = { id: 'user-1' };
    expect(
      guard.handleRequest(null, user, undefined, createContext({}).context),
    ).toBe(user);
  });

  it.each([
    [
      'cancelamento (fail com a descrição do Google)',
      { error: 'access_denied', error_description: 'x' },
      null,
      { message: 'x' },
      'access_denied',
    ],
    [
      'state recusado pelo OAuthStateStore',
      { code: 'c', state: 's' },
      null,
      OAUTH_STATE_MISMATCH,
      'state_mismatch',
    ],
    [
      'email não verificado',
      { code: 'c', state: 's' },
      new GoogleEmailNotVerifiedException(),
      undefined,
      'email_not_verified',
    ],
    [
      'code inválido (TokenError)',
      { code: 'c', state: 's' },
      new TokenError('Malformed auth code.', 'invalid_grant'),
      undefined,
      'oauth_failed',
    ],
    [
      'outro 401 (conta Google sem email)',
      { code: 'c', state: 's' },
      new UnauthorizedException('Google account has no email'),
      undefined,
      'oauth_failed',
    ],
    [
      'fail sem o info do store',
      { code: 'c', state: 's' },
      null,
      { message: 'outro' },
      'oauth_failed',
    ],
    [
      'outro error= do Google',
      { error: 'server_error' },
      new Error('AuthorizationError'),
      undefined,
      'oauth_failed',
    ],
  ])('%s -> %s', (_label, query, err, info, expected) => {
    expect(codeFor(query, err, info)).toBe(expected);
  });

  it('guarda o erro original como cause (nunca vai ao cliente)', () => {
    const original = new TokenError('Malformed auth code.', 'invalid_grant');
    try {
      guard.handleRequest(
        original,
        false,
        undefined,
        createContext({}).context,
      );
    } catch (thrown) {
      expect((thrown as GoogleCallbackError).cause).toBe(original);
    }
  });

  it('callback sem code nem error: oauth_failed sem iniciar fluxo, com o cookie apagado', () => {
    const { context, response } = createContext({});
    expect(() => guard.canActivate(context)).toThrow(GoogleCallbackError);
    expect(stateStore.clear).toHaveBeenCalledWith(response);
  });
});
