import { TokenService } from '../src/auth/token.service.js';
import { CLIENT_TYPES, createClient, type TestClient } from './utils/client.js';
import { createTestApp, type TestApp } from './utils/create-app.js';
import { createAppWithEnv } from './utils/create-app-with-env.js';

/**
 * Famílias de refresh token, janela de tolerância (A-04) e rotação
 * transacional (A-17), contra o Postgres real.
 *
 * O .env.test usa a janela padrão (30 s). O fim da janela é simulado recuando
 * o `rotatedAt` da linha no banco, o mesmo estado que o relógio produziria,
 * sem esperar nem falsificar o relógio do processo (o driver do Postgres e o
 * supertest dependem de timers reais).
 */

const credentials = {
  email: 'ana@example.com',
  password: 'S3nh@Forte!',
  name: 'Ana',
};
const loginBody = { email: credentials.email, password: credentials.password };
const GRACE_SECONDS = 30;

function helpers(t: TestApp) {
  const rowOf = (token: string) =>
    t.prisma.refreshToken.findUnique({
      where: { tokenHash: TokenService.hashToken(token) },
    });
  return {
    rowOf,
    familyOf: async (token: string) => (await rowOf(token))!.familyId,
    familyCount: (familyId: string) =>
      t.prisma.refreshToken.count({ where: { familyId } }),
    /** Leva o token para fora da janela de tolerância. */
    expireGrace: (token: string) =>
      t.prisma.refreshToken.update({
        where: { tokenHash: TokenService.hashToken(token) },
        data: { rotatedAt: new Date(Date.now() - (GRACE_SECONDS + 1) * 1000) },
      }),
  };
}

