// Orquestador para completar la Academy de Anthropic (anthropic.skilljar.com) en MUCHAS
// cuentas email+password, una por una, de forma RESUMIBLE.
//
//   node academia900.mjs --csv <ruta.csv> [--max N] [--desde N] [--solo correo]
//
// Por cada cuenta pendiente: login-pw -> inscribir(21 cursos) -> walk -> run --sondear ->
// verificar -> registra avance -> sign out. Reanuda leyendo el progreso: las cuentas
// 'hecho' se saltan. Nada de paralelo entre cuentas: el portal es una sesión a la vez.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const AQUI = dirname(fileURLToPath(import.meta.url));
const arg = n => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : null; };
const CSV = arg("--csv") || `${process.env.HOME}/telegram_files/CUENTAS_SKILLJAR_900.csv`;
const MAX = Number(arg("--max") || "0");         // 0 = sin límite
const DESDE = Number(arg("--desde") || "1");     // 1-based, salta las primeras N-1
const HASTA = Number(arg("--hasta") || "0");     // 1-based inclusive; 0 = hasta el final
const SOLO = arg("--solo");                        // procesar solo este correo
const PORTAL = "https://anthropic.skilljar.com/";
const LISTA = `${process.env.HOME}/Documentos/skilljar-cursos/academia_cursos.txt`;
const NOTAS = `${process.env.HOME}/Documentos/skilljar-cursos`;
// Cada worker escribe SU archivo de progreso (evita carreras read-modify-write entre
// workers paralelos), pero para decidir qué cuentas saltar se LEEN TODOS los
// academia900_progreso*.json del directorio.
const PROGRESO = arg("--progreso") || `${NOTAS}/academia900_progreso.json`;
const ENV = {
  ...process.env,
  SKILLJAR_DIR: process.env.SKILLJAR_DIR || "/tmp/skj900",
  SKILLJAR_PUERTO: process.env.SKILLJAR_PUERTO || "9222",
  SKILLJAR_NOTAS: NOTAS,
};

mkdirSync(NOTAS, { recursive: true });
const prog = existsSync(PROGRESO) ? JSON.parse(readFileSync(PROGRESO, "utf8")) : {};
const guardaProg = () => writeFileSync(PROGRESO, JSON.stringify(prog, null, 2));
function hechasGlobales() {
  const done = new Set();
  try {
    for (const f of readdirSync(NOTAS)) {
      if (!/^academia900_progreso.*\.json$/.test(f)) continue;
      try {
        const p = JSON.parse(readFileSync(`${NOTAS}/${f}`, "utf8"));
        for (const [em, v] of Object.entries(p)) if (v.status === "hecho") done.add(em);
      } catch {}
    }
  } catch {}
  return done;
}

// --- CSV: Nombre,Correo,Contraseña,Estado ---
const filas = readFileSync(CSV, "utf8").trim().split(/\r?\n/).slice(1)
  .map(l => l.split(",")).filter(c => c.length >= 3 && c[1].includes("@"))
  .map(c => ({ nombre: c[0].trim(), email: c[1].trim(), pass: c[2].trim() }));
console.log(`CSV: ${filas.length} cuentas`);

function corre(script, args, ms) {
  try {
    const out = execFileSync("node", [`${AQUI}/${script}`, ...args], {
      env: ENV, timeout: ms, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 32 * 1024 * 1024,
    });
    return { ok: true, out };
  } catch (e) {
    return { ok: false, out: (e.stdout || "") + (e.stderr || ""), err: e.message };
  }
}

function cursosDeJson() {
  try { return JSON.parse(readFileSync(`${ENV.SKILLJAR_DIR}/cursos.json`, "utf8")); } catch { return []; }
}

// Cuenta cursos al 100% leyendo el veredicto de verificar (resumen.json)
function contarCompletos() {
  try {
    const r = JSON.parse(readFileSync(`${ENV.SKILLJAR_DIR}/verificacion.json`, "utf8"));
    return r;
  } catch { return null; }
}

