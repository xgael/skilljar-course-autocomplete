# skilljar-course-autocomplete

Skill para **Claude Code / ARCA** que completa de punta a punta un curso alojado en
[Skilljar](https://www.skilljar.com/) (el LMS que usa, entre otros, **Anthropic Academy** —
`anthropic.skilljar.com`): marca todas las lecciones y **aprueba el quiz final**, reintentando
hasta pasar, y verifica el certificado.

En vez de pedir credenciales (Skilljar usa login por enlace magico al correo), **reusa una sesion
de navegador ya iniciada** copiando las cookies de Firefox (solo lectura).

## Instalacion como skill
Copia la carpeta a `~/.claude/skills/` y queda disponible para el Skill tool:

```bash
git clone https://github.com/xgael/skilljar-course-autocomplete \
  ~/.claude/skills/skilljar-course-autocomplete
```

## Uso directo
```bash
# requiere Playwright + chromium (python)
python3 scripts/skilljar.py "https://anthropic.skilljar.com/<slug>/<id>"
```

| Opcion | Default | Para que |
|---|---|---|
| `--resolver` | `bank+llm` | `bank` (solo cache), `llm` (solo LLM), o ambos |
| `--llm-cmd` | `ask-llm` | comando del resolvedor LLM (p.ej. `"claude -p"`) |
| `--profile` | autodetecta snap | profile de Firefox |
| `--state` | `/tmp/skilljar_state.json` | storage_state de Playwright |
| `--answers` | `answers.json` | banco de respuestas |
| `--max-retakes` | `6` | reintentos del quiz |
| `--headful` | off | ventana visible (debug) |

## Como funciona
1. **Sesion** — extrae cookies de `*.skilljar.com` de `cookies.sqlite` de Firefox y las inyecta en
   Playwright headless.
2. **Lecciones** — visita cada `a.lesson-modular` (Skilljar auto-marca al cargar).
3. **Quiz** — navega pregunta por pregunta: encuestas -> opcion positiva; conocimiento -> banco
   `answers.json` y, si no esta, un LLM; envia y, si falla, "Take this again" y reintenta.
4. **Certificado** — verifica en `/accounts/profile/`.

## Requisitos
- Firefox **abierto y logueado** en el sitio de Skilljar.
- Python 3 con `playwright` + chromium (`python -m playwright install chromium`).
- Opcional: un CLI LLM (`ask-llm`, o `claude -p`) para preguntas fuera del banco.

## Etica
Para que el dueño de la cuenta (o alguien autorizado) automatice **su propia** formacion. Reusa la
sesion existente; no evade autenticacion. No uses el banco de respuestas como guia de examen.

## Verificado
Probado e2e (jun-2026) contra **Claude 101** (10/10), **Claude Code 101** (5/5) y
**Claude Platform 101** (6/6) en Anthropic Academy.

## Licencia
MIT
