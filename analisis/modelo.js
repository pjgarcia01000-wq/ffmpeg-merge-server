'use strict';

// Modelo de goles para pronósticos de fútbol: Poisson con corrección Dixon-Coles,
// mercados derivados, eliminación del margen de las cuotas, EV y stake (Kelly fraccional).
// Uso: node analisis/modelo.js --ayuda

const MAX_GOLES = 10;
const UMBRAL_EV = 0.03;   // EV mínimo para marcar una selección como "valor"
const TOPE_STAKE = 0.02;  // stake máximo por pronóstico (2% del bankroll)

function poissonPmf(lambda, max = MAX_GOLES) {
  const p = [Math.exp(-lambda)];
  for (let k = 1; k <= max; k++) p.push(p[k - 1] * lambda / k);
  return p;
}

// Corrección Dixon-Coles para marcadores bajos (ρ < 0 sube 0-0 y 1-1, baja 1-0 y 0-1)
function tau(x, y, lh, la, rho) {
  if (x === 0 && y === 0) return 1 - lh * la * rho;
  if (x === 0 && y === 1) return 1 + lh * rho;
  if (x === 1 && y === 0) return 1 + la * rho;
  if (x === 1 && y === 1) return 1 - rho;
  return 1;
}

// m[x][y] = P(local marca x, visitante marca y)
function matrizMarcadores(lh, la, rho = 0, max = MAX_GOLES) {
  if (!(lh > 0) || !(la > 0)) throw new Error('λ local y λ visitante deben ser > 0');
  const ph = poissonPmf(lh, max);
  const pa = poissonPmf(la, max);
  const m = [];
  let total = 0;
  for (let x = 0; x <= max; x++) {
    m.push([]);
    for (let y = 0; y <= max; y++) {
      const t = tau(x, y, lh, la, rho);
      if (t < 0) throw new Error(`ρ = ${rho} genera probabilidades negativas con estos λ`);
      m[x].push(ph[x] * pa[y] * t);
      total += m[x][y];
    }
  }
  // Renormaliza la masa truncada por encima de MAX_GOLES
  return m.map(fila => fila.map(p => p / total));
}

// Modelo multiplicativo: λ = ataque relativo × defensa relativa rival × media de la liga.
// xgf/xgc: xG a favor/en contra por partido (todas las sedes); medias: goles por partido
// de locales y visitantes en la liga (la ventaja de campo sale de su diferencia).
function estimarLambdas({ xgfLocal, xgcLocal, xgfVisitante, xgcVisitante, mediaLocal, mediaVisitante }) {
  const media = (mediaLocal + mediaVisitante) / 2;
  return {
    local: (xgfLocal / media) * (xgcVisitante / media) * mediaLocal,
    visitante: (xgfVisitante / media) * (xgcLocal / media) * mediaVisitante,
  };
}

function resumen(m) {
  let local = 0, empate = 0, visitante = 0, ambos = 0;
  const marcadores = [];
  m.forEach((fila, x) => fila.forEach((p, y) => {
    if (x > y) local += p; else if (x === y) empate += p; else visitante += p;
    if (x > 0 && y > 0) ambos += p;
    marcadores.push({ marcador: `${x}-${y}`, p });
  }));
  marcadores.sort((a, b) => b.p - a.p);
  return { local, empate, visitante, ambos, marcadores };
}

// Una línea asiática (múltiplo de 0.25) se reparte en dos mitades: -0.75 → -1 y -0.5
function mitades(linea) {
  if (Math.abs(linea * 4 - Math.round(linea * 4)) > 1e-9) throw new Error(`Línea no válida: ${linea}`);
  return Math.round(linea * 4) % 2 === 0 ? [linea, linea] : [linea - 0.25, linea + 0.25];
}

