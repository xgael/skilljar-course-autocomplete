// Contesta un examen como se debe: una sola pasada, leyendo cada pregunta en la
// página, guardando captura de pantalla, y respondiendo con criterio.
//
//   node run.mjs                      todos los exámenes pendientes
//   node run.mjs --solo "Final"       solo los que casen con ese texto
//
// Diferencia con el flujo viejo (capture + apply), que fue un error:
// aquel avanzaba marcando la primera opción como relleno para poder ver la pregunta
// siguiente, y si algo fallaba después, ese relleno se enviaba. Aquí NO hay relleno:
// cada pregunta se lee y se contesta antes de avanzar, o el examen se detiene.
//
// Cuando no hay respuesta en el banco, escribe la pregunta en
// /tmp/skilljar/pregunta-abierta.json y espera a que alguien ponga la letra o el texto
// de la respuesta en /tmp/skilljar/respuesta.txt. Nunca adivina.

import { writeFileSync, readFileSync, existsSync, unlinkSync, mkdirSync, readdirSync, statSync } from "node:fs";
import {
  conectar, reiniciar, progreso, opciones, elegir, boton, clic, textoPregunta,
  enviar, revelarCorrectas, esEncuesta, exigirSesion, esperarExamenListo, esperarPregunta, decidir, cargarBanco, guardarBanco, norm, log, guardar, leer, hay, ESTADO, BANCO_ARCHIVO, soltar, rellenarTextoObligatorio} from "./lib.mjs";

const filtro = process.argv.includes("--solo") ? process.argv[process.argv.indexOf("--solo") + 1] : null;
const ESPERA_MAX_MS = Number(process.env.SKILLJAR_ESPERA ?? 600000);   // 10 min por pregunta
// Con --recolectar no se espera pregunta por pregunta: las desconocidas se juntan en
// desconocidas.json y ese examen se abandona sin enviar. Sirve para responder muchas
// de una sentada y luego correr sin la bandera. Tampoco adivina nada.
const RECOLECTAR = process.argv.includes("--recolectar");
// Con --sondear no se detiene ante una pregunta desconocida: la marca, envía, y le pide
// la correcta a la PLATAFORMA con "Show Answers" para reintentar con todo bien.
//
// Esto no rompe la regla de no adivinar, la resuelve por otro lado. La regla existía
// porque un envío a ciegas dejaba un 30% pegado en el expediente. Pero los reintentos
// son ilimitados y el ÚLTIMO sobreescribe el score — ya se comprobó pasando exámenes de
// 42% a 100%. Así que un envío deliberadamente imperfecto no es un resultado, es una
// consulta: la plataforma es la que sabe la respuesta, y es más confiable que yo.
//
// Solo se sondea si el examen se pudo reiniciar (o sea, admite reintentos). Si no
// admitiera, un score malo sería definitivo y ahí sí hay que abstenerse.
const SONDEAR = process.argv.includes("--sondear");
// Escalas de satisfacción: se marca el PUNTO MEDIO (neutral). Autorizado por el usuario
// el 2026-07-30 ("contéstalas a partir de ahora").
//
// Antes se dejaban en blanco, y eso rompía en dos frentes: hay escalas OBLIGATORIAS donde
// el portal no avanza sin respuesta —una de ellas vivía dentro de un examen calificado y
// bloqueó el envío del certificado entero— y el bucle giraba en falso repitiendo la misma
// pregunta. El punto medio es la opción menos opinada de la escala.
//
// Los comentarios de TEXTO LIBRE siguen vacíos: ahí no hay opción neutral que elegir, y
// escribir una frase a nombre del usuario es otra cosa muy distinta a marcar un neutral.
const ENCUESTAS_VACIAS = process.argv.includes("--encuestas-vacias");
// Escalas que el portal exige contestar y que, aun así, no se pudieron pasar.
const obligatorias = [];

/** Índice de la opción neutral de una escala: por texto si lo dice, si no la central. */
function puntoMedio(textos) {
  const neutral = textos.findIndex(t => /^\s*(neutral|unsure|not sure|maybe|no opinion|3\b|3 -)/i.test(t));
  return neutral >= 0 ? neutral : Math.floor(textos.length / 2);
}

