import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import request from 'supertest';
import {
  EMPTY_FILE_MESSAGE,
  FIT_FILE_MAX_BYTES,
  MISSING_FILE_MESSAGE,
} from '../src/activities/activities.controller.js';
import { DUPLICATE_IMPORT_MESSAGE } from '../src/activities/activities.service.js';
import { INVALID_FIT_MESSAGE } from '../src/activities/fit/fit-activity-parser.js';
import type { Activity } from '../src/generated/prisma/client.js';
import { buildFitFile, RUNNING_FIXTURE_PATH } from './fixtures/build-fit.js';
import { createClient } from './utils/client.js';
import { createTestApp, TestApp } from './utils/create-app.js';

/**
 * Nos testes de leitura, as atividades são inseridas direto pelo Prisma, para
 * controlar cada campo; os de importação passam pela rota. Os usuários sempre
 * passam pelo signup de verdade para os testes usarem access tokens reais.
 *
 * O object storage é um MOCK em memória (`t.storage`,
 * test/fakes/fake-activity-file-storage.ts): nenhum teste fala com o bucket.
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
    post(url: string): request.Test;
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
      post: (url) => http().post(url).set('Authorization', `Bearer ${token}`),
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

  describe('POST /activities/import', () => {
    const fixture = readFileSync(RUNNING_FIXTURE_PATH);
    const importFit = (
      user: TestUser,
      file: Buffer | Uint8Array = fixture,
      filename = 'corrida.fit',
    ) =>
      user.post('/activities/import').attach('file', Buffer.from(file), {
        filename,
        contentType: 'application/octet-stream',
      });
    const countActivities = () => t.prisma.activity.count();

    it('201 com a atividade no mesmo formato do GET /activities/:id', async () => {
      const res = await importFit(ana).expect(201);

      expect(res.body).toEqual({
        id: expect.any(String),
        userId: ana.id,
        name: 'Corrida da manhã',
        sport: 'running',
        startedAt: '2026-09-20T09:15:30.000Z',
        elapsedTimeSeconds: 3125,
        movingTimeSeconds: 3010,
        distanceMeters: 10012.4,
        elevationGainMeters: 87,
        averageHeartRateBpm: 152,
        maxHeartRateBpm: 178,
        calories: 689,
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
      });
      const detail = await ana.get(`/activities/${res.body.id}`).expect(200);
      expect(detail.body).toEqual(res.body);
    });

    it('guarda o arquivo original com chave rastreável até usuário e atividade', async () => {
      const res = await importFit(ana).expect(201);

      const key = `activities/${ana.id}/${res.body.id}.fit`;
      expect([...t.storage.objects.keys()]).toEqual([key]);
      expect(t.storage.objects.get(key)).toEqual(fixture);
      const row = await t.prisma.activity.findUniqueOrThrow({
        where: { id: res.body.id },
      });
      expect(row.fitFileKey).toBe(key);
      // A chave é detalhe interno: não sai na resposta.
      expect(res.body).not.toHaveProperty('fitFileKey');
      expect(res.body).not.toHaveProperty('fitFingerprint');
    });

    it('a atividade é do usuário do token, nunca de um campo do formulário', async () => {
      const res = await importFit(ana).field('userId', bia.id).expect(201);

      expect(res.body.userId).toBe(ana.id);
      await bia.get(`/activities/${res.body.id}`).expect(404);
      expect((await bia.get('/activities').expect(200)).body.items).toEqual([]);
      expect(ids(await ana.get('/activities').expect(200))).toEqual([
        res.body.id,
      ]);
    });

    it('401 sem token, sem gravar nada', async () => {
      await http()
        .post('/activities/import')
        .attach('file', fixture, 'corrida.fit')
        .expect(401);

      expect(await countActivities()).toBe(0);
      expect(t.storage.objects.size).toBe(0);
    });

    describe('400', () => {
      it.each([
        [
          'sem corpo multipart',
          () => ana.post('/activities/import'),
          MISSING_FILE_MESSAGE,
        ],
        [
          'multipart sem o campo file',
          () => ana.post('/activities/import').field('nome', 'x'),
          MISSING_FILE_MESSAGE,
        ],
        [
          'arquivo vazio',
          () =>
            ana
              .post('/activities/import')
              .attach('file', Buffer.alloc(0), 'vazio.fit'),
          EMPTY_FILE_MESSAGE,
        ],
        [
          'arquivo que não é FIT',
          () =>
            ana
              .post('/activities/import')
              .attach('file', Buffer.from('<gpx></gpx>'), 'trilha.fit'),
          INVALID_FIT_MESSAGE,
        ],
        [
          'FIT truncado (upload interrompido)',
          () =>
            ana
              .post('/activities/import')
              .attach('file', fixture.subarray(0, 120), 'corrida.fit'),
          INVALID_FIT_MESSAGE,
        ],
        [
          'FIT que não é de atividade',
          () =>
            ana
              .post('/activities/import')
              .attach(
                'file',
                Buffer.from(buildFitFile({ fileType: 'course' })),
                'percurso.fit',
              ),
          'O arquivo .fit não é de uma atividade (tipo "course").',
        ],
      ])('%s', async (_label, send, message) => {
        const res = await send().expect(400);

        expect(res.body).toMatchObject({
          statusCode: 400,
          error: 'Bad Request',
          message,
          path: '/activities/import',
        });
        expect(await countActivities()).toBe(0);
        expect(t.storage.objects.size).toBe(0);
      });

      it('arquivo em outro campo que não file', async () => {
        const res = await ana
          .post('/activities/import')
          .attach('arquivo', fixture, 'corrida.fit')
          .expect(400);

        expect(res.body.statusCode).toBe(400);
        expect(t.storage.objects.size).toBe(0);
      });
    });

    it(`413 acima de ${FIT_FILE_MAX_BYTES} bytes, sem gravar nada`, async () => {
      const tooBig = Buffer.alloc(FIT_FILE_MAX_BYTES + 1);

      const res = await importFit(ana, tooBig).expect(413);

      expect(res.body).toMatchObject({
        statusCode: 413,
        error: 'Payload Too Large',
      });
      expect(await countActivities()).toBe(0);
      expect(t.storage.objects.size).toBe(0);
    });

    it('um arquivo exatamente no limite passa do multer e segue para o parse', async () => {
      // Não é FIT, então vira 400; o que importa é não ser 413.
      await importFit(ana, Buffer.alloc(FIT_FILE_MAX_BYTES)).expect(400);
    });

    describe('duplicidade', () => {
      it('409 ao reimportar o mesmo arquivo, mesmo com outro nome', async () => {
        await importFit(ana).expect(201);

        const res = await importFit(ana, fixture, 'copia.fit').expect(409);

        expect(res.body).toMatchObject({
          statusCode: 409,
          error: 'Conflict',
          message: DUPLICATE_IMPORT_MESSAGE,
        });
        expect(await countActivities()).toBe(1);
        expect(t.storage.objects.size).toBe(1);
      });

      it('outro usuário pode importar o mesmo arquivo', async () => {
        await importFit(ana).expect(201);

        const res = await importFit(bia).expect(201);

        expect(res.body.userId).toBe(bia.id);
        expect(t.storage.objects.size).toBe(2);
      });

      it('importações simultâneas do mesmo arquivo criam uma atividade só', async () => {
        const results = await Promise.all(
          Array.from({ length: 3 }, () => importFit(ana)),
        );

        expect(results.map((r) => r.status).sort((a, b) => a - b)).toEqual([
          201, 409, 409,
        ]);
        expect(await countActivities()).toBe(1);
        // As perdedoras da corrida apagam o que chegaram a subir.
        expect(t.storage.objects.size).toBe(1);
      });
    });

    describe('consistência entre banco e storage', () => {
      it('falha no upload: 500 genérico e nenhuma atividade criada', async () => {
        t.storage.failPutWith = new Error(
          'SignatureDoesNotMatch at tenant-ns.compat.objectstorage.oraclecloud.com',
        );

        const res = await importFit(ana).expect(500);

        expect(res.body).toMatchObject({
          statusCode: 500,
          message: 'Internal server error',
        });
        expect(JSON.stringify(res.body)).not.toMatch(/oracle|signature/i);
        expect(await countActivities()).toBe(0);
      });

      it('depois de uma falha no upload, o mesmo arquivo pode ser importado', async () => {
        t.storage.failPutWith = new Error('storage fora do ar');
        await importFit(ana).expect(500);

        t.storage.failPutWith = null;
        await importFit(ana).expect(201);
      });

      it('falha ao gravar no banco: o arquivo enviado é apagado do storage', async () => {
        const create = vi
          .spyOn(t.prisma.activity, 'create')
          .mockRejectedValueOnce(new Error('connection lost'));

        await importFit(ana).expect(500);

        expect(create).toHaveBeenCalledOnce();
        expect(t.storage.objects.size).toBe(0);
        expect(await countActivities()).toBe(0);
        create.mockRestore();
      });
    });
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
    const importOp = paths['/activities/import'].post;
    expect(importOp.security).toEqual([{ bearer: [] }]);
    expect(Object.keys(importOp.requestBody.content)).toEqual([
      'multipart/form-data',
    ]);
    expect(Object.keys(importOp.responses)).toEqual(
      expect.arrayContaining(['201', '400', '401', '409', '413', '500']),
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

describe('Rate limiting da importação (e2e)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp({ keepThrottling: true });
    await t.resetDb();
  });

  afterAll(async () => {
    await t.close();
  });

  it('bloqueia com 429 após 20 importações por minuto', async () => {
    const signup = await createClient(t.app, 'mobile')
      .post('/auth/signup')
      .send({ email: 'ana@example.com', password: 'S3nh@Forte!' })
      .expect(201);
    // Sem arquivo (400): o guard de rate limit roda antes do upload, então
    // até requests recusadas contam.
    const post = () =>
      request(t.app.getHttpServer())
        .post('/activities/import')
        .set('Authorization', `Bearer ${signup.body.accessToken}`);

    for (let i = 0; i < 20; i++) {
      await post().expect(400);
    }
    const res = await post().expect(429);
    expect(res.body).toMatchObject({
      statusCode: 429,
      path: '/activities/import',
    });
  });
});