// W/L = peso efectivo de ganar/perder (el empate de línea devuelve la apuesta).
// margen(x, y, h) > 0 gana, = 0 nula, < 0 pierde.
function lineaAsiatica(m, linea, margen) {
  let W = 0, L = 0;
  for (const h of mitades(linea)) {
    m.forEach((fila, x) => fila.forEach((p, y) => {
      const r = margen(x, y, h);
      if (r > 0) W += p / 2; else if (r < 0) L += p / 2;
    }));
  }
  return { W, L };
}

const handicapLocal = (m, linea) => lineaAsiatica(m, linea, (x, y, h) => x - y + h);
const masDe = (m, linea) => lineaAsiatica(m, linea, (x, y, t) => x + y - t);
const invertir = ({ W, L }) => ({ W: L, L: W });

const cuotaJusta = ({ W, L }) => (W + L) / W;

// EV por unidad apostada y stake Kelly fraccional (con nulas: f* = EV / ((c-1)(W+L)),
// aproximado en líneas de cuarto)
function evaluar({ W, L }, cuota, fraccionKelly = 0.25) {
  const ev = W * (cuota - 1) - L;
  const kelly = Math.max(0, ev / ((cuota - 1) * (W + L)));
  return { ev, stake: Math.min(kelly * fraccionKelly, TOPE_STAKE) };
}

// Probabilidades implícitas sin margen. 'potencia' (p_i = q_i^k, Σ = 1) corrige mejor el
// sesgo favorito-sorpresa que 'proporcional'.
function quitarMargen(cuotas, metodo = 'potencia') {
  if (cuotas.some(c => !(c > 1))) throw new Error('Las cuotas deben ser decimales > 1');
  const q = cuotas.map(c => 1 / c);
  if (metodo === 'proporcional') {
    const s = q.reduce((a, b) => a + b, 0);
    return q.map(p => p / s);
  }
  let lo = 0.01, hi = 20;
  for (let i = 0; i < 100; i++) {
    const k = (lo + hi) / 2;
    if (q.reduce((s, p) => s + p ** k, 0) > 1) lo = k; else hi = k;
  }
  return q.map(p => p ** ((lo + hi) / 2));
}

// Las 5 líneas alrededor de la más equilibrada (cuotas justas más cercanas a 2.00)
function lineasCentradas(calcular, desde, hasta) {
  const filas = [];
  for (let l = desde; l <= hasta; l += 0.25) filas.push({ linea: l, ...calcular(l) });
  let mejor = 0;
  filas.forEach((f, i) => {
    if (Math.abs(f.W - f.L) < Math.abs(filas[mejor].W - filas[mejor].L)) mejor = i;
  });
  const ini = Math.min(Math.max(mejor - 2, 0), filas.length - 5);
  return filas.slice(ini, ini + 5);
}

// ---------------------------------------------------------------- CLI

const AYUDA = `Uso:
  node analisis/modelo.js --local 1.65 --visitante 1.05 [opciones]
  node analisis/modelo.js --xgf-local 1.9 --xgc-local 1.0 --xgf-visitante 1.3 --xgc-visitante 1.4 \\
                          --media-local 1.55 --media-visitante 1.25 [opciones]

Opciones:
  --rho -0.13                   corrección Dixon-Coles (por defecto 0 = Poisson independiente)
  --ajuste-local -0.15          ajuste contextual sumado a λ local (también --ajuste-visitante)
  --cuotas 1.95,3.60,4.20       cuotas 1X2 del mercado
  --ou 2.5:1.90:1.95            línea:más:menos (repetible; admite líneas asiáticas 2.25, 2.75...)
  --ah -0.5:1.95:1.95           línea local:cuota local:cuota visitante (repetible)
  --btts 1.85:1.95              ambos marcan sí:no
  --kelly 0.25                  fracción de Kelly (por defecto 1/4; tope ${TOPE_STAKE * 100}% del bankroll)`;