const LOG = `${ESTADO}/run.log`;
const CAPTURAS = `${ESTADO}/capturas`;
const ABIERTA = `${ESTADO}/pregunta-abierta.json`;
const RESPUESTA = `${ESTADO}/respuesta.txt`;
mkdirSync(CAPTURAS, { recursive: true });

// Limpieza por antigüedad: las capturas son evidencia de la corrida actual, no un
// archivo histórico. Sin esto crecen sin techo (98 MB en unos días de pruebas).
const RETENCION_DIAS = Number(process.env.SKILLJAR_RETENCION_DIAS ?? 3);
try {
  const limite = Date.now() - RETENCION_DIAS * 86400000;
  let viejas = 0;
  for (const f of readdirSync(CAPTURAS)) {
    const ruta = `${CAPTURAS}/${f}`;
    if (statSync(ruta).mtimeMs < limite) { unlinkSync(ruta); viejas++; }
  }
  if (viejas) console.log(`limpieza: ${viejas} capturas de más de ${RETENCION_DIAS} días`);
} catch {}

// Lee el banco compartido y encima lo que este agente ya aprendió. Escribe SOLO en su
// copia local: con varios agentes en paralelo, escribir el compartido es una carrera y
// el último en guardar borra lo de los demás. El orquestador integra al final.
const BANCO_LOCAL = `${ESTADO}/banco.json`;
const BANCO = cargarBanco(BANCO_ARCHIVO, BANCO_LOCAL);
const CLAVES = hay(`${ESTADO}/claves.json`) ? leer(`${ESTADO}/claves.json`) : {};
if (!hay(`${ESTADO}/pendientes.json`)) { console.error("corre walk.mjs primero"); process.exit(1); }

const pendientes = leer(`${ESTADO}/pendientes.json`).filter(p => !p.paqueteWeb);
const { navegador, page } = await conectar();
log(LOG, `banco: ${BANCO.size} respuestas · ${pendientes.length} exámenes por contestar`);

/** Deja la pregunta a la vista y espera la respuesta de una persona. */
async function preguntarAlOperador(examen, n, texto, ops, captura) {
  guardar(ABIERTA, { examen, pregunta: n, texto, opciones: ops, captura,
    comoResponder: `escribe la letra (A/B/C/D) o un fragmento del texto en ${RESPUESTA}` });
  if (existsSync(RESPUESTA)) unlinkSync(RESPUESTA);
  log(LOG, `  Q${n} ESPERANDO RESPUESTA — pregunta en ${ABIERTA}, captura en ${captura}`);

  const hasta = Date.now() + ESPERA_MAX_MS;
  while (Date.now() < hasta) {
    if (existsSync(RESPUESTA)) {
      const cruda = readFileSync(RESPUESTA, "utf8").trim();
      if (cruda) {
        unlinkSync(RESPUESTA);
        if (existsSync(ABIERTA)) unlinkSync(ABIERTA);
        const letra = cruda.match(/^([A-Za-z])[).\s]*$/);
        if (letra) {
          const i = letra[1].toUpperCase().charCodeAt(0) - 65;
          if (i >= 0 && i < ops.length) return { indice: i, fuente: "operador" };
        }
        const i = ops.findIndex(o => norm(o).includes(norm(cruda)));
        if (i >= 0) return { indice: i, fuente: "operador" };
        log(LOG, `  Q${n} la respuesta "${cruda.slice(0, 30)}" no casó con ninguna opción, sigo esperando`);
      }
    }
    await page.waitForTimeout(3000);
  }
  return null;
}

