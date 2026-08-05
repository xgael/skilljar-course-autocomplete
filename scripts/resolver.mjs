#!/usr/bin/env node
/**
 * Resolver en dos fases, con captura por pregunta.
 *
 *   node resolver.mjs leer      -> abre cada examen, reinicia con "Take this again",
 *                                  guarda captura + pregunta + opciones de CADA pregunta
 *                                  y abandona sin enviar.
 *   node resolver.mjs contestar -> lee /tmp/skilljar/respuestas.json {href: {n: "A"}},
 *                                  marca esas opciones, envía y reporta el score.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import {
  ESTADO, NOTAS, norm, conectar, progreso, boton, clic, reiniciar, opciones, elegir,
  textoPregunta, esperarExamenListo, esperarPregunta, esperarResultado,
  enviar, exigirSesion, log,
} from "./lib.mjs";

const MODO = process.argv[2] ?? "leer";
const FILTRO = process.argv[3] ?? "";
const CAPTURAS = `${ESTADO}/capturas_preguntas`;
const SALIDA = `${ESTADO}/examenes.json`;
const RESPUESTAS = `${ESTADO}/respuestas.json`;
const LOG = `${ESTADO}/resolver.log`;
// Copia fuera de /tmp: las preguntas CON SUS OPCIONES son el insumo para decidir, y
// volver a leerlas cuesta una pasada completa por el portal.
const RESPALDO = `${NOTAS}/preguntas_leidas.json`;
mkdirSync(CAPTURAS, { recursive: true });
mkdirSync(NOTAS, { recursive: true });

const pendientes = JSON.parse(readFileSync(`${ESTADO}/pendientes.json`, "utf8"));
const { navegador, page } = await conectar();
await exigirSesion(page);

const datos = existsSync(SALIDA) ? JSON.parse(readFileSync(SALIDA, "utf8")) : {};
const claves = existsSync(RESPUESTAS) ? JSON.parse(readFileSync(RESPUESTAS, "utf8")) : {};

/** Abre el examen dejándolo en la pregunta 1. */
async function abrir(P) {
  for (let intento = 1; intento <= 3; intento++) {
    try {
      await page.goto(P.base + P.href, { waitUntil: "domcontentloaded", timeout: 90000 });
      break;
    } catch (e) {
      log(LOG, `  navegación ${intento}: ${String(e.message).slice(0, 50)}`);
      await page.waitForTimeout(3000);
      if (intento === 3) throw e;
    }
  }
  await page.waitForTimeout(1800);
  await esperarExamenListo(page).catch(() => {});
  // "Take this again" es un <span>: el clic por JS no lo activa, hay que usar el
  // locator de Playwright. Y después SIEMPRE aparece un botón Start que hay que pulsar.
  const again = page.locator("text=Take this again").first();
  if (await again.count()) {
    await again.click({ force: true, timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(2500);
  }
  if (!(await progreso(page))[0]) {
    const start = boton(page, /start/i);
    if (await start.count()) {
      await start.click({ timeout: 8000 }).catch(() => {});
      await page.waitForTimeout(2500);
    }
    await esperarExamenListo(page).catch(() => {});
  }
  // Un examen ABANDONADO a media (no enviado) no ofrece "Take this again": vuelve a
  // abrirse donde se quedó. Hay que caminar hacia atrás con Previous hasta la 1,
  // o se leen solo las preguntas del final.
  let guarda = 0;
  while ((await progreso(page))[0] > 1 && guarda++ < 40) {
    const prev = boton(page, /^previous$/i);
    if (!(await prev.count())) break;
    const antes = (await progreso(page))[0];
    await prev.click({ timeout: 6000 }).catch(() => {});
    await esperarPregunta(page, antes, 6000).catch(() => {});
    if ((await progreso(page))[0] === antes) break;
  }
  return (await progreso(page))[0];
}

for (const P of pendientes) {
  const etiqueta = `${P.titulo} — ${P.curso}`;
  if (FILTRO && !etiqueta.toLowerCase().includes(FILTRO.toLowerCase())) continue;
  const id = P.href.split("/").pop();
  log(LOG, `\n===== ${etiqueta} =====`);

  try {
    if (!(await abrir(P))) { log(LOG, "  no abrió"); continue; }

    const preguntas = [];
    let previoN = null;
    for (let i = 0; i < 40; i++) {
      const [n, total] = await progreso(page);
      if (!n || n === previoN) break;
      previoN = n;
      const texto = await textoPregunta(page, n, total);
      const ops = (await opciones(page)).map(o => o.texto);

      // captura de ESTA pregunta
      const png = `${CAPTURAS}/${id}_q${String(n).padStart(2, "0")}.png`;
      await page.screenshot({ path: png }).catch(() => {});

      if (MODO === "contestar") {
        // OJO: Skilljar REORDENA las opciones en cada intento, así que la letra que se
        // vio al leer no sirve para marcar. Se marca por TEXTO: la letra de
        // respuestas.json se traduce al texto que tenía esa opción durante la lectura,
        // y aquí se busca ese texto entre las opciones actuales.
        const clave = claves[P.href]?.[String(n)] ?? "";
        let objetivo = clave;
        if (/^[A-E]$/i.test(clave)) {
          const leidas = (datos[P.href]?.preguntas ?? [])
            .find(q => norm(q.texto) === norm(texto) || q.n === n);
          const idxLeido = clave.toUpperCase().charCodeAt(0) - 65;
          objetivo = leidas?.opciones?.[idxLeido] ?? "";
        }
        const idx = ops.findIndex(o => norm(o) === norm(objetivo));
        if (idx >= 0) {
          await elegir(page, idx);
          log(LOG, `  Q${n}/${total} -> ${ops[idx].slice(0, 62)}`);
        } else if (objetivo) {
          // sin coincidencia exacta: el mejor parecido, y se avisa
          const puntaje = o => {
            const a = new Set(norm(o).split(" ")), b = new Set(norm(objetivo).split(" "));
            let c = 0; for (const w of a) if (b.has(w)) c++;
            return c / Math.max(a.size, b.size);
          };
          let mejor = -1, mejorP = 0;
          ops.forEach((o, i) => { const p = puntaje(o); if (p > mejorP) { mejorP = p; mejor = i; } });
          if (mejor >= 0 && mejorP >= 0.6) {
            await elegir(page, mejor);
            log(LOG, `  Q${n}/${total} ~ ${ops[mejor].slice(0, 55)} (parecido ${mejorP.toFixed(2)})`);
          } else {
            log(LOG, `  Q${n}/${total} !! no encontré "${objetivo.slice(0, 45)}" entre las opciones`);
          }
        } else {
          log(LOG, `  Q${n}/${total} SIN RESPUESTA en respuestas.json`);
        }
      } else {
        preguntas.push({ n, total, texto, opciones: ops, captura: png });
        log(LOG, `  Q${n}/${total} · ${ops.length} opciones · ${texto.slice(0, 60)}`);
        if (ops.length) await elegir(page, 0);   // solo para poder avanzar
      }

      if (n >= total) break;
      const next = boton(page, /^next question$|^next$/i);
      if (!(await next.count())) break;
      await next.click({ timeout: 6000 }).catch(() => {});
      await esperarPregunta(page, n).catch(() => {});
    }

    if (MODO === "contestar") {
      const res = await enviar(page).catch(() => null);
      log(LOG, `  RESULTADO: ${res?.score ?? "sin score"}`);
      datos[P.href] = { ...(datos[P.href] ?? {}), resultado: res };
    } else {
      datos[P.href] = { curso: P.curso, examen: P.titulo, href: P.href, preguntas };
      log(LOG, `  -> ${preguntas.length} preguntas + capturas (SIN enviar)`);
    }
    writeFileSync(SALIDA, JSON.stringify(datos, null, 1));
    writeFileSync(RESPALDO, JSON.stringify(datos, null, 1));
  } catch (e) {
    log(LOG, `  !! ${String(e.message).slice(0, 120)}`);
  }
}
log(LOG, "\n===== FIN =====");
process.exit(0);