describe.each(CLIENT_TYPES)(
  'Famílias de refresh token e janela de tolerância: %s (e2e)',
  (clientType) => {
    let t: TestApp;
    let c: TestClient;
    let h: ReturnType<typeof helpers>;

    beforeAll(async () => {
      t = await createTestApp();
      h = helpers(t);
    });

    beforeEach(async () => {
      await t.resetDb();
      c = createClient(t.app, clientType);
    });

    afterAll(async () => {
      await t.close();
    });

    /** Signup neste cliente; devolve o primeiro refresh token (R0). */
    async function signup(): Promise<string> {
      const res = await c.post('/auth/signup').send(credentials).expect(201);
      return c.refreshTokenOf(res)!;
    }

    /** Login num "outro dispositivo": outra família do mesmo usuário. */
    async function otherDevice(): Promise<{
      client: TestClient;
      token: string;
    }> {
      const client = createClient(t.app, clientType);
      const res = await client.post('/auth/login').send(loginBody).expect(200);
      return { client, token: client.refreshTokenOf(res)! };
    }

    const refresh = (token: string) => c.refreshWith(token);
    const tokenOf = (res: Awaited<ReturnType<typeof refresh>>) =>
      c.refreshTokenOf(res)!;

    it('resposta perdida: o retry com R0 dentro da janela devolve um par válido e o cliente segue logado', async () => {
      const r0 = await signup();
      const familyId = await h.familyOf(r0);

      // A resposta desta rotação "se perde": o cliente nunca vê o R1.
      const lost = await refresh(r0).expect(200);
      const r1 = tokenOf(lost);

      const retry = await refresh(r0).expect(200);
      c.expectTokenChannel(retry);
      const sibling = tokenOf(retry);
      expect(sibling).not.toBe(r0);
      expect(sibling).not.toBe(r1);

      // O par novo funciona: access no /me e refresh rotacionando.
      await c
        .get('/me')
        .set('Authorization', `Bearer ${retry.body.accessToken}`)
        .expect(200);
      await refresh(sibling).expect(200);

      // Irmão na mesma família; o sucessor original não foi tocado.
      expect(await h.rowOf(sibling)).toMatchObject({ familyId });
      expect(await h.rowOf(r1)).toMatchObject({
        familyId,
        revokedAt: null,
        rotatedAt: null,
      });
      expect(await h.rowOf(r0)).toMatchObject({
        graceUsedAt: expect.any(Date),
        successorId: (await h.rowOf(r1))!.id,
      });
    });

    it('duas requests concorrentes com o mesmo R0: as duas funcionam e cada par rotaciona depois', async () => {
      const r0 = await signup();
      const familyId = await h.familyOf(r0);

      const [a, b] = await Promise.all([refresh(r0), refresh(r0)]);
      expect(a.status).toBe(200);
      expect(b.status).toBe(200);
      const [ta, tb] = [tokenOf(a), tokenOf(b)];
      expect(ta).not.toBe(tb);

      // Um CAS ganhou a rotação (sucessor) e o outro usou a tolerância
      // (irmão): R0 aponta para um sucessor só e gastou a janela.
      const row0 = await h.rowOf(r0);
      expect(row0).toMatchObject({
        rotatedAt: expect.any(Date),
        graceUsedAt: expect.any(Date),
      });
      expect([ta, tb].map((tk) => TokenService.hashToken(tk))).toContain(
        (await t.prisma.refreshToken.findUnique({
          where: { id: row0!.successorId! },
        }))!.tokenHash,
      );
      expect(await h.familyCount(familyId)).toBe(3);

      // Nenhuma das duas sessões (abas) foi derrubada.
      await refresh(ta).expect(200);
      await refresh(tb).expect(200);
    });

    it('corrida real: as duas leem R0 ativo antes de qualquer CAS; a perdedora recarrega e usa a tolerância', async () => {
      const r0 = await signup();
      const familyId = await h.familyOf(r0);
      // Barreira: as duas primeiras assinaturas (feitas depois de carregar a
      // linha e antes da transação) esperam uma pela outra. Assim as duas
      // requests chegam ao CAS com R0 lido como ativo, e uma delas perde.
      const tokens = t.app.get(TokenService) as unknown as {
        signTokenPair: (...args: unknown[]) => Promise<unknown>;
      };
      const original = tokens.signTokenPair.bind(tokens);
      let arrived = 0;
      let release!: () => void;
      const bothLoaded = new Promise<void>((resolve) => (release = resolve));
      const spy = vi
        .spyOn(tokens, 'signTokenPair')
        .mockImplementation(async (...args: unknown[]) => {
          arrived += 1;
          if (arrived <= 2) {
            if (arrived === 2) release();
            await bothLoaded;
          }
          return original(...args);
        });

      const [a, b] = await Promise.all([refresh(r0), refresh(r0)]).finally(() =>
        spy.mockRestore(),
      );
      expect([a.status, b.status]).toEqual([200, 200]);
      // 2 assinaturas na barreira + 1 do par de tolerância da perdedora.
      expect(arrived).toBe(3);
      expect(await h.rowOf(r0)).toMatchObject({
        graceUsedAt: expect.any(Date),
      });
      expect(await h.familyCount(familyId)).toBe(3);

      await refresh(tokenOf(a)).expect(200);
      await refresh(tokenOf(b)).expect(200);
    });

    it('terceiro uso do mesmo R0 dentro da janela (tolerância já usada) é reuso e apaga a família', async () => {
      const r0 = await signup();
      const familyId = await h.familyOf(r0);
      const r1 = tokenOf(await refresh(r0).expect(200));
      const sibling = tokenOf(await refresh(r0).expect(200));

      const third = await refresh(r0).expect(401);
      expect(third.body.message).toBe('Invalid refresh token');

      expect(await h.familyCount(familyId)).toBe(0);
      await refresh(r1).expect(401);
      await refresh(sibling).expect(401);
    });

    it('retry fora da janela apaga só a família; outra família do mesmo usuário continua válida', async () => {
      const r0 = await signup();
      const familyId = await h.familyOf(r0);
      const other = await otherDevice();
      const otherFamily = await h.familyOf(other.token);
      expect(otherFamily).not.toBe(familyId);

      const r1 = tokenOf(await refresh(r0).expect(200));
      await h.expireGrace(r0);

      const late = await refresh(r0).expect(401);
      expect(late.body.message).toBe('Invalid refresh token');

      expect(await h.familyCount(familyId)).toBe(0);
      await refresh(r1).expect(401);
      // O outro dispositivo não percebe nada.
      expect(await h.familyCount(otherFamily)).toBe(1);
      await other.client.refreshWith(other.token).expect(200);
    });

    it('reuso real (R0 depois que o sucessor já rotacionou de novo) apaga a família, mesmo dentro da janela', async () => {
      const r0 = await signup();
      const familyId = await h.familyOf(r0);
      const other = await otherDevice();
      const r1 = tokenOf(await refresh(r0).expect(200));
      const r2 = tokenOf(await refresh(r1).expect(200));

      await refresh(r0).expect(401);

      expect(await h.familyCount(familyId)).toBe(0);
      await refresh(r2).expect(401);
      await other.client.refreshWith(other.token).expect(200);
    });

    it('sucessor apagado por logout: reapresentar R0 dá 401 simples e não afeta nada', async () => {
      const r0 = await signup();
      const familyId = await h.familyOf(r0);
      const other = await otherDevice();
      const r1 = tokenOf(await refresh(r0).expect(200));
      await c.logoutWith(r1).expect(204);
      const before = await h.rowOf(r0);

      // Dentro da janela, e de novo fora dela: a sessão já tinha acabado.
      const res = await refresh(r0).expect(401);
      expect(res.body.message).toBe('Invalid refresh token');
      await h.expireGrace(r0);
      await refresh(r0).expect(401);

      // Sem efeito colateral: R0 continua lá, sem usar a tolerância.
      expect(await h.familyCount(familyId)).toBe(1);
      expect(await h.rowOf(r0)).toMatchObject({
        id: before!.id,
        graceUsedAt: null,
      });
      await other.client.refreshWith(other.token).expect(200);
    });

    it('A-17: se o INSERT do sucessor falhar, o CAS é desfeito e R0 continua ativo', async () => {
      const r0 = await signup();
      const tokens = t.app.get(TokenService);
      // O "sucessor" assinado colide com o hash do próprio R0: o INSERT viola
      // o índice único dentro da transação.
      const spy = vi
        .spyOn(
          tokens as unknown as { signTokenPair: () => Promise<unknown> },
          'signTokenPair',
        )
        .mockResolvedValueOnce({
          accessToken: 'x',
          refreshToken: r0,
          refreshTokenExpiresAt: new Date(Date.now() + 60_000),
        });

      // O filtro global traduz a violação de unicidade (P2002) em 409; o que
      // importa aqui é o estado do banco depois da falha.
      await refresh(r0).expect(409);
      spy.mockRestore();

      expect(await h.rowOf(r0)).toMatchObject({
        revokedAt: null,
        rotatedAt: null,
        successorId: null,
      });
      // Nada de reuso no retry: rotaciona normalmente.
      const ok = await refresh(r0).expect(200);
      await refresh(tokenOf(ok)).expect(200);
    });
  },
);

describe('REFRESH_GRACE_SECONDS=0 desativa a tolerância (e2e)', () => {
  let t: TestApp;
  let h: ReturnType<typeof helpers>;

  beforeAll(async () => {
    t = await createAppWithEnv({ REFRESH_GRACE_SECONDS: '0' });
    h = helpers(t);
  });

  beforeEach(() => t.resetDb());

  afterAll(async () => {
    await t.close();
    vi.unstubAllEnvs();
  });

  it('o retry imediato com R0 já é reuso: apaga a família, e só ela', async () => {
    const c = createClient(t.app, 'mobile');
    const signup = await c.post('/auth/signup').send(credentials).expect(201);
    const r0 = c.refreshTokenOf(signup)!;
    const familyId = await h.familyOf(r0);
    const other = createClient(t.app, 'mobile');
    const otherLogin = await other
      .post('/auth/login')
      .send(loginBody)
      .expect(200);

    const r1 = c.refreshTokenOf(await c.refreshWith(r0).expect(200))!;
    await c.refreshWith(r0).expect(401);

    expect(await h.familyCount(familyId)).toBe(0);
    await c.refreshWith(r1).expect(401);
    await other.refreshWith(other.refreshTokenOf(otherLogin)!).expect(200);
  });
});
