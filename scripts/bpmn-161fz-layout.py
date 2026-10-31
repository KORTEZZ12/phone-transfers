# Генератор BPMN 2.0 с разметкой и SVG-превью процесса 161-ФЗ из одной раскладки.
# Запуск из корня репозитория: python3 scripts/bpmn-161fz-layout.py
import html
OUT = 'docs/design/bpmn/antifraud-161fz'
CW, X0 = 140, 150                       # ширина колонки, x центра колонки 0
def X(c): return X0 + c * CW
LANES = [  # id, имя, верх, высота
    ('lane_client', 'Отправитель', 0, 140),
    ('lane_service', 'Сервис переводов', 140, 220),
    ('lane_af', 'Антифрод', 360, 240),
    ('lane_sb', 'Сотрудник СБ', 600, 140),
]
Y = {'L1A': 70, 'L2A': 210, 'L2B': 305, 'L3A': 430, 'L3B': 525, 'L4A': 670, 'CH': 588}
TW, TH, EV, GW = 112, 70, 36, 50
# id: (тип, имя, линия, колонка, строка)
N = {
 'start':      ('startEvent', 'Сумма заблокирована', 'lane_service', 0, 'L2A'),
 't_check':    ('serviceTask', 'Запросить проверку перевода', 'lane_service', 1, 'L2A'),
 't_af':       ('serviceTask', 'Проверить признаки и базу ЦБ', 'lane_af', 2, 'L3A'),
 'g_need':     ('exclusiveGateway', 'Нужна ручная проверка?', 'lane_af', 3, 'L3A'),
 't_manual':   ('userTask', 'Проверить перевод вручную', 'lane_sb', 4, 'L4A'),
 'g_dec':      ('exclusiveGateway', 'Решение', 'lane_af', 5, 'L3A'),
 't_rej_af':   ('serviceTask', 'Отклонить, снять холд', 'lane_service', 5, 'L2B'),
 'end_rej_af': ('endEvent', 'Отклонён', 'lane_service', 6, 'L2B'),
 't_suspend':  ('serviceTask', 'Приостановить, пуш с запросом', 'lane_service', 7, 'L2A'),
 't_confirm':  ('userTask', 'Подтвердить или отменить перевод', 'lane_client', 9, 'L1A'),
 'g_conf':     ('exclusiveGateway', 'Подтвердил?', 'lane_client', 11, 'L1A'),
 't_rej_nc':   ('serviceTask', 'Отклонить: не подтверждён', 'lane_service', 9, 'L2B'),
 'end_rej_nc': ('endEvent', 'Отклонён', 'lane_service', 10, 'L2B'),
 't_cancel':   ('serviceTask', 'Отменить, снять холд', 'lane_service', 11, 'L2B'),
 'end_cancel': ('endEvent', 'Отменён', 'lane_service', 12, 'L2B'),
 't_recheck':  ('serviceTask', 'Повторно сверить с базой ЦБ', 'lane_af', 13, 'L3B'),
 'g_cbr':      ('exclusiveGateway', 'Есть новые сведения?', 'lane_af', 14, 'L3B'),
 'tm_wait':    ('intermediateCatchEvent', '2 дня от приостановки, P-21', 'lane_service', 15, 'L2B'),
 'g_join':     ('exclusiveGateway', '', 'lane_service', 15, 'L2A'),
 't_post':     ('serviceTask', 'Провести перевод', 'lane_service', 16, 'L2A'),
 'end_ok':     ('endEvent', 'Выполнен', 'lane_service', 17, 'L2A'),
}
BOUND = {  # граничные таймеры: id: (к чему, имя, x-сдвиг, сторона)
 'bt_48':  ('t_manual', '48 ч от первого REVIEW, P-11', 30, 'top'),
 'bt_p20': ('t_confirm', 'Срок P-20', 0, 'bottom'),
}
def size(t):
    if t.endswith('Task'): return TW, TH
    if t.endswith('Gateway'): return GW, GW
    return EV, EV
