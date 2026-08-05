// Auditoría: pregunta al portal en qué va cada curso, ítem por ítem.
//
//   node verificar.mjs <url-curso> [más urls...]
//   node verificar.mjs                        (usa los cursos del último recorrido)
//
// No lee mis bitácoras ni mis resultados a propósito. La única prueba de que algo se
// completó es que el portal lo marque; lo que diga mi log es una intención, no un hecho.
// Si los dos no coinciden, gana el portal.
//
// Salida: un renglón por curso y el detalle de lo que falta, más un veredicto global
// que sirve de respuesta a "¿ya quedó?".

import { writeFileSync, mkdirSync } from "node:fs";
import { conectar, origen, temario, exigirSesion, mismoCurso, esperarTemario, leer, hay, ESTADO, soltar} from "./lib.mjs";

// Con SKILLJAR_DIR apuntando a una carpeta nueva (una auditoría aparte, por ejemplo), el
// informe tronaba con ENOENT al final: la auditoría ya estaba hecha pero el veredicto
// escrito se perdía. Crear la carpeta antes de trabajar.
mkdirSync(ESTADO, { recursive: true });

let urls = process.argv.slice(2).filter(a => a.startsWith("http"));
if (!urls.length) {
  if (!hay(`${ESTADO}/resumen.json`)) { console.error("pasa las urls o corre walk.mjs antes"); process.exit(1); }
  const base = hay(`${ESTADO}/pendientes.json`) ? (leer(`${ESTADO}/pendientes.json`)[0]?.base ?? "") : "";
  urls = leer(`${ESTADO}/resumen.json`).map(x => base + x.url).filter(u => u.startsWith("http"));
  if (!urls.length) { console.error("no pude deducir las urls, pásalas a mano"); process.exit(1); }
}

const esExamen = t => /quiz|assessment|survey|certificate|examen|encuesta/i.test(t);
let { navegador, page } = await conectar();
const informe = [];
const roto = e => /has been closed|Target (page|closed)|Protocol error|ERR_ABORTED|browserType|ECONNREFUSED/i.test(String(e));

for (const url of urls) {
  const ruta = new URL(url).pathname;
  // Dos intentos por curso, igual que walk.mjs. El navegador de depuración se degrada
  // (bug conocido de CDP) y sin esto una auditoría de 18 cursos se pierde entera por una
  // caída en el número 15 — y peor: se pierde en silencio, con el informe a medias.
  for (let intento = 1; intento <= 2; intento++) {
    try {
      await page.goto(origen(url) + ruta, { waitUntil: "domcontentloaded", timeout: 90000 });
      await esperarTemario(page);
      await exigirSesion(page);

      if (!mismoCurso(ruta, page.url())) {
        informe.push({ ruta, veredicto: "no accesible", detalle: `redirigió a ${new URL(page.url()).pathname}` });
        break;
      }
      const { titulo, lecciones } = await temario(page);
      if (!lecciones.length) {
        informe.push({ ruta, titulo, veredicto: "sin temario", detalle: "la cuenta no parece inscrita" });
        break;
      }

      const faltan = lecciones.filter(l => !l.completa);
      informe.push({
        ruta, titulo,
        total: lecciones.length,
        completas: lecciones.length - faltan.length,
        veredicto: faltan.length === 0 ? "cerrado" : "incompleto",
        lecciones: faltan.filter(l => !esExamen(l.titulo) && !l.paqueteWeb).map(l => l.titulo),
        examenes: faltan.filter(l => esExamen(l.titulo)).map(l => l.titulo),
        paquetesWeb: faltan.filter(l => l.paqueteWeb).map(l => l.titulo),
      });
      break;
    } catch (e) {
      if (roto(e) && intento === 1) {
        console.log(`  · navegador caído en ${ruta}, reconecto y repito`);
        try { ({ navegador, page } = await conectar()); continue; }
        catch { informe.push({ ruta, veredicto: "sin navegador", detalle: "no pude reconectar" }); break; }
      }
      // Un curso que no se pudo auditar se DICE. Callarlo lo haría parecer auditado.
      informe.push({ ruta, veredicto: "no auditado", detalle: String(e).slice(0, 90) });
      break;
    }
  }
}
await soltar(navegador);

const cerrados = informe.filter(x => x.veredicto === "cerrado");
console.log("");
for (const x of informe) {
  const marca = x.veredicto === "cerrado" ? "OK" : "--";
  console.log(`${marca}  ${String(x.completas ?? 0).padStart(3)}/${String(x.total ?? 0).padEnd(3)} ${x.titulo ?? x.ruta}${x.veredicto === "cerrado" ? "" : `  · ${x.veredicto}`}`);
  if (x.detalle) console.log(`         ${x.detalle}`);
  if (x.lecciones?.length) console.log(`         lecciones sin marcar: ${x.lecciones.join(" · ")}`);
  if (x.examenes?.length) console.log(`         exámenes pendientes: ${x.examenes.join(" · ")}`);
  if (x.paquetesWeb?.length) console.log(`         paquetes web (no se pueden cerrar así): ${x.paquetesWeb.join(" · ")}`);
}

// El resumen se escribe con las cuentas separadas: una lección sin marcar es un fallo
// del recorrido y se arregla revisitando; un examen pendiente es trabajo que falta; un
// paquete web es un bloqueo conocido. Mezclarlos esconde el problema real.
const sueltas = informe.flatMap(x => x.lecciones ?? []).length;
const examenes = informe.flatMap(x => x.examenes ?? []).length;
const paquetes = informe.flatMap(x => x.paquetesWeb ?? []).length;

console.log(`\n${cerrados.length}/${informe.length} cursos cerrados`);
if (sueltas) console.log(`[!] ${sueltas} lecciones sin marcar → revisítalas: node walk.mjs <curso>`);
if (examenes) console.log(`    ${examenes} exámenes pendientes → node run.mjs`);
if (paquetes) console.log(`    ${paquetes} paquetes web: no se cierran con esta herramienta`);

writeFileSync(`${ESTADO}/verificacion.json`, JSON.stringify(informe, null, 2));
console.log(`\ndetalle en ${ESTADO}/verificacion.json`);
process.exit(sueltas ? 1 : 0);