const OPCIONES = ['local', 'visitante', 'xgf-local', 'xgc-local', 'xgf-visitante', 'xgc-visitante',
  'media-local', 'media-visitante', 'rho', 'ajuste-local', 'ajuste-visitante', 'cuotas', 'ou', 'ah',
  'btts', 'kelly'];

function leerArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const clave = argv[i].replace(/^--/, '');
    if (!argv[i].startsWith('--') || !OPCIONES.includes(clave)) throw new Error(`Opción desconocida: ${argv[i]}`);
    if (argv[i + 1] === undefined) throw new Error(`Falta el valor de ${argv[i]}`);
    (args[clave] = args[clave] || []).push(argv[i + 1]);
  }
  return args;
}

function numero(args, clave, porDefecto) {
  if (!args[clave]) {
    if (porDefecto === undefined) throw new Error(`Falta --${clave}`);
    return porDefecto;
  }
  const n = Number(args[clave][args[clave].length - 1]);
  if (!Number.isFinite(n)) throw new Error(`Valor no numérico en --${clave}`);
  return n;
}

function numeros(texto, separador, cantidad, opcion) {
  const n = texto.split(separador).map(Number);
  if (n.length !== cantidad || n.some(v => !Number.isFinite(v))) throw new Error(`Formato no válido en --${opcion}: ${texto}`);
  return n;
}

const pct = p => `${(p * 100).toFixed(1)}%`;
const signo = l => (l > 0 ? `+${l}` : `${l}`);
function tabla(filas) {
  const anchos = filas[0].map((_, i) => Math.max(...filas.map(f => String(f[i]).length)) + 2);
  return filas.map(f => f.map((c, i) => String(c).padEnd(anchos[i])).join('').trimEnd()).join('\n');
}

