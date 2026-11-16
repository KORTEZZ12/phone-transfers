#!/usr/bin/env node
// Собирает Postman-коллекцию из сценариев и контрактов:
//   phone-transfers.postman_collection.json — коллекция v2.1, её можно импортировать в Postman
//   mock.postman_environment.json           — окружение для mock-сервера
//   docs/testing/coverage.md                — какие строки таблицы отказов, правила и истории чем проверены
// Схемы ответов берутся из docs/api/openapi.yaml и internal-antifraud.yaml, схема события — из asyncapi.yaml.
// Каждый ответ публичного API коллекция сверяет с контрактом: код описан, тело по схеме, заголовки на месте.
// Запуск: cd tests && npm ci && npm run build. CI проверяет, что собранные файлы совпадают с репозиторием.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { folders, environment, lib, coverageNotes } from './scenarios.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const apiDir = join(root, 'docs/api');

// ------------------------------------------------------------------ контракты → JSON Schema draft-07

const docs = {};
const load = (file) => (docs[file] ??= YAML.parse(readFileSync(join(apiDir, file), 'utf8')));

function deref(ref, base) {
  const [file, pointer] = ref.includes('#') ? ref.split('#') : [ref, ''];
  const target = file ? file.replace(/^\.\//, '') : base;
  let node = load(target);
  for (const part of pointer.split('/').filter(Boolean)) node = node[part.replace(/~1/g, '/').replace(/~0/g, '~')];
  if (node === undefined) throw new Error(`Не найдена ссылка ${ref} из ${base}`);
  return { node, file: target };
}

const UUID = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
const DATE_TIME = '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d+)?(Z|[+-]\\d{2}:\\d{2})$';
const DROP = new Set(['description', 'example', 'examples', 'summary', 'title', 'deprecated', 'readOnly', 'writeOnly', 'externalDocs']);

// Схемы OpenAPI 3.1 почти совпадают с JSON Schema. Форматы заменяются шаблонами, чтобы проверка не зависела
// от версии валидатора в Postman, а у объектов запрещаются незадокументированные поля: так ловится расхождение
// mock и контракта в обе стороны
function toJsonSchema(schema, file) {
  if (Array.isArray(schema)) return schema.map((s) => toJsonSchema(s, file));
  if (!schema || typeof schema !== 'object') return schema;
  if (schema.$ref) {
    const { node, file: f } = deref(schema.$ref, file);
    const { $ref, ...siblings } = schema;
    return { ...toJsonSchema(node, f), ...toJsonSchema(siblings, file) };
  }
  const out = {};
  for (const [k, v] of Object.entries(schema)) {
    if (DROP.has(k)) continue;
    if (k === 'format') {
      if (v === 'uuid') out.pattern = UUID;
      if (v === 'date-time') out.pattern = DATE_TIME;
      continue;
    }
    if (k === 'properties') {
      out.properties = Object.fromEntries(Object.entries(v).map(([p, s]) => [p, toJsonSchema(s, file)]));
      continue;
    }
    out[k] = typeof v === 'object' ? toJsonSchema(v, file) : v;
  }
  if (out.properties && !('additionalProperties' in out)) out.additionalProperties = false;
  return out;
}

function operations(file) {
  const doc = load(file);
  const ops = [];
  for (const [path, item] of Object.entries(doc.paths)) {
    for (const [method, op] of Object.entries(item)) {
      const responses = {};
      for (const [code, resp0] of Object.entries(op.responses)) {
        const { node: resp, file: rf } = resp0.$ref ? deref(resp0.$ref, file) : { node: resp0, file };
        const [contentType, media] = Object.entries(resp.content ?? {})[0] ?? [];
        responses[code] = {
          contentType: contentType ?? null,
          schema: media ? toJsonSchema(media.schema, rf) : null,
          headers: Object.keys(resp.headers ?? {}),
        };
      }
      ops.push({
        id: op.operationId,
        method: method.toUpperCase(),
        path: '^' + path.replace(/\{[^}]+\}/g, '[^/]+') + '$',
        responses,
      });
    }
  }
  return ops;
}

