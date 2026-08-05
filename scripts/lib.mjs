// Piezas compartidas: conexión al navegador, selectores del sitio y utilidades.
//
// Todo lo raro de Skilljar vive aquí para que los scripts de arriba se lean simple.

import { appendFileSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";

const PLAYWRIGHT = process.env.PLAYWRIGHT_PATH
  ?? `${process.env.HOME}/.claude/skills/webapp-demo-recorder/node_modules/playwright/index.mjs`;

export const ESTADO = process.env.SKILLJAR_DIR ?? "/tmp/skilljar";
// Puerto del navegador y ruta del banco, configurables para correr varios agentes a la
// vez: cada uno con su Chrome y su carpeta de estado, pero compartiendo el mismo banco.
export const PUERTO = Number(process.env.SKILLJAR_PUERTO ?? 9222);
export const NOTAS = process.env.SKILLJAR_NOTAS ?? `${process.env.HOME}/Documentos/skilljar-cursos`;
// El banco vive FUERA de /tmp a propósito: es lo más valioso que produce la skill y en
// /tmp se borró una vez, con ~286 respuestas confirmadas dentro. Reconstruirlo costó una
// sesión entera. Sigue siendo configurable con SKILLJAR_BANCO.
export const BANCO_ARCHIVO = process.env.SKILLJAR_BANCO ?? `${NOTAS}/banco.json`;

// Enlaces del temario. Algunos cursos usan `a.lesson`, otros solo `lesson-web-package`
// o `lesson-modular` sin la clase pelona: por eso el comodín.
export const SEL_LECCION = 'a.lesson, a[class*="lesson-"]';

export function log(archivo, msg) {
  console.log(msg);
  mkdirSync(dirname(archivo), { recursive: true });
  appendFileSync(archivo, msg + "\n");
}

export const leer = f => JSON.parse(readFileSync(f, "utf8"));
export function guardar(f, datos) {
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, JSON.stringify(datos, null, 2));
}
export const hay = existsSync;

/** Normaliza texto para comparar: minúsculas, comillas rectas, espacios colapsados. */
export const norm = s => (s ?? "").toString().toLowerCase()
  .replace(/[’‘`]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, " ").trim();

/**
 * Se engancha al Chrome que dejó corriendo chrome.sh, y si el navegador quedó en mal
 * estado lo relanza y reintenta.
 *
 * Después de varias corridas seguidas, Chrome empieza a rechazar la conexión con
 * "Browser context management is not supported": el proceso sigue vivo y responde el
 * puerto, pero ya no acepta que Playwright le maneje contextos. No encontré la causa
 * raíz; lo que sí se sabe es que un Chrome recién levantado siempre funciona. Así que en
 * vez de morir con un error críptico, se mata el navegador, se vuelve a levantar con el
 * mismo perfil y se reintenta una vez.
 */
export async function conectar(puerto = PUERTO, reintentos = 1) {
  const { chromium } = await import(PLAYWRIGHT);
  try {
    const navegador = await chromium.connectOverCDP(`http://localhost:${puerto}`);
    const ctx = navegador.contexts()[0];
    if (!ctx) throw new Error("el navegador no tiene contexto");
    const page = ctx.pages()[0] ?? await ctx.newPage();
    return { navegador, page };
  } catch (e) {
    if (!reintentos) throw e;
    console.log(`navegador en mal estado (${String(e.message ?? e).slice(0, 60)}), lo relanzo`);
    const { execFileSync } = await import("node:child_process");
    const { dirname } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const aqui = dirname(fileURLToPath(import.meta.url));
    try { execFileSync("pkill", ["-f", `remote-debugging-port=${puerto}`]); } catch {}
    await new Promise(r => setTimeout(r, 4000));
    execFileSync(`${aqui}/chrome.sh`, [String(puerto)], { stdio: "inherit" });
    await new Promise(r => setTimeout(r, 3000));
    return conectar(puerto, reintentos - 1);
  }
}

