# Contrato da API de Autenticação — Dutrail (app Android)

Versão do contrato de autenticação focada no app Android nativo em Kotlin.
Existe também um fluxo web, com o refresh token em cookie `httpOnly`,
documentado no contrato principal ([`API-CONTRACT.md`](API-CONTRACT.md)), que
atende o frontend Angular. **Este documento cobre somente
`X-Client-Type: mobile`.** Em caso de divergência, vale o contrato principal.

Espelha o comportamento verificado pelos testes em
[`test/auth.e2e-spec.ts`](../test/auth.e2e-spec.ts); a documentação interativa
fica em `/docs` e o OpenAPI JSON em `/docs-json`.

> **Em produção, `/docs` e `/docs-json` não existem (404).** O Swagger só é
> registrado com `NODE_ENV` diferente de `production`; em produção, este
> documento é a referência.

As rotas de atividades (`/activities`) estão em
[`ACTIVITIES-CONTRACT.md`](ACTIVITIES-CONTRACT.md); os padrões descritos aqui
(Bearer, formato de erro, interceptor) valem para elas também.

O **access token** vai no corpo JSON e volta em
`Authorization: Bearer <accessToken>`. Trate-o como opaco: o payload só tem o
id do usuário (`sub`) e claims técnicas, **sem email**. Os dados do usuário
vêm do `user` da resposta ou de `GET /me`. O **refresh token** também trafega no
corpo JSON: o app o recebe no corpo e o envia no corpo.

Base em desenvolvimento: `http://localhost:3000`.

## X-Client-Type é obrigatório

No app, o valor é sempre `mobile`. Nas rotas que emitem ou leem o refresh token
(`/auth/signup`, `/auth/login`, `/auth/refresh`, `/auth/logout`,
`/auth/logout-all`, `/auth/google/exchange`):

| Header                             | Resposta                                               |
| ---------------------------------- | ------------------------------------------------------ |
| `X-Client-Type: mobile`            | Fluxo normal (case-insensitive, espaços são ignorados) |
| Ausente                            | **400** `x-client-type header is required...`          |
| Valor desconhecido (ex. `desktop`) | **400** `x-client-type header must be one of...`       |

Não há default silencioso. `GET /auth/google`, `GET /auth/google/callback` e
`GET /me` **não** exigem o header; nelas ele é ignorado, então enviá-lo em
todas as requests é seguro.

## Fluxo mobile

| Aspecto                        | `mobile`                                                                                             |
| ------------------------------ | ---------------------------------------------------------------------------------------------------- |
| Configuração do cliente        | Nada (sem cookies)                                                                                   |
| Corpo de signup/login/exchange | `{ accessToken, refreshToken, user }`                                                                |
| Corpo de `/auth/refresh`       | `{ accessToken, refreshToken }`                                                                      |
| Enviar o refresh token         | `{ "refreshToken": "eyJ..." }` no corpo                                                              |
| Token no canal errado          | Cookie `refreshToken` presente na request → **400**                                                  |
| Logout                         | Revoga no banco                                                                                      |
| Logout de todos os dispositivos | Bearer; encerra todas as sessões do usuário (app e web)                                             |
| Onde o cliente guarda          | Armazenamento seguro do Android (Android Keystore protegendo os tokens, ex. DataStore criptografado) |

Como o app não deve mandar cookie `refreshToken`, o cliente HTTP não precisa de
nenhum armazenamento de cookies. Rotação, detecção de reuso e revogação do
refresh token são feitas no servidor; o banco guarda apenas o SHA-256 do token.

Nenhuma resposta contém senha, hash de senha ou `googleId`. O objeto `user` é
sempre este:

```json
{
  "id": "c7a3d2f4-8b1e-4c7a-9f3d-2e1b5a6c8d9e",
  "email": "ana@example.com",
  "name": "Ana",
  "avatarUrl": null,
  "emailVerified": false,
  "hasPassword": true,
  "createdAt": "2026-09-21T19:26:10.085Z"
}
```

