import type { ActivityFileStorageService } from '../../src/activities/storage/activity-file-storage.service.js';

type StoragePort = Pick<ActivityFileStorageService, 'put' | 'delete'>;

/**
 * MOCK do object storage nos e2e: substitui o ActivityFileStorageService (que
 * fala com o bucket S3-compatível da Oracle) por um Map em memória. Assim o CI
 * não precisa de credenciais nem de rede, e os testes conseguem simular falha
 * do provedor (`failPutWith` / `failDeleteWith`).
 *
 * O que NÃO é coberto por aqui: autenticação, path-style e checksums do SDK
 * contra o provedor real — isso é validado manualmente contra o bucket de dev.
 */
export class FakeActivityFileStorage implements StoragePort {
  readonly objects = new Map<string, Buffer>();
  /** Próximos `put` falham com este erro enquanto estiver definido. */
  failPutWith: Error | null = null;
  failDeleteWith: Error | null = null;

  put(key: string, body: Uint8Array): Promise<void> {
    if (this.failPutWith) return Promise.reject(this.failPutWith);
    this.objects.set(key, Buffer.from(body));
    return Promise.resolve();
  }

  delete(key: string): Promise<void> {
    if (this.failDeleteWith) return Promise.reject(this.failDeleteWith);
    this.objects.delete(key);
    return Promise.resolve();
  }

  reset(): void {
    this.objects.clear();
    this.failPutWith = null;
    this.failDeleteWith = null;
  }
}