/**
 * Suelta la conexión sin romper el navegador.
 *
 * `navegador.close()` sobre una conexión CDP le cierra los contextos al Chrome, y el
 * siguiente script que intente conectarse falla con "Browser context management is not
 * supported" — el navegador queda vivo pero sin contexto donde engancharse. Aquí el
 * Chrome no es nuestro: lo levantó chrome.sh y lo van a seguir usando otros scripts,
 * así que solo se deja ir la conexión y el proceso al salir la cierra.
 */
export async function soltar(_navegador) { /* a propósito no se cierra nada */ }

/** Origen del portal, deducido del primer enlace que reciba el script. */
export function origen(url) {
  const u = new URL(url);
  return `${u.protocol}//${u.host}`;
}

// ---------------------------------------------------------------- examen

/** `Question N of M` del cuerpo. Devuelve [] si no hay examen abierto. */
export async function progreso(page) {
  const t = await page.locator('body').innerText();
  return ((t.match(/Question (\d+) of (\d+)/) || []).slice(1)).map(Number);
}

export const boton = (page, re) => page.getByRole('button', { name: re }).first();

/**
 * Espera a que pase algo, no a que corra el reloj.
 *
 * Las esperas fijas son la misma enfermedad que ya se curó en las lecciones: 4s por
 * cargar un examen y 1.3s entre preguntas eran ~10 min dormido en una corrida de 39
 * exámenes, y además fallan cuando el portal tarda MÁS de lo supuesto. Devuelve si la
 * condición se cumplió antes del techo.
 */
export async function esperarA(page, condicion, { techo = 12000, paso = 200 } = {}) {
  const hasta = Date.now() + techo;
  while (Date.now() < hasta) {
    if (await condicion().catch(() => false)) return true;
    await page.waitForTimeout(paso);
  }
  return false;
}

/** Espera a que el examen esté usable: con Start, ya en una pregunta, o mostrando score. */
export const esperarExamenListo = (page, techo = 15000) => esperarA(page, async () => {
  if ((await progreso(page))[0]) return true;
  if (await boton(page, /start/i).count()) return true;
  return /Correct \(\d+%\)|you have passed|did not pass/i.test(await page.locator('body').innerText());
}, { techo });

/** Espera a que la pregunta visible cambie (o a que aparezca la primera). */
export const esperarPregunta = (page, distintaDe = null, techo = 12000) =>
  esperarA(page, async () => {
    const n = (await progreso(page))[0];
    return n ? n !== distintaDe : false;
  }, { techo });

/**
 * Espera a que el temario esté en el DOM. Si el curso no tiene (cuenta no inscrita) o
 * el portal redirigió, se agota el techo y quien llama lo detecta con sus guardas — no
 * se cuelga.
 */
export const esperarTemario = (page, techo = 9000) => esperarA(page, async () =>
  await page.locator(SEL_LECCION).count() > 0, { techo });

/** Espera el veredicto tras enviar: score, aprobado o reprobado. */
export const esperarResultado = (page, techo = 20000) => esperarA(page, async () =>
  /Correct \(\d+%\)|you have passed|did not pass|thank you/i.test(await page.locator('body').innerText()),
  { techo });

/**
 * Clic que no tumba el proceso. Un botón puede existir en el DOM y no ser accionable
 * (se re-renderiza, queda tapado, el examen cambió de pantalla): ahí `click()` lanza
 * TimeoutError a los 30s y se muere toda la corrida. Devuelve si logró clicar.
 */
export async function clic(loc, ms = 6000) {
  try { await loc.click({ timeout: ms }); return true; } catch { return false; }
}

/**
 * Deja el examen listo en la pregunta 1.
 *
 * Es EL paso crítico: Skilljar reanuda donde te quedaste, así que sin reiniciar se
 * contesta solo la última pregunta y se envía el resto en blanco. "Take this again"
 * es un <span> y el clic de Playwright a veces no prende, de ahí el clic por JS.
 */