const problem = toJsonSchema({ $ref: '#/components/schemas/Problem' }, 'openapi.yaml');
const CONTRACT = {
  operations: [...operations('openapi.yaml'), ...operations('internal-antifraud.yaml')],
  // 503 одинаков для всех операций и в операциях не описан (соглашения API)
  unavailable: { contentType: 'application/problem+json', schema: problem, headers: ['Retry-After'] },
  event: toJsonSchema({ $ref: '#/components/schemas/TransferStatusChangedPayload' }, 'asyncapi.yaml'),
};

// ------------------------------------------------------------------ сценарии → коллекция

// Тело функции сценария без обёртки function () { … }
function body(fn) {
  const src = fn.toString();
  return src.slice(src.indexOf('{') + 1, src.lastIndexOf('}')).replace(/^\n/, '').replace(/\s+$/, '');
}
const dedent = (code) => {
  const lines = code.split('\n');
  const pad = Math.min(...lines.filter((l) => l.trim()).map((l) => l.match(/^ */)[0].length));
  return lines.map((l) => l.slice(pad));
};
const LIB = dedent(body(lib));
const consts = (c) => Object.entries(c ?? {}).map(([k, v]) => `const ${k} = ${JSON.stringify(v)};`);
const script = (fn, c, extra = []) => (fn || extra.length
  ? ['// --- общие помощники, вставлены сборщиком', ...LIB, '// --- сценарий', ...consts(c), ...extra, ...(fn ? dedent(body(fn)) : [])]
  : null);

function item(step) {
  const headers = [];
  if (step.as) headers.push({ key: 'Authorization', value: `Bearer {{token_${step.as}}}` });
  for (const [key, value] of Object.entries(step.headers ?? {})) headers.push({ key, value });
  if (step.body !== undefined) headers.push({ key: 'Content-Type', value: 'application/json' });
  const event = [];
  const pre = script(step.pre, step.consts);
  const extra = [];
  if (step.eventSchema) extra.push(`const EVENT_SCHEMA = ${JSON.stringify(CONTRACT.event)};`);
  if (step.save) extra.push('if ([200, 201].includes(pm.response.code)) setv(SAVE, json().id);');
  const test = script(step.test, step.consts, extra);
  if (pre) event.push({ listen: 'prerequest', script: { type: 'text/javascript', exec: pre } });
  if (test) event.push({ listen: 'test', script: { type: 'text/javascript', exec: test } });
  const raw = `{{baseUrl}}${step.path}`;
  return {
    name: step.name,
    event,
    request: {
      method: step.method,
      header: headers,
      ...(step.body !== undefined ? { body: { mode: 'raw', raw: typeof step.body === 'string' ? step.body : JSON.stringify(step.body, null, 2) } } : {}),
      url: raw,
      ...(step.doc ? { description: step.doc } : {}),
    },
  };
}

// Проверка контракта: выполняется после каждого запроса коллекции
function contractCheck() {
  const path = pm.request.url.getPath();
  if (!path.startsWith('/__mock')) {
    const op = CONTRACT.operations.find((o) => o.method === pm.request.method && new RegExp(o.path).test(path));
    const code = String(pm.response.code);
    const spec = op && (op.responses[code] || (code === '503' ? CONTRACT.unavailable : null));
    pm.test(`Контракт · ${op ? op.id : path} · ответ ${code} описан в спецификации`, () => {
      pm.expect(op, 'операция есть в спецификации').to.be.ok;
      pm.expect(spec, `код ${code} есть среди ответов операции`).to.be.ok;
    });
    if (spec && spec.schema) {
      pm.test(`Контракт · ${op.id} · ${code}: тело и заголовки по схеме`, () => {
        pm.expect(pm.response.headers.get('Content-Type') || '').to.include(spec.contentType);
        const Ajv = require('ajv');
        const ajv = new Ajv({ allErrors: true });
        const ok = ajv.validate(spec.schema, pm.response.json());
        pm.expect(ok, ajv.errorsText()).to.equal(true);
        for (const h of spec.headers) pm.expect(pm.response.headers.has(h), `заголовок ${h}`).to.equal(true);
      });
    }
  }
}

