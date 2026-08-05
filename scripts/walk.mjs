// Recorre las lecciones de uno o varios cursos. Visitarlas es lo que las marca
// completas, así que este paso cierra todo salvo los exámenes.
//
//   node walk.mjs https://portal.skilljar.com/curso/123 [más urls...]
//
// Guarda el contenido en ~/Documentos/skilljar-cursos/<curso>.md y deja el inventario
// de pendientes en /tmp/skilljar/pendientes.json para que capture.mjs lo tome.

import { mkdirSync, writeFileSync } from "node:fs";
import {
  conectar, origen, temario, contenido, leccionCompleta, exigirSesion, mismoCurso, esperarTemario,
  log, guardar, ESTADO, NOTAS, soltar} from "./lib.mjs";

// --inventario: solo lee el temario y anota lo que falta, sin visitar nada. Es lo que
// se usa cuando las lecciones ya están completas y solo faltan los exámenes: una carga
// de página por curso en vez de noventa.
const INVENTARIO = process.argv.includes("--inventario");
// Dos pestañas como máximo, por decisión: con 3 agentes eso ya son 6 páginas del portal
// en vuelo, y más pestañas por ventana no compran velocidad — el cuello es el portal, no
// la máquina. El techo es duro a propósito para que nadie lo suba "por si acaso".
//
// Y el default es UNA, no dos: abrir una pestaña con newPage() y cerrarla después dejaba
// la conexión CDP inservible ("Target page, context or browser has been closed") y el
// curso siguiente se caía sin razón aparente. Con --pestanas 2 se acepta el riesgo a
// cambio de velocidad; por defecto, no.
const iTabs = process.argv.indexOf("--pestanas");
const PESTANAS = Math.min(2, Math.max(1, iTabs >= 0 ? Number(process.argv[iTabs + 1]) : 1));
// Por defecto NO se revisita lo que ya está completo: recorrer de nuevo 380 lecciones
// para nada es justo lo que hay que evitar. Con --forzar se revisitan todas.
const FORZAR = process.argv.includes("--forzar");
const urls = process.argv.slice(2).filter(a => a.startsWith("http"));
if (!urls.length) {
  console.error("uso: node walk.mjs <url-del-curso> [más urls...]");
  process.exit(1);
}

const LOG = `${ESTADO}/walk.log`;
const BASE = origen(urls[0]);
let { navegador, page } = await conectar();
mkdirSync(NOTAS, { recursive: true });

const pendientes = [];
const resumen = [];

