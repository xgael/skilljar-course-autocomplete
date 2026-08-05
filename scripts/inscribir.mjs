// Inscribe la cuenta en cursos y devuelve la URL de entrada al temario de cada uno.
//
//   node inscribir.mjs <slug-o-url> [más...]        # inscribe los que le pases
//   node inscribir.mjs --lista <archivo.txt>        # ALCANCE FIJO: solo los del archivo
//   node inscribir.mjs --catalogo <portal>          # descubre el catálogo y los inscribe todos
//
// Escribe la lista lista para usar en /tmp/skilljar/cursos.json:
//
//   node inscribir.mjs --lista ~/telegram_files/links_cursos.txt
//   node orquesta.mjs $(python3 -c "import json;print(' '.join(json.load(open('/tmp/skilljar/cursos.json'))))")
//
// PREFERIR --lista SOBRE --catalogo. El catálogo trae más cursos de los que el usuario
// quiere: con --catalogo se inscribieron 18 cuando el encargo eran 15, y hacer cursos de
// más es trabajo que nadie pidió. --catalogo es para cuando NO hay lista.
//
// POR QUÉ EXISTE: en una cuenta nueva los cursos NO están inscritos, y sin inscripción
// el temario no existe. walk.mjs reportaba "sin temario (¿no inscrito?)" — un diagnóstico
// correcto que dejaba el trabajo parado. Ahora se resuelve en vez de reportarse.
//
// LA TRAMPA: al pulsar "Enroll in Course" / "Register | FREE" la URL NO cambia. Verificar
// la inscripción por el redirect da falso negativo en TODOS los cursos. La prueba de que
// quedó es que la portada empiece a listar enlaces de lección (/slug/<id>).

import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { conectar, origen, esperarA, ESTADO, soltar } from "./lib.mjs";

mkdirSync(ESTADO, { recursive: true });
const args = process.argv.slice(2);
const iCat = args.indexOf("--catalogo");
const iLista = args.indexOf("--lista");
const PORTAL = iCat >= 0 ? args[iCat + 1] : null;
const LISTA = iLista >= 0 ? args[iLista + 1] : null;
const consumidos = new Set([iCat + 1, iLista + 1].filter(i => i > 0));
let entradas = args.filter((a, i) => !a.startsWith("--") && !consumidos.has(i));

// Lista de alcance escrita por el usuario: un enlace por renglón, y una línea en prosa
// marcando lo que NO se hace ("Esto es el único que no se hace:"). Todo lo que venga
// DESPUÉS de esa marca queda fuera — así el archivo se lee tal como está escrito, sin
// pedirle al usuario que lo reformatee.
let portalDeLista = null;
if (LISTA) {
  const texto = readFileSync(LISTA.replace(/^~/, process.env.HOME), "utf8");
  portalDeLista = texto.match(/https?:\/\/[^/\s]+/)?.[0] ?? null;   // el portal sale del propio archivo
  const marca = texto.match(/^.*\b(no se hace|no se hacen|no hacer|excluir)\b.*$/im);
  const dentro = marca ? texto.slice(0, marca.index) : texto;
  const fuera = marca ? [...texto.slice(marca.index).matchAll(/https?:\/\/\S+/g)].map(m => m[0]) : [];
  const rutaDe = u => new URL(u.replace(/[.,;)]+$/, "")).pathname.split("/").filter(Boolean)[0];
  const vetados = new Set(fuera.map(u => { try { return rutaDe(u); } catch { return null; } }).filter(Boolean));
  entradas = [...new Set([...dentro.matchAll(/https?:\/\/\S+/g)]
    .map(m => { try { return rutaDe(m[0]); } catch { return null; } })
    .filter(s => s && !vetados.has(s) && !/^(page|path|accounts|auth|catalog)$/.test(s)))]
    .map(s => "/" + s);
  console.log(`alcance del archivo: ${entradas.length} cursos${vetados.size ? ` · fuera: ${[...vetados].join(" ")}` : ""}\n`);
}

if (!PORTAL && !entradas.length) {
  console.error("uso: node inscribir.mjs <slug|url> [...]  |  --lista <archivo>  |  --catalogo <portal>");
  process.exit(1);
}

const BASE = origen(PORTAL ?? portalDeLista ?? entradas[0]);
const { navegador, page } = await conectar();