const collection = {
  info: {
    _postman_id: '6b1d3c0e-4a52-4c8f-9d27-1f0e3a5b7c91',
    name: 'Переводы по номеру телефона — проверки по таблице отказов',
    description: [
      'Сценарии по таблице отказов (docs/design/failure-modes.md) и критериям историй (docs/requirements/user-stories.md).',
      'Каждая папка начинается со сброса mock и не зависит от других. Время в mock виртуальное: шаги «Время +…» двигают его вперёд.',
      'После каждого запроса к публичному API коллекция сверяет ответ с OpenAPI: код описан, тело по схеме, заголовки на месте.',
      'Файл собирается из tests/postman/scenarios.mjs командой npm run build, руками его не правят.',
    ].join('\n\n'),
    schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
  },
  event: [{ listen: 'test', script: { type: 'text/javascript', exec: [`const CONTRACT = ${JSON.stringify(CONTRACT)};`, ...dedent(body(contractCheck))] } }],
  item: folders.map((f) => ({
    name: f.name,
    description: [f.doc, `Строки таблицы отказов: ${f.rows.join(', ') || '—'}. Правила: ${f.rules.join(', ') || '—'}. Истории: ${f.stories.join(', ') || '—'}.`].filter(Boolean).join('\n\n'),
    item: f.items.map(item),
  })),
};

writeFileSync(join(here, 'phone-transfers.postman_collection.json'), JSON.stringify(collection, null, 2) + '\n');
writeFileSync(join(here, 'mock.postman_environment.json'), JSON.stringify({
  id: '0f6c2a9e-8d31-4b7a-a5e4-3c2b1a0f9e8d',
  name: 'phone-transfers mock',
  values: Object.entries(environment).map(([key, value]) => ({ key, value, type: 'default', enabled: true })),
  _postman_variable_scope: 'environment',
}, null, 2) + '\n');

// ------------------------------------------------------------------ матрица покрытия

const FAILURE_ROWS = [...readFileSync(join(root, 'docs/design/failure-modes.md'), 'utf8').matchAll(/^\| (\d+) \| ([^|]+) \|/gm)].map((m) => ({ n: Number(m[1]), title: m[2].trim() }));
const byRow = new Map();
const byRule = new Map();
const byStory = new Map();
const add = (map, key, folder) => { if (!map.has(key)) map.set(key, new Set()); map.get(key).add(folder); };
for (const f of folders) {
  for (const r of f.rows) add(byRow, r, f.name);
  for (const r of f.rules) add(byRule, r, f.name);
  for (const s of f.stories) add(byStory, s, f.name);
}
const anchor = (name) => '`' + name + '`';
const steps = folders.reduce((s, f) => s + f.items.length, 0);
const md = [
  '# Покрытие проверками',
  '',
  `Файл собирает [\`tests/postman/build.mjs\`](../../tests/postman/build.mjs) из сценариев коллекции, руками его не правят. В коллекции ${folders.length} папок и ${steps} запросов. Кроме того, каждый ответ публичного API сверяется с OpenAPI.`,
  '',
  '## Таблица отказов',
  '',
  '| № | Ситуация | Папка коллекции | Чем ещё проверено |',
  '|---|---|---|---|',
  ...FAILURE_ROWS.map(({ n, title }) => `| ${n} | ${title} | ${[...(byRow.get(n) ?? [])].map(anchor).join(', ') || '—'} | ${coverageNotes.rows[n] ?? '—'} |`),
  '',
  '## Бизнес-правила',
  '',
  '| Правило | Папка коллекции | Чем ещё проверено |',
  '|---|---|---|',
  ...Array.from({ length: 38 }, (_, i) => `TR-${String(i + 1).padStart(2, '0')}`).map((r) => `| ${r} | ${[...(byRule.get(r) ?? [])].map(anchor).join(', ') || '—'} | ${coverageNotes.rules[r] ?? '—'} |`),
  '',
  '## Пользовательские истории',
  '',
  '| История | Папка коллекции |',
  '|---|---|',
  ...['US-01', 'US-02', 'US-03', 'US-04', 'US-05', 'US-06', 'US-07'].map((s) => `| ${s} | ${[...(byStory.get(s) ?? [])].map(anchor).join(', ') || '—'} |`),
  '',
];
mkdirSync(join(root, 'docs/testing'), { recursive: true });
writeFileSync(join(root, 'docs/testing/coverage.md'), md.join('\n'));

console.log(`Коллекция: ${folders.length} папок, ${steps} запросов. Операций в контракте: ${CONTRACT.operations.length}`);