export async function reiniciar(page) {
  for (let intento = 0; intento < 3; intento++) {
    if ((await progreso(page))[0] === 1) return true;

    await page.evaluate(() => {
      const buscar = raiz => {
        for (const el of raiz.querySelectorAll('*')) {
          if (el.shadowRoot && buscar(el.shadowRoot)) return true;
          const t = (el.innerText || "").trim();
          if (/^take this again$/i.test(t) && el.children.length <= 1) { el.click(); return true; }
        }
        return false;
      };
      return buscar(document);
    });
    await esperarExamenListo(page, 8000);

    if (!(await progreso(page))[0]) {
      const start = boton(page, /start/i);
      if (await start.count()) { await clic(start); await esperarPregunta(page, null, 10000); }
    }
    // Si quedó a media, caminar hacia atrás.
    let guarda = 0;
    while ((await progreso(page))[0] > 1 && guarda++ < 40) {
      const prev = boton(page, /^previous$/i);
      if (!await prev.count()) break;
      const antes = (await progreso(page))[0];
      if (!await clic(prev)) break;
      await esperarPregunta(page, antes, 6000);
    }
    if ((await progreso(page))[0] === 1) return true;
  }
  return (await progreso(page))[0] === 1;
}

/**
 * Opciones de la pregunta actual.
 * OJO: el examen vive en shadow DOM, así que hay que leerlo con locators de Playwright.
 * `document.querySelectorAll` desde `page.evaluate` devuelve vacío.
 */
export async function opciones(page) {
  const radios = page.locator('input[type=radio]');
  const n = await radios.count();
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({
      i,
      texto: (await radios.nth(i).evaluate(e => (e.closest('label') || e.parentElement)?.innerText?.trim() || ""))
        .replace(/\s+/g, " ").replace(/ Selected$/, ""),
      marcado: await radios.nth(i).isChecked().catch(() => false),
    });
  }
  return out;
}

export async function elegir(page, indice) {
  const r = page.locator('input[type=radio]').nth(indice);
  await r.click({ force: true });
  await page.waitForTimeout(200);
  return await r.isChecked().catch(() => false);
}

/**
 * El banco guarda de dónde salió cada respuesta y si un score la confirmó.
 *
 * Formato: { respuesta, verificada, origen, vistas }. Las entradas viejas eran un
 * string suelto; se cargan como NO verificadas, porque nunca se comprobó que fueran
 * correctas — solo que alguien las escribió.
 */
export function cargarBanco(archivo, ...extras) {
  const banco = new Map();
  for (const f of [archivo, ...extras]) {
    if (!hay(f)) continue;
    for (const [k, v] of Object.entries(leer(f))) {
      const entrada = typeof v === "string"
        ? { respuesta: v, verificada: false, origen: "importada" }
        : v;
      // La MISMA pregunta aparece en varios cursos con la respuesta correcta redactada
      // distinto ("communication layer that provides context" vs "standardized protocol
      // that enables secure connections"). Guardar solo una hacía que en el otro curso
      // ninguna opción casara y la pregunta pareciera desconocida. Se acumulan.
      entrada.respuestas = [...new Set([entrada.respuesta, ...(entrada.respuestas ?? [])].filter(Boolean))];
      // Una verificada nunca se degrada por una supuesta que llegue después.
      const previa = banco.get(k);
      if (!previa) { banco.set(k, entrada); continue; }
      const fusion = {
        ...(entrada.verificada && !previa.verificada ? entrada : previa),
        respuestas: [...new Set([...(previa.respuestas ?? [previa.respuesta]), ...entrada.respuestas])],
      };
      banco.set(k, fusion);
    }
  }
  return banco;
}

export const guardarBanco = (archivo, banco) => guardar(archivo, Object.fromEntries(banco));

/**
 * Busca la pregunta en el banco. Devuelve además SI fue coincidencia exacta, porque de
 * eso depende cuánta confianza merece: el mismo examen aparece reescrito entre cursos
 * ("the GitHub tool code" vs "the GitHub tool functions") y ahí hay que tolerar, pero
 * tolerar no es lo mismo que dar por hecho.
 */
