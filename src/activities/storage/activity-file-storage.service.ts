import {
  DeleteObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EnvironmentVariables } from '../../config/env.validation.js';

/** Content-Type registrado na IANA para arquivos FIT. */
export const FIT_CONTENT_TYPE = 'application/vnd.ant.fit';

/**
 * Guarda os arquivos .fit originais num bucket S3-compatível (hoje o Object
 * Storage da Oracle Cloud). O resto da aplicação só conhece `put`/`delete`:
 * trocar de provedor é trocar as variáveis OCI_S3_*, não o código.
 *
 * Nos e2e este provider é substituído por um fake em memória
 * (test/fakes/fake-activity-file-storage.ts).
 */
@Injectable()
export class ActivityFileStorageService implements OnModuleDestroy {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(config: ConfigService<EnvironmentVariables, true>) {
    this.bucket = config.get('OCI_S3_BUCKET', { infer: true });
    this.client = new S3Client({
      endpoint: config.get('OCI_S3_ENDPOINT', { infer: true }),
      region: config.get('OCI_S3_REGION', { infer: true }),
      credentials: {
        accessKeyId: config.get('OCI_S3_ACCESS_KEY', { infer: true }),
        secretAccessKey: config.get('OCI_S3_SECRET_KEY', { infer: true }),
      },
      // A API compatível da Oracle só aceita path-style
      // (`{endpoint}/{bucket}/{key}`), não o subdomínio por bucket da AWS.
      forcePathStyle: true,
      // Desde a v3.729 o SDK manda checksums CRC32 em toda request por padrão,
      // o que provedores S3-compatíveis nem sempre aceitam. Só quando a
      // operação exige.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
  }

  /** Chave do objeto: agrupa por usuário e usa o id da atividade como nome. */
  static keyFor(userId: string, activityId: string): string {
    return `activities/${userId}/${activityId}.fit`;
  }

  async put(key: string, body: Uint8Array): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: FIT_CONTENT_TYPE,
      }),
    );
  }

  async delete(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
    );
  }

  onModuleDestroy(): void {
    this.client.destroy();
  }
}
