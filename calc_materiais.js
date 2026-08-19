// ══════════════════════════════════════════════════════════════
// CÁLCULO AUTOMÁTICO DE MATERIAIS DE INSTALAÇÃO
// Cruza o laudo do técnico (distâncias, conexões) com o modelo do
// trocador escolhido pela vendedora e devolve a lista de materiais.
//
// Fontes das regras (regras_instalacao.json):
//  · Planilha "CABOS ELÉTRICOS LINHA ORTUM E CÁLIDAS" — bitola por modelo × distância
//  · Manual Ortum Prime — disjuntor por corrente, obrigatoriedade de contator/relé/DPS
//  · Obras reais de referência (Diego Teixeira S12, Yuri Canellas AQ9)
// ══════════════════════════════════════════════════════════════
const REGRAS = require('./regras_instalacao.json');

const FOLGA_PCT = 0.10;        // folga sobre o comprimento medido
const METROS_POR_BARRA = 3;    // tubo soldável vem em barras de 3m
const TERRA_MIN_M = 20;        // terra: mínimo praticado nas obras de referência

// ── Aquex Inverter: nome comercial × código da tabela de cabos ──
// O nome comercial usa uma numeração própria (AQ 7) enquanto a tabela de cabos usa
// o BTU/1000 (AQ 24 IN). Cuidado: "AQ 24" comercial é 82.000 BTU, mas "AQ 24 IN" na
// tabela é 24.000 BTU — são equipamentos diferentes com número parecido.
const AQUEX_INV_COMERCIAL = {
  4:  { btu: 14000,  tabela: 'AQ 14 IN' },
  7:  { btu: 24000,  tabela: 'AQ 24 IN' },
  9:  { btu: 30000,  tabela: 'AQ 30 IN' },
  12: { btu: 43000,  tabela: 'AQ 43 IN' },
  14: { btu: 50000,  tabela: 'AQ 50 IN' },
  17: { btu: 60000,  tabela: 'AQ 60 IN' },
  19: { btu: 71000,  tabela: 'AQ 71 IN' },
  24: { btu: 82000,  tabela: 'AQ 82 IN' },
  32: { btu: 110000, tabela: 'AQ 110 IN' },
  38: { btu: 130000, tabela: 'AQ 130 IN' },
};

// Descobre a chave da tabela a partir do nome comercial do equipamento.
// Ex.: "Trocador De Calor Sibrape Mini Ortum S12 220v" → "S 12"
//      "SB130", "Ortum Prime S110", "AQ 28" → "SB 130", "S 110", "AQ 28"
function _chaveModelo(nome) {
  const txt = String(nome || '').toUpperCase();
  const tabela = Object.keys(REGRAS.cabos_por_modelo);
  const norm = s => s.toUpperCase().replace(/[^A-Z0-9]/g, '');

  // Igualdade direta (o usuário digitou o código exato)
  const exato = tabela.find(k => norm(k) === norm(txt));
  if (exato) return exato;

  // Aquex: o BTU no próprio nome é a informação mais confiável ("AQ7INV ... 24.000BTUs")
  if (/AQ/.test(txt)) {
    const mBtu = txt.match(/(\d{2,3})[.\s]?(\d{3})\s*BTU/);
    if (mBtu) {
      const btu = parseInt(mBtu[1] + mBtu[2], 10);
      const porBtu = Object.values(AQUEX_INV_COMERCIAL).find(v => v.btu === btu);
      if (porBtu && tabela.includes(porBtu.tabela)) return porBtu.tabela;
    }
    // Sem BTU no nome: usa o de/para comercial, só quando for da linha Inverter
    const ehInverter = /\bINV|INVERTER\b/.test(txt);
    const mAq = txt.match(/\bAQ\s*[-]?\s*(\d{1,3})\b/);
    if (ehInverter && mAq) {
      const eq = AQUEX_INV_COMERCIAL[parseInt(mAq[1], 10)];
      if (eq && tabela.includes(eq.tabela)) return eq.tabela;
    }
  }

  // Procura códigos no texto: prefixo (S, SB, SU, AQ) + número + sufixo IN opcional.
  // "220V"/"12.000BTU" não casam porque exigimos o prefixo de letras colado ao número.
  const candidatos = [];
  const rx = /\b(SB|SU|AQ|S)\s*[-]?\s*(\d{2,3})\s*(IN|INV)?\b/g;
  let m;
  while ((m = rx.exec(txt)) !== null) {
    const [, pre, numero, suf] = m;
    // Ignora sequências que são tensão ou capacidade, não modelo
    if (['110', '127', '220', '240', '380'].includes(numero) && !suf) {
      // 110 é modelo válido (S110/SB110) — só descarta quando vier logo antes de "V"
      const depois = txt.slice(m.index + m[0].length, m.index + m[0].length + 2);
      if (/^\s*V/.test(depois)) continue;
    }
    candidatos.push({ pre, numero, inverter: !!suf });
  }
  for (const c of candidatos) {
    // Com sufixo IN/INV tenta primeiro a variante inverter da tabela
    const tentativas = c.inverter
      ? [`${c.pre} ${c.numero} IN`, `${c.pre}${c.numero} IN`, `${c.pre} ${c.numero}`]
      : [`${c.pre} ${c.numero}`, `${c.pre}${c.numero}`];
    for (const t of tentativas) {
      const achado = tabela.find(k => norm(k) === norm(t));
      if (achado) return achado;
    }
  }
  return null;
}

