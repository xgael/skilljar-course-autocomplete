#!/usr/bin/env python3
"""
skilljar.py — Completa un curso de Skilljar de punta a punta reusando una
sesion de navegador ya iniciada (cookies de Firefox), marcando todas las
lecciones y resolviendo el quiz final (reintentando hasta aprobar).

Uso:
    python3 skilljar.py <course_url> [opciones]

Opciones:
    --profile PATH        Ruta al profile de Firefox (default: autodetecta el snap).
    --state PATH          Guarda/lee el storage_state de Playwright (default: /tmp/skilljar_state.json).
    --answers PATH        Banco de respuestas JSON (default: ../answers.json junto al script).
    --resolver MODE       Como resolver preguntas de conocimiento: bank | llm | bank+llm (default).
    --llm-cmd CMD         Comando para el resolvedor LLM (default: "ask-llm").
    --max-retakes N       Maximo de reintentos del quiz (default: 6).
    --headful             Ejecuta con ventana visible (debug).

Requisitos: Playwright (python) + chromium instalado. Firefox abierto y
logueado en Skilljar (la sesion se copia de sus cookies, solo lectura).

Diseno: la MECANICA (sesion, completado, navegacion del quiz, retake) es
generica. Las RESPUESTAS de conocimiento salen de (1) un banco JSON por
substring de pregunta/opcion, y si no, (2) un LLM. Las preguntas de encuesta
(satisfaccion / recomendacion) se responden con la opcion mas positiva, y el
campo de feedback con un texto generico. Como Skilljar permite reintentos
ilimitados, el quiz se repite hasta pasar.
"""
import argparse, glob, json, os, re, shutil, sqlite3, subprocess, sys, tempfile

# ---------- sesion: cookies de Firefox -> cookies de Playwright ----------

def find_firefox_profile(explicit=None):
    if explicit:
        return explicit
    candidates = []
    home = os.path.expanduser("~")
    for base in (
        f"{home}/snap/firefox/common/.mozilla/firefox",   # Firefox snap (Ubuntu)
        f"{home}/.mozilla/firefox",                         # Firefox deb/clasico
    ):
        candidates += glob.glob(f"{base}/*.default*/cookies.sqlite")
    if not candidates:
        raise SystemExit("No encontre cookies.sqlite de Firefox. Pasa --profile <dir>.")
    # el mas reciente
    candidates.sort(key=lambda p: os.path.getmtime(p), reverse=True)
    return os.path.dirname(candidates[0])


def load_skilljar_cookies(profile_dir):
    src = os.path.join(profile_dir, "cookies.sqlite")
    tmp = os.path.join(tempfile.gettempdir(), "skilljar_ff_cookies.sqlite")
    shutil.copy(src, tmp)  # Firefox bloquea el original; copiamos
    con = sqlite3.connect(f"file:{tmp}?immutable=1", uri=True)
    rows = con.execute(
        "SELECT name,value,host,path,expiry,isSecure,isHttpOnly,sameSite "
        "FROM moz_cookies WHERE host LIKE '%skilljar%'"
    ).fetchall()
    con.close()
    cookies = []
    for name, value, host, path, expiry, sec, httponly, samesite in rows:
        exp = float(expiry) if expiry and expiry > 0 else -1
        if exp > 2147483647:
            exp = 2147483647
        cookies.append({
            "name": name, "value": value, "domain": host, "path": path or "/",
            "expires": exp, "httpOnly": bool(httponly), "secure": bool(sec),
            "sameSite": {0: "None", 1: "Lax", 2: "Strict"}.get(samesite, "Lax"),
        })
    if not cookies:
        raise SystemExit("No hay cookies de skilljar en ese profile. Inicia sesion en Firefox primero.")
    return cookies


# ---------- resolucion de respuestas ----------

SURVEY_POSITIVE = [
    "very satisfied", "extremely satisfied", "extremely likely", "very likely",
    "strongly agree", "satisfied", "agree", "likely",
]
# Frases que delatan una pregunta de encuesta (no se califica por conocimiento)
SURVEY_HINTS = ["how satisfied", "how likely", "recommend this course", "would you recommend"]


def looks_like_survey(question, options):
    q = (question or "").lower()
    if any(h in q for h in SURVEY_HINTS):
        return True
    joined = " ".join(o.lower() for o in options)
    return ("satisfied" in joined and "not at all" in joined) or \
           ("likely" in joined and "unlikely" in joined)


