import { BadRequestException } from '@nestjs/common';
import {
  decodeActivityCursor,
  encodeActivityCursor,
} from './activity-cursor.js';

describe('activity cursor', () => {
  it('ida e volta preserva a posição', () => {
    const cursor = {
      startedAt: new Date('2026-09-20T07:15:30.123Z'),
      id: 'c7a3d2f4-8b1e-4c7a-9f3d-2e1b5a6c8d9e',
    };

    const raw = encodeActivityCursor(cursor);

    expect(raw).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeActivityCursor(raw)).toEqual(cursor);
  });

  it.each([
    ['lixo', 'not-a-cursor'],
    ['JSON que não é array', Buffer.from('{"a":1}').toString('base64url')],
    ['data inválida', Buffer.from('["ontem","x"]').toString('base64url')],
    [
      'id vazio',
      Buffer.from('["2026-09-20T07:15:30Z",""]').toString('base64url'),
    ],
    [
      'id não-string',
      Buffer.from('["2026-09-20T07:15:30Z",1]').toString('base64url'),
    ],
  ])('rejeita %s com 400', (_label, raw) => {
    expect(() => decodeActivityCursor(raw)).toThrow(BadRequestException);
  });
});