// Enlaces de lección de ESTE curso. Es el detector de inscripción.
const lecciones = slug => page.$$eval("a[href]", (as, s) =>
  [...new Set(as.map(a => a.getAttribute("href") || "").filter(h => new RegExp(`^${s}/\\d+$`).test(h)))], slug);

// El catálogo vive repartido entre la portada y las páginas de sección (/page/...): un
// curso puede estar en una y no en la otra, así que se recorren las dos y se unen.
async function catalogo() {
  const slugs = new Set(), paginas = new Set([BASE + "/"]);
  for (const p of ["/page/all-courses", "/catalog"]) paginas.add(BASE + p);
  for (const u of paginas) {
    try {
      await page.goto(u, { waitUntil: "domcontentloaded", timeout: 90000 });
      await esperarA(page, async () => (await page.locator("a[href]").count()) > 20, { techo: 8000 });
      const hs = await page.$$eval("a[href]", as => as.map(a => a.getAttribute("href") || ""));
      for (const h of hs) {
        // Portadas de curso: un solo segmento. Se descartan las secciones (/page/, /path/),
        // la cuenta, y las certificaciones (son exámenes presenciales, no cursos: no tienen
        // temario que recorrer y registrarse en ellas no ayuda).
        if (/^\/[a-z0-9][a-z0-9-]{4,}$/.test(h)
            && !/^\/(page|path|accounts|auth|catalog|api)\b/.test(h)
            && !/certification$/.test(h)) slugs.add(h);
      }
    } catch { /* una sección que no existe en este portal no es un error */ }
  }
  return [...slugs];
}

const objetivos = (PORTAL ? await catalogo() : entradas)
  .map(x => x.startsWith("http") ? new URL(x).pathname : x)
  .map(x => "/" + x.replace(/^\/+|\/+$/g, "").split("/")[0]);

console.log(`${objetivos.length} cursos por revisar\n`);
const listos = [], sinResolver = [];

for (const slug of objetivos) {
  try {
    await page.goto(BASE + slug, { waitUntil: "domcontentloaded", timeout: 90000 });
    await esperarA(page, async () => (await page.locator("a[href]").count()) > 15, { techo: 8000 });

    let ls = await lecciones(slug);
    let ya = ls.length > 0;
    if (!ya) {
      const btn = page.getByRole("link", { name: /^(enroll|register|start course|continue|resume)/i })
        .or(page.getByRole("button", { name: /^(enroll|register|start course|continue|resume)/i })).first();
      if (!await btn.count()) { sinResolver.push({ slug, motivo: "sin botón de inscripción" }); console.log(`--  ${slug}  sin botón de inscripción`); continue; }
      await btn.click({ timeout: 15000 }).catch(() => {});
      // El botón puede llevar al temario o quedarse donde estaba; ambos casos son normales.
      await esperarA(page, async () => (await lecciones(slug)).length > 0 || /\/\d+$/.test(page.url()), { techo: 10000 });
      if (!(await lecciones(slug)).length) {
        await page.goto(BASE + slug, { waitUntil: "domcontentloaded", timeout: 90000 });
        await esperarA(page, async () => (await lecciones(slug)).length > 0, { techo: 8000 });
      }
      ls = await lecciones(slug);
    }
    if (ls.length) { listos.push(BASE + ls[0]); console.log(`OK  ${slug}  ${ls.length} ítems${ya ? " (ya estaba)" : " (inscrito ahora)"}`); }
    else { sinResolver.push({ slug, motivo: "inscribió pero no aparece temario" }); console.log(`--  ${slug}  inscribió pero no aparece temario`); }
  } catch (e) {
    sinResolver.push({ slug, motivo: String(e).slice(0, 70) });
    console.log(`--  ${slug}  ${String(e).slice(0, 70)}`);
  }
}

writeFileSync(`${ESTADO}/cursos.json`, JSON.stringify(listos, null, 2));
writeFileSync(`${ESTADO}/sin-inscribir.json`, JSON.stringify(sinResolver, null, 2));
console.log(`\n${listos.length} con temario · ${sinResolver.length} sin resolver`);
// Lo que no se pudo inscribir se dice por nombre: un curso que no aparece en la lista
// se olvida en silencio, y eso es justo lo que hace que falten cursos al final.
for (const s of sinResolver) console.log(`  [!] ${s.slug}: ${s.motivo}`);
console.log(`\nlista para el orquestador en ${ESTADO}/cursos.json`);
await soltar(navegador);
process.exit(0);
