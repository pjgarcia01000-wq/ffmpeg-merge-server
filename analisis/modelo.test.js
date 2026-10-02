'use strict';

// Ejecutar: node --test analisis/modelo.test.js

const test = require('node:test');
const assert = require('node:assert');
const { execFileSync, spawnSync } = require('child_process');
const path = require('path');
const {
  matrizMarcadores, estimarLambdas, resumen, mitades, handicapLocal, masDe, invertir,
  cuotaJusta, evaluar, quitarMargen,
} = require('./modelo');

const cerca = (a, b, tol = 1e-6) => assert.ok(Math.abs(a - b) < tol, `${a} ≠ ${b}`);
const suma = m => m.flat().reduce((a, b) => a + b, 0);
const media = (m, eje) => m.reduce((s, fila, x) => s + fila.reduce((t, p, y) => t + p * (eje === 'x' ? x : y), 0), 0);
const pTotal = (m, cond) => m.reduce((s, fila, x) => s + fila.reduce((t, p, y) => t + (cond(x + y) ? p : 0), 0), 0);

test('la matriz de marcadores suma 1 y coincide con Poisson independiente si ρ = 0', () => {
  const m = matrizMarcadores(1.5, 1.0);
  cerca(suma(m), 1, 1e-12);
  cerca(m[0][0], Math.exp(-2.5));
  cerca(m[2][1], Math.exp(-1.5) * 1.5 ** 2 / 2 * Math.exp(-1) * 1.0);
});

test('λ iguales dan la misma probabilidad a local y visitante', () => {
  const r = resumen(matrizMarcadores(1.3, 1.3, -0.13));
  cerca(r.local, r.visitante, 1e-12);
  cerca(r.local + r.empate + r.visitante, 1, 1e-12);
});

test('Dixon-Coles con ρ < 0 sube el empate y conserva las medias de goles', () => {
  const base = resumen(matrizMarcadores(1.4, 1.1, 0));
  const m = matrizMarcadores(1.4, 1.1, -0.13);
  assert.ok(resumen(m).empate > base.empate);
  cerca(media(m, 'x'), 1.4, 1e-4);
  cerca(media(m, 'y'), 1.1, 1e-4);
});

test('ρ que genera probabilidades negativas lanza error', () => {
  assert.throws(() => matrizMarcadores(4, 4, 0.1), /negativas/);
  assert.throws(() => matrizMarcadores(0, 1), /> 0/);
});

test('over 2.5 y ambos marcan coinciden con la fórmula cerrada (ρ = 0)', () => {
  const m = matrizMarcadores(1.6, 1.2);
  const T = 2.8;
  cerca(masDe(m, 2.5).W, 1 - Math.exp(-T) * (1 + T + T ** 2 / 2));
  cerca(resumen(m).ambos, (1 - Math.exp(-1.6)) * (1 - Math.exp(-1.2)));
});

test('las líneas asiáticas se reparten en mitades', () => {
  assert.deepStrictEqual(mitades(-0.75), [-1, -0.5]);
  assert.deepStrictEqual(mitades(-0.25), [-0.5, 0]);
  assert.deepStrictEqual(mitades(2.25), [2, 2.5]);
  assert.deepStrictEqual(mitades(2.5), [2.5, 2.5]);
  assert.throws(() => mitades(0.3), /no válida/);
});

test('hándicap asiático: -0.5 = victoria local, 0 = empate anula, -0.25 = medio perdido con empate', () => {
  const m = matrizMarcadores(1.5, 1.1, -0.13);
  const r = resumen(m);
  cerca(cuotaJusta(handicapLocal(m, -0.5)), 1 / r.local, 1e-12);
  const dnb = handicapLocal(m, 0);
  cerca(dnb.W, r.local, 1e-12);
  cerca(dnb.L, r.visitante, 1e-12);
  const cuarto = handicapLocal(m, -0.25);
  cerca(cuarto.W, r.local, 1e-12);
  cerca(cuarto.L, r.visitante + r.empate / 2, 1e-12);
  const visitante = invertir(handicapLocal(m, -0.5));
  cerca(cuotaJusta(visitante), 1 / (r.empate + r.visitante), 1e-12);
});

test('total asiático 2.25: gana con 3+, pierde medio con 2', () => {
  const m = matrizMarcadores(1.5, 1.1);
  const { W, L } = masDe(m, 2.25);
  cerca(W, pTotal(m, t => t >= 3), 1e-12);
  cerca(L, pTotal(m, t => t <= 1) + pTotal(m, t => t === 2) / 2, 1e-12);
});

test('quitar margen: mercado simétrico y sesgo favorito-sorpresa', () => {
  for (const metodo of ['potencia', 'proporcional']) {
    quitarMargen([1.9, 1.9], metodo).forEach(p => cerca(p, 0.5));
  }
  const potencia = quitarMargen([1.5, 4.0, 6.0]);
  const proporcional = quitarMargen([1.5, 4.0, 6.0], 'proporcional');
  cerca(potencia.reduce((a, b) => a + b, 0), 1);
  assert.ok(potencia[0] > proporcional[0]);
  assert.ok(potencia[2] < proporcional[2]);
  assert.throws(() => quitarMargen([1.0, 2.0]), /> 1/);
});

test('EV y stake Kelly fraccional con tope', () => {
  const sel = { W: 0.55, L: 0.45 };
  cerca(evaluar(sel, 2.0).ev, 0.10);
  cerca(evaluar(sel, 2.0, 0.1).stake, 0.01);   // Kelly completo 10% × 0.1
  cerca(evaluar(sel, 2.0, 0.25).stake, 0.02);  // 2.5% recortado al tope del 2%
  assert.strictEqual(evaluar(sel, 1.7).stake, 0);
});

test('equipos de nivel medio reproducen las medias de la liga', () => {
  const l = estimarLambdas({
    xgfLocal: 1.4, xgcLocal: 1.4, xgfVisitante: 1.4, xgcVisitante: 1.4, mediaLocal: 1.55, mediaVisitante: 1.25,
  });
  cerca(l.local, 1.55);
  cerca(l.visitante, 1.25);
});

test('CLI: imprime mercados y la comparativa con el mercado', () => {
  const salida = execFileSync(process.execPath, [path.join(__dirname, 'modelo.js'),
    '--local', '1.65', '--visitante', '1.05', '--rho', '-0.13', '--ajuste-local', '-0.1',
    '--cuotas', '1.95,3.60,4.20', '--ou', '2.5:1.90:1.95', '--ah', '-0.25:1.90:2.00', '--btts', '1.85:1.95'], { encoding: 'utf8' });
  assert.match(salida, /λ final: local 1\.55 \| visitante 1\.05/);
  assert.match(salida, /Hándicap asiático/);
  assert.match(salida, /Modelo vs mercado/);
  assert.match(salida, /AH local -0\.25/);
  const error = spawnSync(process.execPath, [path.join(__dirname, 'modelo.js'), '--locla', '1.5'], { encoding: 'utf8' });
  assert.strictEqual(error.status, 1);
  assert.match(error.stderr, /Opción desconocida/);
});

test('CLI: una línea de mercado no válida falla sin imprimir resultados parciales', () => {
  const error = spawnSync(process.execPath, [path.join(__dirname, 'modelo.js'),
    '--local', '1.5', '--visitante', '1.1', '--ah', '0.3:1.90:1.90'], { encoding: 'utf8' });
  assert.strictEqual(error.status, 1);
  assert.strictEqual(error.stdout, '');
  assert.match(error.stderr, /Línea no válida/);
});