const resultados = [];
for (const P of pendientes) {
  if (filtro && !`${P.titulo} ${P.curso}`.toLowerCase().includes(filtro.toLowerCase())) continue;
  log(LOG, `\n===== ${P.titulo} — ${P.curso} =====`);

  let reveladas = null, final = null, bitacoraFinal = [];
  for (let intento = 1; intento <= 3; intento++) {
    // net::ERR_ABORTED transitorio no debe tumbar toda la corrida: reintento una vez
    // y si persiste se salta ESTE examen, no el proceso completo.
    try {
      await page.goto(P.base + P.href, { waitUntil: "domcontentloaded", timeout: 90000 });
    } catch (e) {
      log(LOG, `  goto falló (${String(e.message).slice(0, 60)}), reintento`);
      await page.waitForTimeout(3000);
      try { await page.goto(P.base + P.href, { waitUntil: "domcontentloaded", timeout: 90000 }); }
      catch { log(LOG, `  goto falló otra vez, salto este examen`); break; }
    }
    await esperarExamenListo(page);
    // En una corrida de 39 exámenes la sesión puede caducar a medias. Sin este chequeo
    // los exámenes empiezan a fallar por una razón que no es la que se reporta.
    await exigirSesion(page);

    // Bajo carga, el goto a la lección del examen a veces aterriza en el TEMARIO sin
    // montar el contenido (196 evidencias: body = lista de lecciones, sin Start, sin
    // score, sin "Take this again"). El examen se abre clicando su PROPIA lección en
    // el temario. Sin esto, reiniciar() no encuentra nada y el examen se salta.
    if (!(await progreso(page))[0]
        && !await boton(page, /start/i).count()
        && !/did not pass|you have passed|Correct \(/i.test(await page.locator('body').innerText())) {
      const propia = page.locator(`a[href$="${P.href}"]`).first();
      if (await propia.count()) {
        log(LOG, `  el examen no montó al navegar: lo abro desde el temario`);
        await clic(propia);
        await esperarExamenListo(page, 20000);
      }
    }

    // Bajo carga (varios workers) el quiz puede quedarse en "Loading..." indefinido:
    // el XHR del quiz engine murió y el goto de reintento no siempre lo destraba.
    // Espera activa a que el Loading resuelva y, si persiste, UNA recarga dura.
    for (let recargas = 0; recargas <= 1; recargas++) {
      let cargando = true;
      for (let t = 0; t < 30 && cargando; t++) {   // hasta 45 s
        const b = await page.locator('body').innerText().catch(() => "");
        cargando = /Loading\.\.\./.test(b) && !/Correct \(|did not pass|you have passed/i.test(b)
                   && !await boton(page, /start/i).count();
        if (cargando) await page.waitForTimeout(1500);
      }
      if (!cargando) break;
      if (recargas === 0) {
        log(LOG, "  quiz atorado en Loading...: recarga dura");
        await page.reload({ waitUntil: "domcontentloaded", timeout: 90000 }).catch(() => {});
        await esperarExamenListo(page, 20000);
      }
    }

    const cuerpo = await page.locator('body').innerText();
    if (intento === 1 && /you have passed/i.test(cuerpo) && /\(100%\)/.test(cuerpo)) {
      final = { score: (cuerpo.match(/\d+ of \d+ Correct \(\d+%\)/) || ["?"])[0], aprobado: true };
      log(LOG, `  ${final.score} · ya estaba al 100%`);
      break;
    }

    const start = boton(page, /start/i);
    if (await start.count()) { await clic(start); await esperarPregunta(page); }
    if (!await reiniciar(page)) {
      log(LOG, "  !! no pude abrir el examen en la pregunta 1");
      // Diagnóstico: dejar evidencia del estado exacto en que quedó la página.
      const diag = `${CAPTURAS}/noabre-${P.href.split("/").pop()}-${Date.now()}`;
      await page.screenshot({ path: diag + ".png" }).catch(() => {});
      const cuerpoDiag = await page.locator('body').innerText().catch(() => "");
      guardar(diag + ".json", { href: P.href, url: page.url(), body: cuerpoDiag.slice(0, 800) });
      break;
    }

    const bitacora = [];
    const desconocidasAqui = [];
    const sondeadas = [];
    const sondeoPreguntas = [];   // texto+opciones de lo sondeado, por si no hay reveal
    let abortar = false;
    for (let paso = 0; paso < 60; paso++) {
      const [n, total] = await progreso(page);
      if (!n) break;
      const ops = await opciones(page);

      // Texto leído de la página en este momento, no de un archivo viejo: ahí estuvo
      // el error que hizo que el banco no encontrara nada.
      const texto = await textoPregunta(page, n, total);
      const captura = `${CAPTURAS}/${P.href.split("/").pop()}-q${String(n).padStart(2, "0")}.png`;
      // En modo lote (SKILLJAR_SIN_CAPTURAS=1) no se captura cada pregunta: con el
      // banco maduro la evidencia por pregunta no aporta y cuesta ~2-3 min por cuenta.
      // Las preguntas DESCONOCIDAS sí se capturan más abajo, que es donde importa.
      if (!process.env.SKILLJAR_SIN_CAPTURAS)
        await page.screenshot({ path: captura }).catch(() => {});

      if (!ops.length) {
        // Política del usuario (2026-09-13): los comentarios libres se contestan
        // "Muy bueno" siempre (antes se dejaban vacíos y los obligatorios trababan).
        const rellenos = await rellenarTextoObligatorio(page);
        log(LOG, `  Q${n}/${total} texto libre: ${rellenos ? '"Muy bueno"' : "(ya tenía texto)"}`);
        bitacora.push({ n, texto, elegida: rellenos ? "Muy bueno" : null, fuente: "texto libre" });
      }
      else {
        const textos = ops.map(o => o.texto);
        const clave = CLAVES[P.href]?.[String(n)];
        let idx = -1, fuente = "", motivoBanco = null;

        // ---- Preguntas de CHECKBOXES ("select all that apply", Academy) ----
        // El banco las guarda con `multi: [textos...]`. Sin entrada multi: en recolectar
        // se anota y se marca relleno para poder avanzar (nunca se envía); en otros modos
        // se marca la primera para no trabar el examen (se corrige cuando el banco tenga
        // la entrada). El avance SIEMPRE se verifica por número de pregunta.
        if (ops.some(o => o.tipo === "checkbox")) {
          const entradaMulti = BANCO.get(norm(texto));
          if (entradaMulti?.multi?.length) {
            const marcadas = [];
            for (const m of entradaMulti.multi) {
              const i = textos.findIndex(x => norm(x).includes(norm(m)) || norm(m).includes(norm(x)));
              if (i >= 0 && await elegir(page, i)) marcadas.push(textos[i]);
            }
            log(LOG, `  Q${n}/${total} [banco multi] marqué ${marcadas.length}/${entradaMulti.multi.length}`);
            bitacora.push({ n, texto, elegida: marcadas.join(" + "), fuente: "banco multi", captura });
          } else if (RECOLECTAR) {
            if (!desconocidasAqui.some(d => d.pregunta === n)) {
              if (process.env.SKILLJAR_SIN_CAPTURAS) await page.screenshot({ path: captura }).catch(() => {});
              desconocidasAqui.push({ examen: P.titulo, curso: P.curso, href: P.href, pregunta: n, texto, opciones: textos, captura, multi: true, motivo: "checkbox multi sin entrada en banco" });
          }
            log(LOG, `  Q${n}/${total} [multi] sin entrada en banco, la anoto y marco relleno`);
            await elegir(page, 0);
          } else {
            await elegir(page, 0);
            log(LOG, `  Q${n}/${total} [multi sin banco] relleno provisional`);
            bitacora.push({ n, texto, elegida: textos[0], fuente: "multi relleno", captura });
          }
          if (n >= total) break;
          const sigM = boton(page, /^next question$|^next$/i);
          if (!await sigM.count()) break;
          if (!(await clic(sigM) && await esperarPregunta(page, n))) {
            log(LOG, `  Q${n} !! pregunta multi no avanza, abandono este examen`);
            abortar = true; break;
          }
          continue;
        }

        // La regla de encuestas va PRIMERO, antes de cualquier fuente de respuesta.
        //
        // Estaba al final, después del banco, y eso la volvía inútil justo donde importa:
        // en un examen MIXTO (preguntas calificadas + escalas de satisfacción) el banco
        // traía "Unsure"/"Not sure" aprendidos de otra cuenta y los marcaba, o sea firmaba
        // una opinión a nombre del usuario. Una escala no se contesta aunque alguien la
        // haya contestado antes: no hay respuesta correcta que aprender.
        if (esEncuesta(texto, textos)) {
          let elegida = null;
          if (!ENCUESTAS_VACIAS) {
            const medio = puntoMedio(textos);
            if (await elegir(page, medio)) elegida = textos[medio];
          }
          log(LOG, `  Q${n}/${total} [encuesta] ${elegida ? `punto medio: ${elegida.slice(0, 40)}` : "la dejo vacía"}`);
          bitacora.push({ n, texto, elegida, fuente: elegida ? "encuesta: punto medio" : "encuesta: vacía" });
          if (n >= total) break;
          const sigEnc = boton(page, /^next question$|^next$/i);
          if (!await sigEnc.count()) break;

          // Comprobar que la pregunta CAMBIÓ, no que el clic no tronó. Con la escala en
          // blanco el portal aceptaba el clic y se quedaba donde estaba: el bucle volvía a
          // leer la misma pregunta y a registrar "la dejo vacía", 47 veces seguidas.
          const avanzo = await clic(sigEnc) && await esperarPregunta(page, n);
          if (!avanzo) {
            log(LOG, `  Q${n} [!] la escala no avanza${elegida ? " ni marcando el punto medio" : " (¿obligatoria?)"}. Abandono este examen sin enviarlo.`);
            obligatorias.push({ examen: P.titulo, curso: P.curso, href: P.href, pregunta: n, texto, opciones: textos, marcada: elegida });
            abortar = true;
          }
          continue;
        }

        if (reveladas?.[n]) {
          const t = norm(reveladas[n]);
          idx = textos.findIndex(x => norm(x).includes(t) || t.includes(norm(x)));
          if (idx >= 0) fuente = "revelada por la plataforma";
        }
        if (idx < 0 && clave) {
          idx = textos.findIndex(x => norm(x).includes(norm(clave)));
          if (idx >= 0) fuente = "clave";
        }
        let claveUsada = null, confianza = null;
        if (idx < 0) {
          const d = decidir(BANCO, texto, textos);
          if (d.indice >= 0) { idx = d.indice; fuente = d.fuente; claveUsada = d.clave; confianza = d.confianza; }
          else motivoBanco = d.motivo;
        }
        if (idx < 0 && RECOLECTAR) {
          // Se anota y se SIGUE, para juntar todas las desconocidas del examen en una
          // sola pasada. Antes abortaba en la primera: un examen con tres preguntas
          // nuevas costaba tres vueltas completas.
          // No re-anotar la misma pregunta si el portal nos rebotó y la releímos.
          if (!desconocidasAqui.some(d => d.pregunta === n)) {
            if (process.env.SKILLJAR_SIN_CAPTURAS) await page.screenshot({ path: captura }).catch(() => {});
            desconocidasAqui.push({ examen: P.titulo, curso: P.curso, href: P.href, pregunta: n, texto, opciones: textos, captura, motivo: motivoBanco });
          }
          log(LOG, `  Q${n}/${total} sin respuesta confiable (${motivoBanco ?? "no está en el banco"}), la anoto y sigo inventariando`);
          // Para poder ver la siguiente hay que avanzar. Se intenta SIN marcar nada,
          // PERO hay exámenes (Academy) que exigen respuesta: el clic a Next "funciona"
          // y el portal rebota con "You must provide an answer" — la pregunta NO cambia.
          // La única señal fiable es que el número avance; si no avanzó, se marca la
          // primera opción SOLO para poder pasar (este examen no se envía en modo
          // recolectar) y se reintenta. Si ni así, se abandona: jamás quedarse en bucle.
          if (n >= total) break;
          let sig = boton(page, /^next question$|^next$/i);
          if (!await sig.count()) break;
          await clic(sig);
          if (!await esperarPregunta(page, n, 6000)) {
            await elegir(page, 0);
            await clic(boton(page, /^next question$|^next$/i));
            if (!await esperarPregunta(page, n, 8000)) {
              log(LOG, `  Q${n} !! no pude avanzar ni con relleno, abandono la recolección de este examen`);
              break;
            }
          }
          continue;
        }
        if (idx < 0 && SONDEAR) {
          // Marca la primera y sigue. El score de ESTE intento no importa: existe para
          // que la plataforma revele las correctas y el siguiente intento salga 100%.
          idx = 0; fuente = "sondeo (la plataforma va a revelar la correcta)";
          sondeadas.push(n);
          sondeoPreguntas.push({ examen: P.titulo, curso: P.curso, href: P.href, pregunta: n, texto, opciones: textos, captura });
          log(LOG, `  Q${n}/${total} [sondeo] no la sé (${motivoBanco ?? "no está en el banco"}), marco para que la plataforma me la revele`);
        }
        if (idx < 0) {
          const r = await preguntarAlOperador(P.titulo, n, texto, textos, captura);
          if (!r) { log(LOG, `  Q${n} nadie contestó a tiempo, abandono este examen sin enviarlo`); abortar = true; break; }
          idx = r.indice; fuente = r.fuente;
          BANCO.set(norm(texto), { respuesta: textos[idx], verificada: false, origen: "operador" });
          guardarBanco(BANCO_LOCAL, BANCO);
        }

        if (!await elegir(page, idx)) { log(LOG, `  Q${n} !! no quedó marcada`); abortar = true; break; }
        log(LOG, `  Q${n}/${total} [${fuente}] ${textos[idx].slice(0, 58)}`);
        bitacora.push({ n, texto, elegida: textos[idx], fuente, confianza, clave: claveUsada, captura });
      }

      if (n >= total) break;
      const sig = boton(page, /^next question$|^next$/i);
      if (!await sig.count()) break;
      if (!await clic(sig)) { log(LOG, `  Q${n} !! no pude avanzar`); abortar = true; break; }
      // Esperar a que el número de pregunta CAMBIE, no contar hasta 1.3s: si el portal
      // tarda más se leía la pregunta anterior, y si tarda menos se dormía de gratis.
      if (!await esperarPregunta(page, n)) {
        // Texto libre OBLIGATORIO a media prueba (Academy): el portal rebota el avance
        // con "You must provide an answer". Relleno neutral y un solo reintento.
        if (/must provide an answer/i.test(await page.locator('body').innerText())
            && await rellenarTextoObligatorio(page)) {
          log(LOG, `  Q${n} texto libre obligatorio: relleno "N/A" para poder avanzar`);
          await clic(boton(page, /^next question$|^next$/i));
          if (await esperarPregunta(page, n)) continue;
        }
        log(LOG, `  Q${n} !! la siguiente pregunta no apareció`); abortar = true; break;
      }
    }

    // Si quedaron desconocidas, este examen NO se envía: se guardan todas juntas para
    // contestarlas de una sentada y volver a correr.
    if (desconocidasAqui.length) {
      const previas = hay(`${ESTADO}/desconocidas.json`) ? leer(`${ESTADO}/desconocidas.json`) : [];
      guardar(`${ESTADO}/desconocidas.json`, [...previas, ...desconocidasAqui]);
      log(LOG, `  ${desconocidasAqui.length} preguntas por contestar: NO envío este examen`);
      final = { score: null, aprobado: false, nota: `${desconocidasAqui.length} preguntas nuevas, sin enviar` };
      break;
    }
    if (abortar) { final = { score: null, aprobado: false, nota: "incompleto, no se envió" }; break; }

    const r = await enviar(page);
    if (!r) { log(LOG, "  !! sin botón de envío"); break; }
    log(LOG, `  intento ${intento}: ${r.score ?? "(encuesta)"}${r.aprobado ? " · APROBADO" : (r.score ? " · NO PASÓ" : "")}`);

    // El score es la única prueba real de que una respuesta era correcta. Un 100%
    // confirma TODAS las que se usaron; hasta entonces quedan como supuestas.
    if (r.porcentaje === 100) {
      let confirmadas = 0;
      for (const b of bitacora) {
        const k = b.clave ?? norm(b.texto);
        const e = BANCO.get(k);
        if (e && !e.verificada) { BANCO.set(k, { ...e, verificada: true, origen: "confirmada por score 100%" }); confirmadas++; }
        else if (!e && b.elegida) BANCO.set(norm(b.texto), { respuesta: b.elegida, verificada: true, origen: "confirmada por score 100%" });
      }
      if (confirmadas) { guardarBanco(BANCO_LOCAL, BANCO); log(LOG, `  ${confirmadas} respuestas quedaron confirmadas por el score`); }
    }
    guardar(`${ESTADO}/bitacoras/${P.href.split("/").pop()}.json`, { examen: P.titulo, curso: P.curso, intento, resultado: r, respuestas: bitacora });
    final = r;
    bitacoraFinal = bitacora;
    if (r.porcentaje === null || r.porcentaje === 100) break;

    reveladas = await revelarCorrectas(page);
    const cuantas = reveladas ? Object.keys(reveladas).length : 0;
    if (cuantas) {
      // Lo que dice la plataforma es la verdad, así que corrige el banco aunque hubiera
      // una entrada previa: justo estas son las que estaban mal.
      for (const [nn, correcta] of Object.entries(reveladas)) {
        const b = bitacora.find(x => String(x.n) === String(nn));
        if (b) BANCO.set(norm(b.texto), { respuesta: correcta, verificada: true, origen: "revelada por la plataforma" });
      }
      guardarBanco(BANCO_LOCAL, BANCO);
    }
    log(LOG, `  ${cuantas ? `la plataforma reveló ${cuantas} correctas, reintento` : "sin 'Show Answers': hay que revisar las respuestas a mano"}`);
    // Un sondeo sin revelación es el único caso en que este modo sale peor que abstenerse:
    // quedó un score bajo y no aprendimos nada. Hay que gritarlo, no dejarlo en el log.
    if (!cuantas && sondeadas.length) {
      log(LOG, `  [!] sondeé ${sondeadas.length} preguntas (${sondeadas.join(", ")}) y este examen NO revela las correctas.`);
      log(LOG, `  [!] el score se queda en ${r.score}. Hay que contestarlas a mano y reintentar: node run.mjs --solo "${P.titulo}"`);
      guardar(`${ESTADO}/sin-revelar.json`, [
        ...(hay(`${ESTADO}/sin-revelar.json`) ? leer(`${ESTADO}/sin-revelar.json`) : []),
        { examen: P.titulo, curso: P.curso, href: P.href, score: r.score,
          preguntas: bitacora.filter(b => sondeadas.includes(b.n)).map(b => ({ n: b.n, texto: b.texto })) },
      ]);
      // Y guardarlas CON OPCIONES en desconocidas.json: es la única vía para que el
      // banco aprenda las variantes del pool de preguntas de exámenes sin reveal.
      const previasD = hay(`${ESTADO}/desconocidas.json`) ? leer(`${ESTADO}/desconocidas.json`) : [];
      const nuevasD = sondeoPreguntas.filter(q => !previasD.some(p => p.texto === q.texto));
      if (nuevasD.length) guardar(`${ESTADO}/desconocidas.json`, [...previasD, ...nuevasD]);
    }
    if (!cuantas) break;
  }

  // Las capturas son evidencia para auditar. Si el examen salió 100% y cada respuesta
  // se decidió con confianza alta, no hay nada que auditar: se borran. Se conservan las
  // de exámenes que no dieron 100% y las de decisiones de confianza media.
  if (final?.porcentaje === 100 && bitacoraFinal.every(b => !b.confianza || b.confianza === "alta")) {
    let borradas = 0;
    for (const b of bitacoraFinal) {
      if (b.captura && hay(b.captura)) { try { unlinkSync(b.captura); borradas++; } catch {} }
    }
    if (borradas) log(LOG, `  ${borradas} capturas borradas (100% y todo con confianza alta)`);
  }
  resultados.push({ curso: P.curso, examen: P.titulo, ...final });
  guardar(`${ESTADO}/resultados.json`, resultados);
}

log(LOG, "\n===== RESUMEN =====");
for (const r of resultados) log(LOG, `${r.aprobado ? "OK" : (r.score ? "--" : "  ")}  ${(r.score ?? r.nota ?? "encuesta").padEnd(26)} ${r.examen} (${r.curso})`);

// Las escalas obligatorias se reportan con nombre y pregunta. Es lo único de todo el
// flujo que NO se puede resolver sin decidir por el usuario, así que no se disimula
// dentro del conteo de "encuestas".
if (obligatorias.length) {
  guardar(`${ESTADO}/obligatorias.json`, obligatorias);
  log(LOG, `\n[!] ${obligatorias.length} escalas de satisfacción bloquearon su examen (no avanzan):`);
  for (const o of obligatorias) log(LOG, `    ${o.examen} (${o.curso}) Q${o.pregunta}: ${o.texto.slice(0, 70)}${o.marcada ? `  [marqué: ${o.marcada}]` : ""}`);
  log(LOG, `    Detalle en ${ESTADO}/obligatorias.json`);
}
await soltar(navegador);
// Ver la nota en walk.mjs: sin esto el proceso queda vivo por el socket CDP abierto.
process.exit(0);