def ctr(i):
    if i in BOUND:
        host, _, dx, side = BOUND[i]; hx, hy = ctr(host)
        return hx + dx, hy - TH/2 if side == 'top' else hy + TH/2
    t, _, _, c, r = N[i]; return X(c), Y[r]
def box(i):
    x, y = ctr(i); w, h = size(N[i][0]) if i in N else (EV, EV)
    return x - w/2, y - h/2, w, h
def side(i, s):
    x, y = ctr(i); w, h = size(N[i][0]) if i in N else (EV, EV)
    return {'l': (x - w/2, y), 'r': (x + w/2, y), 't': (x, y - h/2), 'b': (x, y + h/2)}[s]
# потоки: id, из, в, имя, точки (выход, промежуточные, вход)
def P(i, s): return side(i, s)
F = []
def flow(fid, a, b, name, pts): F.append((fid, a, b, name, pts))
flow('f1', 'start', 't_check', '', [P('start','r'), P('t_check','l')])
flow('f2', 't_check', 't_af', '', [P('t_check','r'), (X(1)+70, Y['L2A']), (X(1)+70, Y['L3A']), P('t_af','l')])
flow('f3', 't_af', 'g_need', '', [P('t_af','r'), P('g_need','l')])
flow('f4', 'g_need', 'g_dec', 'Нет', [P('g_need','r'), P('g_dec','l')])
flow('f5', 'g_need', 't_manual', 'Да', [P('g_need','b'), (X(3), Y['L4A']), P('t_manual','l')])
flow('f6', 't_manual', 'g_dec', '', [(X(4)-20, Y['L4A']-TH/2), (X(4)-20, Y['L3A']), P('g_dec','l')])
flow('f7', 'bt_48', 't_rej_af', '', [P('bt_48','t'), (X(4)+30, Y['L2B']), P('t_rej_af','l')])
flow('f8', 'g_dec', 't_rej_af', 'Отклонить', [P('g_dec','t'), P('t_rej_af','b')])
flow('f9', 't_rej_af', 'end_rej_af', '', [P('t_rej_af','r'), P('end_rej_af','l')])
flow('f10', 'g_dec', 't_suspend', 'Признаки 161-ФЗ', [P('g_dec','r'), (X(7), Y['L3A']), P('t_suspend','b')])
flow('f11', 'g_dec', 't_post', 'Разрешить', [P('g_dec','b'), (X(5), Y['CH']), (X(16), Y['CH']), P('t_post','b')])
flow('f12', 't_suspend', 't_confirm', '', [P('t_suspend','r'), (X(8), Y['L2A']), (X(8), Y['L1A']), P('t_confirm','l')])
flow('f13', 't_confirm', 'g_conf', '', [P('t_confirm','r'), P('g_conf','l')])
flow('f14', 'bt_p20', 't_rej_nc', '', [P('bt_p20','b'), P('t_rej_nc','t')])
flow('f15', 't_rej_nc', 'end_rej_nc', '', [P('t_rej_nc','r'), P('end_rej_nc','l')])
flow('f16', 'g_conf', 't_cancel', 'Отменил', [P('g_conf','b'), P('t_cancel','t')])
flow('f17', 't_cancel', 'end_cancel', '', [P('t_cancel','r'), P('end_cancel','l')])
flow('f18', 'g_conf', 't_recheck', 'Подтвердил', [P('g_conf','r'), (X(12)+55, Y['L1A']), (X(12)+55, Y['L3B']), P('t_recheck','l')])
flow('f19', 't_recheck', 'g_cbr', '', [P('t_recheck','r'), P('g_cbr','l')])
flow('f20', 'g_cbr', 'g_join', 'Нет', [P('g_cbr','t'), (X(14), Y['L2A']), P('g_join','l')])
flow('f21', 'g_cbr', 'tm_wait', 'Да', [P('g_cbr','r'), (X(15), Y['L3B']), P('tm_wait','b')])
flow('f22', 'tm_wait', 'g_join', '', [P('tm_wait','t'), P('g_join','b')])
flow('f23', 'g_join', 't_post', '', [P('g_join','r'), P('t_post','l')])
flow('f24', 't_post', 'end_ok', '', [P('t_post','r'), P('end_ok','l')])

