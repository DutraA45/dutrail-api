# Contrato da API de Atividades — Dutrail

Referência para quem consome as rotas `/activities` (frontend Angular e,
futuramente, o app React Native). Espelha o comportamento verificado por
[`test/activities.e2e-spec.ts`](../test/activities.e2e-spec.ts). A
autenticação, o formato de erro e o interceptor estão em
[`API-CONTRACT.md`](API-CONTRACT.md); a documentação interativa fica em `/docs`.

Estado desta etapa: listagem, detalhe e **criação por importação de arquivo
`.fit`**. Edição e exclusão ainda não existem — ver
[Lacunas conhecidas](#lacunas-conhecidas).

## Autenticação e isolamento

- As três rotas exigem `Authorization: Bearer <accessToken>`, como `GET /me`.
  Sem token válido: **401** (o interceptor faz o refresh normalmente).
- `X-Client-Type` **não** é exigido (é aceito e ignorado).
- O dono é sempre o usuário do token. Não há parâmetro de usuário na URL,
  query ou corpo (na importação, um campo `userId` no formulário é
  ignorado). Um usuário não consegue listar, ler nem inferir a existência de
  atividades de outro.

## Endpoints

| Método | Rota                 | Query                | Sucesso | Resposta                            |
| ------ | -------------------- | -------------------- | ------- | ----------------------------------- |
| GET    | `/activities`        | `limit?`, `cursor?`  | 200     | `{ items: Activity[], nextCursor }` |
| GET    | `/activities/:id`    | —                    | 200     | `Activity` na raiz, sem envelope    |
| POST   | `/activities/import` | — (multipart `file`) | 201     | `Activity` criada, na raiz          |

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

## `POST /activities/import`

Cria uma atividade a partir de um arquivo `.fit` (formato binário da
Garmin/ANT+, exportado por praticamente todo relógio ou ciclocomputador) e
guarda o arquivo original.

### Request

- `Content-Type: multipart/form-data`, com o arquivo no campo **`file`**. Com
  `FormData` o browser monta o header (e o boundary) sozinho, então não o
  defina à mão.
- **Tamanho máximo: 10 MiB (10 485 760 bytes).** Um arquivo com exatamente
  esse tamanho é aceito; acima dele, **413**. Para validar antes no cliente:
  `file.size > 10 * 1024 * 1024`. Para ter uma referência: uma corrida de 40
  minutos tem cerca de 25 KB, e 10 horas gravando a cada segundo com GPS e FC
  ficam por volta de 1 MB.
- O nome e a extensão do arquivo **não** são verificados no servidor. O que
  vale é o conteúdo: cabeçalho FIT e CRC. Um `.FIT` maiúsculo ou sem
  extensão passa; um `.gpx` renomeado para `.fit` dá 400.
- Um único arquivo por request. Um campo de arquivo com outro nome (ex.
  `arquivo`) dá 400. Campos de texto extras são ignorados.

```http
POST /activities/import
Authorization: Bearer eyJhbGciOi...
Content-Type: multipart/form-data; boundary=----X

------X
Content-Disposition: form-data; name="file"; filename="24443171229_ACTIVITY.fit"
Content-Type: application/octet-stream

<bytes do arquivo>
------X--
```

### Resposta de sucesso: 201

O objeto `Activity` criado, **no mesmo formato de `GET /activities/:id`**, na
raiz e sem envelope. A atividade já aparece em `GET /activities` na posição de
`startedAt` (que é a data do treino, não a da importação).

```http
HTTP/1.1 201 Created

{
  "id": "5b0e4f9e-6d0a-4a51-8a8e-2f1f3c7d9b10",
  "userId": "e8cdc132-e7ba-4a01-9c03-f75278ef3a39",
  "name": "Corrida da manhã",
  "sport": "running",
  "startedAt": "2026-09-21T12:22:47.000Z",
  "elapsedTimeSeconds": 2327,
  "movingTimeSeconds": 2327,
  "distanceMeters": 7014.31,
  "elevationGainMeters": 24,
  "averageHeartRateBpm": 144,
  "maxHeartRateBpm": 166,
  "calories": 416,
  "createdAt": "2026-09-24T20:41:07.512Z",
  "updatedAt": "2026-09-24T20:41:07.512Z"
}
```

### De onde vem cada campo

Os valores saem da mensagem de **sessão** do arquivo, que é o resumo calculado
pelo próprio aparelho, e não de um recálculo a partir dos pontos de GPS. Por
isso os números batem com os que o relógio e o Garmin Connect mostram.

| Campo                 | Origem no `.fit`                                                                                          |
| --------------------- | --------------------------------------------------------------------------------------------------------- |
| `name`                | Gerado: modalidade + período do dia **no horário local do treino** (`Corrida da manhã`, `Pedal da noite`) |
| `sport`               | `session.sport` (ver abaixo)                                                                              |
| `startedAt`           | `session.start_time`                                                                                      |
| `elapsedTimeSeconds`  | `session.total_elapsed_time`, arredondado                                                                 |
| `movingTimeSeconds`   | `session.total_moving_time`; se ausente, `total_timer_time` (cronômetro, que já exclui as pausas)         |
| `distanceMeters`      | `session.total_distance`. **`0` vira `null`** (é o que aparelhos gravam em atividades sem distância)      |
| `elevationGainMeters` | `session.total_ascent`                                                                                    |
| `averageHeartRateBpm` | `session.avg_heart_rate`                                                                                  |
| `maxHeartRateBpm`     | `session.max_heart_rate`                                                                                  |
| `calories`            | `session.total_calories` (kcal)                                                                           |

Qualquer métrica que o arquivo não traga (relógio sem cinta cardíaca, esteira
sem altímetro etc.) vem como `null`, como no resto do contrato.

- **Nome**: o `.fit` não tem título. Períodos: madrugada (0h–4h), manhã
  (5h–11h), tarde (12h–17h) e noite (18h–23h), no fuso local de onde o treino
  aconteceu, que o próprio arquivo informa. Se o arquivo não trouxer o fuso,
  o nome fica só com a modalidade (`Corrida`). Para `other`, o rótulo é
  `Atividade`.
- **Multiesporte** (triatlo, duatlo): o arquivo tem uma sessão por modalidade,
  além das transições. Vira **uma** atividade com as métricas somadas (FC
  média ponderada pelo tempo, FC máxima = maior das sessões). O `sport` é
  `other` quando as modalidades diferem, ou a modalidade comum quando todas
  são iguais.

### Esportes: decisão para os não suportados

**Todo arquivo de atividade válido é importado.** O que não tem equivalente no
enum vira `sport: "other"`. Ele **não** é recusado com 400.

| `sport` no `.fit`             | `sport` no Dutrail |
| ----------------------------- | ------------------ |
| `running`                     | `running`          |
| `cycling`, `e_biking`         | `cycling`          |
| `walking`                     | `walking`          |
| `hiking`                      | `hiking`           |
| `swimming`                    | `swimming`         |
| qualquer outro (remo, esqui…) | `other`            |

O sub-esporte não muda a modalidade: corrida em trilha ou esteira continua
`running`, e pedal no rolo continua `cycling`. Motivo: o enum já tem `other`
para esse caso, e recusar o arquivo só impediria o usuário de registrar o
treino. Quando o enum ganhar valores novos, o mapeamento acompanha.

### Duplicidade: decisão

**Reimportar o mesmo arquivo pelo mesmo usuário é recusado com 409.**

- A identidade do arquivo é o `file_id` que o protocolo FIT define:
  fabricante, produto, número de série do aparelho e instante de criação. O
  mesmo treino exportado duas vezes é reconhecido mesmo que tenha outro nome
  de arquivo ou bytes diferentes. Se o aparelho não preencher número de série
  ou data (alguns apps não preenchem), a identidade passa a ser o SHA-256 do
  conteúdo. Nesse caso, só o reenvio byte a byte idêntico é detectado.
- A regra vale **por usuário**: outra pessoa pode importar o mesmo arquivo.
- A garantia é um índice único no banco. Duas importações simultâneas do mesmo
  arquivo resultam em um 201 e um 409, nunca em duas atividades.
- Um arquivo recusado por falha (400, 413, 500) não conta. Pode ser reenviado.

```json
{
  "statusCode": 409,
  "error": "Conflict",
  "message": "Esta atividade já foi importada.",
  "path": "/activities/import",
  "timestamp": "2026-09-24T20:41:09.004Z"
}
```

### Arquivo original

O arquivo enviado é guardado **sem alteração** no storage de arquivos do
Dutrail, associado à atividade criada. A referência a ele é interna e **não
aparece** na resposta (não há rota para baixá-lo nesta etapa). Guardar o
original permite extrair depois dados que hoje não são lidos (trajeto,
voltas, séries de FC), sem pedir ao usuário que reimporte.

Garantia de consistência: **uma resposta 201 significa que o arquivo foi
guardado e a atividade foi criada**. Em qualquer erro, nenhuma atividade é
criada. Não existe atividade sem arquivo guardado.

### Erros de `POST /activities/import`

As mensagens de 400 e 409 estão em **português e prontas para exibir**. O
frontend já mostra a `message` de um 400 como veio.

| Código | Quando                                                                                       | `message`                                                        |
| ------ | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| 400    | Sem campo `file` (request sem multipart, multipart sem o campo, ou JSON)                     | `Envie um arquivo .fit no campo "file".`                         |
| 400    | Arquivo com 0 bytes                                                                          | `O arquivo .fit está vazio.`                                     |
| 400    | Não é FIT, está truncado ou corrompido (CRC não confere), ou falha inesperada ao decodificar | `Arquivo .fit inválido ou corrompido.`                           |
| 400    | FIT válido, mas de outro tipo (percurso, treino planejado, configurações…)                   | `O arquivo .fit não é de uma atividade (tipo "course").`         |
| 400    | Atividade sem mensagem de sessão (resumo)                                                    | `O arquivo .fit não contém o resumo da atividade (sessão).`      |
| 400    | Sessão sem início ou sem duração                                                             | `O arquivo .fit não informa o início ou a duração da atividade.` |
| 400    | Arquivo num campo com outro nome que não `file`                                              | Mensagem do multer, ex. `Unexpected file field - arquivo`        |
| 401    | Access token ausente, inválido ou expirado                                                   | `Unauthorized`                                                   |
| 409    | O mesmo arquivo já foi importado por este usuário                                            | `Esta atividade já foi importada.`                               |
| 413    | Arquivo maior que 10 MiB                                                                     | `File too large` (texto do multer; use uma mensagem própria)     |
| 429    | Mais de **20 importações por minuto** por IP (limite próprio da rota)                        | `ThrottlerException: Too Many Requests`                          |
| 500    | Falha ao guardar o arquivo (storage indisponível, credencial inválida…)                      | `Internal server error`. O detalhe fica só no log do servidor    |

Todo problema **no arquivo** é 400, inclusive exceções inesperadas do
decodificador. O 500 fica reservado para falhas do servidor. Em todos os
erros, nada é gravado: nem atividade, nem arquivo.

## Erros

Formato global, idêntico ao das rotas de auth (ver
[API-CONTRACT.md § Erros](API-CONTRACT.md#erros)).

| Código | Rota                  | Quando                                              | `message`                                           |
| ------ | --------------------- | --------------------------------------------------- | --------------------------------------------------- |
| 400    | `GET /activities`     | `limit` fora de 1..100, não inteiro ou não numérico | array, ex. `["limit must not be greater than 100"]` |
| 400    | `GET /activities`     | Parâmetro de query desconhecido (ex. `?page=2`)     | array, ex. `["property page should not exist"]`     |
| 400    | `GET /activities`     | `cursor` adulterado, truncado ou inventado          | `"Invalid cursor"`                                  |
| 401    | todas                 | Access token ausente, inválido ou expirado          | `"Unauthorized"`                                    |
| 404    | `GET /activities/:id` | Inexistente, de outro usuário ou id malformado      | `"Activity not found"`                              |
| 429    | as duas `GET`         | Rate limit global (100 req/min por IP)              | —                                                   |

Os erros de `POST /activities/import` (400, 409, 413, 429, 500) estão na
[seção da rota](#erros-de-post-activitiesimport).

Com um 400 de `Invalid cursor`, o cliente deve recarregar a lista do início
(sem cursor).

Caso de borda: com um access token válido de um usuário que foi apagado, a
listagem devolve `200` vazio e o detalhe `404` (as atividades são apagadas
junto com o usuário). Quem detecta isso é o `GET /me` (404), como antes.

## Diferenças em relação ao contrato proposto (`activity.models.ts`)

Os **nomes e tipos de todos os campos** propostos foram mantidos. O que muda
para o frontend:

| #   | Onde                          | Proposto                                        | Implementado                                                                 | Ação no `dutrail-web`                                                                 |
| --- | ----------------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| 1   | Resposta de `GET /activities` | `Activity[]`                                    | `{ items: Activity[], nextCursor: string \| null }`                          | **Quebra.** Ler `.items`; criar tipo `ActivityPage`                                   |
| 2   | Query de `GET /activities`    | —                                               | `?limit=1..100` (padrão 20) e `?cursor=`                                     | Paginar com `nextCursor` (ou pedir `limit=100` enquanto não houver scroll infinito)   |
| 3   | Campo `updatedAt`             | não existia                                     | `updatedAt: string` (ISO 8601), sempre presente                              | Adicionar ao `interface Activity`                                                     |
| 4   | Atividade de outro usuário    | 404 ou 403                                      | Sempre **404**                                                               | O tratamento de 403 pode ser removido (inofensivo se ficar)                           |
| 5   | Id malformado                 | não especificado                                | 404 (não 400)                                                                | Nenhuma: cai no mesmo estado de "não encontrada"                                      |
| 6   | Parâmetros de query extras    | não especificado                                | 400                                                                          | Não enviar parâmetros além de `limit`/`cursor`                                        |
| 7   | `POST /activities/import`     | 201 com a `Activity`; 400 para arquivo inválido | Como proposto, mais **409** para reimportação e 413 acima de 10 MiB          | Remover o `TODO(api)` e o override de 404; **adicionar override de 409** (ver abaixo) |
| 8   | Semântica dos números         | `number`                                        | Segundos, FC e `calories` (kcal) são **inteiros**; metros podem ter decimais | Nenhuma no tipo TS. Só não esperar frações de segundo                                 |

Sobre o 409 na importação: hoje o `describeApiError` do `dutrail-web` traduz
todo 409 como "Este email já está em uso.", porque até aqui o único 409 da API
era o do cadastro. Na tela de importação, isso mostraria a mensagem errada.
É preciso um override no `FitFileImport`:

```ts
describeApiError(error, {
  [HttpStatusCode.Conflict]: 'Esta atividade já foi importada.',
  [HttpStatusCode.PayloadTooLarge]:
    'O arquivo é grande demais para ser importado.',
});
```

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

- **Criação manual, edição (renomear) e exclusão** de atividades.
- **Download do arquivo `.fit` original.** Ele é guardado, mas nenhuma rota o
  devolve.
- **Fuso horário local da atividade.** `startedAt` é um instante UTC, e a tela
  converte para o fuso do dispositivo. A importação já lê o fuso do `.fit`
  (é o que dá o período do dia no `name`), mas ainda não o expõe num campo
  próprio.
- **Trajeto (GPS), splits, voltas e séries temporais** (FC/altimetria por
  ponto). O `.fit` original já fica guardado, então esses dados podem ser
  extraídos depois sem reimportação. Vão exigir rotas ou campos próprios.
- **Arquivos `.fit` sem mensagem de sessão** são recusados (400). A
  especificação FIT exige a sessão em arquivos de atividade, e os aparelhos
  comuns a gravam. Recalcular o resumo a partir dos pontos fica para quando
  aparecer um caso real.
- **Outros formatos** (`.gpx`, `.tcx`) não são aceitos.
- **Filtros** na listagem (por `sport`, por período) e total de itens.