let procesadas = 0;
const yaHechas = hechasGlobales();
console.log(`hechas globales al arrancar: ${yaHechas.size}`);
for (let idx = 0; idx < filas.length; idx++) {
  if (existsSync(`${ENV.SKILLJAR_DIR}/STOP`) || existsSync("/tmp/skj900/STOP")) { console.log("STOP detectado, salgo limpio"); break; }
  const n = idx + 1;
  if (n < DESDE) continue;
  if (HASTA && n > HASTA) break;
  const { nombre, email, pass } = filas[idx];
  if (SOLO && email !== SOLO) continue;
  const est = prog[email];
  if ((est && est.status === "hecho") || yaHechas.has(email)) { continue; }
  if (MAX && procesadas >= MAX) break;
  procesadas++;

  const t0 = Date.now();
  console.log(`\n===== [${n}/${filas.length}] ${email} =====`);
  prog[email] = { status: "en_proceso", nombre, inicio: new Date().toISOString() };
  guardaProg();

  // 1) LOGIN (2 intentos)
  let login = corre("login-pw.mjs", ["--url", PORTAL, "--email", email, "--pass", pass], 150000);
  if (!/"ok":true/.test(login.out)) {
    login = corre("login-pw.mjs", ["--url", PORTAL, "--email", email, "--pass", pass], 150000);
  }
  if (!/"ok":true/.test(login.out)) {
    prog[email] = { ...prog[email], status: "error", etapa: "login", detalle: login.out.slice(-300), fin: new Date().toISOString() };
    guardaProg(); console.log("  ✗ login falló"); continue;
  }
  console.log("  ✓ login");

  // 2) INSCRIBIR (alcance fijo: la lista de 21)
  corre("inscribir.mjs", ["--lista", LISTA], 600000);
  const urls = cursosDeJson();
  if (!urls.length) {
    prog[email] = { ...prog[email], status: "error", etapa: "inscribir", fin: new Date().toISOString() };
    guardaProg(); console.log("  ✗ sin cursos tras inscribir"); corre("login-pw.mjs", ["--signout", "--url", PORTAL], 60000); continue;
  }
  console.log(`  ✓ inscrito en ${urls.length} cursos`);

  // 3) WALK (todas las lecciones de todos los cursos)
  const w = corre("walk.mjs", urls, 5400000);
  console.log("  ✓ walk " + (w.ok ? "" : "(con avisos)"));

  // 4) EXÁMENES automáticos (banco + Show Answers, sin esperar humano)
  const r = corre("run.mjs", ["--sondear"], 5400000);
  console.log("  ✓ exámenes " + (r.ok ? "" : "(con avisos)"));

  // 4b) Segunda pasada de walk: las lecciones tipo "Certificate of completion" solo se
  // marcan visitándolas DESPUÉS de que el quiz pasó. Barata: salta lo ya completo.
  corre("walk.mjs", urls, 1800000);

  // 5) VERIFICAR contra el portal — la única verdad es "N/M cursos cerrados"
  const v = corre("verificar.mjs", urls, 1200000);
  const m = v.out.match(/(\d+)\s*\/\s*(\d+)\s+cursos cerrados/i);
  const cerrados = m ? +m[1] : 0, total = m ? +m[2] : urls.length;
  const veredicto = v.out.split("\n").filter(Boolean).slice(-5).join(" | ");

  const dur = Math.round((Date.now() - t0) / 1000);
  prog[email] = {
    status: cerrados === total && total > 0 ? "hecho" : "parcial",
    nombre, cursos: `${cerrados}/${total}`,
    veredicto: veredicto.slice(-400), seg: dur, fin: new Date().toISOString(),
  };
  guardaProg();
  console.log(`  ${cerrados === total ? "✓ HECHO" : "△ PARCIAL"} ${cerrados}/${total} en ${dur}s`);

  // 6) SIGN OUT para aislar la siguiente cuenta
  corre("login-pw.mjs", ["--signout", "--url", PORTAL], 60000);
}

const hechas = Object.values(prog).filter(x => x.status === "hecho").length;
const err = Object.values(prog).filter(x => x.status === "error").length;
console.log(`\n===== FIN de esta corrida · procesadas ${procesadas} · total hechas ${hechas} · errores ${err} =====`);
