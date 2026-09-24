import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { Activity } from '../src/generated/prisma/client.js';
import { createClient } from './utils/client.js';
import { createTestApp, TestApp } from './utils/create-app.js';

/**
 * Não existe rota de criação ainda (a importação de .fit vem depois), então
 * as atividades são inseridas direto pelo Prisma. Os usuários, ao contrário,
 * passam pelo signup de verdade para os testes usarem access tokens reais.
 */
describe('Activities (e2e)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });

  beforeEach(async () => {
    await t.resetDb();
  });

  afterAll(async () => {
    await t.close();
  });

  const http = () => request(t.app.getHttpServer());

  interface TestUser {
    id: string;
    token: string;
    get(url: string): request.Test;
  }

  async function signup(email: string): Promise<TestUser> {
    const res = await createClient(t.app, 'mobile')
      .post('/auth/signup')
      .send({ email, password: 'S3nh@Forte!' })
      .expect(201);
    const token = res.body.accessToken as string;
    return {
      id: res.body.user.id as string,
      token,
      get: (url) => http().get(url).set('Authorization', `Bearer ${token}`),
    };
  }

  function createActivity(
    userId: string,
    data: Partial<Omit<Activity, 'userId'>> = {},
  ): Promise<Activity> {
    return t.prisma.activity.create({
      data: {
        userId,
        name: 'Corrida matinal',
        sport: 'running',
        startedAt: new Date('2026-09-20T07:15:30.000Z'),
        elapsedTimeSeconds: 3125,
        ...data,
      },
    });
  }

  const ids = (res: request.Response) =>
    (res.body.items as { id: string }[]).map((a) => a.id);

  let ana: TestUser;
  let bia: TestUser;

  beforeEach(async () => {
    ana = await signup('ana@example.com');
    bia = await signup('bia@example.com');
  });

  describe('autenticação', () => {
    it.each(['/activities', `/activities/${randomUUID()}`])(
      'GET %s sem token retorna 401',
      async (url) => {
        await http().get(url).expect(401);
      },
    );

    it('não exige X-Client-Type', async () => {
      await ana.get('/activities').expect(200);
    });
  });

  describe('GET /activities', () => {
    it('lista vazia quando o usuário não tem atividades', async () => {
      await createActivity(bia.id);

      const res = await ana.get('/activities').expect(200);

      expect(res.body).toEqual({ items: [], nextCursor: null });
    });

    it('retorna apenas as atividades do próprio usuário', async () => {
      const a1 = await createActivity(ana.id, { name: 'Ana 1' });
      const a2 = await createActivity(ana.id, {
        name: 'Ana 2',
        startedAt: new Date('2026-09-21T07:00:00Z'),
      });
      const b1 = await createActivity(bia.id, { name: 'Bia 1' });

      const resAna = await ana.get('/activities').expect(200);
      const resBia = await bia.get('/activities').expect(200);

      expect(ids(resAna).sort()).toEqual([a1.id, a2.id].sort());
      expect(
        resAna.body.items.every((a: Activity) => a.userId === ana.id),
      ).toBe(true);
      expect(ids(resBia)).toEqual([b1.id]);
    });

    it('ordena por startedAt decrescente, independente da ordem de inserção', async () => {
      const middle = await createActivity(ana.id, {
        startedAt: new Date('2026-09-15T10:00:00Z'),
      });
      const oldest = await createActivity(ana.id, {
        startedAt: new Date('2026-08-01T06:00:00Z'),
      });
      const newest = await createActivity(ana.id, {
        startedAt: new Date('2026-09-22T18:30:00Z'),
      });

      const res = await ana.get('/activities').expect(200);

      expect(ids(res)).toEqual([newest.id, middle.id, oldest.id]);
    });

    it('cada item tem exatamente os campos do contrato', async () => {
      await createActivity(ana.id, {
        distanceMeters: 10012.4,
        averageHeartRateBpm: 152,
      });

      const res = await ana.get('/activities').expect(200);

      const [item] = res.body.items;
      expect(Object.keys(item).sort()).toEqual(
        [
          'id',
          'userId',
          'name',
          'sport',
          'startedAt',
          'elapsedTimeSeconds',
          'movingTimeSeconds',
          'distanceMeters',
          'elevationGainMeters',
          'averageHeartRateBpm',
          'maxHeartRateBpm',
          'calories',
          'createdAt',
          'updatedAt',
        ].sort(),
      );
      expect(item).toMatchObject({
        sport: 'running',
        startedAt: '2026-09-20T07:15:30.000Z',
        distanceMeters: 10012.4,
        averageHeartRateBpm: 152,
        // Métricas ausentes saem como null, não somem do JSON.
        movingTimeSeconds: null,
        calories: null,
      });
    });

    describe('paginação por cursor', () => {
      it('percorre todas as páginas sem repetir nem pular, com empates em startedAt', async () => {
        const sameInstant = new Date('2026-09-10T08:00:00Z');
        const created = await Promise.all([
          createActivity(ana.id, {
            startedAt: new Date('2026-09-12T08:00:00Z'),
          }),
          createActivity(ana.id, { startedAt: sameInstant }),
          createActivity(ana.id, { startedAt: sameInstant }),
          createActivity(ana.id, { startedAt: sameInstant }),
          createActivity(ana.id, {
            startedAt: new Date('2026-09-01T08:00:00Z'),
          }),
        ]);
        const expected = [...created]
          .sort(
            (a, b) =>
              b.startedAt.getTime() - a.startedAt.getTime() ||
              (a.id < b.id ? 1 : -1),
          )
          .map((a) => a.id);

        const seen: string[] = [];
        const pageSizes: number[] = [];
        let cursor: string | null = null;
        do {
          const url: string =
            cursor === null
              ? '/activities?limit=2'
              : `/activities?limit=2&cursor=${encodeURIComponent(cursor)}`;
          const res = await ana.get(url).expect(200);
          seen.push(...ids(res));
          pageSizes.push(res.body.items.length);
          cursor = res.body.nextCursor;
        } while (cursor !== null);

        expect(seen).toEqual(expected);
        expect(pageSizes).toEqual([2, 2, 1]);
      });

      it('nextCursor é null quando a página exata esgota os itens', async () => {
        await createActivity(ana.id);
        await createActivity(ana.id);

        const res = await ana.get('/activities?limit=2').expect(200);

        expect(res.body.items).toHaveLength(2);
        expect(res.body.nextCursor).toBeNull();
      });

      it('limit padrão é 20', async () => {
        await t.prisma.activity.createMany({
          data: Array.from({ length: 21 }, (_, i) => ({
            userId: ana.id,
            name: `Atividade ${i}`,
            sport: 'cycling' as const,
            startedAt: new Date(Date.UTC(2026, 8, 1 + i)),
            elapsedTimeSeconds: 600,
          })),
        });

        const res = await ana.get('/activities').expect(200);

        expect(res.body.items).toHaveLength(20);
        expect(res.body.nextCursor).toBeTypeOf('string');
      });

      it('o cursor de um usuário não expõe atividades de outro', async () => {
        const bias = await createActivity(bia.id, {
          startedAt: new Date('2026-09-20T00:00:00Z'),
        });
        await createActivity(bia.id, {
          startedAt: new Date('2026-09-01T00:00:00Z'),
        });
        const anas = await createActivity(ana.id, {
          startedAt: new Date('2026-09-05T00:00:00Z'),
        });
        // Cursor gerado na sessão da Bia, apresentado pela Ana.
        const page = await bia.get('/activities?limit=1').expect(200);
        expect(ids(page)).toEqual([bias.id]);

        const res = await ana
          .get(`/activities?cursor=${encodeURIComponent(page.body.nextCursor)}`)
          .expect(200);

        // Só vira uma posição na lista da própria Ana.
        expect(ids(res)).toEqual([anas.id]);
      });
    });

    it.each([
      ['limit=0', 'limit must not be less than 1'],
      ['limit=101', 'limit must not be greater than 100'],
      ['limit=abc', 'limit must be an integer number'],
      ['limit=2.5', 'limit must be an integer number'],
      ['foo=bar', 'property foo should not exist'],
    ])('?%s retorna 400 de validação', async (query, message) => {
      const res = await ana.get(`/activities?${query}`).expect(400);

      expect(res.body).toMatchObject({
        statusCode: 400,
        error: 'Bad Request',
        path: `/activities?${query}`,
      });
      expect(res.body.message).toContain(message);
    });

    it('cursor adulterado retorna 400', async () => {
      const res = await ana
        .get('/activities?cursor=nao-e-um-cursor')
        .expect(400);

      expect(res.body).toMatchObject({
        statusCode: 400,
        error: 'Bad Request',
        message: 'Invalid cursor',
      });
      expect(res.body.timestamp).toBeTypeOf('string');
    });
  });

  describe('GET /activities/:id', () => {
    it('retorna a atividade com todos os campos', async () => {
      const activity = await createActivity(ana.id, {
        sport: 'hiking',
        movingTimeSeconds: 3010,
        distanceMeters: 8123.5,
        elevationGainMeters: 412.3,
        averageHeartRateBpm: 131,
        maxHeartRateBpm: 164,
        calories: 702,
      });

      const res = await ana.get(`/activities/${activity.id}`).expect(200);

      expect(res.body).toEqual({
        id: activity.id,
        userId: ana.id,
        name: 'Corrida matinal',
        sport: 'hiking',
        startedAt: '2026-09-20T07:15:30.000Z',
        elapsedTimeSeconds: 3125,
        movingTimeSeconds: 3010,
        distanceMeters: 8123.5,
        elevationGainMeters: 412.3,
        averageHeartRateBpm: 131,
        maxHeartRateBpm: 164,
        calories: 702,
        createdAt: activity.createdAt.toISOString(),
        updatedAt: activity.updatedAt.toISOString(),
      });
    });

    it('o detalhe tem o mesmo formato do item da listagem', async () => {
      const activity = await createActivity(ana.id);

      const list = await ana.get('/activities').expect(200);
      const detail = await ana.get(`/activities/${activity.id}`).expect(200);

      expect(detail.body).toEqual(list.body.items[0]);
    });

    it.each([
      ['uuid inexistente', randomUUID()],
      ['id malformado', 'nao-e-um-uuid'],
    ])('404 para %s', async (_label, id) => {
      const res = await ana.get(`/activities/${id}`).expect(404);

      expect(res.body).toMatchObject({
        statusCode: 404,
        error: 'Not Found',
        message: 'Activity not found',
        path: `/activities/${id}`,
      });
    });

    it('404 para atividade de outro usuário, indistinguível de uma inexistente', async () => {
      const bias = await createActivity(bia.id);
      const missingId = randomUUID();

      const foreign = await ana.get(`/activities/${bias.id}`).expect(404);
      const missing = await ana.get(`/activities/${missingId}`).expect(404);

      // Tirando path e timestamp (que variam por natureza), a resposta é
      // idêntica: nada indica que o id da Bia existe.
      const strip = ({
        path: _p,
        timestamp: _t,
        ...rest
      }: Record<string, unknown>) => rest;
      expect(strip(foreign.body)).toEqual(strip(missing.body));
      expect(Object.keys(foreign.headers).sort()).toEqual(
        Object.keys(missing.headers).sort(),
      );

      // E a dona continua enxergando normalmente.
      await bia.get(`/activities/${bias.id}`).expect(200);
    });
  });

  it('POST /activities/import ainda não existe (404)', async () => {
    const res = await http()
      .post('/activities/import')
      .set('Authorization', `Bearer ${ana.token}`)
      .expect(404);

    expect(res.body).toMatchObject({ statusCode: 404, error: 'Not Found' });
  });

  it('apagar o usuário apaga as atividades dele (onDelete: Cascade)', async () => {
    await createActivity(ana.id);
    await createActivity(bia.id);

    await t.prisma.user.delete({ where: { id: ana.id } });

    expect(await t.prisma.activity.count({ where: { userId: ana.id } })).toBe(
      0,
    );
    expect(await t.prisma.activity.count({ where: { userId: bia.id } })).toBe(
      1,
    );
  });

  it('Swagger documenta as rotas como autenticadas', async () => {
    const res = await http().get('/docs-json').expect(200);
    const paths = res.body.paths;

    expect(paths['/activities'].get.security).toEqual([{ bearer: [] }]);
    expect(paths['/activities/{id}'].get.security).toEqual([{ bearer: [] }]);
    expect(Object.keys(paths['/activities/{id}'].get.responses)).toEqual(
      expect.arrayContaining(['200', '401', '404']),
    );
    expect(res.body.components.schemas.ActivitySport.enum).toEqual([
      'running',
      'cycling',
      'walking',
      'hiking',
      'swimming',
      'other',
    ]);
  });
});