`hasPassword: false` identifica conta sem senha: criada via Google, ou conta
local com email não verificado cuja senha foi descartada ao ser vinculada ao
Google (ver [Login com Google](#login-com-google)).

## Validade dos tokens

Os valores abaixo são o **padrão, configurável por variável de ambiente** no
servidor; não são garantia e podem mudar por ambiente sem aviso ao app.

| Token   | Variável          | Padrão     |
| ------- | ----------------- | ---------- |
| Access  | `JWT_ACCESS_TTL`  | 15 minutos |
| Refresh | `JWT_REFRESH_TTL` | 7 dias     |
| Repetição do refresh já usado (tolerância) | `REFRESH_GRACE_SECONDS` | 30 segundos (máximo 60; 0 desativa) |

A validade do refresh token é uma **janela deslizante**: cada chamada bem-sucedida
a `/auth/refresh` emite um refresh token novo com a validade completa contada a
partir daquele momento, e não herda o prazo do login original. Não há limite
absoluto de duração da sessão: ela só expira se o app passar um período inteiro
de `JWT_REFRESH_TTL` (7 dias no padrão) sem renovar, ou se for encerrada
(logout, logout de todos os dispositivos, ou detecção de reuso na sessão deste
dispositivo).

Consequência para o app: **renovar ao receber 401 é suficiente.** Não é preciso
ler o `exp` dos tokens, agendar renovação antes da expiração nem fixar esses
valores no código. Um 401 por access token expirado é esperado durante o uso
normal e é tratado pelo `Authenticator` (ver [Interceptor](#interceptor)). Um
usuário que abre o app pelo menos uma vez dentro da janela do refresh token
continua logado; depois disso, a renovação na inicialização retorna 401 e o app
mostra o login.

### Sessão por dispositivo e janela de tolerância

Cada login (senha, signup ou Google) abre uma **sessão própria deste
dispositivo**, e as renovações dela continuam na mesma sessão.

Um refresh token que acabou de ser trocado em `/auth/refresh` ainda pode ser
reapresentado **uma única vez**, por até `REFRESH_GRACE_SECONDS` (30 segundos
no padrão) contados daquela troca, e recebe um par novo e válido da mesma
sessão. É para o caso em que a resposta do refresh se perde (timeout, troca de
Wi-Fi/4G, app morto em background): o servidor renovou, mas o app ficou com o
token antigo. Ver [Erro de rede no refresh](#erro-de-rede-no-refresh).

Fora disso, reapresentar um refresh token já usado é tratado como roubo
(**reuso**): o servidor encerra **a sessão deste dispositivo** (todos os tokens
dela) e responde 401 `Invalid refresh token`. As sessões do mesmo usuário em
outros aparelhos e no web **não** são afetadas. Contam como reuso:

- repetir depois da janela;
- repetir pela segunda vez o mesmo token (a tolerância vale uma vez);
- repetir um token depois que o token que o substituiu já foi usado num
  refresh.

## Endpoints

| Método | Rota                    | `X-Client-Type` | Corpo enviado                | Sucesso | Resposta                                  |
| ------ | ----------------------- | --------------- | ---------------------------- | ------- | ----------------------------------------- |
| POST   | `/auth/signup`          | `mobile`        | `email`, `password`, `name?` | 201     | `accessToken`, `refreshToken`, `user`     |
| POST   | `/auth/login`           | `mobile`        | `email`, `password`          | 200     | `accessToken`, `refreshToken`, `user`     |
| POST   | `/auth/refresh`         | `mobile`        | `refreshToken`               | 200     | `accessToken`, `refreshToken`             |
| POST   | `/auth/logout`          | `mobile`        | `refreshToken`               | 204     | corpo vazio                               |
| POST   | `/auth/logout-all`      | `mobile`        | vazio (Bearer)               | 204     | corpo vazio                               |
| GET    | `/auth/google`          | —               | —                            | 302     | redirect para o Google (ver aviso abaixo) |
| POST   | `/auth/google/exchange` | `mobile`        | `code`                       | 200     | `accessToken`, `refreshToken`, `user`     |
| GET    | `/me`                   | —               | — (Bearer)                   | 200     | apenas `user`                             |

A validação rejeita campos desconhecidos: enviar `name` em `/auth/login`
retorna **400**, não é ignorado. `email` é normalizado no servidor (trim +
minúsculas); `password` tem entre 8 e 128 caracteres no cadastro.

A senha é normalizada em **NFKC** no servidor, no cadastro e no login: senhas
equivalentes em Unicode entram igual ("é" pré-composto ou "e" + acento
combinante, "ｐａｓｓ" de largura total ou "pass"). Não normalize no cliente:
envie o que a pessoa digitou. O limite de 128 caracteres vale também depois
da normalização, que pode expandir alguns caracteres (ex.: "㍿" vira 4); se
passar, o cadastro responde **400** com
`password must be shorter than or equal to 128 characters after Unicode normalization (NFKC)`.

No cadastro, a senha também é conferida numa lista de **senhas vazadas**
(Have I Been Pwned). Se aparecer lá, o cadastro responde **400** com
`password has appeared in a known data breach; choose a different one`, e o
formulário deve pedir outra senha. O mínimo continua 8 caracteres. Se a lista
estiver fora do ar, o cadastro segue normalmente. O login não faz essa
checagem: uma senha que vazou depois do cadastro continua entrando.

### Exemplos

```http
POST /auth/login
Content-Type: application/json
X-Client-Type: mobile

{ "email": "ana@example.com", "password": "S3nh@Forte!" }
```

```http
HTTP/1.1 200 OK

{ "accessToken": "eyJ...", "refreshToken": "eyJ...", "user": { ... } }
```

```http
POST /auth/refresh
Content-Type: application/json
X-Client-Type: mobile

{ "refreshToken": "eyJ..." }

HTTP/1.1 200 OK

{ "accessToken": "eyJ...", "refreshToken": "<novo>" }
```

```http
POST /auth/logout
Content-Type: application/json
X-Client-Type: mobile

{ "refreshToken": "eyJ..." }

HTTP/1.1 204 No Content
```

`GET /me` devolve o objeto `user` na raiz, sem envelope.

### Sair de todos os dispositivos

`POST /auth/logout-all` encerra **todas** as sessões do usuário: as deste
aparelho, as de outros celulares e as do web. É o "sair de todos os
dispositivos" para um celular perdido ou roubado.

- Autentica pelo **access token** (`Authorization: Bearer`), não pelo refresh
  token. O corpo fica vazio.
- Exige `X-Client-Type: mobile`, como as demais rotas de token.
- Os **outros dispositivos** continuam com o access token que já tinham até
  ele expirar; no próximo `/auth/refresh` recebem 401 `Invalid refresh token`
  e vão para o login.
- O **access token atual continua válido até expirar** (é stateless, até
  `JWT_ACCESS_TTL`). Por isso o app deve descartar os dois tokens e limpar o
  estado local logo após a resposta, como no logout.
- Idempotente: sem sessões abertas, responde 204 do mesmo jeito.
- Rate limit próprio: 20 req/min por IP.

```http
POST /auth/logout-all
Authorization: Bearer eyJ...
X-Client-Type: mobile

HTTP/1.1 204 No Content
```

| Situação                                      | Código | `message`                             |
| --------------------------------------------- | ------ | ------------------------------------- |
| Sem Bearer, ou access token inválido/expirado | 401    | `Unauthorized`                        |
| Sem `X-Client-Type`                           | 400    | `x-client-type header is required...` |

## Erros

Todo erro sai neste formato (filtro global):

```json
{
  "statusCode": 401,
  "error": "Unauthorized",
  "message": "Invalid credentials",
  "path": "/auth/login",
  "timestamp": "2026-09-21T19:26:21.843Z"
}
```

`message` é **string ou array de strings** — array nos erros de validação (400).

| Código | Quando acontece                                                                                                                                                             | O que o app faz                                                       |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| 400    | Body inválido, campo desconhecido, `code` com tamanho ≠ 43, **`X-Client-Type` ausente/inválido**, **cookie `refreshToken` presente na request**                             | Mostra os erros de campo (`message` pode ser array)                   |
| 401    | Credenciais erradas, email inexistente, conta só-Google, access token ausente/inválido/expirado, refresh token ausente/inválido/expirado/revogado, código de troca inválido | Em request comum, tenta refresh; em `/auth/refresh`, faz logout local |
| 404    | Token válido de um usuário que foi apagado                                                                                                                                  | Limpa a sessão local                                                  |
| 409    | `POST /auth/signup` com email já cadastrado; `POST /activities/import` com arquivo já importado                                                                             | Mostra "email já em uso" (signup) ou "já importada" (importação)      |
| 429    | Rate limit por IP: 10 req/min em `/auth/login` e `/auth/signup`; 30 em `/auth/refresh` e `/auth/logout`; 20 em `/auth/google/exchange`, `/auth/logout-all` e `POST /activities/import`; 100 no resto. Também por conta, em `/auth/login` (ver abaixo) | Mostra "muitas tentativas, aguarde"; espera o `Retry-After`. Não limpa a sessão |

Casos específicos do refresh token:

| Situação                                                                                   | Código | `message`                                          |
| ------------------------------------------------------------------------------------------ | ------ | -------------------------------------------------- |
| Cookie `refreshToken` presente na request mobile                                           | 400    | `must not be sent when X-Client-Type is mobile...` |
| `/auth/refresh` sem `refreshToken` no corpo                                                | 401    | `Missing refresh token`                            |
| `/auth/refresh` com token recusado: inválido, expirado, desconhecido, encerrado ou já usado fora da tolerância | 401    | `Invalid refresh token`                            |
| `/auth/logout` com JWT inválido ou expirado (token desconhecido: 204)                      | 401    | `Invalid refresh token`                            |
| `/auth/logout` sem `refreshToken` no corpo                                                 | 204    | — (idempotente)                                    |

Senha errada e email inexistente retornam **o mesmo** 401 com
`"Invalid credentials"`, de propósito (não revelar quais emails existem).
Pelo mesmo motivo, todo refresh token enviado e recusado recebe o mesmo 401
`"Invalid refresh token"`, inclusive quando o backend detecta reuso e encerra
a sessão deste dispositivo. O motivo fica só no log do servidor. O app não
tem como (nem precisa) distinguir os casos: trate como sessão encerrada.

**Limite por conta no login.** Depois de **5 falhas** de login para o mesmo
email em **15 minutos** (valores padrão do servidor), todo
`POST /auth/login` daquele email responde **429, mesmo com a senha certa**,
até os 15 minutos contados da primeira falha acabarem. Vale para qualquer
email, exista ou não a conta, e a resposta é **idêntica** à do rate limit por
IP: mesmo `statusCode`, `error`, `message`
(`ThrottlerException: Too Many Requests`) e header `Retry-After` (segundos até
liberar). O app não tem como (nem precisa) distinguir os dois casos. Um login
certo antes do limite zera a contagem. O bloqueio não afeta sessões já
abertas (`/auth/refresh`) nem o login com Google.

Em qualquer 429: mostre "muitas tentativas, aguarde" (sem dizer que a conta
foi bloqueada), não refaça o login automaticamente e use o `Retry-After` se
quiser exibir o tempo de espera. Um 429 em `/auth/refresh` não é sessão
encerrada: mantenha o refresh token e tente de novo depois.

## Login com Google

> **⚠️ O app ainda NÃO consegue concluir este fluxo.** O callback do Google
> termina com um redirect 302 para `{FRONTEND_URL}/auth/callback?code=...`, ou
> seja, para o cliente **web**. Não há hoje um destino de redirect para o app,
> então ele nunca recebe o `code` a trocar. O login nativo
> (`POST /auth/google/token` recebendo o `idToken` do Google) ainda não existe —
> ver [Lacunas conhecidas](#lacunas-conhecidas). Não implemente login com Google
> no app contra o fluxo atual.

Como o fluxo funciona hoje, para referência:

1. O cliente navega (navegação de browser, não chamada HTTP) para
   `{API}/auth/google`, que responde 302 para o Google e seta um cookie curto
   de state. Esta rota **não** leva `X-Client-Type`.
2. O Google chama de volta a **API** (`GOOGLE_CALLBACK_URL`). O backend confere
   o `state` contra o cookie, troca o code com PKCE e cria ou vincula o
   usuário. Nenhum token é emitido aqui.
3. A API responde 302 para `{FRONTEND_URL}/auth/callback?code=<código>`, ou
   para `{FRONTEND_URL}/auth/callback?error=<código>` em caso de falha —
   **é este passo que exclui o app**. Nenhum token trafega na URL.
4. Quem recebe o `code` chama `POST /auth/google/exchange` com
   `{ "code": "..." }` e o header `X-Client-Type`. Com `X-Client-Type: mobile`,
   a resposta segue o formato mobile (`accessToken`, `refreshToken`, `user`).

O fluxo exige que o browser aceite cookies de primeira parte da API durante o
redirect: o cookie `googleOAuthState` (HttpOnly, `SameSite=Lax`,
`Path=/auth/google`, 10 minutos) liga o callback ao browser que iniciou o login
(`state` + PKCE contra login CSRF) e é apagado no callback, em qualquer
desfecho. Qualquer navegador embutido que um dia rode este fluxo (Custom Tab,
por exemplo) precisa manter esse cookie entre os passos 1 e 2.

Falhas do callback nunca terminam em JSON na API. O `error` é sempre um destes
códigos fixos (nada do Google, como `error_description`, é repassado):

| `error`              | Quando                                                                                    |
| -------------------- | ----------------------------------------------------------------------------------------- |
| `access_denied`      | O usuário cancelou na tela de consentimento do Google                                     |
| `email_not_verified` | O Google não garante o email da conta (a conta não é vinculada nem criada)                |
| `state_mismatch`     | Cookie de state ausente, expirado (> 10 min), adulterado, ou `state` divergente           |
| `oauth_failed`       | Qualquer outra falha: `code` inválido ou expirado, outro `error=` do Google, erro interno |

O código tem exatamente **43 caracteres** do alfabeto `A-Za-z0-9-_` (32 bytes em
base64url). No banco fica apenas o SHA-256 dele.

| Situação do código                | Resposta            |
| --------------------------------- | ------------------- |
| Válido                            | 200 + tokens + user |
| Já usado (uso único)              | 401                 |
| Expirado (TTL de **60 segundos**) | 401                 |
| Inexistente/adulterado, 43 chars  | 401                 |
| Tamanho diferente de 43           | 400                 |

Vinculação de conta (backend), sempre exigindo email **verificado pelo
Google**:

| Situação no backend                                   | Resultado                                                        | `hasPassword` |
| ----------------------------------------------------- | ---------------------------------------------------------------- | ------------- |
| `googleId` já vinculado                               | Login direto                                                     | inalterado    |
| Conta local com o mesmo email, `emailVerified: true`  | Vincula; senha e sessões existentes continuam valendo            | inalterado    |
| Conta local com o mesmo email, `emailVerified: false` | Descarta a senha e **todas** as sessões da conta, depois vincula | `false`       |
| Nenhuma conta                                         | Cria conta sem senha                                             | `false`       |

O payload de resposta é o mesmo nos quatro casos.

Por que a conta não verificada perde a senha: o cadastro por email não
comprova a posse do email, então quem fez o signup pode não ser o dono (alguém
cadastra o email de outra pessoa e espera ela entrar com Google). Ao vincular,
o backend apaga numa única transação o `passwordHash`, todos os refresh tokens
e os códigos de troca pendentes da conta. Consequências para o cliente:

- Login por senha nessa conta passa a responder **401 `Invalid credentials`**;
  o usuário só entra com Google.
- Refresh tokens emitidos antes da vinculação passam a responder **401
  `Invalid refresh token`**, em qualquer dispositivo. Trate como sessão
  encerrada e mande para o login.
- Access tokens já emitidos continuam válidos até expirar (são stateless; até
  `JWT_ACCESS_TTL`, 15 minutos por padrão).
- **Ainda não existe fluxo para definir uma senha nova** (ver
  [Lacunas conhecidas](#lacunas-conhecidas)). Com `hasPassword: false`, não
  ofereça login por senha para essa conta.

## Interceptor

Quatro regras que o backend impõe, em ordem de gravidade:

1. **`/auth/refresh` é de uso único e devolve token novo.** O app deve
   substituir o access **e** o refresh a cada renovação; guardar o refresh
   antigo quebra a próxima renovação.
2. **Reapresentar um refresh token já rotacionado encerra a sessão deste
   dispositivo** (o backend interpreta como roubo), exceto uma única repetição
   dentro da [janela de tolerância](#sessão-por-dispositivo-e-janela-de-tolerância).
   As sessões em outros dispositivos continuam. Garanta **um único refresh em
   voo**, com as demais requests aguardando o resultado dele: a tolerância é
   para a resposta perdida, não para refreshes paralelos.
3. **Não intercepte as rotas de auth.** Um 401 de `/auth/login` ou
   `/auth/refresh` não deve disparar refresh — isso gera laço infinito.
4. **Todas as chamadas precisam do header `X-Client-Type: mobile`.** Sem ele, a
   API responde 400 em vez do erro esperado.

### Como isso se traduz no OkHttp

A implementação no Android se divide em duas peças do OkHttp: um
`Interceptor`, que decora toda request de saída, e um `Authenticator`, que o
OkHttp aciona automaticamente quando uma resposta volta com 401.

O **Interceptor** adiciona a todas as requests o header `X-Client-Type: mobile`
(regra 4) e, quando existe um access token salvo, o header
`Authorization: Bearer <access>` com o valor atual do armazenamento seguro.

O **Authenticator** trata as respostas 401 das rotas que não são de auth. Se a
request que falhou for de `/auth/*` (em especial `/auth/login` e
`/auth/refresh`), ele desiste imediatamente, retornando `null` (regra 3). Ele
também retorna `null` se a request já foi refeita uma vez — o que dá para
detectar pela resposta anterior encadeada na resposta atual — para nunca entrar
em laço; e retorna `null` se não houver refresh token salvo.

Para garantir um único refresh em voo (regra 2), o Authenticator protege a
renovação com um lock — um `Mutex` de coroutines ou um bloco `synchronized`. A
primeira request que recebe 401 entra no lock e renova; as demais que receberem
401 ao mesmo tempo ficam bloqueadas aguardando a liberação. Ao entrar no lock,
cada uma compara o access token que usou na request original (o valor do
header `Authorization` dela) com o access token atual no armazenamento. Se
forem diferentes, outra chamada já renovou: basta refazer a request com o token
novo, **sem** chamar `/auth/refresh` de novo.

Quando de fato precisa renovar, o Authenticator chama `POST /auth/refresh` com
`X-Client-Type: mobile` e `{ "refreshToken": "..." }` no corpo, usando um
cliente (ou uma chamada) que **não** passa pelo próprio Authenticator — senão
um 401 do refresh dispararia outro refresh (regra 3). Em caso de sucesso, ele
persiste o novo access **e** o novo refresh no armazenamento seguro **antes**
de refazer a request original (regra 1), e então refaz essa request uma única
vez com o novo access token.

Se o refresh falhar com 401 (ou 404, usuário apagado), a sessão acabou: o app
limpa os tokens locais, retorna `null` e leva o usuário à tela de login com a
mensagem de sessão expirada. Isso vale também para o 401 de uma repetição fora
da janela de tolerância.

#### Erro de rede no refresh

Erro de rede é qualquer falha **sem** resposta HTTP do servidor (timeout,
conexão recusada ou caída, troca de rede). Nesse caso o servidor pode ter
renovado e a resposta se perdido, então:

1. **Não limpe a sessão** e **mantenha o refresh token que foi enviado**. Não
   há outro: o novo, se existiu, nunca chegou.
2. **Repita `/auth/refresh` com o MESMO refresh token, uma vez, logo em
   seguida** (sem backoff longo: a repetição precisa cair dentro da janela de
   `REFRESH_GRACE_SECONDS`, 30 s no padrão), ainda dentro do lock. Se der
   certo, siga o caminho de sucesso normal: persista o par devolvido e refaça a
   request original.
3. Se a repetição também falhar por rede, desista da request atual, mantenha os
   tokens salvos e deixe o erro chegar a quem chamou. A próxima tentativa (por
   exemplo, quando a rede voltar) usa o mesmo token salvo. Se o servidor
   não tinha recebido nenhuma das chamadas, ela renova normalmente; se tinha
   e a janela já passou, a resposta é 401 e a sessão local termina (passo
   acima).
4. Não repita mais de uma vez dentro da janela: a segunda repetição do mesmo
   token já conta como reuso e encerra a sessão deste dispositivo.

Uma resposta HTTP de erro do servidor (5xx, 429) não é erro de rede. A troca
do token é transacional, então nesse caso o token enviado normalmente continua
válido: mantenha-o e tente de novo mais tarde, sem limpar a sessão.

### Inicialização e logout

Ao abrir o app com um refresh token salvo, chame `/auth/refresh` **antes** de
exibir telas protegidas, persistindo o par de tokens devolvido. Se a resposta
for 401, trate como "sessão expirada": limpe os tokens e mostre o login. Em
erro de rede, aplique a mesma regra do
[erro de rede no refresh](#erro-de-rede-no-refresh): mantenha o token e
repita uma vez com ele. Sem refresh token salvo, vá direto ao login.

No logout, chame `POST /auth/logout` com `{ "refreshToken": "..." }` no corpo e
limpe todo o estado local. O access token continua tecnicamente válido até
expirar (é stateless), por isso descartá-lo no app é obrigatório. O logout é
idempotente (204 mesmo sem token), então a limpeza local deve acontecer
independentemente da resposta.

"Sair de todos os dispositivos" (`POST /auth/logout-all`, ver
[acima](#sair-de-todos-os-dispositivos)) é diferente num ponto: as outras
sessões só caem com o 204. Um 401 por access token expirado é tratado pelo
`Authenticator` como em qualquer request (renova e repete); limpe o estado
local depois do 204.

## Lacunas conhecidas

Não implementadas nesta etapa — o app não deve contar com elas:

- **Login nativo com Google no Android** (`POST /auth/google/token`
  recebendo o `idToken`). Hoje só existe o fluxo de redirect, que termina no
  cliente web (ver [Login com Google](#login-com-google)).
- **Verificação de email e reset de senha** (dependem de envio de email).
- **Definição de senha para conta sem senha** (`hasPassword: false`): contas
  criadas via Google e contas locais não verificadas que perderam a senha ao
  serem vinculadas ao Google.
- **Alteração de perfil** (nome, avatar). `GET /me` é somente leitura.

## Pendências do contrato

Dados de que o app precisa e que o contrato ainda não documenta — não assuma
valores para eles:

- **URL base de produção** da API. Só a base de desenvolvimento está
  documentada.
- **Identificação estável de erros.** Não há campo de código de erro além de
  `statusCode`, e as mensagens aparecem abreviadas no contrato; o app não deve
  depender do texto de `message` para decidir comportamento.