export function buscarEnBanco(banco, texto) {
  const t = norm(texto);
  if (banco.has(t)) return { clave: t, entrada: banco.get(t), exacta: true, puntaje: 1 };

  const palabras = x => new Set(x.split(" ").filter(w => w.length > 3));
  const a = palabras(t);
  if (a.size < 4) return null;
  let mejor = null, mejorClave = null, mejorPuntaje = 0, segundo = 0;
  for (const [k, v] of banco) {
    const b = palabras(k);
    let comunes = 0;
    for (const w of a) if (b.has(w)) comunes++;
    const jaccard = comunes / (a.size + b.size - comunes);
    if (jaccard > mejorPuntaje) { segundo = mejorPuntaje; mejorPuntaje = jaccard; mejor = v; mejorClave = k; }
    else if (jaccard > segundo) segundo = jaccard;
  }
  if (mejorPuntaje < 0.75) return null;
  return { clave: mejorClave, entrada: mejor, exacta: false, puntaje: mejorPuntaje, segundo };
}

/**
 * Encuentra la opción que corresponde a una respuesta guardada. Distingue si la halló
 * literal o por parecido, porque una respuesta aproximada sobre una pregunta aproximada
 * son dos suposiciones encadenadas y eso ya no se decide solo.
 */
export function mejorOpcion(textos, respuesta) {
  const literal = textos.findIndex(x => norm(x).includes(norm(respuesta)));
  if (literal >= 0) return { indice: literal, literal: true, puntaje: 1, margen: 1 };

  const palabras = x => new Set(norm(x).split(" ").filter(w => w.length > 3));
  const r = palabras(respuesta);
  if (!r.size) return { indice: -1 };
  const puntajes = textos.map(t => {
    const o = palabras(t);
    let comunes = 0;
    for (const w of r) if (o.has(w)) comunes++;
    return comunes / r.size;
  });
  const orden = [...puntajes].sort((a, b) => b - a);
  return { indice: puntajes.indexOf(orden[0]), literal: false, puntaje: orden[0], margen: orden[0] - (orden[1] ?? 0) };
}

/**
 * Política de confianza: decide o se abstiene, y dice por qué.
 *
 * Los umbrales no son magia, son una regla: **una sola aproximación se tolera, dos no.**
 * Si tanto la pregunta como la respuesta se hallaron "por parecido", eso es adivinar con
 * pasos extra, así que devuelve -1 y el examen se detiene. Y si la entrada del banco
 * nunca fue confirmada por un score, se exige coincidencia literal de la respuesta.
 */
export function decidir(banco, texto, textos) {
  const hallado = buscarEnBanco(banco, texto);
  if (!hallado) return { indice: -1, motivo: "no está en el banco" };

  const { entrada, exacta, puntaje, clave } = hallado;
  // Se prueban TODAS las redacciones guardadas y gana la que case mejor: una literal
  // vale más que un parecido, y entre parecidos el de mayor puntaje.
  const candidatas = entrada.respuestas ?? [entrada.respuesta];
  let op = { indice: -1, puntaje: 0, margen: 0, literal: false };
  for (const c of candidatas) {
    const intento = mejorOpcion(textos, c);
    if (intento.indice < 0) continue;
    const mejorQueLaPrevia = intento.literal && !op.literal
      || (intento.literal === op.literal && intento.puntaje > op.puntaje);
    if (op.indice < 0 || mejorQueLaPrevia) op = intento;
  }
  if (op.indice < 0) return { indice: -1, motivo: `ninguna de las ${candidatas.length} redacciones guardadas aparece entre las opciones` };

  const aproximaciones = (exacta ? 0 : 1) + (op.literal ? 0 : 1);

  if (aproximaciones >= 2)
    return { indice: -1, motivo: `pregunta y respuesta solo se parecen (${puntaje.toFixed(2)}/${op.puntaje.toFixed(2)}), no decido` };

  if (!op.literal && (op.puntaje < 0.6 || op.margen < 0.3))
    return { indice: -1, motivo: `la respuesta se parece a ${op.puntaje.toFixed(2)} con margen ${op.margen.toFixed(2)}, insuficiente` };

  if (!entrada.verificada && !op.literal)
    return { indice: -1, motivo: "entrada sin confirmar por score y la respuesta no es literal" };

  const conf = exacta && op.literal ? "alta" : "media";
  return { indice: op.indice, clave, confianza: conf, verificada: !!entrada.verificada,
           fuente: `banco ${conf}${entrada.verificada ? " · confirmada" : " · sin confirmar"}` };
}