for (const url of urls) {
  const ruta = new URL(url).pathname;
  // Dos intentos por curso: si el navegador se murió (pasa, y no siempre por nuestra
  // culpa), se reconecta y se repite ESE curso. Antes un navegador caído se llevaba
  // todos los cursos siguientes con él y el reporte decía "se cayó" sin más.
  for (let intento = 1; intento <= 2; intento++) {
  try {
  await page.goto(BASE + ruta, { waitUntil: "domcontentloaded", timeout: 90000 });
  await esperarTemario(page);

  await exigirSesion(page);
  if (!mismoCurso(ruta, page.url())) {
    log(LOG, `\n===== ${ruta} =====\n  [!] no accesible con esta cuenta: el portal redirigió a ${new URL(page.url()).pathname}`);
    resumen.push({ curso: ruta, url: ruta, inaccesible: true });
    break;
  }
  const { titulo, lecciones } = await temario(page);
  // Cero lecciones no es "curso completo": es que no hay temario que leer, casi siempre
  // porque la cuenta no está inscrita. Decirlo, no contarlo como cerrado.
  if (!lecciones.length) {
    log(LOG, `\n===== ${titulo ?? ruta} =====\n  [!] sin temario visible: la cuenta probablemente no está inscrita`);
    resumen.push({ curso: titulo ?? ruta, url: ruta, sinTemario: true });
    break;
  }
  log(LOG, `\n===== ${titulo} · ${lecciones.length} lecciones =====`);

  const yaHechas = lecciones.filter(l => l.completa).length;
  if (INVENTARIO) {
    log(LOG, `  inventario: ${yaHechas}/${lecciones.length} ya completas, no visito nada`);
  }

  const porVisitar = INVENTARIO ? [] : lecciones.filter(l => FORZAR || !l.completa);
  if (!INVENTARIO && yaHechas) log(LOG, `  ${yaHechas} ya completas, las salto`);

  const notas = [`# ${titulo}\n`];
  const noConfirmadas = [];

  // Visita una lección: la carga y espera SOLO hasta que el temario la marque completa.
  //
  // Antes había una espera fija de 2.8s por lección "para estar seguro". Eso son 18 min
  // de reloj en 380 lecciones, casi todo desperdiciado: la marca aparece en menos de un
  // segundo. Ahora se sondea y se sigue en cuanto está, con techo por si no llega —
  // y de paso se COMPRUEBA que quedó completa en vez de suponerlo.
  async function visitar(pestana, L) {
    await pestana.goto(BASE + L.href, { waitUntil: "domcontentloaded", timeout: 90000 });
    const techo = L.paqueteWeb ? 12000 : 6000;
    const hasta = Date.now() + techo;
    let ok = false;
    while (Date.now() < hasta) {
      ok = await leccionCompleta(pestana).catch(() => false);
      if (ok) break;
      await pestana.waitForTimeout(250);
    }
    return { ok, texto: await contenido(pestana).catch(() => "") };
  }

  // Varias pestañas a la vez: las lecciones son independientes entre sí, así que no hay
  // riesgo de pisarse (a diferencia de los exámenes, que sí llevan estado por pestaña).
  const pestanas = [page];
  for (let k = 1; k < PESTANAS; k++) pestanas.push(await page.context().newPage());

  let hechas = 0;
  for (let i = 0; i < porVisitar.length; i += pestanas.length) {
    const lote = porVisitar.slice(i, i + pestanas.length);
    const salidas = await Promise.all(lote.map(async (L, k) => {
      try { return { L, ...(await visitar(pestanas[k], L)) }; }
      catch (e) { return { L, error: String(e).slice(0, 60) }; }
    }));
    for (const s of salidas) {
      hechas++;
      if (s.error) { log(LOG, `  ${hechas} ERROR ${s.L.titulo.slice(0, 40)}: ${s.error}`); noConfirmadas.push(s.L); continue; }
      notas.push(`\n## ${s.L.seccion ?? ""} — ${s.L.titulo}\n\n${s.texto}\n`);
      if (!s.ok && !s.L.paqueteWeb) noConfirmadas.push(s.L);
      log(LOG, `  ${String(hechas).padStart(2)}/${porVisitar.length} ${s.ok ? "✓" : "·"} ${s.L.titulo.slice(0, 56)}${s.L.paqueteWeb ? "  [paquete web]" : ""}`);
    }
  }

  // Segunda pasada para las que no confirmaron. Casi siempre es la página que tardó más
  // de la cuenta, no un candado: al reintentar entran. Lo que aguante dos intentos sí es
  // un problema y hay que decirlo, no dejarlo pasar como punto.
  if (noConfirmadas.length) {
    log(LOG, `  ${noConfirmadas.length} sin confirmar, segundo intento`);
    const resta = [];
    for (const L of noConfirmadas) {
      const r = await visitar(page, L).catch(() => ({ ok: false }));
      log(LOG, `     ${r.ok ? "✓" : "✗"} ${L.titulo.slice(0, 50)}`);
      if (!r.ok) resta.push(L);
    }
    if (resta.length) log(LOG, `  [!] ${resta.length} NO se marcaron ni al segundo intento: ${resta.map(l => l.titulo).join(" · ")}`);
    noConfirmadas.length = 0;
    noConfirmadas.push(...resta);
  }
  for (const p of pestanas.slice(1)) await p.close().catch(() => {});
  const slug = ruta.split("/").filter(Boolean)[0];
  if (porVisitar.length) writeFileSync(`${NOTAS}/${slug}-nuevas.md`, notas.join("\n"));

  // Lo que siga incompleto después de haberlo visitado es examen o paquete web.
  let despues = { lecciones };
  if (porVisitar.length) {
    await page.goto(BASE + ruta, { waitUntil: "domcontentloaded", timeout: 90000 });
    await esperarTemario(page);
    despues = await temario(page);
  }
  const faltan = despues.lecciones.filter(l => !l.completa);
  faltan.forEach(l => pendientes.push({ curso: titulo, base: BASE, ...l }));

  const paquetes = faltan.filter(l => l.paqueteWeb);
  log(LOG, `  --> ${despues.lecciones.length - faltan.length}/${despues.lecciones.length} completas`
    + (faltan.length ? ` · pendientes: ${faltan.map(l => l.titulo).join(" · ")}` : " · TODAS"));
  if (paquetes.length) {
    log(LOG, `  [!] ${paquetes.length} son paquetes web (SCORM): no se completan visitándolas, hay que caminarlas`);
  }
  // Veredicto del curso contra el temario del portal, que es la única fuente de verdad:
  // lo que diga mi bitácora no cuenta si el sitio no lo marcó.
  const veredicto = {
    curso: titulo, url: ruta, total: despues.lecciones.length,
    completas: despues.lecciones.length - faltan.length,
    faltan: faltan.map(l => l.titulo),
    examenesPendientes: faltan.filter(l => /quiz|assessment|survey|certificate/i.test(l.titulo)).length,
    paquetesWeb: paquetes.length,
    leccionesNoConfirmadas: noConfirmadas.map(l => l.titulo),
    cerrado: faltan.length === 0,
  };
  resumen.push(veredicto);
  break;
  } catch (e) {
    // Un timeout del portal en un curso no debe matar la corrida entera. Antes sí lo
    // hacía, y el peor efecto no era perder el curso: era que el paso siguiente usaba
    // el pendientes.json del curso ANTERIOR y contestaba el examen equivocado.
    const roto = /has been closed|Target (page|closed)|Protocol error|ERR_ABORTED|browserType/i.test(String(e));
    if (roto && intento === 1) {
      log(LOG, `\n===== ${ruta} =====\n  navegador caído (${String(e).slice(0, 60)}), reconecto y repito este curso`);
      try { ({ navegador, page } = await conectar()); } catch (e2) {
        log(LOG, `  [!] no pude reconectar: ${String(e2).slice(0, 80)}`);
        resumen.push({ curso: ruta, url: ruta, error: "sin navegador" });
        break;
      }
      continue;
    }
    log(LOG, `\n===== ${ruta} =====\n  [!] se cayó: ${String(e).slice(0, 90)}`);
    resumen.push({ curso: ruta, url: ruta, error: String(e).slice(0, 120) });
    break;
  }
  }
}

guardar(`${ESTADO}/pendientes.json`, pendientes);
guardar(`${ESTADO}/resumen.json`, resumen);
log(LOG, `\n===== ${pendientes.length} pendientes en total · guardados en ${ESTADO}/pendientes.json =====`);
await soltar(navegador);
// Salida explícita: como a propósito NO cerramos el navegador, la conexión CDP queda
// abierta y node se queda vivo para siempre esperando ese socket. El trabajo terminaba
// bien y el proceso nunca soltaba la terminal; el orquestador se quedaba esperándolo.
process.exit(0);