// Bitola em mm² para o modelo na distância informada (arredonda para a faixa superior da tabela)
function bitolaPara(modeloChave, distanciaM) {
  const reg = REGRAS.cabos_por_modelo[modeloChave];
  if (!reg) return null;
  const faixas = REGRAS.distancias_tabela;
  const d = Number(distanciaM) || 0;
  const faixa = faixas.find(f => d <= f) ?? faixas[faixas.length - 1];
  return reg.bitola[faixa] ?? null;
}

// Disjuntor e DR a partir da corrente (tabela do manual Ortum Prime)
function protecaoPara(correnteA) {
  const tab = REGRAS.disjuntor_por_corrente;
  const i = Number(correnteA) || 0;
  return tab.find(f => i <= f.ate_a) || tab[tab.length - 1];
}

// Estima a corrente pela potência de entrada (W) em 220V, quando não há valor de placa
function correnteEstimada(modeloChave) {
  const w = REGRAS.cabos_por_modelo[modeloChave]?.potencia_w;
  return w ? Math.round((w / 220) * 10) / 10 : null;
}

/**
 * Monta a lista de materiais.
 * @param {object} laudo  campos gravados pelo técnico na visita
 * @param {string} modelo nome/código do trocador escolhido
 * @returns {{itens:Array, resumo:object, avisos:string[]}}
 */