/**
 * ¿Las opciones son una escala de opinión? Se mira la FORMA de las opciones, no el
 * enunciado.
 *
 * Antes se detectaba por palabras clave en la pregunta ("how satisfied…") y eso falla
 * en las dos direcciones. La grave: una pregunta CALIFICADA que mencione "satisfied"
 * se dejaba en blanco y perdía el punto sin avisar. Una escala se reconoce por sus
 * opciones — dos polos y grados entre ellos — y eso no depende de la redacción.
 */
export function esEscala(opciones) {
  if (!opciones || opciones.length < 4) return false;
  const t = opciones.map(norm);

  // Escala numérica: "1 - very unlikely", "5", "3 - maybe"…
  const numeradas = t.filter(x => /^[1-9]\b/.test(x)).length;
  if (numeradas >= opciones.length - 1) return true;

  const grados = /^(not at all|not very|not likely|slightly|somewhat|moderately|neutral|unsure|not sure|no opinion|too soon|very|extremely|highly|completely|satisfied|dissatisfied|likely|unlikely|agree|disagree|strongly)/;
  const conGrado = t.filter(x => grados.test(x)).length;
  if (conGrado < Math.ceil(opciones.length * 0.6)) return false;

  // Y que existan los dos extremos: una escala sin polos no es escala.
  const bajo = t.some(x => /^(not at all|not very|not likely|very unlikely|strongly disagree|dissatisfied|1\b)/.test(x));
  const alto = t.some(x => /(very|extremely|highly|completely|strongly agree)/.test(x));
  return bajo && alto;
}

/**
 * Encuesta = la pregunta pide una opinión Y las opciones son una escala. Se exigen las
 * dos señales: con una sola, o se deja en blanco una pregunta calificada, o se detiene
 * el examen por una encuesta redactada distinto.
 */
export function esEncuesta(texto, opciones) {
  const pideOpinion = /how satisfied|how likely|how happy|how would you rate|recommend this course|recommend it to|scale of one to five|your experience/i.test(texto ?? "");
  return pideOpinion && esEscala(opciones);
}

/** Texto de la pregunta N tal como aparece en el cuerpo. */
export async function textoPregunta(page, n, total) {
  const cuerpo = await page.locator('body').innerText();
  const m = cuerpo.match(new RegExp(`Question ${n} of ${total}\\s*\\n+([\\s\\S]{0,400}?)\\n`));
  return m ? m[1].trim() : "(?)";
}

/** Envía y devuelve { score, aprobado, porcentaje }. */
export async function enviar(page) {
  const b = boton(page, /^(submit|complete|finish|see results)$/i);
  if (!await b.count()) return null;
  if (!await clic(b, 15000)) return null;
  await esperarResultado(page);
  const t = await page.locator('body').innerText();
  const m = t.match(/(\d+) of (\d+) Correct \((\d+)%\)/);
  return { score: m ? m[0] : null, aprobado: /you have passed|passed!/i.test(t), porcentaje: m ? +m[3] : null };
}

/**
 * Red de seguridad: tras enviar, algunos exámenes ofrecen "Show Answers" y ahí el DOM
 * marca la buena con `div.answer.correct`. Devuelve { nPregunta: textoCorrecto } o null
 * si este examen no revela nada.
 */
