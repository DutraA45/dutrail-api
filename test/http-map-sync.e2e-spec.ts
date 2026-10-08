import { readFileSync } from 'node:fs';

/** `MÉTODO /caminho`, no mesmo formato de `docs/openapi.json` (ex.: `/activities/{id}`). */
type Route = string;

interface OpenApiDocument {
  paths: Record<string, Record<string, unknown>>;
}

function openApiRoutes(): Set<Route> {
  const doc = JSON.parse(
    readFileSync('docs/openapi.json', 'utf8'),
  ) as OpenApiDocument;
  const routes = new Set<Route>();
  for (const [path, methods] of Object.entries(doc.paths)) {
    for (const method of Object.keys(methods)) {
      routes.add(`${method.toUpperCase()} ${path}`);
    }
  }
  return routes;
}

/**
 * Só a primeira coluna das tabelas de rota (entre crases, logo depois do
 * `|` que abre a linha) — não menções à rota em texto corrido ou nos
 * diagramas, que não seguem esse formato.
 */
const ROUTE_TABLE_CELL = /^\|\s*`(GET|POST|PUT|PATCH|DELETE) ([^\s`]+)`\s*\|/gm;

function httpMapRoutes(): Set<Route> {
  const text = readFileSync('docs/HTTP-MAP.md', 'utf8');
  const routes = new Set<Route>();
  for (const match of text.matchAll(ROUTE_TABLE_CELL)) {
    routes.add(`${match[1]} ${match[2]}`);
  }
  return routes;
}

describe('docs/HTTP-MAP.md em sincronia com docs/openapi.json (e2e)', () => {
  it('toda rota do openapi.json está mapeada, e o mapa não cita rota inexistente', () => {
    const fromOpenApi = openApiRoutes();
    const fromMap = httpMapRoutes();

    const missingFromMap = [...fromOpenApi]
      .filter((route) => !fromMap.has(route))
      .sort();
    const unknownInMap = [...fromMap]
      .filter((route) => !fromOpenApi.has(route))
      .sort();

    expect(
      missingFromMap,
      'rotas do openapi.json ausentes de docs/HTTP-MAP.md',
    ).toEqual([]);
    expect(
      unknownInMap,
      'rotas citadas em docs/HTTP-MAP.md que não existem em docs/openapi.json',
    ).toEqual([]);
  });
});
