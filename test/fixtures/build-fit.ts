import { writeFileSync } from 'node:fs';
import { Encoder, Profile, type Mesg } from '@garmin/fitsdk';

/**
 * Monta arquivos .fit sintéticos com o Encoder oficial da Garmin, para os
 * testes não dependerem de arquivos reais (que trazem o trajeto GPS de quem
 * gravou). Sem posição nos `record`: só tempo, distância e FC.
 *
 * Rodado direto pelo Node, regenera o fixture commitado:
 *   node test/fixtures/build-fit.ts
 */

export interface FitSessionInput {
  /** Nome do esporte no perfil FIT: 'running', 'cycling', 'transition'... */
  sport: string;
  startTime: Date;
  /** `null` omite a duração (tempo total e de cronômetro). */
  totalElapsedTime: number | null;
  totalTimerTime?: number;
  totalDistance?: number;
  totalAscent?: number;
  avgHeartRate?: number;
  maxHeartRate?: number;
  totalCalories?: number;
}

export interface FitFileInput {
  /** `file_id.type`. Padrão: 'activity'. */
  fileType?: string;
  /** `null` omite o campo (vários apps não preenchem). */
  serialNumber?: number | null;
  timeCreated?: Date;
  sessions?: FitSessionInput[];
  /** Fuso local em segundos (ex. -10800 = UTC-3). `null` omite. */
  utcOffsetSeconds?: number | null;
}

/** 1989-12-31T00:00:00Z em segundos Unix: o "zero" dos timestamps FIT. */
const FIT_EPOCH_UNIX_SECONDS = 631_065_600;

export const DEFAULT_SESSION: FitSessionInput = {
  sport: 'running',
  startTime: new Date('2026-09-20T09:15:30.000Z'),
  totalElapsedTime: 3125,
  totalTimerTime: 3010,
  totalDistance: 10012.4,
  totalAscent: 87,
  avgHeartRate: 152,
  maxHeartRate: 178,
  totalCalories: 689,
};

export function buildFitFile(input: FitFileInput = {}): Uint8Array {
  const sessions = input.sessions ?? [DEFAULT_SESSION];
  const first = sessions[0] ?? DEFAULT_SESSION;
  const serialNumber =
    input.serialNumber === undefined ? 1234567890 : input.serialNumber;
  const utcOffset =
    input.utcOffsetSeconds === undefined ? -3 * 3600 : input.utcOffsetSeconds;

  const encoder = new Encoder();
  // Os tipos do SDK declaram os enums como número e não listam os campos de
  // cada mensagem em `Mesg`; o Encoder aceita os mesmos nomes em string que o
  // Decoder devolve ('activity', 'running'...).
  const write = (mesgNum: number, fields: Record<string, unknown>) =>
    encoder.onMesg(mesgNum, fields as Mesg);

  write(Profile.MesgNum.FILE_ID, {
    type: input.fileType ?? 'activity',
    manufacturer: 'development',
    product: 1,
    timeCreated: input.timeCreated ?? first.startTime,
    ...(serialNumber !== null && { serialNumber }),
  });

  let end = first.startTime;
  sessions.forEach((session, index) => {
    end = new Date(
      session.startTime.getTime() + (session.totalElapsedTime ?? 0) * 1000,
    );
    // Dois pontos (início e fim) bastam: a API usa o resumo da sessão.
    for (const [timestamp, share] of [
      [session.startTime, 0],
      [end, 1],
    ] as const) {
      write(Profile.MesgNum.RECORD, {
        timestamp,
        ...(session.totalDistance !== undefined && {
          distance: session.totalDistance * share,
        }),
        ...(session.avgHeartRate !== undefined && {
          heartRate: session.avgHeartRate,
        }),
      });
    }
    const summary = {
      messageIndex: index,
      timestamp: end,
      startTime: session.startTime,
      sport: session.sport,
      totalElapsedTime: session.totalElapsedTime ?? undefined,
      totalTimerTime:
        session.totalTimerTime ?? session.totalElapsedTime ?? undefined,
      totalDistance: session.totalDistance,
      totalAscent: session.totalAscent,
      avgHeartRate: session.avgHeartRate,
      maxHeartRate: session.maxHeartRate,
      totalCalories: session.totalCalories,
    };
    write(Profile.MesgNum.LAP, summary);
    write(Profile.MesgNum.SESSION, {
      ...summary,
      firstLapIndex: index,
      numLaps: 1,
    });
  });

  write(Profile.MesgNum.ACTIVITY, {
    timestamp: end,
    numSessions: sessions.length,
    type: 'manual',
    ...(utcOffset !== null && {
      localTimestamp:
        Math.round(end.getTime() / 1000) - FIT_EPOCH_UNIX_SECONDS + utcOffset,
    }),
  });

  return encoder.close();
}

export const RUNNING_FIXTURE_PATH = new URL('./running.fit', import.meta.url)
  .pathname;

if (import.meta.main) {
  writeFileSync(RUNNING_FIXTURE_PATH, buildFitFile());
  console.log(`Gerado ${RUNNING_FIXTURE_PATH}`);
}