def pick_survey(options):
    for pref in SURVEY_POSITIVE:
        for i, o in enumerate(options):
            if o.strip().lower() == pref:
                return i
    for pref in SURVEY_POSITIVE:
        for i, o in enumerate(options):
            if pref in o.lower():
                return i
    return len(options) - 1  # ultima suele ser la mas positiva


def clean(text):
    return re.sub(r"<[^>]+>", "", text or "").strip()


def pick_from_bank(question, options, bank):
    """bank: lista de {q: substr_pregunta, a: substr_opcion_correcta}."""
    qn = clean(question).lower()
    for entry in bank:
        if entry["q"].lower() in qn:
            for i, o in enumerate(options):
                if entry["a"].lower() in clean(o).lower():
                    return i
    # fallback: match por opcion unica (cuando el texto de pregunta no se capturo)
    for entry in bank:
        for i, o in enumerate(options):
            if entry["a"].lower() in clean(o).lower():
                return i
    return None


def pick_from_llm(question, options, llm_cmd):
    opts_txt = "\n".join(f"{i}) {clean(o)}" for i, o in enumerate(options))
    prompt = (
        "Eres experto en la plataforma y productos de Anthropic (Claude). "
        "Responde la siguiente pregunta de opcion multiple.\n\n"
        f"Pregunta: {clean(question)}\n{opts_txt}\n\n"
        "Responde UNICAMENTE con el numero del indice de la respuesta correcta (0, 1, 2, ...). "
        "Sin explicacion."
    )
    try:
        out = subprocess.run(
            llm_cmd.split() + [prompt], capture_output=True, text=True, timeout=120
        ).stdout
    except Exception as e:
        print(f"   [llm] error: {e}")
        return None
    m = re.search(r"\b([0-9])\b", out)
    if m:
        idx = int(m.group(1))
        if 0 <= idx < len(options):
            return idx
    return None


def resolve_answer(question, options, bank, resolver, llm_cmd):
    if looks_like_survey(question, options):
        return pick_survey(options), "survey"
    if resolver in ("bank", "bank+llm"):
        idx = pick_from_bank(question, options, bank)
        if idx is not None:
            return idx, "bank"
    if resolver in ("llm", "bank+llm"):
        idx = pick_from_llm(question, options, llm_cmd)
        if idx is not None:
            return idx, "llm"
    return 0, "fallback"  # ultimo recurso (se corregira en retake si falla)


# ---------- driver de Playwright ----------

JS_START = """() => {const c=[...document.querySelectorAll('button,a,div')]
  .find(e=>e.offsetParent!==null && /quiz-start/.test(e.className)); if(c)c.click();}"""

JS_READ = r"""() => {
  const radios=[...document.querySelectorAll('input[type=radio]')].filter(r=>r.offsetParent!==null);
  const qel=document.querySelector('.quiz-question-text')||document.querySelector('[class*=question-text]');
  let qt=qel?qel.innerText.trim():'';
  if(!qt){const cont=document.querySelector('[class*=quiz]')||document.body;
    const lines=(cont.innerText||'').split('\n').map(s=>s.trim());
    qt=lines.filter(x=>x.endsWith('?')).slice(-1)[0]||'';}
  const num=((document.body.innerText||'').match(/Question (\d+) of (\d+)/)||[''])[0];
  const opts=radios.map(r=>{let l=r.closest('label');
    if(!l&&r.id)l=document.querySelector('label[for="'+r.id+'"]');
    return (l?l.innerText:r.value).trim();});
  const ids=radios.map(r=>r.id);
  return {n:radios.length, qt, num, opts, ids, ta:document.querySelectorAll('textarea').length};
}"""


def lesson_states(pg):
    # OJO: el quiz es <a class="lesson lesson-quiz"> (SIN lesson-modular), por eso
    # hay que consultar por `a.lesson` (engloba lecciones normales Y el quiz).
    return pg.eval_on_selector_all(
        "a.lesson",
        "els=>els.filter(e=>/\\/\\d+$/.test(e.href)).map(e=>({id:e.href.split('/').pop(),"
        "t:(e.innerText||'').trim().slice(0,50),"
        "done:e.className.includes('lesson-complete'),"
        "quiz:e.className.includes('lesson-quiz')}))",
    )


