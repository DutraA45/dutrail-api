import request from 'supertest';
import type { TestApp } from './utils/create-app.js';
import { createAppWithEnv } from './utils/create-app-with-env.js';

/**
 * Prefixo global /api e health check. A app sobe com o rate limit real e o
 * limite global em 1 request por janela: qualquer rota que contasse no limite
 * responderia 429 já na segunda chamada.
 */
describe('Prefixo /api e health check (e2e)', () => {
  let t: TestApp;
  const http = () => request(t.app.getHttpServer());

  beforeAll(async () => {
    t = await createAppWithEnv(
      { THROTTLE_LIMIT: '1' },
      { keepThrottling: true },
    );
  });

  afterAll(async () => {
    await t.close();
    vi.unstubAllEnvs();
  });

  it('GET /api/health: 200 { status: "ok" }, sem Bearer', async () => {
    const res = await http().get('/api/health').expect(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('fica fora do rate limit (o limite global aqui é 1/min)', async () => {
    for (let i = 0; i < 5; i++) {
      const res = await http().get('/api/health').expect(200);
      expect(res.headers['x-ratelimit-limit']).toBeUndefined();
    }

    // As outras rotas continuam limitadas: a segunda é 429.
    await http().get('/api/me').expect(401);
    await http().get('/api/me').expect(429);
  });

  // Fora do prefixo o Nest não registra rota nem o handler de 404 (ele é
  // montado só sob /api): responde o 404 padrão do Express, em texto.
  it.each([
    ['GET', '/health'],
    ['GET', '/me'],
    ['GET', '/activities'],
    ['POST', '/auth/login'],
    ['POST', '/auth/refresh'],
    ['GET', '/auth/google'],
    ['GET', '/docs'],
  ])('%s %s (sem o prefixo) responde 404', async (method, path) => {
    const res = await http()
      [method === 'GET' ? 'get' : 'post'](path)
      .set('X-Client-Type', 'mobile')
      .expect(404);
    expect(res.text).toContain(`Cannot ${method} ${path}`);
  });

  // Os handlers de 404 e de erro do Nest ficam montados sob /api, onde o
  // Express tira o prefixo do req.url: o `path` do corpo precisa vir completo.
  it('dentro do prefixo, rota inexistente é o 404 JSON da API, com o path completo', async () => {
    const res = await http().get('/api/nao-existe?x=1').expect(404);
    expect(res.body).toMatchObject({
      statusCode: 404,
      error: 'Not Found',
      message: 'Cannot GET /api/nao-existe?x=1',
      path: '/api/nao-existe?x=1',
    });
  });

  it('JSON malformado: 400 com o path completo', async () => {
    const res = await http()
      .post('/api/auth/login')
      .set('X-Client-Type', 'mobile')
      .set('Content-Type', 'application/json')
      .send('{"email":')
      .expect(400);
    expect(res.body).toMatchObject({
      statusCode: 400,
      path: '/api/auth/login',
    });
  });
});
