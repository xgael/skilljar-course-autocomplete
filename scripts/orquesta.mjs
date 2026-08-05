// Orquestador: reparte los cursos entre varios agentes que trabajan a la vez.
//
//   node orquesta.mjs [--agentes 3] <url-curso> <url-curso> ...
//
// Cada agente es independiente de verdad: su propio Chrome, su propio puerto de
// depuración y su propia carpeta de estado. Eso es obligatorio, no un lujo — los
// scripts manejan UNA pestaña, así que dos agentes en el mismo navegador se pisarían
// las páginas y ambos acabarían contestando el examen equivocado.
//
// Lo único que comparten es el banco de respuestas, y solo para leerlo. Lo que cada
// agente aprende se guarda aparte y el orquestador lo integra al final, para que dos
// procesos no escriban el mismo archivo al mismo tiempo.
//
// El reparto es por CARGA, no por número de cursos: un curso de 93 lecciones no pesa
// lo mismo que uno de 4. Se ordenan de mayor a menor y cada curso se le da al agente
// que va más desahogado.

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { conectar, temario, exigirSesion, mismoCurso, origen, esperarTemario, cargarBanco, guardarBanco, soltar} from "./lib.mjs";

const AQUI = dirname(fileURLToPath(import.meta.url));
const RAIZ = process.env.SKILLJAR_DIR ?? "/tmp/skilljar";
const BANCO = process.env.SKILLJAR_BANCO ?? `${RAIZ}/banco.json`;
// Con SKILLJAR_DIR apuntando a una carpeta nueva, escribir el estado previo tronaba con
// ENOENT antes de hacer nada. Crearla primero.
mkdirSync(RAIZ, { recursive: true });

const args = process.argv.slice(2);
const iAg = args.indexOf("--agentes");
// Tres por defecto: cada agente carga su propio Chrome y a partir de ahí la máquina
// se vuelve el cuello de botella (con cinco el load subió a 16 y todo se arrastró).
const AGENTES = iAg >= 0 ? Number(args[iAg + 1]) : 3;
const PUERTO_BASE = Number(process.env.SKILLJAR_PUERTO ?? 9222);
// Ojo con el filtro: sin --agentes, iAg es -1 y "i !== iAg + 1" excluía el índice 0,
// o sea la PRIMERA url. Se perdía un curso completo sin decir nada.
const urls = args.filter((a, i) => a.startsWith("http") && !(iAg >= 0 && i === iAg + 1));
const soloExamenes = args.includes("--solo-examenes");
// Ante una pregunta desconocida, sondear en vez de recolectar y abandonar.
//
// --recolectar dejaba el examen sin enviar esperando que una persona contestara: con
// varios agentes en paralelo y nadie mirando, eso es un curso que no cierra. --sondear
// le pregunta a la PLATAFORMA (envío deliberadamente imperfecto → "Show Answers" →
// reintento al 100%), que además sabe la respuesta mejor que yo. Se puede volver al
// comportamiento viejo pasando --recolectar.
const modoDesconocidas = args.includes("--recolectar") ? "--recolectar" : "--sondear";

if (!urls.length) {
  console.error("uso: node orquesta.mjs [--agentes 3] <url-curso> [más urls...]");
  process.exit(1);
}

// ------------------------------------------------- revisión previa
//
// Antes de repartir hay que ver en qué va cada curso. Sin esto se mandan agentes a
// recorrer 93 lecciones que ya estaban completas, o a cursos donde la cuenta no está
// inscrita. Cuesta una página por curso y ahorra cientos.

const primerPuerto = PUERTO_BASE;
await new Promise(r => spawn(`${AQUI}/chrome.sh`, [String(primerPuerto)],
  { env: { ...process.env, SKILLJAR_PROFILE: "/tmp/skilljar-chrome-1" }, stdio: "ignore" }).on("close", r));

console.log("revisando el estado de cada curso antes de repartir…\n");
const { navegador, page } = await conectar(primerPuerto);
const estado = [];
for (const u of urls) {
  const ruta = new URL(u).pathname;
  try {
    await page.goto(origen(u) + ruta, { waitUntil: "domcontentloaded", timeout: 90000 });
    await esperarTemario(page);
    await exigirSesion(page);
    if (!mismoCurso(ruta, page.url())) { estado.push({ url: u, ruta, problema: "no accesible (redirigió)" }); continue; }
    const { titulo, lecciones } = await temario(page);
    if (!lecciones.length) { estado.push({ url: u, ruta, titulo, problema: "sin temario (¿no inscrito?)" }); continue; }
    const faltan = lecciones.filter(l => !l.completa);
    estado.push({
      url: u, ruta, titulo, total: lecciones.length,
      faltanLecciones: faltan.filter(l => !l.paqueteWeb && !/quiz|assessment|survey|certificate/i.test(l.titulo)).length,
      faltanExamenes: faltan.filter(l => /quiz|assessment|survey|certificate/i.test(l.titulo)).length,
      paquetesWeb: faltan.filter(l => l.paqueteWeb).length,
    });
  } catch (e) { estado.push({ url: u, ruta, problema: String(e).slice(0, 60) }); }
}
await soltar(navegador);
writeFileSync(`${RAIZ}/estado-previo.json`, JSON.stringify(estado, null, 2));

