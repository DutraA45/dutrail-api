import { BadRequestException } from '@nestjs/common';
import {
  CLIENT_TYPE_HEADER,
  parseClientType,
} from './client-type.decorator.js';

describe('parseClientType', () => {
  it.each([
    ['web', 'web'],
    ['mobile', 'mobile'],
    ['WEB', 'web'],
    ['  mobile  ', 'mobile'],
  ])('aceita %j e normaliza para %j', (raw, expected) => {
    expect(parseClientType(raw)).toBe(expected);
  });

  it.each([
    ['ausente', undefined],
    ['vazio', ''],
    ['desconhecido', 'desktop'],
    ['array (header repetido)', ['web', 'mobile']],
  ])('rejeita header %s com 400', (_label, raw) => {
    expect(() => parseClientType(raw)).toThrow(BadRequestException);
  });

  it('não assume default silencioso quando o header falta', () => {
    expect(() => parseClientType(undefined)).toThrow(
      new RegExp(CLIENT_TYPE_HEADER),
    );
  });
});
