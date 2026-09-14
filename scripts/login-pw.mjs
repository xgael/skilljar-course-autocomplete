// Login por email+password en un portal Skilljar (p.ej. anthropic.skilljar.com — Academy),
// DENTRO del navegador de trabajo (:9222) que usan walk/run/verificar.
//
//   node login-pw.mjs --url https://anthropic.skilljar.com/ --email x@y --pass ****
//   node login-pw.mjs --signout --url https://anthropic.skilljar.com/
//
// A diferencia de login.mjs (código OTP de 6 dígitos, portal de partners), la Academy usa
// email+password. Devuelve exit 0 si la sesión quedó viva.

import { conectar, sesionViva, soltar } from "./lib.mjs";

const arg = n => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : null; };
const url = arg("--url") || "https://anthropic.skilljar.com/";
const email = arg("--email"), pass = arg("--pass");
const signout = process.argv.includes("--signout");

const { navegador, page } = await conectar();

async function cerrarSesion() {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(900);
  const so = page.getByRole('link', { name: /sign out|log out|cerrar sesión/i }).first();
  if (await so.count()) { await so.click().catch(() => {}); await page.waitForTimeout(1400); }
  // limpieza dura por si el enlace no estaba: borrar cookies del contexto
  try { await page.context().clearCookies(); } catch {}
  await page.waitForTimeout(300);
  console.log("signout hecho");
}

if (signout) { await cerrarSesion(); await soltar(navegador); process.exit(0); }

if (!email || !pass) { console.error("faltan --email/--pass"); process.exit(1); }

// Sesión limpia antes de entrar (evita heredar la cuenta anterior)
await cerrarSesion();

await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForTimeout(1200);
if (await sesionViva(page)) { console.log("ya había sesión viva (inesperado), la cierro y reintento"); await cerrarSesion(); await page.goto(url, { waitUntil: "domcontentloaded" }); await page.waitForTimeout(2000); }

// Ir a Sign In
const si = page.getByRole('link', { name: /sign in|log in|iniciar sesión/i }).first();
if (await si.count()) { await si.click(); await page.locator("#id_login").waitFor({ timeout: 15000 }).catch(() => {}); }

// Rellenar credenciales (accounts.skilljar.com: #id_login / #id_password)
const campoEmail = page.locator('#id_login, input[type=email][name="login"], input[type=email]').first();
await campoEmail.waitFor({ timeout: 30000 });
await campoEmail.fill(email);
const campoPass = page.locator('#id_password, input[type=password]').first();
await campoPass.fill(pass);
const btn = page.getByRole('button', { name: /^sign in$|^log in$|iniciar/i }).first();
if (await btn.count()) await btn.click(); else await campoPass.press("Enter");

for (let i = 0; i < 28; i++) {
  await page.waitForTimeout(500);
  if (await sesionViva(page).catch(() => false)) break;
}
const cuerpo = await page.locator('body').innerText();
const errores = /incorrect|invalid|no active account|wrong|does not match|too many/i.test(cuerpo);
const ok = await sesionViva(page);
console.log(JSON.stringify({ email, ok, error: errores && !ok, url: page.url() }));
await soltar(navegador);
process.exit(ok ? 0 : 1);