for (const e of estado) {
  if (e.problema) { console.log(`  [!] ${e.ruta}: ${e.problema}`); continue; }
  const partes = [];
  if (e.faltanLecciones) partes.push(`${e.faltanLecciones} lecciones`);
  if (e.faltanExamenes) partes.push(`${e.faltanExamenes} exámenes`);
  if (e.paquetesWeb) partes.push(`${e.paquetesWeb} paquetes web (no se pueden)`);
  console.log(`  ${partes.length ? "·" : "OK"} ${e.titulo ?? e.ruta}: ${partes.join(" + ") || "ya está completo"}`);
}

const trabajo = estado.filter(e => !e.problema && (e.faltanLecciones || e.faltanExamenes));
const listos = estado.filter(e => !e.problema && !e.faltanLecciones && !e.faltanExamenes);
console.log(`\n${listos.length} ya completos (no se tocan) · ${trabajo.length} por trabajar\n`);
if (!trabajo.length) { console.log("no hay nada que hacer"); process.exit(0); }

// Peso real: lo que FALTA, no el tamaño del curso. Un examen cuesta más que una lección
// (hay que contestarlo), de ahí el factor.
const peso = e => e.faltanLecciones + e.faltanExamenes * 8;

const grupos = Array.from({ length: AGENTES }, () => ({ carga: 0, cursos: [], soloExamenes: true }));
for (const e of [...trabajo].sort((a, b) => peso(b) - peso(a))) {
  const g = grupos.reduce((min, x) => (x.carga < min.carga ? x : min), grupos[0]);
  g.cursos.push(e.url);
  g.carga += peso(e);
  if (e.faltanLecciones) g.soloExamenes = false;      // este agente sí tiene que visitar lecciones
}

const activos = grupos.filter(g => g.cursos.length);
console.log(`${urls.length} cursos entre ${activos.length} agentes\n`);
activos.forEach((g, i) => {
  console.log(`  agente ${i + 1} (puerto ${PUERTO_BASE + i}, carga ~${g.carga})`);
  g.cursos.forEach(u => console.log(`      ${new URL(u).pathname}`));
});
console.log("");

const ejecutar = (cmd, cmdArgs, env, etiqueta) => new Promise(resolve => {
  const p = spawn(cmd, cmdArgs, { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  const prefijo = d => d.toString().split("\n").filter(Boolean).forEach(l => console.log(`[${etiqueta}] ${l}`));
  p.stdout.on("data", prefijo);
  p.stderr.on("data", prefijo);
  p.on("close", code => resolve(code));
});

async function trabajar(g, i) {
  const etiqueta = `ag${i + 1}`;
  const puerto = PUERTO_BASE + i;
  const dir = `${RAIZ}/agente-${i + 1}`;
  const perfil = `/tmp/skilljar-chrome-${i + 1}`;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });

  const env = {
    SKILLJAR_DIR: dir,
    SKILLJAR_PUERTO: String(puerto),
    SKILLJAR_BANCO: BANCO,          // el banco se comparte para leer
    SKILLJAR_PROFILE: perfil,
  };

  // Un navegador por agente. El perfil se copia del Chrome del usuario, así que los
  // cinco heredan la misma sesión sin volver a iniciarla.
  const arranque = i === 0 ? 0 : await ejecutar(`${AQUI}/chrome.sh`, [String(puerto)], env, etiqueta);
  if (arranque !== 0) { console.log(`[${etiqueta}] no levantó el navegador, me detengo`); return { etiqueta, error: "sin navegador" }; }

  // CURSO POR CURSO, no todas las lecciones y luego todos los exámenes.
  //
  // Hacerlo por fases dejaba a cada curso en n-1 hasta el final: si la corrida moría a
  // la mitad, ningún curso quedaba cerrado y no había un solo certificado. Cerrando de
  // uno en uno, lo que ya se terminó se queda terminado.
  //
  // Funciona porque walk.mjs sobrescribe pendientes.json con lo del curso que acaba de
  // leer, así que run.mjs solo ve los exámenes de ese curso.
  for (const curso of g.cursos) {
    // Se borra el inventario ANTES de cada curso. Si walk se cae, run encuentra vacío y
    // dice "corre walk primero" en vez de contestar los exámenes del curso anterior.
    rmSync(`${dir}/pendientes.json`, { force: true });
    const modo = (soloExamenes || g.soloExamenes) ? ["--inventario"] : [];
    await ejecutar("node", [`${AQUI}/walk.mjs`, ...modo, curso], env, etiqueta);
    await ejecutar("node", [`${AQUI}/run.mjs`, modoDesconocidas], env, etiqueta);
    // Los resultados de cada curso se acumulan: run.mjs reescribe resultados.json por
    // corrida, así que hay que juntarlos antes de que el siguiente los pise.
    if (existsSync(`${dir}/resultados.json`)) {
      const previos = existsSync(`${dir}/acumulado.json`) ? JSON.parse(readFileSync(`${dir}/acumulado.json`, "utf8")) : [];
      writeFileSync(`${dir}/acumulado.json`,
        JSON.stringify([...previos, ...JSON.parse(readFileSync(`${dir}/resultados.json`, "utf8"))], null, 2));
    }
    // Lo aprendido se integra al banco compartido AL CERRAR CADA CURSO, no al final de
    // todo: así el agente 2 ya encuentra lo que el agente 1 acabó de aprender. Es seguro
    // hacerlo aquí porque los tres trabajar() viven en este mismo proceso y el merge es
    // sincrónico — no hay dos escrituras entrelazadas.
    if (existsSync(`${dir}/banco.json`)) {
      const compartido = cargarBanco(BANCO);
      let sumadas = 0;
      for (const [k, v] of Object.entries(JSON.parse(readFileSync(`${dir}/banco.json`, "utf8")))) {
        const entrada = typeof v === "string" ? { respuesta: v, verificada: false, origen: "importada" } : v;
        const previa = compartido.get(k);
        if (!previa || (entrada.verificada && !previa.verificada)) { compartido.set(k, entrada); sumadas++; }
      }
      if (sumadas) { guardarBanco(BANCO, compartido); console.log(`[${etiqueta}] +${sumadas} al banco compartido`); }
    }
    console.log(`[${etiqueta}] cerrado: ${new URL(curso).pathname}`);
  }

  return {
    etiqueta,
    cursos: g.cursos.map(u => new URL(u).pathname),
    resultados: existsSync(`${dir}/acumulado.json`) ? JSON.parse(readFileSync(`${dir}/acumulado.json`, "utf8")) : [],
    desconocidas: existsSync(`${dir}/desconocidas.json`) ? JSON.parse(readFileSync(`${dir}/desconocidas.json`, "utf8")) : [],
    aprendido: existsSync(`${dir}/banco.json`) ? JSON.parse(readFileSync(`${dir}/banco.json`, "utf8")) : {},
  };
}

