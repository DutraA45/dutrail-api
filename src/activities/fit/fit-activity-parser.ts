import { createHash } from 'node:crypto';
import { BadRequestException } from '@nestjs/common';
import {
  Decoder,
  Stream,
  type ActivityMesg,
  type FileIdMesg,
  type FitMessages,
  type SessionMesg,
} from '@garmin/fitsdk';
import { ActivitySport } from '../../generated/prisma/client.js';

// As mensagens de 400 vão direto para a tela do usuário (o frontend exibe a
// `message` de um 400 sem traduzir), por isso estão em português.
export const INVALID_FIT_MESSAGE = 'Arquivo .fit inválido ou corrompido.';
export const NO_SESSION_MESSAGE =
  'O arquivo .fit não contém o resumo da atividade (sessão).';
export const MISSING_TIMES_MESSAGE =
  'O arquivo .fit não informa o início ou a duração da atividade.';

/** Campos de `Activity` extraídos do arquivo (sem dono, id e storage). */
export interface FitActivityData {
  name: string;
  sport: ActivitySport;
  startedAt: Date;
  elapsedTimeSeconds: number;
  movingTimeSeconds: number | null;
  distanceMeters: number | null;
  elevationGainMeters: number | null;
  averageHeartRateBpm: number | null;
  maxHeartRateBpm: number | null;
  calories: number | null;
}

export interface ParsedFitActivity {
  data: FitActivityData;
  /** Identidade do arquivo, para detectar reimportação. */
  fingerprint: string;
}

/** 1989-12-31T00:00:00Z, o "zero" dos timestamps FIT, em segundos Unix. */
const FIT_EPOCH_UNIX_SECONDS = 631_065_600;
const MAX_UTC_OFFSET_SECONDS = 14 * 3600;

/**
 * Esportes FIT (já convertidos em string pelo SDK) com equivalente no Dutrail.
 * O `subSport` não entra: trilha, esteira e rolo continuam sendo corrida/pedal.
 * O resto vira `other`, como prevê o enum.
 */
const SPORT_MAP: Readonly<Record<string, ActivitySport>> = {
  running: ActivitySport.running,
  cycling: ActivitySport.cycling,
  eBiking: ActivitySport.cycling,
  walking: ActivitySport.walking,
  hiking: ActivitySport.hiking,
  swimming: ActivitySport.swimming,
};

const SPORT_LABEL: Readonly<Record<ActivitySport, string>> = {
  running: 'Corrida',
  cycling: 'Pedal',
  walking: 'Caminhada',
  hiking: 'Trilha',
  swimming: 'Natação',
  other: 'Atividade',
};

/**
 * Lê um arquivo FIT de atividade e extrai o resumo que vira uma `Activity`.
 *
 * Usa as mensagens de sessão (o resumo que o próprio aparelho calcula), não
 * os pontos (`record`). Qualquer problema no arquivo vira 400; esta função
 * não deixa escapar erro que resulte em 500.
 */
export function parseFitActivity(buffer: Uint8Array): ParsedFitActivity {
  const messages = decode(buffer);

  const fileId = messages.fileIdMesgs?.[0];
  // O tipo declarado no SDK é numérico, mas com `convertTypesToStrings`
  // (padrão) o valor chega como string.
  const fileType = fileId?.type as unknown;
  if (fileId === undefined || fileType !== 'activity') {
    throw new BadRequestException(
      typeof fileType === 'string' || typeof fileType === 'number'
        ? `O arquivo .fit não é de uma atividade (tipo "${fileType}").`
        : INVALID_FIT_MESSAGE,
    );
  }

  const sessions = [...(messages.sessionMesgs ?? [])].sort(
    (a, b) =>
      (asDate(a.startTime)?.getTime() ?? 0) -
      (asDate(b.startTime)?.getTime() ?? 0),
  );
  if (sessions.length === 0) {
    throw new BadRequestException(NO_SESSION_MESSAGE);
  }

  const summary = summarize(sessions, fileId);
  const name = activityName(
    summary.sport,
    summary.startedAt,
    messages.activityMesgs?.[0],
  );

  return {
    data: { name, ...summary },
    fingerprint: fingerprintOf(fileId, buffer),
  };
}

function decode(buffer: Uint8Array): FitMessages {
  try {
    const decoder = new Decoder(Stream.fromBuffer(buffer));
    // checkIntegrity também valida o CRC: pega arquivos truncados (upload
    // interrompido) e bytes alterados, não só o cabeçalho.
    if (!decoder.isFIT() || !decoder.checkIntegrity()) {
      throw new Error('header or CRC check failed');
    }
    const { messages, errors } = decoder.read();
    if (errors.length > 0) {
      throw errors[0];
    }
    return messages;
  } catch {
    // O SDK pode lançar ou acumular erros; para o cliente é o mesmo problema.
    throw new BadRequestException(INVALID_FIT_MESSAGE);
  }
}

/**
 * Uma sessão na grande maioria dos arquivos. Multiesporte (triatlo, duatlo)
 * traz uma sessão por modalidade, mais as transições: vira UMA atividade com
 * as métricas somadas e `sport` = `other` quando as modalidades diferem.
 */
