// Проверка BPMN: схема BPMN 2.0, нет висящих узлов, у каждого элемента есть разметка на диаграмме.
// Запуск: npm install --no-save bpmn-moddle@9 && node scripts/validate-bpmn.mjs docs/design/bpmn/antifraud-161fz.bpmn
import BpmnModdle from 'bpmn-moddle';
import fs from 'node:fs';
const xml = fs.readFileSync(process.argv[2], 'utf8');
const { rootElement, warnings } = await new BpmnModdle().fromXML(xml);
const proc = rootElement.rootElements.find(e => e.$type === 'bpmn:Process');
const flows = proc.flowElements.filter(e => e.$type === 'bpmn:SequenceFlow');
const nodes = proc.flowElements.filter(e => e.$type !== 'bpmn:SequenceFlow');
const dangling = nodes.filter(n => n.$type !== 'bpmn:StartEvent' && n.$type !== 'bpmn:BoundaryEvent' && !(n.incoming||[]).length)
  .concat(nodes.filter(n => n.$type !== 'bpmn:EndEvent' && !(n.outgoing||[]).length));
console.log('warnings:', warnings.length, warnings.map(w => w.message).slice(0,5));
console.log('узлов:', nodes.length, 'потоков:', flows.length, 'висящих:', dangling.map(d => d.id));
const di = rootElement.diagrams[0].plane.planeElement.length;
console.log('элементов на диаграмме:', di);
const expected = 1 + proc.laneSets.reduce((n, s) => n + s.lanes.length, 0) + nodes.length + flows.length;
if (warnings.length || dangling.length || di !== expected) {
  console.error(`ошибка: предупреждений ${warnings.length}, висящих узлов ${dangling.length}, разметки ${di} из ${expected}`);
  process.exit(1);
}
console.log('ок');
