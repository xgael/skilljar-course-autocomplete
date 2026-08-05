// Estado de todos los cursos tocados: lecciones y exámenes.
//
//   node status.mjs [url-del-curso ...]      sin argumentos usa el resumen del último walk

import { conectar, origen, temario, exigirSesion, mismoCurso, leer, hay, ESTADO, soltar} from "./lib.mjs";

let urls = process.argv.slice(2);
if (!urls.length) {
  if (!hay(`${ESTADO}/resumen.json`)) { console.error("pasa las urls o corre walk.mjs antes"); process.exit(1); }
  const r = leer(`${ESTADO}/resumen.json`);
  const base = hay(`${ESTADO}/pendientes.json`) ? (leer(`${ESTADO}/pendientes.json`)[0]?.base ?? "") : "";
  urls = r.map(x => base + x.url);
}

const { navegador, page } = await conectar();
let completos = 0;
for (const url of urls) {
  await page.goto(origen(url) + new URL(url).pathname, { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.waitForTimeout(3000);
  await exigirSesion(page);
  if (!mismoCurso(new URL(url).pathname, page.url())) {
    console.log(`  --   ${new URL(url).pathname}  · no accesible con esta cuenta (redirigió)`);
    continue;
  }
  const { titulo, lecciones } = await temario(page);
  const faltan = lecciones.filter(l => !l.completa);
  if (!faltan.length) completos++;
  console.log(`${faltan.length ? "  " : "OK"}  ${String(lecciones.length - faltan.length).padStart(3)}/${String(lecciones.length).padEnd(3)} ${titulo}`
    + (faltan.length ? `  · falta: ${faltan.map(l => l.titulo + (l.paqueteWeb ? " [paquete web]" : "")).join(" · ")}` : ""));
}
console.log(`\n${completos}/${urls.length} cursos completos`);
await soltar(navegador);
