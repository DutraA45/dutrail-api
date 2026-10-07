import { readFileSync } from 'node:fs';
import { ConflictException, Logger, NotFoundException } from '@nestjs/common';
import { RUNNING_FIXTURE_PATH } from '../../test/fixtures/build-fit.js';
import { Prisma } from '../generated/prisma/client.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import {
  ActivitiesService,
  DUPLICATE_IMPORT_MESSAGE,
  USER_NOT_FOUND_MESSAGE,
} from './activities.service.js';
import type { ActivityFileStorageService } from './storage/activity-file-storage.service.js';

const USER_ID = 'c7a3d2f4-8b1e-4c7a-9f3d-2e1b5a6c8d9e';

function prismaError(code: string): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('falha no INSERT', {
    code,
    clientVersion: 'test',
  });
}

/**
 * Só o tratamento de falha do INSERT na importação: o caminho feliz e a
 * integração com o banco real ficam nos e2e (test/activities.e2e-spec.ts).
 */
describe('ActivitiesService.importFitFile (falha no INSERT)', () => {
  const fixture = readFileSync(RUNNING_FIXTURE_PATH);
  let create: ReturnType<typeof vi.fn>;
  let storage: {
    put: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
  };
  let service: ActivitiesService;

  beforeEach(() => {
    create = vi.fn();
    storage = { put: vi.fn(), delete: vi.fn() };
    const prisma = {
      activity: { findFirst: vi.fn().mockResolvedValue(null), create },
    };
    service = new ActivitiesService(
      prisma as unknown as PrismaService,
      storage as unknown as ActivityFileStorageService,
    );
  });

  /** A chave enviada no `put` tem de ser a mesma apagada na compensação. */
  function expectUploadUndone(): void {
    expect(storage.put).toHaveBeenCalledOnce();
    const [key] = storage.put.mock.calls[0] as [string];
    expect(key).toMatch(new RegExp(`^activities/${USER_ID}/[0-9a-f-]+\\.fit$`));
    expect(storage.delete).toHaveBeenCalledExactlyOnceWith(key);
  }

  it('P2003 (usuário do token apagado): 404 User not found e apaga o arquivo enviado', async () => {
    create.mockRejectedValue(prismaError('P2003'));

    const result = service.importFitFile(USER_ID, fixture);

    await expect(result).rejects.toThrow(NotFoundException);
    await expect(result).rejects.toThrow(USER_NOT_FOUND_MESSAGE);
    expectUploadUndone();
  });

  it('P2002 (importação simultânea): 409 e apaga o arquivo enviado', async () => {
    create.mockRejectedValue(prismaError('P2002'));

    const result = service.importFitFile(USER_ID, fixture);

    await expect(result).rejects.toThrow(ConflictException);
    await expect(result).rejects.toThrow(DUPLICATE_IMPORT_MESSAGE);
    expectUploadUndone();
  });

  it.each([
    ['outro erro conhecido do Prisma', prismaError('P2000')],
    ['erro qualquer', new Error('connection lost')],
  ])(
    '%s: propaga o erro original (500 no filtro) e apaga o arquivo',
    async (_, error) => {
      create.mockRejectedValue(error);

      await expect(service.importFitFile(USER_ID, fixture)).rejects.toBe(error);
      expectUploadUndone();
    },
  );

  it('se a remoção do arquivo também falha, a resposta continua sendo a do INSERT e a chave vai para o log', async () => {
    const logError = vi
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    create.mockRejectedValue(prismaError('P2003'));
    storage.delete.mockRejectedValue(new Error('storage fora do ar'));

    await expect(service.importFitFile(USER_ID, fixture)).rejects.toThrow(
      NotFoundException,
    );
    expectUploadUndone();
    const [key] = storage.put.mock.calls[0] as [string];
    expect(logError).toHaveBeenCalledWith(
      expect.stringContaining(`key=${key}`),
      expect.any(String),
    );
    logError.mockRestore();
  });
});