function calcularMateriais(laudo = {}, modelo = '') {
  const avisos = [];
  const num = v => { const n = parseFloat(String(v ?? '').replace(',', '.')); return isNaN(n) ? 0 : n; };

  const distTubo   = num(laudo.dist);          // trocador → casa de máquinas
  const distCabo   = num(laudo.dist_quadro);   // trocador → quadro elétrico
  const curva90    = num(laudo.curva90);
  const joelho90   = num(laudo.joelho90);
  const joelho45   = num(laudo.joelho45);
  const precisaSup = !!laudo.suporte;
  const temDisj    = !!laudo.disj_livre;

  const chave = _chaveModelo(modelo);
  if (!chave) avisos.push(`Modelo "${modelo}" não encontrado na tabela de cabos — a bitola precisa ser conferida manualmente.`);
  if (!distTubo)  avisos.push('Distância até a casa de máquinas não informada no laudo — tubulação não calculada.');
  if (!distCabo)  avisos.push('Distância até o quadro elétrico não informada no laudo — cabo elétrico não calculado.');

  const bitola = chave ? bitolaPara(chave, distCabo) : null;
  if (chave && distCabo > 60) avisos.push('Distância acima de 60 m: a tabela do fabricante para nessa faixa. Confirme a bitola com o eletricista.');

  const corrente = chave ? correnteEstimada(chave) : null;
  const prot = corrente ? protecaoPara(corrente) : null;

  const itens = [];
  // Materiais são comprados em unidades inteiras (barras, metros), então sempre arredonda para cima
  const add = (nome, qtd, unidade = 'UN', obs = '') => {
    const q = Math.ceil(qtd);
    if (q > 0) itens.push({ nome, quantidade: q, unidade, obs });
  };

  // ── HIDRÁULICA ──
  // Dois trechos (ida e volta) entre o trocador e a casa de máquinas, com folga
  const metrosTubo = distTubo * 2 * (1 + FOLGA_PCT);
  add('Tubo Soldável 50x3m', metrosTubo / METROS_POR_BARRA, 'UN', `${distTubo}m ida e volta + ${FOLGA_PCT * 100}% folga`);
  add('Registro de Esfera Soldável 50mm C/ União', 3, 'UN', 'by-pass (entrada, saída e desvio)');
  add('TE Soldável 50mm', 2, 'UN', 'by-pass');
  add('Curva 90 Soldável 50mm', curva90, 'UN', 'informado no laudo');
  add('Joelho 90 Soldável 50mm', joelho90, 'UN', 'informado no laudo');
  add('Joelho 45 Soldável 50mm', joelho45, 'UN', 'informado no laudo');
  add('Adesivo CPVC - Amanco 175gr', 1);
  add('Lixa 120', 1);
  add('Mangueira Cristal 1/2 - dreno', 5, 'UN', 'dreno do condensado');

  // ── ELÉTRICA ──
  if (bitola) {
    // Fase + neutro percorrem o trecho duas vezes; terra uma vez
    const mFase  = distCabo * 2 * (1 + FOLGA_PCT);
    const mTerra = Math.max(distCabo * (1 + FOLGA_PCT), TERRA_MIN_M);
    add(`Fio Flexível ${String(bitola).replace('.', ',')}mm Preto 1m`, mFase, 'M', `${distCabo}m × 2 (fase e neutro) + folga`);
    add(`Fio Flexível ${String(bitola).replace('.', ',')}mm Verde 1m`, mTerra, 'M', 'aterramento');
  }
  if (prot) {
    add(`Disjuntor Curva C ${prot.disjuntor_a}A`, temDisj ? 1 : 2, 'UN',
      temDisj ? 'quadro já tem disjuntor livre' : 'bomba de calor + motobomba');
    add(`IDR/DR ${prot.dr_ma}mA`, 1, 'UN', 'obrigatório pelo manual');
  }
  add('Contator 9A 220V', 2, 'UN', 'bomba de calor + motobomba');
  add('Relé de Sobrecarga', 1, 'UN', corrente ? `faixa compatível com ${corrente}A` : 'obrigatório pelo manual');
  add('DPS - Dispositivo de Proteção contra Surtos', 1, 'UN', 'obrigatório pelo manual');
  add('Caixa de Passagem/Comando', 1);
  add('Trilho DIN', 1);
  add('Fita Isolante', 1);
  add('Kit Terminais Ilhós', 1);
  if (distCabo > 0) add('Conduíte Espiral 3/4 1m', distCabo * (1 + FOLGA_PCT), 'M', 'proteção do cabo');

  // ── FIXAÇÃO ──
  if (precisaSup) {
    add('Suporte Ar Cond. Split 50cm Reforçado', 1, 'UN', 'informado no laudo');
    add('Parafuso S10 c/ Bucha e Arruela', 6);
  }

  return {
    itens,
    resumo: {
      modelo, modelo_tabela: chave, potencia_w: chave ? REGRAS.cabos_por_modelo[chave].potencia_w : null,
      corrente_estimada_a: corrente, bitola_mm2: bitola,
      disjuntor_a: prot?.disjuntor_a ?? null, dr_ma: prot?.dr_ma ?? null,
      distancia_tubo_m: distTubo, distancia_cabo_m: distCabo,
    },
    avisos,
  };
}

module.exports = { calcularMateriais, bitolaPara, protecaoPara, _chaveModelo, REGRAS };