const inicio = Date.now();
const informes = await Promise.all(activos.map(trabajar));
const minutos = ((Date.now() - inicio) / 60000).toFixed(1);

// Integrar lo aprendido: se escribe UNA vez, aquí, y no tres veces en paralelo.
// Una respuesta confirmada por un score gana sobre una supuesta, sin importar el orden
// en que terminaron los agentes.
const banco = cargarBanco(BANCO);
let nuevas = 0, promovidas = 0;
for (const inf of informes) {
  for (const [k, v] of Object.entries(inf.aprendido ?? {})) {
    const entrada = typeof v === "string" ? { respuesta: v, verificada: false, origen: "importada" } : v;
    const previa = banco.get(k);
    if (!previa) { banco.set(k, entrada); nuevas++; }
    else if (entrada.verificada && !previa.verificada) { banco.set(k, entrada); promovidas++; }
  }
}
guardarBanco(BANCO, banco);

const todos = informes.flatMap(i => i.resultados ?? []);
const pendientes = informes.flatMap(i => i.desconocidas ?? []);
writeFileSync(`${RAIZ}/resultados-global.json`, JSON.stringify(todos, null, 2));
writeFileSync(`${RAIZ}/desconocidas-global.json`, JSON.stringify(pendientes, null, 2));

const cien = todos.filter(r => /\(100%\)/.test(r.score ?? ""));
const encuestas = todos.filter(r => !r.score && !r.nota);
const sinEnviar = todos.filter(r => r.nota);

console.log(`\n===== ${minutos} min con ${activos.length} agentes =====`);
for (const inf of informes) {
  const n = (inf.resultados ?? []).filter(r => /\(100%\)/.test(r.score ?? "")).length;
  console.log(`  ${inf.etiqueta}: ${n} exámenes al 100% · ${inf.cursos?.length ?? 0} cursos${inf.error ? " · " + inf.error : ""}`);
}
console.log(`\n  al 100%: ${cien.length} · encuestas: ${encuestas.length} · sin enviar: ${sinEnviar.length}`);
if (nuevas) console.log(`  banco: +${nuevas} respuestas aprendidas (total ${Object.keys(banco).length})`);
if (sinEnviar.length) {
  console.log("\n  detenidos por preguntas nuevas (NO se enviaron):");
  sinEnviar.forEach(r => console.log(`    ${r.examen} (${r.curso})`));
  console.log(`  las preguntas quedaron en ${RAIZ}/desconocidas-global.json`);
}

// Salida explícita, igual que walk.mjs y run.mjs: la revisión previa deja una conexión
// CDP abierta (soltar() no cierra el navegador a propósito) y node se queda vivo para
// siempre esperando ese socket. El resumen ya se imprimió y el trabajo está hecho, pero
// el proceso sigue en la lista — y entonces "¿ya terminó?" se contesta mal.
process.exit(0);
