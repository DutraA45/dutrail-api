import request from 'supertest';
import type { Response } from 'supertest';
import type { INestApplication } from '@nestjs/common';
import type { ClientType } from '../../src/common/decorators/client-type.decorator.js';

export const CLIENT_TYPES: readonly ClientType[] = ['web', 'mobile'];

/**
 * Cliente de teste que fala com a API do jeito do seu tipo, escondendo a única
 * diferença real (cookie vs corpo) atrás de métodos iguais. Assim o MESMO
 * cenário roda para web e mobile, e qualquer divergência de comportamento que
 * não seja o transporte aparece como falha.
 */
export interface TestClient {
  type: ClientType;
  /** Request com o header X-Client-Type e cookie jar (o browser do teste). */
  post(url: string): request.Test;
  get(url: string): request.Test;
  /** Request SEM cookie jar, para controlar exatamente o que é enviado. */
  rawPost(url: string): request.Test;
  /** Renova usando a sessão corrente (cookie do jar, ou token informado). */
  refresh(token?: string): request.Test;
  /** Renova apresentando um token específico — usado nos testes de reuso. */
  refreshWith(token: string): request.Test;
  logout(token?: string): request.Test;
  /** Extrai o refresh token da resposta, do canal próprio do cliente. */
  refreshTokenOf(res: Response): string | undefined;
  /** Garante que o token saiu SÓ pelo canal certo. */
  expectTokenChannel(res: Response): void;
}

/** Valor de um cookie no header Set-Cookie, ou undefined se não veio. */
export function setCookie(
  res: Response,
  name = 'refreshToken',
): string | undefined {
  const header = res.headers['set-cookie'] as string[] | string | undefined;
  const cookies = Array.isArray(header) ? header : header ? [header] : [];
  const found = cookies.find((c) => c.startsWith(`${name}=`));
  if (found === undefined) return undefined;
  const value = found.slice(name.length + 1).split(';')[0];
  return decodeURIComponent(value);
}

/** Atributos crus do cookie (para checar HttpOnly, Path, SameSite...). */
export function setCookieRaw(
  res: Response,
  name = 'refreshToken',
): string | undefined {
  const header = res.headers['set-cookie'] as string[] | string | undefined;
  const cookies = Array.isArray(header) ? header : header ? [header] : [];
  return cookies.find((c) => c.startsWith(`${name}=`));
}

/**
 * Cookies que o agent REALMENTE enviou nesta request (o cookie jar aplica o
 * Path, então isso comprova se o cookie acompanhou ou não a rota).
 */
export function sentCookies(res: Response): string {
  return (res.request as unknown as { cookies?: string }).cookies ?? '';
}

export function createClient(
  app: INestApplication,
  type: ClientType,
): TestClient {
  const server = app.getHttpServer();
  // O agent mantém um cookie jar, como um browser — essencial para o fluxo web.
  const agent = request.agent(server);
  const withHeader = (t: request.Test) => t.set('X-Client-Type', type);

  const client: TestClient = {
    type,
    post: (url) => withHeader(agent.post(url)),
    get: (url) => withHeader(agent.get(url)),
    rawPost: (url) => withHeader(request(server).post(url)),

    refresh: (token) =>
      type === 'web'
        ? // O cookie vai automaticamente; o body fica vazio de propósito.
          withHeader(agent.post('/auth/refresh'))
        : withHeader(agent.post('/auth/refresh')).send({ refreshToken: token }),

    refreshWith: (token) =>
      type === 'web'
        ? withHeader(request(server).post('/auth/refresh')).set(
            'Cookie',
            `refreshToken=${encodeURIComponent(token)}`,
          )
        : withHeader(request(server).post('/auth/refresh')).send({
            refreshToken: token,
          }),

    logout: (token) =>
      type === 'web'
        ? withHeader(agent.post('/auth/logout'))
        : withHeader(agent.post('/auth/logout')).send({ refreshToken: token }),

    refreshTokenOf: (res) =>
      type === 'web'
        ? setCookie(res)
        : (res.body.refreshToken as string | undefined),

    expectTokenChannel: (res) => {
      if (type === 'web') {
        // Nunca no corpo; sempre no cookie, com as flags de segurança.
        expect(res.body.refreshToken).toBeUndefined();
        const cookie = setCookieRaw(res);
        expect(cookie).toBeDefined();
        expect(cookie).toContain('HttpOnly');
        expect(cookie).toContain('Path=/auth');
        expect(cookie).toMatch(/SameSite=Lax/i);
      } else {
        // Nunca cookie; sempre no corpo.
        expect(res.headers['set-cookie']).toBeUndefined();
        expect(res.body.refreshToken).toBeTypeOf('string');
      }
    },
  };

  return client;
}