export async function revelarCorrectas(page) {
  const sa = page.getByText(/show answers/i).first();
  if (!await sa.count()) return null;
  if (!await clic(sa)) return null;
  await esperarA(page, async () => await page.locator('div.answer.correct').count() > 0, { techo: 8000 });
  return await page.evaluate(() => {
    const orden = [];
    const recorrer = raiz => {
      for (const el of raiz.querySelectorAll('*')) {
        if (el.shadowRoot) recorrer(el.shadowRoot);
        const c = (el.className || "").toString();
        if (el.tagName === "SPAN" && /^(correct|incorrect)$/.test(c.trim())) orden.push({ tipo: "pregunta" });
        else if (el.tagName === "DIV" && /\banswer\b/.test(c) && /\bcorrect\b/.test(c))
          orden.push({ tipo: "correcta", texto: (el.innerText || "").trim() });
      }
    };
    recorrer(document);
    const res = {};
    let n = 0;
    for (const x of orden) {
      if (x.tipo === "pregunta") n++;
      else if (n) res[n] = x.texto;
    }
    return res;
  });
}

// ---------------------------------------------------------------- temario

/** Lecciones del curso con su estado. */
export async function temario(page) {
  return await page.evaluate(sel => ({
    titulo: document.querySelector('h1')?.textContent?.trim(),
    lecciones: [...document.querySelectorAll(sel)]
      .filter(a => /\/\d{4,}$/.test(a.getAttribute('href') || ''))
      .map(a => ({
        titulo: a.textContent.trim().replace(/\s+/g, ' '),
        href: a.getAttribute('href'),
        completa: /lesson-complete/.test(a.className),
        paqueteWeb: /lesson-web-package/.test(a.className),
        seccion: a.closest('.lessons-wrapper')?.querySelector('.section-title')?.textContent?.trim(),
      })),
  }), SEL_LECCION);
}

/** ¿La lección abierta quedó marcada como completa? */
export async function leccionCompleta(page) {
  return await page.evaluate(sel => {
    const actual = [...document.querySelectorAll(sel)].find(a => a.getAttribute('aria-current') === 'page');
    return /lesson-complete/.test(actual?.className || "");
  }, SEL_LECCION);
}

/** Texto de la lección, sin el temario ni la navegación. */
export async function contenido(page) {
  return await page.evaluate(() => {
    const c = document.body.cloneNode(true);
    c.querySelectorAll('nav,header,footer,aside,.lessons-wrapper,script,style').forEach(e => e.remove());
    return c.innerText.replace(/\n{3,}/g, "\n\n").trim();
  });
}

/**
 * ¿La sesión sigue viva? Skilljar no redirige a una pantalla de login: deja la página
 * del curso pero vacía, con "Sign In" arriba y el temario ausente. Si no se checa,
 * los scripts reportan "0/0 lecciones" y parece que el curso ya estaba completo.
 */
export async function sesionViva(page) {
  const t = await page.locator('body').innerText();
  return !/please register to access|sign in\s*$/im.test(t) && /sign out/i.test(t);
}

/**
 * ¿Seguimos en el curso que pedimos? El portal redirige a otro curso cuando el que
 * pediste no está habilitado para la cuenta, y entonces el temario que se lee es del
 * curso equivocado: sale "0/0 lecciones, todas completas" y parece cerrado cuando ni
 * se abrió.
 */
export function mismoCurso(pedido, actual) {
  const slug = u => new URL(u, "https://x").pathname.split("/").filter(Boolean)[0] ?? "";
  return slug(pedido) === slug(actual);
}

/** Aborta con un mensaje claro si no hay sesión. */
export async function exigirSesion(page) {
  if (await sesionViva(page)) return;
  console.error(
    "\nSesión caducada en el navegador de trabajo.\n" +
    "  node login.mjs --url <url-de-login> --email <correo>\n" +
    "y cuando pida el código, escríbelo en " + ESTADO + "/codigo.txt\n");
  process.exit(2);
}