function main(argv) {
  if (argv.length === 0 || argv.includes('--ayuda') || argv.includes('--help')) return console.log(AYUDA);
  const args = leerArgs(argv);

  let lh, la, base;
  if (args['xgf-local']) {
    base = estimarLambdas({
      xgfLocal: numero(args, 'xgf-local'), xgcLocal: numero(args, 'xgc-local'),
      xgfVisitante: numero(args, 'xgf-visitante'), xgcVisitante: numero(args, 'xgc-visitante'),
      mediaLocal: numero(args, 'media-local'), mediaVisitante: numero(args, 'media-visitante'),
    });
    lh = base.local;
    la = base.visitante;
  } else {
    lh = numero(args, 'local');
    la = numero(args, 'visitante');
  }
  lh += numero(args, 'ajuste-local', 0);
  la += numero(args, 'ajuste-visitante', 0);
  const rho = numero(args, 'rho', 0);
  const fraccion = numero(args, 'kelly', 0.25);

  const m = matrizMarcadores(lh, la, rho);
  const r = resumen(m);
  const binaria = p => ({ W: p, L: 1 - p });
  const fila = (nombre, wl) => [nombre, pct(wl.W / (wl.W + wl.L)), cuotaJusta(wl).toFixed(2)];

  // Comparativa con el mercado: se valida antes de imprimir nada
  const apuestas = [];
  const mercado = (nombres, wls, cuotas) => {
    const pm = quitarMargen(cuotas);
    const margenCasa = cuotas.reduce((s, c) => s + 1 / c, 0) - 1;
    nombres.forEach((n, i) => apuestas.push({ n, wl: wls[i], cuota: cuotas[i], pm: pm[i], margenCasa }));
  };
  if (args.cuotas) {
    mercado(['1 (local)', 'X (empate)', '2 (visitante)'],
      [binaria(r.local), binaria(r.empate), binaria(r.visitante)], numeros(args.cuotas[0], ',', 3, 'cuotas'));
  }
  for (const texto of args.ou || []) {
    const [l, cm, cn] = numeros(texto, ':', 3, 'ou');
    mercado([`Más de ${l}`, `Menos de ${l}`], [masDe(m, l), invertir(masDe(m, l))], [cm, cn]);
  }
  for (const texto of args.ah || []) {
    const [l, cl, cv] = numeros(texto, ':', 3, 'ah');
    mercado([`AH local ${signo(l)}`, `AH visitante ${signo(-l)}`], [handicapLocal(m, l), invertir(handicapLocal(m, l))], [cl, cv]);
  }
  if (args.btts) {
    mercado(['Ambos marcan: sí', 'Ambos marcan: no'], [binaria(r.ambos), binaria(1 - r.ambos)], numeros(args.btts[0], ':', 2, 'btts'));
  }

  if (base) console.log(`λ base (modelo multiplicativo): local ${base.local.toFixed(2)} | visitante ${base.visitante.toFixed(2)}`);
  console.log(`λ final: local ${lh.toFixed(2)} | visitante ${la.toFixed(2)} | total ${(lh + la).toFixed(2)} | ρ = ${rho}\n`);
  console.log(tabla([
    ['Mercado', 'Prob.', 'Cuota justa'],
    fila('1 (local)', binaria(r.local)),
    fila('X (empate)', binaria(r.empate)),
    fila('2 (visitante)', binaria(r.visitante)),
    fila('1X', binaria(r.local + r.empate)),
    fila('12', binaria(r.local + r.visitante)),
    fila('X2', binaria(r.empate + r.visitante)),
    fila('Ambos marcan: sí', binaria(r.ambos)),
    fila('Ambos marcan: no', binaria(1 - r.ambos)),
    ...[1.5, 2.5, 3.5].flatMap(l => [fila(`Más de ${l}`, masDe(m, l)), fila(`Menos de ${l}`, invertir(masDe(m, l)))]),
  ]));

  console.log('\n' + tabla([
    ['Hándicap asiático', 'Local', 'Visitante'],
    ...lineasCentradas(l => handicapLocal(m, l), -3, 3).map(f =>
      [`Local ${signo(f.linea)} / Visit. ${signo(-f.linea)}`, cuotaJusta(f).toFixed(2), cuotaJusta(invertir(f)).toFixed(2)]),
  ]));

  console.log('\n' + tabla([
    ['Total asiático', 'Más', 'Menos'],
    ...lineasCentradas(l => masDe(m, l), 0.5, 6).map(f =>
      [`Línea ${f.linea}`, cuotaJusta(f).toFixed(2), cuotaJusta(invertir(f)).toFixed(2)]),
  ]));

  console.log('\nMarcadores más probables: ' +
    r.marcadores.slice(0, 6).map(s => `${s.marcador} ${pct(s.p)}`).join(' | '));

  if (apuestas.length) {
    console.log(`\nModelo vs mercado (margen eliminado: método potencia | Kelly ×${fraccion}, tope ${TOPE_STAKE * 100}% | valor si EV ≥ ${UMBRAL_EV * 100}%)`);
    console.log(tabla([
      ['Selección', 'Cuota', 'Margen', 'P.mercado', 'P.modelo', 'Cuota justa', 'EV', 'Stake', 'Valor'],
      ...apuestas.map(a => {
        const { ev, stake } = evaluar(a.wl, a.cuota, fraccion);
        return [a.n, a.cuota.toFixed(2), pct(a.margenCasa), pct(a.pm), pct(a.wl.W / (a.wl.W + a.wl.L)),
          cuotaJusta(a.wl).toFixed(2), `${ev >= 0 ? '+' : ''}${pct(ev)}`, pct(stake), ev >= UMBRAL_EV ? 'sí' : 'no'];
      }),
    ]));
  }
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    console.error(`Error: ${err.message}\n\n${AYUDA}`);
    process.exit(1);
  }
}

module.exports = {
  poissonPmf, matrizMarcadores, estimarLambdas, resumen, mitades, lineaAsiatica, handicapLocal,
  masDe, invertir, cuotaJusta, evaluar, quitarMargen, lineasCentradas,
};
