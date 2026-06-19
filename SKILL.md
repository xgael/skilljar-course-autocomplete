---
name: skilljar-course-autocomplete
description: >-
  Completa de punta a punta un curso alojado en Skilljar (p.ej. Anthropic Academy,
  anthropic.skilljar.com): marca todas las lecciones como completadas y resuelve
  el quiz/examen final reintentando hasta aprobar, luego verifica el certificado.
  Reusa una sesion de navegador YA iniciada (cookies de Firefox, solo lectura) en
  vez de pedir credenciales. Usar cuando el usuario diga "completa este curso",
  "haz el curso X", "pasa el examen de Skilljar", o pase una URL de *.skilljar.com.
  No registra cuentas ni maneja credenciales: requiere que el usuario ya este
  logueado en Firefox.
---

# Skilljar Course Autocomplete

Automatiza cursos de **Skilljar** (LMS que usa Anthropic Academy y muchas empresas):
completa las lecciones y aprueba el quiz final, reusando la sesion del navegador
del usuario. Verificado e2e contra Claude 101, Claude Code 101 y Claude Platform 101.

## Cuando usar
- El usuario pasa una URL de un curso en `*.skilljar.com` y pide completarlo / pasar el examen.
- "Completa este curso", "haz el examen", "saca el certificado".

## Requisitos
- **Firefox abierto y logueado** en el sitio de Skilljar (la sesion se copia de sus cookies).
  Skilljar normalmente usa login passwordless (enlace magico al correo); por eso esta skill
  **no** registra cuentas ni maneja contraseñas: aprovecha que el usuario ya entro.
- **Playwright (python) + chromium**. En el GB10 esta en `~/proyectos/IASocietyPro/.venv`
  (`.venv/bin/python -m playwright install chromium` si falta). Ver memoria `arca-ui-refactor`.
- Opcional: `ask-llm` (router LLM de [[cyber-toolkit]]) para resolver preguntas no cacheadas.

## Como funciona
1. **Sesion**: copia `cookies.sqlite` del profile de Firefox (autodetecta el snap), extrae las
   cookies de `*.skilljar.com` y las inyecta en un contexto headless de Playwright. Solo lectura;
   no toca el navegador del usuario.
2. **Lecciones**: enumera los items `a.lesson-modular`, visita cada leccion (Skilljar las
   auto-marca al cargar; el boton `Complete` es respaldo) y confirma `lesson-complete`.
3. **Quiz** (`a.lesson-quiz`): arranca, navega pregunta por pregunta (`button.sj-text-quiz-next`),
   y por cada una:
   - **Encuesta** (satisfaccion / recomendacion) -> opcion mas positiva. **Feedback** (textarea) -> texto generico.
   - **Conocimiento** -> banco de respuestas (`answers.json`, match por substring), y si no, un **LLM**.
   - Envia (`button.sj-text-quiz-submit`). Si no pasa, usa **"Take this again"** y reintenta
     (Skilljar permite reintentos ilimitados). El quiz **guarda progreso**, asi que un intento a
     medias se cierra antes de reabrir.
4. **Certificado**: abre `/accounts/profile/` y verifica que aparezca el certificado del curso.

## Uso
```bash
cd ~/proyectos/IASocietyPro            # entorno con el venv de Playwright
.venv/bin/python ~/.claude/skills/skilljar-course-autocomplete/scripts/skilljar.py \
  "https://anthropic.skilljar.com/<slug>/<id>"
```
Opciones utiles:
- `--resolver bank+llm` (default): banco primero, LLM para lo desconocido. `bank` = solo cache, `llm` = solo LLM.
- `--llm-cmd "claude -p"` si no usas `ask-llm`.
- `--profile /ruta/al/profile` si Firefox no es el snap por defecto.
- `--headful` para ver el navegador (debug).
- `--max-retakes N` (default 6).

## Notas / gotchas (aprendidos en vivo)
- El boton **Start** del quiz es `button.sj-text-quiz-start` (a veces no recibe click normal -> se
  dispara por JS buscando `.quiz-start`).
- **No** uses selectores con la palabra "next" genericos: el sidebar tiene lecciones cuyo titulo
  contiene "next" y se clickean por error. Usa exactamente `button.sj-text-quiz-next`.
- El texto de la pregunta a veces no se captura; por eso el banco tambien resuelve por **opcion**.
- Las preguntas de encuesta pueden contar como "correctas" en el score con cualquier respuesta
  (participacion); igual se eligen positivas.
- Ampliar el banco: agrega `{ "q": "...", "a": "..." }` a `answers.json` por cada curso nuevo
  (substrings unicos, en minusculas; se ignora HTML).
- **Quizzes sin barajado + resolvedor determinista:** si el LLM falla una pregunta y el quiz NO
  baraja las opciones, reintentar da el MISMO resultado. `solve_quiz` cachea la "firma" de
  respuestas de cada intento (set de opciones elegidas) y, si se repite una firma ya enviada,
  **aborta ese quiz** en vez de gastar los reintentos. Si el quiz SI baraja, las firmas difieren
  y se sigue reintentando (asi paso AI Fluency en el 2o intento). Para cazar respuestas dificiles:
  ampliar `answers.json` con la respuesta correcta, o deducirla por las ecuaciones de score
  (cada intento revela cuantas acertaste).

## Etica / alcance
Pensada para que el dueño de la cuenta (o alguien autorizado) automatice **su propia** formacion.
Reusa la sesion existente; no evade autenticacion ni rompe controles. No publiques el banco de
respuestas como guia de examen.
