# Documentação — dutrail-api

Índice da documentação em `docs/`. Cobre dois tipos de material: o
**contrato** da API (o que os clientes podem assumir) e o **mapa** do
projeto (como o código e as rotas estão organizados, útil para quem
mantém o repositório).

## Documentos

| Documento                                            | Para que serve                                                                                                | Quem lê                                                                                            | Fonte da verdade ou derivado                                                                                   | Como é gerado/atualizado                                                                             |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| [`API-CONTRACT.md`](API-CONTRACT.md)                 | Contrato de autenticação e dos padrões comuns a toda a API (erro, rate limit, refresh no 401, CORS)           | Cliente web (Angular); base para os demais contratos                                               | Fonte da verdade do comportamento para o cliente web                                                           | Mantido manualmente; conferido contra o código e contra requisições reais                            |
| [`ACTIVITIES-CONTRACT.md`](ACTIVITIES-CONTRACT.md)   | Contrato das rotas `/activities` (listagem, detalhe, importação)                                              | Cliente web e app Android                                                                          | Fonte da verdade do comportamento dessas rotas                                                                 | Mantido manualmente; conferido contra o código e contra requisições reais                            |
| [`AUTH-CONTRACT-MOBILE.md`](AUTH-CONTRACT-MOBILE.md) | O mesmo contrato de autenticação do ponto de vista do app Android (`X-Client-Type: mobile`); autossuficiente  | App Android                                                                                        | Fonte da verdade do comportamento para o app                                                                   | Mantido manualmente; conferido contra o código e contra requisições reais                            |
| [`SECURITY-AUDIT.md`](SECURITY-AUDIT.md)             | Auditoria de segurança da autenticação: achados (A-01 a A-21), status de correção e riscos aceitos            | Mantenedores                                                                                       | Registro de um ponto no tempo (auditoria + fechamento), não regenerado                                         | Mantido manualmente; cada achado foi conferido no código e no histórico do git na data do fechamento |
| [`openapi.json`](openapi.json)                       | Documento OpenAPI/Swagger servido em `/docs-json` (fora de produção)                                          | Ferramentas (Swagger UI, geradores de cliente) e mantenedores, para conferir paridade com o código | Derivado do código; **não** é a referência de comportamento (essa é o `API-CONTRACT.md` e os demais contratos) | Gerado por `npm run openapi:generate` (compila a app e lê `/docs-json` sem precisar de banco)        |
| [`HTTP-MAP.md`](HTTP-MAP.md)                         | Mapa de todas as rotas HTTP, comportamentos globais e fluxos (login, refresh, importação etc.)                | Mantenedores                                                                                       | Derivado do código e do `openapi.json`; a sincronia das rotas listadas é conferida por teste automatizado      | Mantido manualmente; `test/http-map-sync.e2e-spec.ts` falha se o mapa e o `openapi.json` divergirem  |
| [`CODE-MAP.md`](CODE-MAP.md)                         | Mapa do código: estrutura de pastas, responsabilidade de cada módulo e onde vive cada comportamento relevante | Mantenedores                                                                                       | Derivado do código                                                                                             | Mantido manualmente, sem geração ou verificação automatizada                                         |

## Ordem de leitura sugerida

1. [`API-CONTRACT.md`](API-CONTRACT.md) — define os padrões comuns (erro,
   rate limit, refresh) usados pelos demais documentos.
2. [`ACTIVITIES-CONTRACT.md`](ACTIVITIES-CONTRACT.md) e
   [`AUTH-CONTRACT-MOBILE.md`](AUTH-CONTRACT-MOBILE.md) — complementam o
   primeiro; o segundo é autossuficiente para quem só integra o app Android.
3. [`HTTP-MAP.md`](HTTP-MAP.md) — visão consolidada de todas as rotas e dos
   fluxos entre elas, a partir do código.
4. [`CODE-MAP.md`](CODE-MAP.md) — estrutura do código por trás das rotas.

[`SECURITY-AUDIT.md`](SECURITY-AUDIT.md) e [`openapi.json`](openapi.json)
são referências consultadas conforme a necessidade, fora dessa sequência.

## Manutenção

Este repositório é **público**. Nenhum documento em `docs/` deve conter URL
real de produção, IP, host de banco, nome de bucket, valor de variável de
ambiente classificada como segredo, token, cookie real ou e-mail real.
Variáveis de ambiente são descritas só por nome, finalidade e, quando não
forem segredo, padrão.

Ao alterar rotas, contratos ou a estrutura do código, atualize o documento
correspondente na mesma mudança: os contratos e o `HTTP-MAP.md` descrevem
comportamento voltado a quem integra a API; o `CODE-MAP.md`, a organização
interna. Depois de mudar uma rota, regenere o snapshot com
`npm run openapi:generate` e rode `npm run test:e2e` — o teste de sincronia
do `HTTP-MAP.md` e o snapshot do Swagger (`test/swagger-by-env.e2e-spec.ts`)
falham se o código e os documentos divergirem.