def run(args):
    from playwright.sync_api import sync_playwright

    profile = find_firefox_profile(args.profile)
    cookies = load_skilljar_cookies(profile)
    bank = []
    if os.path.exists(args.answers):
        bank = json.load(open(args.answers)).get("knowledge", [])
    base = args.course_url.rstrip("/")
    # raiz del curso, p.ej. https://x.skilljar.com/<slug>
    m = re.match(r"(https://[^/]+/[^/]+)", base)
    course_root = m.group(1) if m else base

    with sync_playwright() as p:
        b = p.chromium.launch(headless=not args.headful)
        ctx = b.new_context()
        ctx.add_cookies(cookies)
        pg = ctx.new_page()

        pg.goto(base, wait_until="domcontentloaded", timeout=60000)
        pg.wait_for_timeout(3000)
        body = pg.inner_text("body")
        if "Sign Out" not in body:
            raise SystemExit("La sesion de Skilljar no esta activa (no logueado). Inicia sesion en Firefox.")
        print("Sesion OK. Curso:", pg.title())

        # 1) completar todas las lecciones (visitar marca; el boton Complete es respaldo)
        states = lesson_states(pg)
        lesson_ids = [s["id"] for s in states if not s["quiz"]]
        quiz_ids = [s["id"] for s in states if s["quiz"]]
        print(f"Lecciones: {len(lesson_ids)} | Quiz: {len(quiz_ids)}")
        for lid in lesson_ids:
            pg.goto(f"{course_root}/{lid}", wait_until="domcontentloaded", timeout=60000)
            pg.wait_for_timeout(1300)
            pg.evaluate("()=>{const b=document.querySelector('a.complete-lesson-link'); if(b)b.click();}")
            pg.wait_for_timeout(400)
        pg.goto(base, wait_until="domcontentloaded", timeout=60000)
        pg.wait_for_timeout(2000)
        st = lesson_states(pg)
        done = sum(1 for s in st if s["done"])
        print(f"Lecciones completas: {done}/{len(st)}")

        QUIZ_WIDGET = (".sj-text-quiz-start, .quiz-start, [class*=quiz-start], "
                       ".quiz-content, button.sj-text-quiz-next, .quiz-timer")

        # 2) recolectar TODOS los quizzes/encuestas y resolverlos.
        # Pueden ser: items lesson-quiz, quizzes EMBEBIDOS en una leccion normal
        # (p.ej. "Certificate of completion"), o ENCUESTAS que no auto-completan al
        # visitarlas. Sondeamos las lecciones candidatas (incompletas o con titulo de
        # quiz/encuesta/certificado) buscando el widget del quiz.
        targets = [s["id"] for s in st if s["quiz"]] + list(quiz_ids)
        probe = [s for s in st if (not s["done"]) or
                 re.search(r"quiz|surv|encuest|certificat|exam|assess", s["t"], re.I)]
        for s in probe:
            if s["id"] in targets:
                continue
            pg.goto(f"{course_root}/{s['id']}", wait_until="domcontentloaded", timeout=60000)
            pg.wait_for_timeout(1800)
            if pg.locator(QUIZ_WIDGET).count():
                targets.append(s["id"])
                print(f"Quiz/encuesta detectado: {s['id']} ({s['t']})")
        # dedup preservando orden
        seen = set()
        targets = [q for q in targets if not (q in seen or seen.add(q))]

        if not targets:
            print("Este curso no tiene quiz. Listo.")
            ctx.storage_state(path=args.state)
            b.close()
            return

        def solve_quiz(quiz_url):
            """Resuelve un quiz/encuesta reintentando hasta pasar. True si paso."""
            tried_sigs = set()  # firmas de respuestas ya enviadas (para cazar estancamiento)
            for attempt in range(1, args.max_retakes + 1):
                print(f"\n=== {quiz_url.split('/')[-1]} — intento #{attempt} ===")
                pg.goto(quiz_url, wait_until="domcontentloaded", timeout=60000)
                pg.wait_for_timeout(2500)
                # intento a medias en el paso de feedback -> enviarlo
                if pg.locator("textarea").count():
                    pg.locator("textarea").first.fill("ok")
                    try:
                        pg.locator("button.sj-text-quiz-submit").first.click()
                        pg.wait_for_timeout(3000)
                    except Exception:
                        pass
                # pantalla de resultados con "Take this again"
                again = pg.locator("a:has-text('Take this again'), button:has-text('Take this again')")
                if again.count():
                    again.first.click()
                    pg.wait_for_timeout(2500)
                pg.evaluate(JS_START)
                pg.wait_for_timeout(2500)

                chosen = []  # opciones elegidas en este intento (para la firma)
                for _ in range(40):
                    pg.wait_for_timeout(900)
                    d = pg.evaluate(JS_READ)
                    if d["n"] == 0:
                        if d["ta"]:
                            pg.locator("textarea").first.fill("Great course, clear and practical.")
                            pg.wait_for_timeout(300)
                            pg.evaluate("()=>{const s=document.querySelector("
                                        "'button.sj-text-quiz-submit,button.sj-text-quiz-finish');"
                                        "if(s)s.click();}")
                            pg.wait_for_timeout(3500)
                        break
                    idx, why = resolve_answer(d["qt"], d["opts"], bank, args.resolver, args.llm_cmd)
                    chosen.append(clean(d["opts"][idx]).lower())
                    print(f"  {d['num']}: -> [{idx}] {clean(d['opts'][idx])[:55]} ({why})")
                    rid = d["ids"][idx]
                    if rid:
                        pg.locator(f"#{rid}").check(force=True)
                    else:
                        pg.locator("input[type=radio]").nth(idx).check(force=True)
                    pg.wait_for_timeout(300)
                    # ultima pregunta: el boton es "Submit", no "Next Question"
                    clicked = pg.evaluate(
                        "()=>{const n=document.querySelector('button.sj-text-quiz-next');"
                        "if(n&&n.offsetParent!==null){n.click();return 'next';}"
                        "const s=document.querySelector('button.sj-text-quiz-submit,button.sj-text-quiz-finish');"
                        "if(s){s.click();return 'submit';} return 'none';}"
                    )
                    if clicked == "none":
                        break

                pg.wait_for_timeout(2500)
                res = pg.inner_text("body").lower()
                score = re.search(r"(\d+)\s+of\s+(\d+)\s+correct", res)
                if "did not pass" not in res:
                    # paso = dice "passed", o es encuesta sin score (no hay "X of Y correct")
                    print(f"  OK {score.group(0) if score else '(encuesta/sin score)'}")
                    return True
                # No paso. Si las respuestas son IDENTICAS a un intento previo (firma ya
                # vista), el quiz NO baraja opciones y el resolvedor es determinista:
                # reintentar dara el mismo resultado -> abortar y no gastar intentos.
                sig = tuple(sorted(chosen))
                if sig in tried_sigs:
                    print(f"  No paso {score.group(0) if score else ''}. Mismas respuestas que un "
                          f"intento previo (quiz sin barajado, resolvedor estancado) -> abortando.")
                    print("  Sugerencia: agrega las respuestas correctas al banco (answers.json) "
                          "o usa --resolver bank+llm con un mejor LLM.")
                    return False
                tried_sigs.add(sig)
                print(f"  No paso {score.group(0) if score else ''}. Reintentando...")
            return False

        all_ok = True
        for qid in targets:
            if not solve_quiz(f"{course_root}/{qid}"):
                all_ok = False
                print(f"  Quiz {qid} no se logro aprobar.")

        ctx.storage_state(path=args.state)

        # 3) verificar completado/certificado en el perfil
        host = re.match(r"(https://[^/]+)", base).group(1)
        slug = course_root.rsplit("/", 1)[-1].replace("-", " ")
        key = max(slug.split(), key=len)  # palabra mas larga del slug (mas distintiva)
        pg.goto(f"{host}/accounts/profile/", wait_until="domcontentloaded", timeout=60000)
        pg.wait_for_timeout(2500)
        for line in pg.inner_text("body").split("\n"):
            if key.lower() in line.lower() and ("certificate" in line.lower() or "lesson" in line.lower()):
                print("PERFIL>", line.strip()[:100])
        if not all_ok:
            print("\nAlgun quiz no se aprobo. Revisa el banco o usa --resolver bank+llm.")
            b.close()
            sys.exit(2)
        print("\nCurso completado y quiz aprobado.")
        b.close()


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    ap = argparse.ArgumentParser(description="Auto-completa un curso de Skilljar reusando sesion de Firefox.")
    ap.add_argument("course_url")
    ap.add_argument("--profile", default=None)
    ap.add_argument("--state", default=os.path.join(tempfile.gettempdir(), "skilljar_state.json"))
    ap.add_argument("--answers", default=os.path.join(here, "..", "answers.json"))
    ap.add_argument("--resolver", default="bank+llm", choices=["bank", "llm", "bank+llm"])
    ap.add_argument("--llm-cmd", default="ask-llm")
    ap.add_argument("--max-retakes", type=int, default=6)
    ap.add_argument("--headful", action="store_true")
    run(ap.parse_args())


if __name__ == "__main__":
    main()