W = X(17) + 90; H = 740
def elabel(pts):
    (x1, y1), (x2, y2) = pts[0], pts[1]
    if y1 == y2: return x1 + 6, y1 - 8          # горизонтальный — над линией
    if y2 < y1: return x1 + 6, y1 - 14          # вверх — справа над началом
    return x1 + 6, y1 + 16                      # вниз — справа под началом
# подписи шлюзов: (якорь, dx, dy) от центра
GL = {'g_dec': ('end', -30, -12), 'g_cbr': ('middle', 0, 44)}
# ---------- BPMN XML
inc, out = {}, {}
for fid, a, b, _, _ in F:
    out.setdefault(a, []).append(fid); inc.setdefault(b, []).append(fid)
e = html.escape
xml = ['<?xml version="1.0" encoding="UTF-8"?>',
 '<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI" '
 'xmlns:dc="http://www.omg.org/spec/DD/20100524/DC" xmlns:di="http://www.omg.org/spec/DD/20100524/DI" '
 'id="defs_161fz" targetNamespace="https://github.com/KORTEZZ12/phone-transfers" exporter="phone-transfers" exporterVersion="0.3">',
 '  <bpmn:collaboration id="collab_161fz">',
 '    <bpmn:participant id="pool_bank" name="Перевод с признаками мошенничества, 161-ФЗ" processRef="proc_161fz" />',
 '  </bpmn:collaboration>',
 '  <bpmn:process id="proc_161fz" isExecutable="false">',
 '    <bpmn:laneSet id="laneset_161fz">']
for lid, ln, _, _ in LANES:
    xml.append(f'      <bpmn:lane id="{lid}" name="{e(ln)}">')
    for nid, (t, nm, l, c, r) in N.items():
        if l == lid: xml.append(f'        <bpmn:flowNodeRef>{nid}</bpmn:flowNodeRef>')
    for bid, (host, nm, dx, sd) in BOUND.items():
        if N[host][2] == lid: xml.append(f'        <bpmn:flowNodeRef>{bid}</bpmn:flowNodeRef>')
    xml.append('      </bpmn:lane>')
xml.append('    </bpmn:laneSet>')
def refs(i):
    return ''.join(f'\n      <bpmn:incoming>{f}</bpmn:incoming>' for f in inc.get(i, [])) + \
           ''.join(f'\n      <bpmn:outgoing>{f}</bpmn:outgoing>' for f in out.get(i, []))
for nid, (t, nm, l, c, r) in N.items():
    body = refs(nid)
    if nid == 'tm_wait':
        body += '\n      <bpmn:timerEventDefinition id="td_wait" />'
    xml.append(f'    <bpmn:{t} id="{nid}" name="{e(nm)}">{body}\n    </bpmn:{t}>')
for bid, (host, nm, dx, sd) in BOUND.items():
    xml.append(f'    <bpmn:boundaryEvent id="{bid}" name="{e(nm)}" attachedToRef="{host}">{refs(bid)}\n      <bpmn:timerEventDefinition id="td_{bid}" />\n    </bpmn:boundaryEvent>')
for fid, a, b, nm, _ in F:
    xml.append(f'    <bpmn:sequenceFlow id="{fid}" sourceRef="{a}" targetRef="{b}"' + (f' name="{e(nm)}"' if nm else '') + ' />')
xml.append('  </bpmn:process>')
xml.append('  <bpmndi:BPMNDiagram id="dia_161fz">\n    <bpmndi:BPMNPlane id="plane_161fz" bpmnElement="collab_161fz">')
xml.append(f'      <bpmndi:BPMNShape id="pool_bank_di" bpmnElement="pool_bank" isHorizontal="true"><dc:Bounds x="0" y="0" width="{W}" height="{H}" /></bpmndi:BPMNShape>')
for lid, ln, top, h in LANES:
    xml.append(f'      <bpmndi:BPMNShape id="{lid}_di" bpmnElement="{lid}" isHorizontal="true"><dc:Bounds x="30" y="{top}" width="{W-30}" height="{h}" /></bpmndi:BPMNShape>')
