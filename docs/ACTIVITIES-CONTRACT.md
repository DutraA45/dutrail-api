# Contrato da API de Atividades — Dutrail

Referência para quem consome as rotas `/activities` (frontend Angular e,
futuramente, o app React Native). Espelha o comportamento verificado por
[`test/activities.e2e-spec.ts`](../test/activities.e2e-spec.ts). A
autenticação, o formato de erro e o interceptor estão em
[`API-CONTRACT.md`](API-CONTRACT.md); a documentação interativa fica em `/docs`.

Estado desta etapa: **somente leitura**. Existem a listagem e o detalhe; a
criação de atividades (importação de `.fit`) ainda **não existe** — ver
[Lacunas conhecidas](#lacunas-conhecidas).

## Autenticação e isolamento

- As duas rotas exigem `Authorization: Bearer <accessToken>`, como `GET /me`.
  Sem token válido: **401** (o interceptor faz o refresh normalmente).
- `X-Client-Type` **não** é exigido (é aceito e ignorado).
- O dono é sempre o usuário do token. Não há parâmetro de usuário na URL,
  query ou corpo. Um usuário não consegue listar, ler nem inferir a
  existência de atividades de outro.

## Endpoints

| Método | Rota                 | Query               | Sucesso | Resposta                            |
| ------ | -------------------- | ------------------- | ------- | ----------------------------------- |
| GET    | `/activities`        | `limit?`, `cursor?` | 200     | `{ items: Activity[], nextCursor }` |
| GET    | `/activities/:id`    | —                   | 200     | `Activity` na raiz, sem envelope    |
| POST   | `/activities/import` | —                   | —       | **Não implementado** (responde 404) |

## O objeto `Activity`

O formato é o mesmo na listagem e no detalhe:

```json
{
  "id": "f8c9802b-216e-4d02-82df-64d4d7c8001d",
  "userId": "e8cdc132-e7ba-4a01-9c03-f75278ef3a39",
  "name": "Pedal de domingo",
  "sport": "cycling",
  "startedAt": "2026-09-21T08:00:00.000Z",
  "elapsedTimeSeconds": 7260,
  "movingTimeSeconds": 6900,
  "distanceMeters": 52340.5,
  "elevationGainMeters": 610,
  "averageHeartRateBpm": 141,
  "maxHeartRateBpm": 172,
  "calories": 1320,
  "createdAt": "2026-09-23T20:29:45.707Z",
  "updatedAt": "2026-09-23T20:29:45.707Z"
}
```

| Campo                 | Tipo JSON         | Nulo? | Significado                                                                    |
| --------------------- | ----------------- | ----- | ------------------------------------------------------------------------------ |
| `id`                  | string (UUID)     | não   | Identificador da atividade                                                     |
| `userId`              | string (UUID)     | não   | Dono. É sempre o usuário do token                                              |
| `name`                | string            | não   | Título exibido                                                                 |
| `sport`               | string (enum)     | não   | `running`, `cycling`, `walking`, `hiking`, `swimming` ou `other`               |
| `startedAt`           | string (ISO 8601) | não   | Início da atividade, em **UTC**. Chave da ordenação                            |
| `elapsedTimeSeconds`  | inteiro           | não   | Tempo total em segundos, pausas incluídas                                      |
| `movingTimeSeconds`   | inteiro           | sim   | Tempo em movimento, em segundos                                                |
| `distanceMeters`      | número (decimal)  | sim   | Distância em metros. Nula em atividades sem GPS/distância                      |
| `elevationGainMeters` | número (decimal)  | sim   | Ganho de elevação acumulado, em metros                                         |
| `averageHeartRateBpm` | inteiro           | sim   | Frequência cardíaca média (bpm)                                                |
| `maxHeartRateBpm`     | inteiro           | sim   | Frequência cardíaca máxima (bpm)                                               |
| `calories`            | inteiro           | sim   | Gasto energético em **kcal**                                                   |
| `createdAt`           | string (ISO 8601) | não   | Quando a atividade foi registrada no Dutrail                                   |
| `updatedAt`           | string (ISO 8601) | não   | Última alteração do registro. Hoje é igual a `createdAt`, porque não há edição |

- Campos nulos **vêm no JSON como `null`**, nunca são omitidos.
- As métricas que dependem de sensor (FC, calorias, altimetria) e o tempo em
  movimento são nulos quando a origem não tem a informação. Trate `null` como
  "sem dado", nunca como zero.
- Novos valores de `sport` podem surgir no futuro. Trate um valor
  desconhecido como `other` em vez de quebrar a tela.
- Pace e velocidade média **não** são enviados: derive-os no cliente de
  `distanceMeters` e `movingTimeSeconds` (ou `elapsedTimeSeconds` quando o
  primeiro for nulo).

## `GET /activities`

Lista as atividades do usuário autenticado, **mais recentes primeiro**
(`startedAt` decrescente; em caso de empate, `id` decrescente, para que a
ordem seja estável).

### Paginação por cursor

| Parâmetro | Padrão | Regras                                                      |
| --------- | ------ | ----------------------------------------------------------- |
| `limit`   | `20`   | Inteiro de 1 a 100                                          |
| `cursor`  | —      | Valor de `nextCursor` da página anterior. Omita na primeira |

Resposta:

```json
{ "items": [ { ... }, { ... } ], "nextCursor": "WyIyMDI2LTA5LTIx..." }
```

- `nextCursor: null` significa que não há mais páginas.
- O cursor é **opaco**: não interprete nem monte o valor, apenas devolva o que
  a API entregou (lembre de passar por `encodeURIComponent`, ou use
  `HttpParams`, que já faz isso).
- Escolhemos cursor em vez de `page`/`pageSize` porque, num feed, atividades
  novas entram no topo: com offset, a página 2 repetiria itens da página 1.
  Com cursor, a sequência não pula nem repete itens, mesmo com inserções ou
  remoções entre as chamadas.
- Para "puxar para atualizar" ou recarregar o feed, peça de novo **sem**
  cursor.

```http
GET /activities?limit=2
Authorization: Bearer eyJhbGciOi...
```

```http
HTTP/1.1 200 OK

{
  "items": [
    { "id": "9f7e8a66-...", "name": "Corrida matinal", "startedAt": "2026-09-22T06:30:00.000Z", ... },
    { "id": "f8c9802b-...", "name": "Pedal de domingo", "startedAt": "2026-09-21T08:00:00.000Z", ... }
  ],
  "nextCursor": "WyIyMDI2LTA5LTIxVDA4OjAwOjAwLjAwMFoiLCJmOGM5ODAyYi0yMTZlLTRkMDItODJkZi02NGQ0ZDdjODAwMWQiXQ"
}
```

```http
GET /activities?limit=2&cursor=WyIyMDI2LTA5LTIxVDA4OjAwOjAwLjAwMFoiLCJmOGM5ODAyYi0yMTZlLTRkMDItODJkZi02NGQ0ZDdjODAwMWQiXQ
Authorization: Bearer eyJhbGciOi...

HTTP/1.1 200 OK

{ "items": [ { "id": "...", "name": "Trilha", ... } ], "nextCursor": null }
```

Usuário sem atividades: `200 { "items": [], "nextCursor": null }`.

## `GET /activities/:id`

Retorna uma atividade do usuário autenticado, com todos os campos, na raiz e
sem envelope.

```http
GET /activities/f8c9802b-216e-4d02-82df-64d4d7c8001d
Authorization: Bearer eyJhbGciOi...

HTTP/1.1 200 OK

{ "id": "f8c9802b-216e-4d02-82df-64d4d7c8001d", "userId": "...", "name": "Pedal de domingo", ... }
```

### 404, nunca 403

As três situações abaixo recebem **a mesma resposta**: mesmo status, mesmo
`error`, mesma `message`. Só `path` e `timestamp` variam, como em qualquer
erro.

| Situação                              | Resposta                 |
| ------------------------------------- | ------------------------ |
| Id não existe                         | 404 `Activity not found` |
| Id existe, mas é de **outro usuário** | 404 `Activity not found` |
| Id malformado (não é UUID)            | 404 `Activity not found` |

```json
{
  "statusCode": 404,
  "error": "Not Found",
  "message": "Activity not found",
  "path": "/activities/9f7e8a66-7a71-42f8-933b-9bf711686091",
  "timestamp": "2026-09-23T20:29:45.919Z"
}
```

Um 403 diria "esse id existe, mas não é seu". É a mesma lógica do
`"Invalid credentials"` genérico do login. A consulta já filtra por dono no
banco (`WHERE id = ? AND userId = ?`), então a API nem chega a saber se o
id existe para outra pessoa.

## Erros

Formato global, idêntico ao das rotas de auth (ver
[API-CONTRACT.md § Erros](API-CONTRACT.md#erros)).

| Código | Rota                  | Quando                                              | `message`                                           |
| ------ | --------------------- | --------------------------------------------------- | --------------------------------------------------- |
| 400    | `GET /activities`     | `limit` fora de 1..100, não inteiro ou não numérico | array, ex. `["limit must not be greater than 100"]` |
| 400    | `GET /activities`     | Parâmetro de query desconhecido (ex. `?page=2`)     | array, ex. `["property page should not exist"]`     |
| 400    | `GET /activities`     | `cursor` adulterado, truncado ou inventado          | `"Invalid cursor"`                                  |
| 401    | ambas                 | Access token ausente, inválido ou expirado          | `"Unauthorized"`                                    |
| 404    | `GET /activities/:id` | Inexistente, de outro usuário ou id malformado      | `"Activity not found"`                              |
| 429    | ambas                 | Rate limit global (100 req/min por IP)              | —                                                   |

Com um 400 de `Invalid cursor`, o cliente deve recarregar a lista do início
(sem cursor).

Caso de borda: com um access token válido de um usuário que foi apagado, a
listagem devolve `200` vazio e o detalhe `404` (as atividades são apagadas
junto com o usuário). Quem detecta isso é o `GET /me` (404), como antes.

## Diferenças em relação ao contrato proposto (`activity.models.ts`)

Os **nomes e tipos de todos os campos** propostos foram mantidos. O que muda
para o frontend:

| #   | Onde                          | Proposto                                        | Implementado                                                                 | Ação no `dutrail-web`                                                               |
| --- | ----------------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| 1   | Resposta de `GET /activities` | `Activity[]`                                    | `{ items: Activity[], nextCursor: string \| null }`                          | **Quebra.** Ler `.items`; criar tipo `ActivityPage`                                 |
| 2   | Query de `GET /activities`    | —                                               | `?limit=1..100` (padrão 20) e `?cursor=`                                     | Paginar com `nextCursor` (ou pedir `limit=100` enquanto não houver scroll infinito) |
| 3   | Campo `updatedAt`             | não existia                                     | `updatedAt: string` (ISO 8601), sempre presente                              | Adicionar ao `interface Activity`                                                   |
| 4   | Atividade de outro usuário    | 404 ou 403                                      | Sempre **404**                                                               | O tratamento de 403 pode ser removido (inofensivo se ficar)                         |
| 5   | Id malformado                 | não especificado                                | 404 (não 400)                                                                | Nenhuma: cai no mesmo estado de "não encontrada"                                    |
| 6   | Parâmetros de query extras    | não especificado                                | 400                                                                          | Não enviar parâmetros além de `limit`/`cursor`                                      |
| 7   | `POST /activities/import`     | 201 com a `Activity`; 400 para arquivo inválido | Não existe (404)                                                             | Manter a tela de importação desabilitada ou com estado "em breve"                   |
| 8   | Semântica dos números         | `number`                                        | Segundos, FC e `calories` (kcal) são **inteiros**; metros podem ter decimais | Nenhuma no tipo TS. Só não esperar frações de segundo                               |

Sugestão de tipo para o frontend:

```ts
export interface Activity {
  // ...campos atuais...
  /** Última alteração do registro, ISO 8601. */
  updatedAt: string;
}

export interface ActivityPage {
  items: Activity[];
  /** Passe em `?cursor=` para a próxima página; `null` = fim da lista. */
  nextCursor: string | null;
}
```

## Lacunas conhecidas

Não implementadas nesta etapa. O cliente não deve contar com elas:

- **`POST /activities/import` não existe.** Hoje a rota responde 404 (rota
  inexistente, mesmo formato de erro). Fica pendente, dos dois lados, a
  definição do upload `multipart/form-data` com o campo `file` (`.fit`), o
  parsing e as regras de 400. Consequência: no momento, nenhuma atividade
  pode ser criada pela API; em dev, elas só existem se forem inseridas direto
  no banco.
- **Criação manual, edição (renomear) e exclusão** de atividades.
- **Fuso horário local da atividade.** `startedAt` é um instante UTC. A tela
  converte para o fuso do dispositivo. O fuso de onde a atividade aconteceu
  (que o `.fit` traz) pode ser adicionado junto com a importação.
- **Trajeto (GPS), splits, voltas e séries temporais** (FC/altimetria por
  ponto). Vão exigir rotas ou campos próprios quando a importação existir.
- **Filtros** na listagem (por `sport`, por período) e total de itens.
