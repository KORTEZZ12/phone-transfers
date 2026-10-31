// Проверка AsyncAPI официальным парсером: падает на любой ошибке или предупреждении.
// Запуск: npm install --no-save @asyncapi/parser@3.6.6 && node scripts/validate-asyncapi.mjs docs/api/asyncapi.yaml
import { Parser } from '@asyncapi/parser';
import fs from 'node:fs';

const file = process.argv[2];
const { document, diagnostics } = await new Parser().parse(fs.readFileSync(file, 'utf8'));
const level = ['error', 'warning', 'info', 'hint'];
for (const d of diagnostics) {
  console.log(`${level[d.severity] ?? d.severity}  ${d.code}  ${d.message}  @ ${(d.path ?? []).join('.')}`);
}
const bad = diagnostics.filter((d) => d.severity <= 1);
if (!document || bad.length) {
  console.error(`${file}: ошибок и предупреждений — ${bad.length}`);
  process.exit(1);
}
console.log(`${file}: ок, диагностик ${diagnostics.length}`);