def lbl(x, y, w=110, h=30): return f'<bpmndi:BPMNLabel><dc:Bounds x="{x:.0f}" y="{y:.0f}" width="{w}" height="{h}" /></bpmndi:BPMNLabel>'
for nid, (t, nm, l, c, r) in N.items():
    x, y, w, h = box(nid)
    extra = ''
    if t.endswith('Gateway'): extra = ' isMarkerVisible="true"'
    if t.endswith('Task'): label = ''
    elif t.endswith('Gateway') and nid in GL:
        anc, dx, dy = GL[nid]; cx0, cy0 = ctr(nid)
        label = lbl(cx0 + dx - (110 if anc == 'end' else 55), cy0 + dy - 14)
    else: label = lbl(x + w/2 - 55, y - 34 if t.endswith('Gateway') else y + h + 4)
    xml.append(f'      <bpmndi:BPMNShape id="{nid}_di" bpmnElement="{nid}"{extra}><dc:Bounds x="{x:.0f}" y="{y:.0f}" width="{w}" height="{h}" />{label}</bpmndi:BPMNShape>')
for bid, (host, nm, dx, sd) in BOUND.items():
    x, y = ctr(bid)
    ly = y - 20 if sd == 'top' else y + 20
    xml.append(f'      <bpmndi:BPMNShape id="{bid}_di" bpmnElement="{bid}"><dc:Bounds x="{x-18:.0f}" y="{y-18:.0f}" width="36" height="36" />{lbl(x + 8, ly)}</bpmndi:BPMNShape>')
for fid, a, b, nm, pts in F:
    wps = ''.join(f'<di:waypoint x="{px:.0f}" y="{py:.0f}" />' for px, py in pts)
    label = ''
    if nm:
        (x1, y1), (x2, y2) = pts[0], pts[1]
        tx, ty = elabel(pts)
        label = lbl(tx, ty - 14, 100, 20)
    xml.append(f'      <bpmndi:BPMNEdge id="{fid}_di" bpmnElement="{fid}">{wps}{label}</bpmndi:BPMNEdge>')
xml.append('    </bpmndi:BPMNPlane>\n  </bpmndi:BPMNDiagram>\n</bpmn:definitions>\n')
open(OUT + '.bpmn', 'w', encoding='utf-8').write('\n'.join(xml))

# ---------- SVG-превью
def wrap(t, n=16):
    words, lines, cur = t.split(), [], ''
    for w in words:
        if len(cur) + len(w) + 1 > n and cur: lines.append(cur); cur = w
        else: cur = (cur + ' ' + w).strip()
    lines.append(cur); return lines
s = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" height="{H}" font-family="Arial, Helvetica, sans-serif" font-size="12">',
     '<defs><marker id="arr" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#333"/></marker></defs>',
     f'<rect x="0" y="0" width="{W}" height="{H}" fill="#fff" stroke="#333" stroke-width="1.5"/>',
     f'<text x="16" y="{H/2}" transform="rotate(-90 16 {H/2})" text-anchor="middle" font-weight="bold">Перевод с признаками мошенничества, 161-ФЗ</text>']
for lid, ln, top, h in LANES:
    s.append(f'<rect x="30" y="{top}" width="{W-30}" height="{h}" fill="none" stroke="#333"/>')
    s.append(f'<text x="48" y="{top+h/2}" transform="rotate(-90 48 {top+h/2})" text-anchor="middle">{e(ln)}</text>')
for fid, a, b, nm, pts in F:
    d = ' '.join(f'{px:.0f},{py:.0f}' for px, py in pts)
    s.append(f'<polyline points="{d}" fill="none" stroke="#333" stroke-width="1.3" marker-end="url(#arr)"/>')
    if nm:
        (x1, y1), (x2, y2) = pts[0], pts[1]
        tx, ty = elabel(pts)
        s.append(f'<text x="{tx:.0f}" y="{ty:.0f}" fill="#555">{e(nm)}</text>')
