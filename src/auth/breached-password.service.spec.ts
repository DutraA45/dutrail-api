import { createHash } from 'node:crypto';
import {
  BreachedPasswordService,
  PWNED_PASSWORDS_RANGE_URL,
} from './breached-password.service.js';

const sha1 = (s: string) =>
  createHash('sha1').update(s, 'utf8').digest('hex').toUpperCase();

// "é" pré-composto (U+00E9) e "e" + acento agudo combinante (U+0301).
const COMPOSED = 'café-S3nh@';
const DECOMPOSED = 'café-S3nh@';

function serviceWith(
  overrides: Partial<{
    BREACHED_PASSWORD_CHECK: boolean;
    BREACHED_PASSWORD_TIMEOUT_MS: number;
  }> = {},
) {
  const env = {
    BREACHED_PASSWORD_CHECK: true,
    BREACHED_PASSWORD_TIMEOUT_MS: 2000,
    ...overrides,
  };
  return new BreachedPasswordService({
    get: (key: keyof typeof env) => env[key],
  } as never);
}

/** Resposta no formato da range API: `SUFIXO:CONTAGEM` por linha, com CRLF. */
function rangeBody(entries: [suffix: string, count: number][]): string {
  return entries.map(([s, c]) => `${s}:${c}`).join('\r\n');
}

describe('BreachedPasswordService', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('envia só o prefixo de 5 caracteres do SHA-1, com padding, e acha o sufixo', async () => {
    const hash = sha1('password123');
    fetchMock.mockResolvedValue(
      new Response(
        rangeBody([
          ['0018A45C4D1DEF81644B54AB7F969B88D65', 1],
          [hash.slice(5), 2_000_000],
        ]),
      ),
    );

    await expect(serviceWith().check('password123')).resolves.toBe('breached');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${PWNED_PASSWORDS_RANGE_URL}${hash.slice(0, 5)}`);
    expect(init.headers).toMatchObject({ 'Add-Padding': 'true' });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    // Nem a senha nem o resto do hash saem daqui.
    const sent = JSON.stringify(fetchMock.mock.calls);
    expect(sent).not.toContain('password123');
    expect(sent).not.toContain(hash.slice(5));
  });

  it('senha ausente da lista: clean', async () => {
    fetchMock.mockResolvedValue(
      new Response(rangeBody([['0018A45C4D1DEF81644B54AB7F969B88D65', 3]])),
    );
    await expect(serviceWith().check('S3nh@Forte!')).resolves.toBe('clean');
  });

  it('linha de padding (contagem 0) com o mesmo sufixo não conta como vazada', async () => {
    const hash = sha1('S3nh@Forte!');
    fetchMock.mockResolvedValue(new Response(rangeBody([[hash.slice(5), 0]])));
    await expect(serviceWith().check('S3nh@Forte!')).resolves.toBe('clean');
  });

  it('consulta a forma NFKC: composta e decomposta dão a mesma consulta', async () => {
    const hash = sha1(COMPOSED);
    fetchMock.mockImplementation(() =>
      Promise.resolve(new Response(rangeBody([[hash.slice(5), 5]]))),
    );

    await expect(serviceWith().check(DECOMPOSED)).resolves.toBe('breached');
    await expect(serviceWith().check(COMPOSED)).resolves.toBe('breached');
    expect(fetchMock.mock.calls[0][0]).toBe(fetchMock.mock.calls[1][0]);
  });

  it.each([
    ['HTTP 503', () => Promise.resolve(new Response('', { status: 503 }))],
    ['falha de rede', () => Promise.reject(new TypeError('fetch failed'))],
  ])('%s: error, sem lançar', async (_label, impl) => {
    fetchMock.mockImplementation(impl);
    await expect(serviceWith().check('S3nh@Forte!')).resolves.toBe('error');
  });

  it('sem resposta no prazo: timeout, sem lançar', async () => {
    // Só termina quando o sinal aborta, como um servidor que não responde.
    fetchMock.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal!.addEventListener('abort', () =>
            reject(init.signal!.reason),
          );
        }),
    );

    const started = Date.now();
    await expect(
      serviceWith({ BREACHED_PASSWORD_TIMEOUT_MS: 100 }).check('S3nh@Forte!'),
    ).resolves.toBe('timeout');
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('desligada: não vai à rede', async () => {
    await expect(
      serviceWith({ BREACHED_PASSWORD_CHECK: false }).check('password123'),
    ).resolves.toBe('disabled');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
