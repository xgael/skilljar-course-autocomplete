# skilljar-course-runner

Skill de Claude Code para completar cursos alojados en Skilljar (portal de partners
de Anthropic, Anthropic Academy, academias de producto): recorre lecciones, contesta
exámenes con un banco de respuestas verificadas, política de confianza (una
aproximación se tolera, dos no), sondeo vía "Show Answers" y auditoría contra el
portal como única fuente de verdad.

## Piezas
- `SKILL.md` — instrucciones completas de operación (leer primero)
- `scripts/` — chrome.sh · login.mjs (OTP) · login-pw.mjs (email+password, Academy) ·
  inscribir.mjs · walk.mjs · run.mjs · resolver.mjs · verificar.mjs · orquesta.mjs ·
  academia900.mjs (lotes de cuentas, resumible)
- `banco.json` — pool de respuestas (texto LITERAL de la opción; Skilljar reordena
  opciones entre intentos, marcar por letra da resultado aleatorio)

## Reglas duras aprendidas
- El banco se respalda fuera de /tmp y las respuestas van con texto literal.
- El avance entre preguntas se verifica porque el NÚMERO cambió, nunca porque el
  clic no tronó (exámenes con respuesta obligatoria rebotan el Next en silencio).
- Preguntas "select all that apply" usan checkboxes: nunca mezclar con radios.
- "Take this again" vive envuelto en spans dentro de un `<a>`: se clickea el ancla.