for nid, (t, nm, l, c, r) in N.items():
    x, y, w, h = box(nid); cx, cy = ctr(nid)
    if t.endswith('Task'):
        s.append(f'<rect x="{x:.0f}" y="{y:.0f}" width="{w}" height="{h}" rx="10" fill="#fff" stroke="#333" stroke-width="1.5"/>')
        if t == 'userTask':
            s.append(f'<circle cx="{x+12:.0f}" cy="{y+12:.0f}" r="5" fill="none" stroke="#333"/><path d="M{x+4:.0f},{y+24:.0f} q8,-10 16,0" fill="none" stroke="#333"/>')
        else:
            s.append(f'<circle cx="{x+12:.0f}" cy="{y+12:.0f}" r="5" fill="none" stroke="#333" stroke-dasharray="2,2"/>')
        lines = wrap(nm)
        for k, ln in enumerate(lines):
            s.append(f'<text x="{cx:.0f}" y="{cy - 7*(len(lines)-1) + 14*k + 4:.0f}" text-anchor="middle">{e(ln)}</text>')
    elif t.endswith('Gateway'):
        s.append(f'<polygon points="{cx},{cy-25} {cx+25},{cy} {cx},{cy+25} {cx-25},{cy}" fill="#fff" stroke="#333" stroke-width="1.5"/>')
        s.append(f'<path d="M{cx-9},{cy-9} L{cx+9},{cy+9} M{cx+9},{cy-9} L{cx-9},{cy+9}" stroke="#333" stroke-width="3"/>')
        anc, dx, dy = GL.get(nid, ('middle', 0, None))
        lines = wrap(nm, 20)
        for k, ln in enumerate(lines):
            yy = cy - 32 - 14*(len(lines)-1-k) if dy is None else cy + dy + 14*k
            s.append(f'<text x="{cx+dx:.0f}" y="{yy:.0f}" text-anchor="{anc}">{e(ln)}</text>')
    else:
        sw = '1.5' if t == 'startEvent' else ('4' if t == 'endEvent' else '1.5')
        s.append(f'<circle cx="{cx}" cy="{cy}" r="18" fill="#fff" stroke="#333" stroke-width="{sw}"/>')
        if t == 'intermediateCatchEvent':
            s.append(f'<circle cx="{cx}" cy="{cy}" r="14" fill="none" stroke="#333"/><circle cx="{cx}" cy="{cy}" r="9" fill="none" stroke="#333"/><path d="M{cx},{cy} L{cx},{cy-7} M{cx},{cy} L{cx+5},{cy}" stroke="#333"/>')
        if nid == 'tm_wait':
            for k, ln in enumerate(wrap(nm, 18)):
                s.append(f'<text x="{cx-26:.0f}" y="{cy - 4 + 14*k:.0f}" text-anchor="end">{e(ln)}</text>')
        else:
            for k, ln in enumerate(wrap(nm, 18)):
                s.append(f'<text x="{cx:.0f}" y="{cy + 34 + 14*k:.0f}" text-anchor="middle">{e(ln)}</text>')
for bid, (host, nm, dx, sd) in BOUND.items():
    cx, cy = ctr(bid)
    s.append(f'<circle cx="{cx:.0f}" cy="{cy:.0f}" r="18" fill="#fff" stroke="#333" stroke-width="1.5"/><circle cx="{cx:.0f}" cy="{cy:.0f}" r="14" fill="none" stroke="#333"/><circle cx="{cx:.0f}" cy="{cy:.0f}" r="9" fill="none" stroke="#333"/><path d="M{cx:.0f},{cy:.0f} L{cx:.0f},{cy-7:.0f} M{cx:.0f},{cy:.0f} L{cx+5:.0f},{cy:.0f}" stroke="#333"/>')
    s.append(f'<text x="{cx+24:.0f}" y="{cy-6 if sd == "top" else cy+32:.0f}" fill="#333">{e(nm)}</text>')
s.append('</svg>\n')
open(OUT + '.svg', 'w', encoding='utf-8').write('\n'.join(s))
print('ok', W, H)
