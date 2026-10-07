# Contrato da API de Atividades — Dutrail

Referência das rotas `/activities` para o frontend Angular e o app Android.
Documentos complementares, que definem o que aqui é só referenciado
(Bearer, refresh no 401, formato de erro, rate limit):

- [`API-CONTRACT.md`](API-CONTRACT.md): autenticação do cliente web e padrões
  comuns da API.
- [`AUTH-CONTRACT-MOBILE.md`](AUTH-CONTRACT-MOBILE.md): autenticação do app
  Android.

Conferido contra o código e contra requisições reais (servidor em
`development`, banco descartável, storage em memória) em 2026-10-05. Os
exemplos de resposta saíram dessas requisições.

**Swagger.** `/docs` e `/docs-json` existem só fora de produção. Em produção
respondem 404, e a referência é este documento.

Estado atual: listagem, detalhe e criação por importação de arquivo `.fit`.
Não há edição nem exclusão (ver [Lacunas conhecidas](#lacunas-conhecidas)).

## Autenticação e isolamento

- As três rotas exigem `Authorization: Bearer <accessToken>`, como `GET /me`.
  Access token ausente, inválido ou expirado: **401** `Unauthorized`, e o
  cliente faz o refresh e repete a request uma vez, como em qualquer rota com
  Bearer.
- `X-Client-Type` **não** é exigido: é ignorado (pode ir junto, como o
  interceptor manda em toda request).
- O dono é sempre o usuário do token. Não há parâmetro de usuário na URL, na
  query nem no corpo; na importação, campos de texto do formulário (como
  `userId`) são ignorados. Um usuário não consegue listar, ler nem inferir a
  existência de atividades de outro.

## Endpoints

| Método | Rota                 | Query               | Corpo                        | Sucesso | Resposta                                     | Limite por IP |
| ------ | -------------------- | ------------------- | ---------------------------- | ------- | -------------------------------------------- | ------------- |
| GET    | `/activities`        | `limit?`, `cursor?` | —                            | 200     | `{ items: Activity[], nextCursor }`          | 100/min       |
| GET    | `/activities/:id`    | —                   | —                            | 200     | `Activity` na raiz, sem envelope             | 100/min       |
| POST   | `/activities/import` | —                   | `multipart/form-data`, `file` | 201    | `Activity` criada, na raiz, sem envelope     | 20/min        |

Os limites são por IP e por rota (cada rota tem o seu contador), valores
atuais do servidor; o de 100/min é o padrão configurável da API. Outros
métodos (`DELETE`, `PATCH`, `POST /activities`) não existem: 404
`Cannot <MÉTODO> <caminho>`.

## O objeto `Activity`

O mesmo formato na listagem, no detalhe e na resposta da importação:

```json
{
  "id": "6fc41af9-a076-46cd-9f49-89f8316286f0",
  "userId": "ccbfee3b-a38a-43d4-921d-62bb669f6800",
  "name": "Corrida da manhã",
  "sport": "running",
  "startedAt": "2026-09-20T09:15:30.000Z",
  "elapsedTimeSeconds": 3125,
  "movingTimeSeconds": 3010,
  "distanceMeters": 10012.4,
  "elevationGainMeters": 87,
  "averageHeartRateBpm": 152,
  "maxHeartRateBpm": 178,
  "calories": 689,
  "createdAt": "2026-10-05T21:00:48.627Z",
  "updatedAt": "2026-10-05T21:00:48.627Z"
}
```

| Campo                 | Tipo JSON         | Nulo? | TypeScript       | Kotlin    | Significado                                                                |
| --------------------- | ----------------- | ----- | ---------------- | --------- | -------------------------------------------------------------------------- |
| `id`                  | string (UUID)     | não   | `string`         | `String`  | Identificador da atividade                                                 |
| `userId`              | string (UUID)     | não   | `string`         | `String`  | Dono; sempre o usuário do token                                            |
| `name`                | string            | não   | `string`         | `String`  | Título exibido (gerado na importação)                                      |
| `sport`               | string (enum)     | não   | `ActivitySport`  | `String`  | `running`, `cycling`, `walking`, `hiking`, `swimming` ou `other`           |
| `startedAt`           | string (ISO 8601) | não   | `string`         | `Instant` | Início da atividade, em **UTC**. Chave da ordenação                        |
| `elapsedTimeSeconds`  | inteiro           | não   | `number`         | `Int`     | Tempo total em segundos, pausas incluídas                                  |
| `movingTimeSeconds`   | inteiro           | sim   | `number \| null` | `Int?`    | Tempo em movimento, em segundos                                            |
| `distanceMeters`      | número (decimal)  | sim   | `number \| null` | `Double?` | Distância em metros. `null` em atividades sem distância                    |
| `elevationGainMeters` | número (decimal)  | sim   | `number \| null` | `Double?` | Ganho de elevação acumulado, em metros                                     |
| `averageHeartRateBpm` | inteiro           | sim   | `number \| null` | `Int?`    | Frequência cardíaca média (bpm)                                            |
| `maxHeartRateBpm`     | inteiro           | sim   | `number \| null` | `Int?`    | Frequência cardíaca máxima (bpm)                                           |
| `calories`            | inteiro           | sim   | `number \| null` | `Int?`    | Gasto energético em **kcal**                                               |
| `createdAt`           | string (ISO 8601) | não   | `string`         | `Instant` | Quando a atividade foi registrada no Dutrail                               |
| `updatedAt`           | string (ISO 8601) | não   | `string`         | `Instant` | Última alteração do registro. Hoje igual a `createdAt` (não há edição)     |

- Campos nulos **vêm no JSON como `null`**, nunca são omitidos.
- `null` significa "sem dado", nunca zero. As métricas que dependem de sensor
  (FC, calorias, altimetria), a distância e o tempo em movimento podem ser
  nulos.
- Metros podem ter casas decimais mesmo quando o exemplo mostra um inteiro
  (`87` acima). Segundos, FC e calorias são sempre inteiros.
- Novos valores de `sport` podem surgir. Trate um valor desconhecido como
  `other` em vez de quebrar a tela.
- Pace e velocidade média **não** são enviados: derive-os no cliente de
  `distanceMeters` e `movingTimeSeconds` (ou `elapsedTimeSeconds` quando o
  primeiro for nulo).

Exemplo real de atividade com métricas ausentes (arquivo sem distância, FC,
altimetria nem fuso):

```json
{
  "id": "ebb11785-bf0f-44d8-89ec-e40ec30b11e9",
  "userId": "ccbfee3b-a38a-43d4-921d-62bb669f6800",
  "name": "Atividade",
  "sport": "other",
  "startedAt": "2026-09-02T10:00:00.000Z",
  "elapsedTimeSeconds": 600,
  "movingTimeSeconds": 600,
  "distanceMeters": null,
  "elevationGainMeters": null,
  "averageHeartRateBpm": null,
  "maxHeartRateBpm": null,
  "calories": null,
  "createdAt": "2026-10-05T21:00:49.035Z",
  "updatedAt": "2026-10-05T21:00:49.035Z"
}
```

## `GET /activities`

Lista as atividades do usuário autenticado, **mais recentes primeiro**
(`startedAt` decrescente; em caso de empate, `id` decrescente, para a ordem
ser estável).

### Paginação por cursor

| Parâmetro | Tipo    | Padrão | Regras                                                                 |
| --------- | ------- | ------ | ---------------------------------------------------------------------- |
| `limit`   | inteiro | `20`   | De 1 a 100                                                             |
| `cursor`  | string  | —      | Valor de `nextCursor` da página anterior, até 200 caracteres. Omita na primeira página |

Não há outros parâmetros: qualquer outro (`page`, `sport`, `from`...) dá 400.
Não há filtros nem total de itens.

Resposta: `{ "items": Activity[], "nextCursor": string | null }`.

- `nextCursor: null` significa que não há mais páginas.
- O cursor é **opaco**: não interprete nem monte o valor; devolva o que a API
  entregou, codificado na URL (`HttpParams` no Angular e `@Query` no Retrofit
  já fazem isso). Um cursor adulterado dá 400 `Invalid cursor`; nesse caso,
  recarregue a lista do início.
- A sequência não pula nem repete itens, mesmo com atividades criadas entre
  as chamadas (uma atividade nova com `startedAt` recente entra no topo e
  aparece só ao recarregar sem cursor).
- Para "puxar para atualizar", peça de novo **sem** cursor.

```http
GET /activities?limit=2&cursor=WyIyMDI2LTA5LTIwVDA5OjE1OjMwLjAwMFoiLCI1YTE3ZWNmZC03YjY3LTRkZTUtOTg5Zi0wMTNmYWE1YzkyOTgiXQ
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9…
```

```http
HTTP/1.1 200 OK
Content-Type: application/json; charset=utf-8

{
  "items": [
    {
      "id": "1f0ac41f-c288-44d9-a384-482b7fb6ba5e",
      "userId": "ccbfee3b-a38a-43d4-921d-62bb669f6800",
      "name": "Corrida da manhã",
      "sport": "running",
      "startedAt": "2026-09-20T09:15:30.000Z",
      "elapsedTimeSeconds": 3125,
      "movingTimeSeconds": 3010,
      "distanceMeters": 10012.4,
      "elevationGainMeters": 87,
      "averageHeartRateBpm": 152,
      "maxHeartRateBpm": 178,
      "calories": 689,
      "createdAt": "2026-10-05T21:00:50.142Z",
      "updatedAt": "2026-10-05T21:00:50.142Z"
    },
    {
      "id": "7fccf924-03f1-4e55-93f1-1bd8ca88e629",
      "userId": "ccbfee3b-a38a-43d4-921d-62bb669f6800",
      "name": "Atividade da madrugada",
      "sport": "other",
      "startedAt": "2026-09-03T06:00:00.000Z",
      "elapsedTimeSeconds": 5520,
      "movingTimeSeconds": 5520,
      "distanceMeters": 41500,
      "elevationGainMeters": 300,
      "averageHeartRateBpm": 137,
      "maxHeartRateBpm": 170,
      "calories": 1200,
      "createdAt": "2026-10-05T21:00:49.490Z",
      "updatedAt": "2026-10-05T21:00:49.490Z"
    }
  ],
  "nextCursor": "WyIyMDI2LTA5LTAzVDA2OjAwOjAwLjAwMFoiLCI3ZmNjZjkyNC0wM2YxLTRlNTUtOTNmMS0xYmQ4Y2E4OGU2MjkiXQ"
}
```

Usuário sem atividades: `200 { "items": [], "nextCursor": null }`.

### Erros de `GET /activities`

| Status | `message`                                                                 | Quando                                       |
| ------ | ------------------------------------------------------------------------- | -------------------------------------------- |
| 400    | `["limit must not be less than 1"]`, `["limit must not be greater than 100"]`, `["limit must be an integer number"]` | `limit` fora de 1..100 ou não inteiro. Um valor não numérico (`?limit=abc`) traz as três mensagens no array |
| 400    | `["property page should not exist"]`                                      | Parâmetro de query desconhecido              |
| 400    | `["cursor must be shorter than or equal to 200 characters"]`              | Cursor longo demais                          |
| 400    | `Invalid cursor`                                                          | Cursor adulterado, truncado, vazio ou inventado |
| 401    | `Unauthorized`                                                            | Access token ausente, inválido ou expirado   |
| 429    | `ThrottlerException: Too Many Requests`                                   | Mais de 100 requests/min do mesmo IP nesta rota |

## `GET /activities/:id`

Retorna uma atividade do usuário autenticado, na raiz e sem envelope, no
formato do [objeto `Activity`](#o-objeto-activity).

```http
GET /activities/6fc41af9-a076-46cd-9f49-89f8316286f0
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9…

HTTP/1.1 200 OK

{ "id": "6fc41af9-a076-46cd-9f49-89f8316286f0", "userId": "ccbfee3b-a38a-43d4-921d-62bb669f6800", "name": "Corrida da manhã", ... }
```

### 404, nunca 403

As três situações recebem **a mesma resposta** (só `path` e `timestamp`
variam):

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
  "timestamp": "2026-10-05T21:00:51.140Z"
}
```

Um 403 diria "esse id existe, mas não é seu". A consulta já filtra por dono
no banco, então a API nem chega a saber se o id existe para outra pessoa.

### Erros de `GET /activities/:id`

| Status | `message`                               | Quando                                          |
| ------ | --------------------------------------- | ----------------------------------------------- |
| 401    | `Unauthorized`                          | Access token ausente, inválido ou expirado      |
| 404    | `Activity not found`                    | Inexistente, de outro usuário ou id malformado  |
| 429    | `ThrottlerException: Too Many Requests` | Mais de 100 requests/min do mesmo IP nesta rota |

## `POST /activities/import`

Cria uma atividade a partir de um arquivo `.fit` (formato binário da
Garmin/ANT+, exportado por praticamente todo relógio ou ciclocomputador) e
guarda o arquivo original.

### Request

- `Content-Type: multipart/form-data`, com o arquivo no campo **`file`**. Com
  `FormData` (web) ou `MultipartBody.Part` (OkHttp), o cliente HTTP monta o
  header e o boundary; não os defina à mão.
- **Tamanho máximo: 10 MiB (10 485 760 bytes).** Um arquivo com exatamente
  esse tamanho passa pelo limite; acima dele, **413**. Para validar antes no
  cliente: `size > 10 * 1024 * 1024`. Referência: uma corrida de 40 minutos
  tem cerca de 25 KB, e 10 horas gravando a cada segundo com GPS e FC ficam
  por volta de 1 MB.
- O nome, a extensão e o `Content-Type` da parte **não** são verificados. O
  que vale é o conteúdo (cabeçalho FIT e CRC): um `.FIT` maiúsculo ou sem
  extensão passa; um `.gpx` renomeado dá 400.
- Um único arquivo por request, no campo `file`. Até 10 campos de texto
  extras são aceitos e ignorados.

```http
POST /activities/import
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9…
Content-Type: multipart/form-data; boundary=----X

------X
Content-Disposition: form-data; name="file"; filename="running.fit"
Content-Type: application/octet-stream

<bytes do arquivo>
------X--
```

### Resposta de sucesso: 201

O objeto `Activity` criado, **no mesmo formato de `GET /activities/:id`**,
na raiz e sem envelope:

```http
HTTP/1.1 201 Created
Content-Type: application/json; charset=utf-8

{
  "id": "6fc41af9-a076-46cd-9f49-89f8316286f0",
  "userId": "ccbfee3b-a38a-43d4-921d-62bb669f6800",
  "name": "Corrida da manhã",
  "sport": "running",
  "startedAt": "2026-09-20T09:15:30.000Z",
  "elapsedTimeSeconds": 3125,
  "movingTimeSeconds": 3010,
  "distanceMeters": 10012.4,
  "elevationGainMeters": 87,
  "averageHeartRateBpm": 152,
  "maxHeartRateBpm": 178,
  "calories": 689,
  "createdAt": "2026-10-05T21:00:48.627Z",
  "updatedAt": "2026-10-05T21:00:48.627Z"
}
```

A atividade já aparece em `GET /activities` na posição do seu `startedAt` (a
data do treino, não a da importação), que pode não ser o topo da lista.

### De onde vem cada campo

Os valores saem da mensagem de **sessão** do arquivo (o resumo calculado
pelo próprio aparelho), não de um recálculo a partir dos pontos de GPS. Por
isso batem com o que o relógio mostra.

| Campo                 | Origem no `.fit`                                                                                          |
| --------------------- | --------------------------------------------------------------------------------------------------------- |
| `name`                | Gerado: modalidade + período do dia **no horário local do treino** (`Corrida da manhã`, `Pedal da noite`) |
| `sport`               | `session.sport` (ver abaixo)                                                                              |
| `startedAt`           | `session.start_time`; se ausente, `file_id.time_created`                                                  |
| `elapsedTimeSeconds`  | `session.total_elapsed_time`; se ausente, `total_timer_time`. Arredondado                                 |
| `movingTimeSeconds`   | `session.total_moving_time`; se ausente, `total_timer_time` (cronômetro, já sem as pausas). Arredondado   |
| `distanceMeters`      | `session.total_distance`. **`0` vira `null`** (é o que aparelhos gravam em atividades sem distância)      |
| `elevationGainMeters` | `session.total_ascent`                                                                                    |
| `averageHeartRateBpm` | `session.avg_heart_rate`, arredondado                                                                     |
| `maxHeartRateBpm`     | `session.max_heart_rate`                                                                                  |
| `calories`            | `session.total_calories` (kcal), arredondado                                                              |

O que o arquivo não traz vem como `null`.

- **Nome**: o `.fit` não tem título. Períodos: madrugada (0h–4h), manhã
  (5h–11h), tarde (12h–17h) e noite (18h–23h), no fuso local de onde o treino
  aconteceu, que o próprio arquivo informa. Sem o fuso no arquivo, o nome fica
  só com a modalidade (`Corrida`). Rótulos: `Corrida`, `Pedal`, `Caminhada`,
  `Trilha`, `Natação` e, para `other`, `Atividade`.
- **Multiesporte** (triatlo, duatlo): uma sessão por modalidade, mais as
  transições. Vira **uma** atividade: `startedAt` da primeira sessão, tempos,
  distância, subida e calorias somados, FC média ponderada pelo tempo e FC
  máxima igual à maior das sessões. `sport` é `other` quando as modalidades
  diferem (as transições não contam), ou a modalidade comum quando são iguais.

### Esportes não suportados

**Todo arquivo de atividade válido é importado.** O que não tem equivalente
no enum vira `sport: "other"`, sem 400.

| `sport` no `.fit`             | `sport` no Dutrail |
| ----------------------------- | ------------------ |
| `running`                     | `running`          |
| `cycling`, `e_biking`         | `cycling`          |
| `walking`                     | `walking`          |
| `hiking`                      | `hiking`           |
| `swimming`                    | `swimming`         |
| qualquer outro (remo, esqui…) | `other`            |

O sub-esporte não muda a modalidade: corrida em trilha ou esteira continua
`running`, e pedal no rolo continua `cycling`.

### Duplicidade

**Reimportar o mesmo arquivo pelo mesmo usuário é recusado com 409.**

- A identidade do arquivo é o `file_id` do protocolo FIT: fabricante,
  produto, número de série do aparelho e instante de criação. O mesmo treino
  exportado duas vezes é reconhecido mesmo com outro nome de arquivo ou
  bytes diferentes. Se o aparelho não preencher número de série ou data, a
  identidade passa a ser o SHA-256 do conteúdo, e só o reenvio idêntico é
  detectado.
- Vale **por usuário**: outra pessoa pode importar o mesmo arquivo.
- Duas importações simultâneas do mesmo arquivo resultam em um 201 e um 409,
  nunca em duas atividades.
- Um arquivo recusado por falha (400, 413, 500) não conta e pode ser
  reenviado.

### Arquivo original

O arquivo é guardado **sem alteração** no storage do Dutrail, associado à
atividade. A referência a ele é interna e **não aparece** na resposta (não
há rota para baixá-lo).

**Um 201 significa que o arquivo foi guardado e a atividade foi criada.** Em
qualquer erro, nada é gravado: nem atividade, nem arquivo.

### Erros de `POST /activities/import`

As mensagens que o servidor escreve para o 400 de conteúdo e para o 409 estão
em **português e prontas para exibir**. As que vêm da biblioteca de upload
(campo errado, arquivos ou campos demais, 413) estão em inglês: use texto
próprio nesses casos.

| Status | Quando                                                                          | `message` (string)                                                 |
| ------ | ------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| 400    | Sem o campo `file` (request sem corpo, JSON, ou multipart sem esse campo)       | `Envie um arquivo .fit no campo "file".`                           |
| 400    | Arquivo com 0 bytes                                                             | `O arquivo .fit está vazio.`                                       |
| 400    | Não é FIT, está truncado ou corrompido (CRC não confere)                        | `Arquivo .fit inválido ou corrompido.`                             |
| 400    | FIT válido, mas de outro tipo (percurso, treino planejado, configurações…)      | `O arquivo .fit não é de uma atividade (tipo "course").` (o tipo varia) |
| 400    | Atividade sem mensagem de sessão (resumo)                                       | `O arquivo .fit não contém o resumo da atividade (sessão).`        |
| 400    | Sessão sem início ou sem duração                                                | `O arquivo .fit não informa o início ou a duração da atividade.`   |
| 400    | Arquivo num campo com outro nome                                                | `Unexpected file field - <campo>` (ex. `Unexpected file field - arquivo`) |
| 400    | Mais de um arquivo no campo `file`                                              | `Too many files`                                                   |
| 400    | Mais de 10 campos de texto                                                      | `Too many fields`                                                  |
| 401    | Access token ausente, inválido ou expirado                                      | `Unauthorized`                                                     |
| 404    | Access token válido de um usuário que foi apagado (como no `GET /me`)           | `User not found`. Nada é gravado; ver abaixo                       |
| 409    | O mesmo arquivo já foi importado por este usuário                               | `Esta atividade já foi importada.`                                 |
| 413    | Arquivo maior que 10 MiB                                                        | `File too large`                                                   |
| 429    | Mais de **20 importações por minuto** do mesmo IP                               | `ThrottlerException: Too Many Requests`                            |
| 500    | Falha ao guardar o arquivo (storage indisponível)                               | `Internal server error`. O detalhe fica só no log do servidor       |

Todo problema **no arquivo** é 400. O 500 fica para falhas do servidor e pode
ser tentado de novo mais tarde (nada foi gravado).

```json
{
  "statusCode": 409,
  "error": "Conflict",
  "message": "Esta atividade já foi importada.",
  "path": "/activities/import",
  "timestamp": "2026-10-05T21:00:48.691Z"
}
```

## Erros: o que vale para as três rotas

O formato é o mesmo da API inteira (`statusCode`, `error`, `message` string
ou array, `path`, `timestamp`); ver [`API-CONTRACT.md` § Erros](API-CONTRACT.md#erros).
Lembretes:

- **401**: o access token expirou ou é inválido. Faça o refresh e repita a
  request uma vez; se o refresh também falhar com 401, a sessão acabou.
- **429**: o rate limit vem antes da autenticação, então pode chegar mesmo com
  o token expirado. Mostre "muitas tentativas, aguarde", não repita
  automaticamente e não encerre a sessão. O header `Retry-After` (segundos)
  vem na resposta e pode ser lido pelo app Android e pelo Angular (a API o
  expõe ao browser em `Access-Control-Expose-Headers`; ver
  [`API-CONTRACT.md` § Rate limit](API-CONTRACT.md#rate-limit)).
- **`path`** traz a query string (ex. `/activities?limit=101`).
- Decida pelo `statusCode`. A exceção são as mensagens em português da
  importação (400 de conteúdo e 409), que podem ser **exibidas** como vieram;
  mesmo assim, não as compare para decidir comportamento.

**Usuário apagado com access token ainda válido** (caso de borda): a
listagem devolve `200` vazio, o detalhe `404` `Activity not found` (as
atividades são apagadas junto com o usuário) e a importação responde **404
`User not found`**, a mesma resposta do `GET /me`. Na importação, nada fica
gravado: o arquivo enviado é descartado. O cliente trata o `User not found`
como no `GET /me`: sessão encerrada, limpa a sessão local e vai para o login,
sem mostrar uma mensagem genérica de "não encontrado". A listagem e o
detalhe não distinguem esse caso; quem o detecta é o `GET /me` ou a
importação.

## O que o cliente não deve assumir

- **Cursor legível.** É opaco: não decodifique, não monte, não guarde entre
  sessões como se fosse estável.
- **Total de itens ou número de páginas.** Não existem.
- **Métricas presentes.** Todos os campos marcados como nulos podem vir
  `null`; `null` não é zero.
- **`sport` fechado.** Pode ganhar valores novos; trate o desconhecido como
  `other`.
- **Metros inteiros.** `distanceMeters` e `elevationGainMeters` podem ter
  decimais.
- **Ordem por data de importação.** A lista é ordenada por `startedAt` (data
  do treino).
- **403.** Atividade de outro usuário é 404.
- **Texto das mensagens** para decidir comportamento (ver acima).
- **Limites fixos.** 10 MiB e 20 importações/min são os valores atuais;
  valide o tamanho no cliente por conforto, mas trate o 413 e o 429.
- **Rotas de edição, exclusão ou download.** Não existem.

## Diferenças em relação ao contrato proposto pelo frontend (`activity.models.ts`)

Os **nomes e tipos de todos os campos** propostos pelo `dutrail-web` foram
mantidos. O que muda para ele:

| #   | Onde                          | Proposto                                        | Implementado                                                                 | Ação no `dutrail-web`                                                                 |
| --- | ----------------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| 1   | Resposta de `GET /activities` | `Activity[]`                                    | `{ items: Activity[], nextCursor: string \| null }`                          | **Quebra.** Ler `.items`; criar o tipo `ActivityPage`                                 |
| 2   | Query de `GET /activities`    | —                                               | `?limit=1..100` (padrão 20) e `?cursor=`                                     | Paginar com `nextCursor` (ou pedir `limit=100` enquanto não houver scroll infinito)   |
| 3   | Campo `updatedAt`             | não existia                                     | `updatedAt: string` (ISO 8601), sempre presente                              | Adicionar ao `interface Activity`                                                     |
| 4   | Atividade de outro usuário    | 404 ou 403                                      | Sempre **404**                                                               | O tratamento de 403 pode ser removido (inofensivo se ficar)                           |
| 5   | Id malformado                 | não especificado                                | 404 (não 400)                                                                | Nenhuma: cai no mesmo estado de "não encontrada"                                      |
| 6   | Parâmetros de query extras    | não especificado                                | 400                                                                          | Não enviar parâmetros além de `limit`/`cursor`                                        |
| 7   | `POST /activities/import`     | 201 com a `Activity`; 400 para arquivo inválido | Como proposto, mais **409** para reimportação, **413** acima de 10 MiB e **404 `User not found`** quando o token ainda é válido mas o usuário foi apagado | Remover o `TODO(api)`; **adicionar overrides de 409 e 413** (ver abaixo); tratar o 404 `User not found` como **sessão encerrada** (limpar a sessão local e ir para o login), não com uma mensagem genérica de "não encontrado" |
| 8   | Semântica dos números         | `number`                                        | Segundos, FC e `calories` (kcal) são **inteiros**; metros podem ter decimais | Nenhuma no tipo TS; só não esperar frações de segundo                                 |

Sobre o 409 na importação: o `describeApiError` do `dutrail-web` traduzia
todo 409 como "Este email já está em uso.", porque até a importação o único
409 da API era o do cadastro. Na tela de importação, isso mostraria a
mensagem errada. É preciso um override no `FitFileImport`:

```ts
describeApiError(error, {
  [HttpStatusCode.Conflict]: 'Esta atividade já foi importada.',
  [HttpStatusCode.PayloadTooLarge]:
    'O arquivo é grande demais para ser importado.',
});
```

Tipos sugeridos para o frontend:

```ts
export type ActivitySport =
  | 'running'
  | 'cycling'
  | 'walking'
  | 'hiking'
  | 'swimming'
  | 'other';

export interface Activity {
  id: string;
  userId: string;
  name: string;
  sport: ActivitySport; // valor desconhecido: tratar como 'other'
  startedAt: string; // ISO 8601, UTC
  elapsedTimeSeconds: number;
  movingTimeSeconds: number | null;
  distanceMeters: number | null;
  elevationGainMeters: number | null;
  averageHeartRateBpm: number | null;
  maxHeartRateBpm: number | null;
  calories: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface ActivityPage {
  items: Activity[];
  /** Passe em `?cursor=` para a próxima página; `null` = fim da lista. */
  nextCursor: string | null;
}
```

## Lacunas conhecidas

Não implementadas; o cliente não deve contar com elas:

- **Criação manual, edição (renomear) e exclusão** de atividades. Não há
  `POST /activities`, `PATCH` nem `DELETE` (404).
- **Download do arquivo `.fit` original.** Ele é guardado, mas nenhuma rota o
  devolve.
- **Fuso horário local da atividade.** `startedAt` é UTC e a tela converte
  para o fuso do dispositivo. A importação lê o fuso do `.fit` (é o que dá o
  período do dia no `name`), mas não o expõe num campo.
- **Trajeto (GPS), splits, voltas e séries temporais** (FC/altimetria por
  ponto). O `.fit` original fica guardado, então esses dados podem ser
  extraídos depois sem reimportação.
- **Arquivos `.fit` sem mensagem de sessão** são recusados (400).
- **Outros formatos** (`.gpx`, `.tcx`).
- **Filtros** na listagem (por `sport`, por período) e total de itens.