function summarize(
  sessions: SessionMesg[],
  fileId: FileIdMesg,
): Omit<FitActivityData, 'name'> {
  const startedAt = asDate(sessions[0].startTime) ?? asDate(fileId.timeCreated);
  const elapsed = sumOrNull(
    sessions.map((s) => s.totalElapsedTime ?? s.totalTimerTime),
  );
  if (startedAt === null || elapsed === null) {
    throw new BadRequestException(MISSING_TIMES_MESSAGE);
  }

  const sports = new Set(
    sessions
      .map((s) => String(s.sport))
      .filter((s) => s !== 'transition')
      .map((s) => SPORT_MAP[s] ?? ActivitySport.other),
  );
  const [onlySport] = sports;
  const sport = sports.size === 1 ? onlySport : ActivitySport.other;

  // Distância 0 é o que aparelhos gravam em atividades sem distância (ex.
  // musculação): para o contrato isso é "sem dado".
  const distance = sumOrNull(sessions.map((s) => s.totalDistance));

  return {
    sport,
    startedAt,
    elapsedTimeSeconds: Math.round(elapsed),
    // Sem `totalMovingTime`, o tempo de cronômetro (que já exclui pausas
    // manuais e automáticas) é o melhor substituto.
    movingTimeSeconds: roundOrNull(
      sumOrNull(sessions.map((s) => s.totalMovingTime ?? s.totalTimerTime)),
    ),
    distanceMeters: distance === 0 ? null : distance,
    elevationGainMeters: sumOrNull(sessions.map((s) => s.totalAscent)),
    averageHeartRateBpm: roundOrNull(weightedAverageHeartRate(sessions)),
    maxHeartRateBpm: maxOrNull(sessions.map((s) => s.maxHeartRate)),
    calories: roundOrNull(sumOrNull(sessions.map((s) => s.totalCalories))),
  };
}

/** Média das sessões ponderada pelo tempo de cada uma. */
function weightedAverageHeartRate(sessions: SessionMesg[]): number | null {
  let weighted = 0;
  let total = 0;
  for (const s of sessions) {
    const time = s.totalTimerTime ?? s.totalElapsedTime;
    if (isNumber(s.avgHeartRate) && isNumber(time) && time > 0) {
      weighted += s.avgHeartRate * time;
      total += time;
    }
  }
  if (total > 0) return weighted / total;
  // Sem tempo para ponderar: só faz sentido com uma sessão.
  return sessions.length === 1 && isNumber(sessions[0].avgHeartRate)
    ? sessions[0].avgHeartRate
    : null;
}

/**
 * "Corrida da manhã", no horário local de onde a atividade aconteceu. O FIT
 * traz esse horário em `activity.localTimestamp`; sem ele não há como saber o
 * fuso, e o nome fica só com a modalidade.
 */
function activityName(
  sport: ActivitySport,
  startedAt: Date,
  activity: ActivityMesg | undefined,
): string {
  const label = SPORT_LABEL[sport];
  const offset = utcOffsetSeconds(activity);
  if (offset === null) return label;

  const hour = new Date(startedAt.getTime() + offset * 1000).getUTCHours();
  if (hour < 5) return `${label} da madrugada`;
  if (hour < 12) return `${label} da manhã`;
  if (hour < 18) return `${label} da tarde`;
  return `${label} da noite`;
}

function utcOffsetSeconds(activity: ActivityMesg | undefined): number | null {
  const utc = asDate(activity?.timestamp);
  const local = activity?.localTimestamp as unknown;
  if (utc === null || !isNumber(local)) return null;

  const offset = local + FIT_EPOCH_UNIX_SECONDS - utc.getTime() / 1000;
  return Math.abs(offset) <= MAX_UTC_OFFSET_SECONDS ? offset : null;
}

/**
 * O `file_id` é a identidade que o protocolo FIT define para um arquivo
 * (fabricante + produto + número de série + instante de criação): o mesmo
 * treino exportado duas vezes tem o mesmo `file_id`, mesmo que os bytes
 * mudem. Quando o aparelho não preenche série ou data, cai no SHA-256 do
 * conteúdo, que ainda pega o reenvio do mesmo arquivo.
 */
function fingerprintOf(fileId: FileIdMesg, buffer: Uint8Array): string {
  const createdAt = asDate(fileId.timeCreated);
  if (isNumber(fileId.serialNumber) && createdAt !== null) {
    return [
      'fileid',
      String(fileId.manufacturer),
      String(fileId.product),
      String(fileId.serialNumber),
      createdAt.toISOString(),
    ].join(':');
  }
  return `sha256:${createHash('sha256').update(buffer).digest('hex')}`;
}

function asDate(value: unknown): Date | null {
  return value instanceof Date && !Number.isNaN(value.getTime()) ? value : null;
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Soma dos valores presentes; `null` se nenhum estiver presente. */
function sumOrNull(values: unknown[]): number | null {
  const present = values.filter(isNumber);
  return present.length === 0 ? null : present.reduce((a, b) => a + b, 0);
}

function maxOrNull(values: unknown[]): number | null {
  const present = values.filter(isNumber);
  return present.length === 0 ? null : Math.max(...present);
}

function roundOrNull(value: number | null): number | null {
  return value === null ? null : Math.round(value);
}
