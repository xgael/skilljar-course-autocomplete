// Inicia sesión DENTRO del navegador de trabajo, no en el Chrome del usuario.
//
//   node login.mjs --url "https://portal.skilljar.com/..." --email tu@correo.com
//
// Importante hacerlo aquí y no en el Chrome personal: Chrome mantiene las cookies en
// memoria y no las vuelca al disco mientras corre, así que copiar su perfil justo
// después de un login trae la sesión a medias o vacía.
//
// El portal manda un código de 6 dígitos por correo. El script espera a que aparezca
// en /tmp/skilljar/codigo.txt (el usuario lo pasa, el agente lo escribe ahí).

import { writeFileSync, readFileSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { conectar, sesionViva, ESTADO, soltar} from "./lib.mjs";

const arg = n => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : null; };
const url = arg("--url"), email = arg("--email");
if (!url || !email) { console.error('uso: node login.mjs --url "<url>" --email <correo>'); process.exit(1); }

mkdirSync(ESTADO, { recursive: true });
const ARCHIVO_CODIGO = `${ESTADO}/codigo.txt`;
if (existsSync(ARCHIVO_CODIGO)) unlinkSync(ARCHIVO_CODIGO);

const { navegador, page } = await conectar();
await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 });
await page.waitForTimeout(4000);

if (await sesionViva(page)) { console.log("la sesión ya estaba viva, no hago nada"); await soltar(navegador); process.exit(0); }

// Si caímos en una página del portal en vez del formulario, entrar por "Sign In".
const selCampo = 'input[type=email], input[name*="email" i], input[placeholder*="correo" i], input[placeholder*="email" i]';
if (!await page.locator(selCampo).count()) {
  const entrar = page.getByRole('link', { name: /sign in|iniciar sesión|log in/i }).first();
  if (await entrar.count()) { await entrar.click(); await page.waitForTimeout(6000); }
}
const campo = page.locator(selCampo).first();
await campo.waitFor({ timeout: 30000 });
await campo.fill(email);
const seguir = page.getByRole('button', { name: /continue|continuar|next|sign in/i }).first();
if (await seguir.count()) await seguir.click(); else await campo.press("Enter");
await page.waitForTimeout(6000);

const cuerpo = await page.locator('body').innerText();
if (!/code|código/i.test(cuerpo)) {
  console.log("no pidió código; estado de la sesión:", await sesionViva(page) ? "viva" : "sin resolver");
  await soltar(navegador); process.exit(0);
}

console.log(`código enviado a ${email}. Esperando... escribe los 6 dígitos en ${ARCHIVO_CODIGO}`);
// El código caduca en minutos: hay que pasarlo pronto.
let codigo = null;
for (let i = 0; i < 150; i++) {                       // ~5 min
  if (existsSync(ARCHIVO_CODIGO)) {
    const c = readFileSync(ARCHIVO_CODIGO, "utf8").replace(/\D/g, "");
    if (c.length >= 4) { codigo = c; break; }
  }
  await page.waitForTimeout(2000);
}
if (!codigo) { console.error("no llegó el código a tiempo"); await soltar(navegador); process.exit(1); }

// Las casillas de un dígito avanzan solas al teclear.
const casillas = page.locator('input[inputmode="numeric"], input[maxlength="1"], input[type="tel"]');
if (await casillas.count() > 1) {
  await casillas.first().click();
  for (const d of codigo.split("")) { await page.keyboard.type(d); await page.waitForTimeout(120); }
} else {
  await casillas.first().fill(codigo);
  await page.keyboard.press("Enter");
}
await page.waitForTimeout(9000);

const ok = await sesionViva(page);
console.log(ok ? "sesión iniciada" : "el código no fue aceptado (¿caducó? pide otro con 'Reenviar')");
writeFileSync(`${ESTADO}/login.json`, JSON.stringify({ email, ok }, null, 2));
await soltar(navegador);
process.exit(ok ? 0 : 1);
