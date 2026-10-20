import { readFileSync } from 'node:fs';
import { BadRequestException } from '@nestjs/common';
import {
  buildFitFile,
  DEFAULT_SESSION,
  RUNNING_FIXTURE_PATH,
  type FitSessionInput,
} from '../../../test/fixtures/build-fit.js';
import {
  INVALID_FIT_MESSAGE,
  MISSING_TIMES_MESSAGE,
  NO_SESSION_MESSAGE,
  parseFitActivity,
} from './fit-activity-parser.js';

function expect400(buffer: Uint8Array, message: string): void {
  let caught: unknown;
  try {
    parseFitActivity(buffer);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(BadRequestException);
  expect((caught as BadRequestException).message).toBe(message);
}

const at = (iso: string) => new Date(iso);

describe('parseFitActivity', () => {
  it('extrai o resumo da sessão com os nomes e unidades do contrato', () => {
    const { data, fingerprint } = parseFitActivity(
      readFileSync(RUNNING_FIXTURE_PATH),
    );

    expect(data).toEqual({
      // 09:15 UTC em UTC-3 = 06:15 local.
      name: 'Corrida da manhã',
      sport: 'running',
      startedAt: at('2026-09-20T09:15:30.000Z'),
      elapsedTimeSeconds: 3125,
      movingTimeSeconds: 3010,
      distanceMeters: 10012.4,
      elevationGainMeters: 87,
      averageHeartRateBpm: 152,
      maxHeartRateBpm: 178,
      calories: 689,
    });
    expect(fingerprint).toBe(
      'fileid:development:1:1234567890:2026-09-20T09:15:30.000Z',
    );
  });

  it('o fixture commitado é o que o gerador produz', () => {
    expect(Buffer.from(buildFitFile())).toEqual(
      readFileSync(RUNNING_FIXTURE_PATH),
    );
  });

  it.each([
    ['running', 'running', 'Corrida'],
    ['cycling', 'cycling', 'Pedal'],
    ['eBiking', 'cycling', 'Pedal'],
    ['walking', 'walking', 'Caminhada'],
    ['hiking', 'hiking', 'Trilha'],
    ['swimming', 'swimming', 'Natação'],
    ['training', 'other', 'Atividade'],
    ['rowing', 'other', 'Atividade'],
    ['generic', 'other', 'Atividade'],
  ])('esporte FIT %s vira %s', (fitSport, sport, label) => {
    const { data } = parseFitActivity(
      buildFitFile({ sessions: [{ ...DEFAULT_SESSION, sport: fitSport }] }),
    );

    expect(data.sport).toBe(sport);
    expect(data.name).toBe(`${label} da manhã`);
  });

  it.each([
    ['03:00', 'Corrida da madrugada'],
    ['05:00', 'Corrida da manhã'],
    ['12:00', 'Corrida da tarde'],
    ['17:59', 'Corrida da tarde'],
    ['18:00', 'Corrida da noite'],
  ])('às %s locais o nome é "%s"', (localTime, name) => {
    // UTC-3: soma 3h para chegar ao instante UTC.
    const startTime = new Date(
      at(`2026-09-20T${localTime}:00.000Z`).getTime() + 3 * 3600_000,
    );

    const { data } = parseFitActivity(
      buildFitFile({ sessions: [{ ...DEFAULT_SESSION, startTime }] }),
    );

    expect(data.name).toBe(name);
  });

  it('sem fuso local no arquivo, o nome é só a modalidade', () => {
    const { data } = parseFitActivity(buildFitFile({ utcOffsetSeconds: null }));

    expect(data.name).toBe('Corrida');
  });

  it('métricas ausentes viram null; distância 0 também', () => {
    const session: FitSessionInput = {
      sport: 'training',
      startTime: DEFAULT_SESSION.startTime,
      totalElapsedTime: 1800,
      totalDistance: 0,
    };

    const { data } = parseFitActivity(buildFitFile({ sessions: [session] }));

    expect(data).toMatchObject({
      elapsedTimeSeconds: 1800,
      movingTimeSeconds: 1800,
      distanceMeters: null,
      elevationGainMeters: null,
      averageHeartRateBpm: null,
      maxHeartRateBpm: null,
      calories: null,
    });
  });

  it('arredonda segundos, FC e calorias para inteiros', () => {
    const { data } = parseFitActivity(
      buildFitFile({
        sessions: [
          {
            ...DEFAULT_SESSION,
            totalElapsedTime: 2326.963,
            totalTimerTime: 2300.5,
          },
        ],
      }),
    );

    expect(data.elapsedTimeSeconds).toBe(2327);
    expect(data.movingTimeSeconds).toBe(2301);
  });

  describe('multiesporte', () => {
    const start = at('2026-09-20T10:00:00.000Z');
    const plus = (seconds: number) =>
      new Date(start.getTime() + seconds * 1000);

    it('triatlo vira uma atividade other com as métricas somadas', () => {
      const sessions: FitSessionInput[] = [
        {
          sport: 'swimming',
          startTime: start,
          totalElapsedTime: 1800,
          totalDistance: 1500,
          avgHeartRate: 140,
          maxHeartRate: 160,
          totalCalories: 400,
        },
        { sport: 'transition', startTime: plus(1800), totalElapsedTime: 120 },
        {
          sport: 'cycling',
          startTime: plus(1920),
          totalElapsedTime: 3600,
          totalDistance: 40000,
          totalAscent: 300,
          avgHeartRate: 150,
          maxHeartRate: 175,
          totalCalories: 900,
        },
      ];

      const { data } = parseFitActivity(
        // Ordem embaralhada no arquivo: o início é o da sessão mais cedo.
        buildFitFile({ sessions: [sessions[2], sessions[0], sessions[1]] }),
      );

      expect(data).toMatchObject({
        sport: 'other',
        name: 'Atividade da manhã',
        startedAt: start,
        elapsedTimeSeconds: 5520,
        distanceMeters: 41500,
        elevationGainMeters: 300,
        // (140*1800 + 150*3600) / 5400 ≈ 146,7; a transição não tem FC.
        averageHeartRateBpm: 147,
        maxHeartRateBpm: 175,
        calories: 1300,
      });
    });

    it('sessões do mesmo esporte mantêm o esporte', () => {
      const { data } = parseFitActivity(
        buildFitFile({
          sessions: [
            { sport: 'running', startTime: start, totalElapsedTime: 600 },
            { sport: 'transition', startTime: plus(600), totalElapsedTime: 60 },
            { sport: 'running', startTime: plus(660), totalElapsedTime: 600 },
          ],
        }),
      );

      expect(data.sport).toBe('running');
      expect(data.elapsedTimeSeconds).toBe(1260);
    });
  });

  describe('fingerprint', () => {
    it('sem número de série, usa o SHA-256 do conteúdo', () => {
      const file = buildFitFile({ serialNumber: null });

      const first = parseFitActivity(file).fingerprint;
      const again = parseFitActivity(Uint8Array.from(file)).fingerprint;

      expect(first).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(again).toBe(first);
    });

    it('arquivos de treinos diferentes têm fingerprints diferentes', () => {
      const other = buildFitFile({ timeCreated: at('2026-09-21T09:00:00Z') });

      expect(parseFitActivity(other).fingerprint).not.toBe(
        parseFitActivity(buildFitFile()).fingerprint,
      );
    });
  });

  describe('arquivos recusados (400)', () => {
    it.each([
      ['vazio', new Uint8Array()],
      ['texto', new TextEncoder().encode('isto não é um arquivo FIT')],
      ['bytes aleatórios', Uint8Array.from({ length: 512 }, (_, i) => i % 251)],
      ['truncado', buildFitFile().slice(0, 100)],
    ])('%s: arquivo inválido', (_label, buffer) => {
      expect400(buffer, INVALID_FIT_MESSAGE);
    });

    it('um byte alterado quebra o CRC', () => {
      const file = buildFitFile();
      file[60] ^= 0xff;

      expect400(file, INVALID_FIT_MESSAGE);
    });

    it('arquivo FIT que não é de atividade (ex. percurso)', () => {
      expect400(
        buildFitFile({ fileType: 'course' }),
        'O arquivo .fit não é de uma atividade (tipo "course").',
      );
    });

    it('atividade sem sessão', () => {
      expect400(buildFitFile({ sessions: [] }), NO_SESSION_MESSAGE);
    });

    it('sessão sem duração', () => {
      expect400(
        buildFitFile({
          sessions: [
            {
              ...DEFAULT_SESSION,
              totalElapsedTime: null,
              totalTimerTime: undefined,
            },
          ],
        }),
        MISSING_TIMES_MESSAGE,
      );
    });
  });
});
