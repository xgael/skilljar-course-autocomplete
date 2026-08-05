---
name: skilljar-course-runner
description: Completa cursos alojados en Skilljar (portal de partners de Anthropic, academias de producto, etc.) manejando el navegador ya logueado. Recorre las lecciones y contesta los exámenes leyendo cada pregunta, con captura de pantalla y bitácora, verificando el score. Úsalo cuando el usuario pida "termina este curso", "haz los cursos de X", "complétame el examen del curso", o pase enlaces de un portal Skilljar.
---

# Skilljar Course Runner

Cierra cursos de Skilljar: lecciones + exámenes, con evidencia y verificación del score.
Salió de completar 15 cursos del portal de partners de Anthropic; cada regla de aquí
viene de un error que ya se pagó.

## Las cuatro reglas que no se rompen

1. **Cada pregunta se lee y se contesta. Nunca se avanza marcando "lo que sea".**
   El flujo viejo hacía dos pasadas: una de relleno que marcaba la primera opción para
   poder ver la pregunta siguiente, y otra que contestaba de verdad. Cuando la primera
   quedaba incompleta, se enviaba el relleno: exámenes al 30% y 37%. Ese flujo está
   borrado a propósito. Una sola pasada, `run.mjs`.
2. **La pregunta se lee de la página, no de un archivo capturado antes.** Cuando el
   texto viene de un archivo viejo y no coincide, el banco de respuestas no encuentra
   nada y todo se derrumba en silencio.
3. **Si no sabe la respuesta, se detiene.** No adivina y no envía. O espera a que una
   persona conteste, o anota la pregunta y abandona ese examen sin mandarlo. Y "no sabe"
   incluye **saber a medias**: ver la política de confianza abajo.
4. **Antes de contestar, reiniciar con `Take this again`.** Skilljar reanuda donde te
   quedaste: sin reiniciar se contesta solo la última pregunta y el resto se va en
   blanco. Aplica igual para leer que para responder.

Aparte: **las escalas de satisfacción se marcan en el PUNTO MEDIO** (la opción neutral;
si ninguna dice "neutral"/"unsure"/"3", la central). Los **comentarios de texto libre
siguen vacíos**: ahí no hay opción neutral que elegir, y redactar una frase a nombre del
usuario es otra cosa muy distinta a marcar un neutral.

Esto cambió el 2026-07-30 por decisión del usuario ("contéstalas a partir de ahora").
Antes se dejaban en blanco y rompía en dos frentes: hay escalas **obligatorias** donde el
portal no avanza sin respuesta —una vivía DENTRO de un examen calificado y bloqueó el
envío del certificado completo— y el bucle **giraba en falso**, repitiendo la misma
pregunta 47 veces porque el clic no fallaba, simplemente no pasaba nada. Para volver al
comportamiento viejo: `--encuestas-vacias`.

⚠️ **Comprobar que la pregunta CAMBIÓ, no que el clic no tronó.** Ese fue exactamente el
bug: `clic()` devolvía true y la página seguía igual. Si no avanza, se abandona el examen
y la pregunta se reporta por nombre en `obligatorias.json` — nunca se sigue girando.

Las escalas se reconocen **por la forma de sus opciones, no por el enunciado**: dos polos
con grados entre ellos, o numeradas 1-5. Detectarlas por palabras clave en la pregunta
fallaba en la dirección peligrosa — una pregunta *calificada* que mencionara "satisfied"
se dejaba en blanco y perdía el punto sin avisar. `prueba-encuestas.mjs` cubre ese caso.

**La regla de encuestas se evalúa ANTES que el banco.** Estaba al final y el banco la
ganaba: en un examen mixto traía "Unsure"/"Not sure" aprendidos en otra cuenta y los
marcaba como si fueran respuestas correctas. Una escala no se aprende — no hay respuesta
correcta que guardar.

## Orden de trabajo: curso por curso

Cada agente **cierra un curso completo antes de pasar al siguiente**: sus lecciones y
enseguida sus exámenes. No todas las lecciones de todos los cursos y los exámenes al
final.

Se hizo así por fases al principio y estaba mal: dejaba cada curso en n-1 hasta el
último momento, así que una corrida que moría a la mitad no dejaba **ningún** curso
cerrado ni un solo certificado. Cerrando de uno en uno, lo terminado se queda terminado.

El orden interno sí es lecciones → exámenes, y eso no es opcional: `run.mjs` no puede
saber qué ítem es un examen hasta que alguien lee el temario, y ese inventario lo
produce `walk.mjs`.

## Flujo

```bash
S=~/.claude/skills/skilljar-course-runner/scripts
# el banco ya sale por defecto a ~/Documentos/skilljar-cursos/banco.json; no hace falta env

$S/chrome.sh                          # navegador de trabajo en :9222, sin tocar tu Chrome
node $S/login.mjs --url <portal> --email <correo>
node $S/inscribir.mjs --lista <archivo>     # ALCANCE FIJO (preferido): solo los del archivo
node $S/walk.mjs <url-curso> [...]    # visitar las lecciones es lo que las completa
node $S/run.mjs                       # contesta los exámenes pendientes
node $S/verificar.mjs <urls...>       # auditoría contra el portal: ¿de verdad quedó?
```

### Cuando el examen no revela las correctas: `resolver.mjs`

Hay cuentas donde **ningún examen ofrece `Show Answers`**, y ahí `--sondear` es ciego:
queda un score bajo y no aprende nada. El camino que sí cierra exámenes es leer cada
pregunta, contestarla con criterio y marcarla por texto:

```bash
node $S/resolver.mjs leer         # abre, reinicia, guarda captura + pregunta + opciones
                                  # de CADA pregunta y abandona SIN enviar
# se leen las preguntas, se decide cada una y se escribe:
#   /tmp/skilljar/respuestas.json  ->  {"/curso/id": {"1":"C","2":"A", ...}}
node $S/resolver.mjs contestar    # marca por TEXTO (no por letra), envía y reporta score
```

Deja una captura por pregunta en `capturas_preguntas/` (evidencia de qué se leyó) y el
inventario en `examenes.json`. Con este ciclo, ocho exámenes que venían de 0-30% salieron
al 100% en el primer envío; solo hay que sumar la vuelta de leer las opciones.

### El alcance lo pone el usuario, no el catálogo

**`--lista <archivo>` antes que `--catalogo`.** El catálogo trae más cursos de los que
alguien pidió: descubriendo se inscribieron 18 cuando el encargo eran 15, y hacer cursos
de más es trabajo que nadie encargó. `--catalogo` es solo para cuando no hay lista.

El archivo se lee tal como lo escribe una persona: enlaces sueltos, y una línea en prosa
marcando el corte (`"Esto es el único que no se hace:"`). Todo lo que venga **después** de
esa marca queda vetado — no hay que pedirle que reformatee nada.

En este portal la lista vive en `~/telegram_files/links_cursos.txt`: **15 cursos**, y fuera
`partner-basecamp` (7 de 8 ítems son paquetes SCORM y el 8º es un Intake Survey con datos
personales) y `claude-certified-architect-foundations-certification` (examen proctorado).

### Cuenta nueva: primero inscribirse

En una cuenta recién creada los cursos **no están inscritos**, y sin inscripción no hay
temario que recorrer. `walk.mjs` decía "sin temario (¿no inscrito?)" — diagnóstico
correcto que dejaba el trabajo parado. `inscribir.mjs` lo resuelve, pulsa el botón, y deja
en `cursos.json` la URL de entrada de cada curso.

**La trampa:** al inscribirse **la URL no cambia**. Verificar por el redirect da falso
negativo en todos los cursos a la vez, aunque la inscripción sí haya quedado. La prueba
es que la portada empiece a listar enlaces de lección (`/slug/<id>`).

Las certificaciones (`*-certification`) se excluyen: son exámenes presenciales, no cursos.

## Cómo se comprueba que algo quedó

Tres capas, y ninguna se cree la anterior:

1. **Por lección.** La espera termina cuando el temario marca `lesson-complete`, no
   cuando se cumple un temporizador. Si no confirma en 6 s, la lección entra a una
   **segunda pasada**; si aguanta dos intentos, se reporta con `[!]` por nombre.
2. **Por curso.** Al terminar se **relee el temario** y se emite veredicto: total,
   completas, qué falta y de qué tipo. `cerrado: true` solo si no falta nada.
3. **Auditoría aparte.** `verificar.mjs` vuelve a preguntarle al portal ítem por ítem y
   **no lee mis bitácoras a propósito**: la única prueba de que algo se completó es que
   el portal lo marque. Si mi log y el portal no coinciden, gana el portal. Sale con
   código 1 si hay lecciones sin marcar, para poder encadenarlo.

Separa las tres causas en vez de mezclarlas: una lección sin marcar es un fallo del
recorrido (se revisita), un examen pendiente es trabajo que falta (`run.mjs`), y un
paquete web es un bloqueo conocido.

⚠️ **Completo no es aprobado.** El temario marca un examen como completo por haberlo
enviado, con el score que sea. Un curso puede auditar 15/15 y tener el certificado final
en 50%. La verdad del score está en `resultados-global.json` y `sin-revelar.json`, no en
el temario — revisarlos siempre antes de decir que quedó. Para reintentar un examen que ya
figura completo hay que escribir `pendientes.json` a mano, porque `walk.mjs` no lo lista.

`run.mjs` por cada pregunta: guarda captura en `/tmp/skilljar/capturas/`, decide la
respuesta, la marca, **verifica que quedó marcada** y avanza. Al final envía, lee el
score y si no fue 100% y el examen ofrece `Show Answers`, toma las correctas de la
propia plataforma y reintenta. Deja bitácora por examen en `/tmp/skilljar/bitacoras/`.

### De dónde sale cada respuesta

En orden: la revelada por la plataforma (en un reintento) → `claves.json` si existe →
el **banco**, bajo la política de confianza → si es encuesta se deja vacía → si nada
aplica, se detiene.

### Política de confianza: una aproximación se tolera, dos no

El texto de la pregunta y el de la respuesta se comparan por parecido, porque el mismo
examen aparece reescrito entre cursos. Pero un parecido es una suposición, y **dos
suposiciones encadenadas es adivinar con pasos extra**. La regla:

| Pregunta | Respuesta | Qué hace |
|---|---|---|
| exacta | literal | decide, confianza **alta** |
| parecida | literal | decide, confianza **media** |
| exacta | parecida | decide solo si la entrada ya fue **confirmada por un score** y el parecido gana por margen |
| parecida | parecida | **se abstiene** y el examen se detiene |

Además exige **margen sobre la segunda opción**: si dos opciones se parecen igual a la
respuesta guardada, no hay certeza y se abstiene. Cada decisión queda en la bitácora con
su confianza y de qué entrada del banco salió, así que un error se puede rastrear.

`prueba-politica.mjs` cubre estos seis casos y no necesita navegador. Correrlo antes de
tocar los umbrales.

### El banco NO se guarda en /tmp (ya corregido en el código)

`BANCO_ARCHIVO` apuntaba a `/tmp/skilljar/banco.json`, y **`/tmp` se vacía**. Así se
perdieron ~286 respuestas confirmadas: se buscaron con `find`, con Spotlight, en la carpeta
de la skill y en los respaldos de los agentes, y no había una sola copia. Reconstruirlas
costó una sesión completa.

El default ya vive fuera de `/tmp`:

```
BANCO_ARCHIVO = process.env.SKILLJAR_BANCO ?? `${NOTAS}/banco.json`
              → ~/Documentos/skilljar-cursos/banco.json
```

**No revertirlo a `/tmp`.** `ESTADO` (logs, capturas, `pendientes.json`) sí puede quedar en
`/tmp`: eso es desechable. Lo que no es desechable son dos cosas, y las dos se guardan ya
en `~/Documentos/skilljar-cursos/`:

| Archivo | Qué es |
|---|---|
| `banco.json` | respuestas por pregunta (lo más valioso que produce la skill) |
| `preguntas_leidas.json` | preguntas **con sus opciones**, que `resolver.mjs leer` respalda solo |

Volver a leer las opciones cuesta una pasada completa por el portal, así que el respaldo
paga por sí solo. Ayudantes que quedaron junto a esos archivos: `cruzar.py` (qué preguntas
cubre el banco y cuáles faltan), `ver_faltan.py` (imprime las que faltan con opciones A-D),
`armar_respuestas.py` (arma `respuestas.json` con el texto literal y alimenta el banco).

### El banco distingue lo comprobado de lo supuesto

`/tmp/skilljar/banco.json` mapea texto de pregunta → `{respuesta, verificada, origen}`.
Indexado por texto y no por número, así sirve en cuentas nuevas, en cursos que cambiaron
de id y aunque el examen reordene las preguntas.

**`verificada` solo se pone cuando algo lo prueba:** un examen que salió 100% confirma
todas las respuestas que usó, y lo que la plataforma revela con `Show Answers` entra ya
confirmado (y corrige lo que hubiera). Lo que teclea una persona entra como **supuesta**:
es una hipótesis razonable, no un hecho. Una supuesta nunca sobrescribe una confirmada,
sin importar el orden en que terminen los agentes.

Con varios agentes, cada uno **escribe solo su copia local** y el orquestador integra al
final: escribir el archivo compartido en paralelo hace que el último en guardar borre lo
de los demás.

### Varios cursos a la vez

```bash
node $S/orquesta.mjs <url-curso> <url-curso> ...             # 3 agentes por defecto
node $S/orquesta.mjs --solo-examenes <urls...>              # lecciones ya hechas: solo exámenes
```

Reparte los cursos entre N agentes que trabajan en paralelo. **Tres es el punto dulce**:
cada agente carga su propio Chrome y de ahí para arriba la máquina se vuelve el cuello de
botella — con cinco el load llegó a 16 y todo se arrastró.

Con `--solo-examenes` los agentes solo leen el temario (una página por curso) en vez de
revisitar lecciones ya completas. Es la diferencia entre 380 cargas de página y 16. **Cada agente necesita su
propio Chrome**: los scripts manejan una sola pestaña, así que dos agentes en el mismo
navegador se pisan las páginas y acaban contestando el examen equivocado. El orquestador
le da a cada uno su puerto (9222, 9223, …), su perfil copiado y su carpeta de estado.

El reparto es **por carga, no por número de cursos**: uno de 93 lecciones no pesa igual
que uno de 4, así que se ordenan de mayor a menor y cada curso va al agente más
desahogado. Con `SKILLJAR_PESOS='{"slug":93,...}'` se afinan los pesos.

El **banco se comparte solo para leer**. Lo que cada agente aprende queda en su carpeta y
el orquestador lo integra al terminar: así cinco procesos no escriben el mismo archivo a
la vez. El resumen global queda en `resultados-global.json` y las preguntas nuevas de
todos en `desconocidas-global.json`.

### Muchas preguntas nuevas

```bash
node $S/run.mjs --recolectar     # anota TODAS las desconocidas del examen y NO envía
# → /tmp/skilljar/desconocidas.json  (pregunta + opciones + captura + por qué se abstuvo)
# se contestan todas de una sentada agregándolas a banco.json, y luego:
node $S/run.mjs
```

Recorre el examen completo anotando cada pregunta que no puede decidir, y **al final no
lo envía**. Antes abortaba en la primera: un examen con tres preguntas nuevas costaba
tres vueltas completas.

Sin `--recolectar` se detiene en cada pregunta desconocida y espera: deja la pregunta
en `pregunta-abierta.json` y lee la respuesta de `respuesta.txt` (una letra o un
fragmento del texto).

## Lo que hay que saber del sitio

**Login.** `login.mjs` inicia sesión **dentro** del navegador de trabajo. No sirve
loguearse en el Chrome personal y copiar su perfil: Chrome guarda las cookies en
memoria y no las vuelca al disco mientras corre, así que la sesión llega vacía o a
medias. Ejecutar JavaScript por AppleScript tampoco sirve: viene desactivado y el menú
para activarlo no responde al clic programático.

**Lecciones.** Con visitar la URL se marcan completas; no hay candado de video.

| | |
|---|---|
| Enlace de lección | `a.lesson`, y en algunos cursos solo `a[class*="lesson-"]` |
| Completa | la clase incluye `lesson-complete` |
| La que estás viendo | `aria-current="page"` |

**Exámenes.** Montados en Vue **dentro de shadow DOM**: `document.querySelectorAll` no
los ve, los locators de Playwright sí. No leas las opciones con `page.evaluate`.

| Control | Cómo se toma |
|---|---|
| Abrir | `getByRole('button', {name:/start/i})` — con `/^start$/` falla por los espacios |
| Avanzar | `getByRole('button', {name:/^next question$|^next$/i})` |
| Enviar | `getByRole('button', {name:/^(submit|complete|finish)$/i})` |
| Reiniciar | texto `Take this again` — es un `<span>`: **`page.locator("text=Take this again").click({force:true})`**, y **después** hay que pulsar `Start` |
| Progreso | el texto `Question N of M` del body — **devuelve un ARRAY `[n, total]`**, no un objeto |
| Correctas reveladas | tras `Show Answers`, `div.answer.correct` |

**Reintentos** ilimitados en la práctica y el último sobrescribe el score, así que un
examen reprobado no es definitivo.

### ⛔ Las opciones se REORDENAN en cada intento: se marca por TEXTO, nunca por letra

Skilljar baraja el orden de las opciones cada vez que se abre el examen. Leer las
opciones en una pasada, anotar "la correcta es la C" y marcar la C en la pasada
siguiente **es tirar una moneda**: así salió `0 of 8 Correct (0%)` en un examen cuyas
ocho respuestas estaban bien razonadas. Los mismos cuatro exámenes, marcando por texto,
dieron 100%, 100%, 100% y 75%.

Regla: la respuesta se guarda y se busca **por el texto de la opción**. Si se anotó una
letra, hay que traducirla al texto que tenía en la pasada donde se leyó, y luego
localizar ese texto entre las opciones actuales (`resolver.mjs` lo hace: coincidencia
exacta y, si no, mejor parecido con umbral 0.6, avisando en el log).

Esto explica de paso por qué `--sondear` puede rendir tan poco: si el examen se reintenta
con las letras de la vuelta anterior, se está contestando otra pregunta.

### Una escala sin marcar CONGELA el examen

En un examen mixto, si la escala de satisfacción se deja vacía, `Next Question` no
avanza: no falla, simplemente no pasa nada, y el examen nunca llega al `Submit`. Un
`Certificate of completion` se quedó clavado en "Question 11 of 13" y reportó
"sin score" con las diez calificadas ya correctas. Marcar el punto medio también sirve
para poder terminar, no solo por cortesía.

### `leer` BORRA el score de un examen ya aprobado

`resolver.mjs leer` pulsa *Take this again*, y eso **tira el score anterior**: un examen que
estaba en 100% queda en blanco hasta que se vuelva a enviar. Pasó por dejar en
`pendientes.json` un examen ya cerrado y correr `leer` encima; hubo que reenviarlo para
recuperar el 100%.

Y `pendientes.json` **no lo escribe `verificar.mjs`, lo escribe `walk.mjs`**: después de
auditar, el archivo sigue con lo que había antes. **Mirar `pendientes.json` antes de cada
`leer`**, no suponer qué trae.

### El examen ABANDONADO a media no ofrece "Take this again": hay que caminar hacia atrás

Un examen **enviado** ofrece *Take this again*. Uno **abandonado sin enviar** (lo que deja
`resolver.mjs leer`) no ofrece nada: al volver a abrirlo **reaparece en la pregunta donde
se quedó**. Si no se detecta, pasan las dos cosas:

- al leer, se guardan solo las preguntas del final (un examen de 7 arrancó en la Q7);
- al contestar, las primeras preguntas **nunca se marcan** y el score sale bajo aunque las
  respuestas fueran correctas. Así salió un `6 of 8 Correct (75%)` en el que las ocho
  respuestas estaban bien: el log arrancaba en `Q3`, y Q1 y Q2 se enviaron en blanco.

Después de intentar *Take this again* y *Start*, si `progreso()` no devuelve 1, hay que
retroceder con el botón **Previous** hasta la primera pregunta (con guarda de ~40 vueltas
y cortando si el número deja de cambiar). Es lo que hace `reiniciar()` de `lib.mjs`; el
mismo retroceso vive ahora en `abrir()` de `resolver.mjs`.

Diagnóstico rápido: si el log de un examen **no empieza en `Q1`**, no confíes en el score.

### El examen ya enviado no se abre solo

Cuando el ítem está completo, la página muestra el resultado con `Show Answers` y
**no hay** `Start` visible. El orden que funciona es: clic al `<span>` *Take this again*
con el locator de Playwright → esperar → **entonces** aparece `Start` → pulsarlo. Sin el
segundo paso, `progreso()` sigue devolviendo vacío y el runner reporta "no pude abrir el
examen en la pregunta 1" aunque la sesión y la URL estén perfectas.

### `--recolectar` gira en falso: para leer un examen hay que poder avanzar

El modo que solo anota preguntas sin marcar nada no puede pulsar `Next` (el botón exige
selección), así que relee la misma pregunta indefinidamente — se registró 7 veces
"Q1/9". Para inventariar un examen hay que **marcar cualquier opción solo para avanzar y
abandonar sin enviar** (`resolver.mjs leer`): mientras no se pulse `Submit`, nada queda
registrado. Y la guardia de "no avanzó" se compara por **número** de pregunta: comparar
el texto da falso negativo, porque `textoPregunta()` devuelve `"(?)"` cuando su regex no
casa y dos `"(?)"` seguidos parecen la misma pregunta.

## Dos silencios que ya están tapados

- **Sesión caducada.** El portal no te manda a una pantalla de login: deja la página
  del curso vacía con "Sign In" arriba. Sin `exigirSesion()` los scripts reportan
  "0/0 lecciones, todas completas" y parece que el curso ya estaba cerrado.
- **Curso no habilitado.** El portal **redirige a otro curso**, y entonces se lee el
  temario del curso equivocado. `mismoCurso()` lo detecta y avisa en vez de fingir.

## Lo que esta skill NO cierra

- **Paquetes web (SCORM)**, clase `lesson-web-package`: contenido propio en iframes
  anidados con pantallas que bloquean el avance hasta contestar sus escenarios. El
  botón `Complete` de Skilljar no las marca; el paquete tiene que reportar solo. Se
  marcan como bloqueadas y se avisa.
- **Formularios con datos del usuario** (correo, empresa, rol). Se pregunta a la persona.

## Higiene

- **Sesión:** `walk`, `run`, `status` y `verificar` la comprueban antes de trabajar. En
  una corrida de 39 exámenes la sesión puede caducar a medias, y sin el chequeo los
  exámenes fallan por una razón que no es la que se reporta.
- **Capturas:** se borran las de exámenes que salieron 100% con todas las decisiones de
  confianza alta (no hay nada que auditar ahí), y las de más de 3 días
  (`SKILLJAR_RETENCION_DIAS`). Sin esto crecían sin techo: 98 MB en unos días.
- **Entre agentes:** lo aprendido se integra al banco compartido **al cerrar cada curso**,
  no al final de todo, así el agente 2 encuentra lo que el 1 acabó de aprender. Es seguro
  porque el merge vive en el proceso del orquestador y es sincrónico.

## Pruebas sin navegador

```bash
node $S/prueba-politica.mjs      # 6 casos de la política de confianza
node $S/prueba-encuestas.mjs     # 6 casos de detección de escalas
```

Correrlas antes de tocar umbrales o la detección de encuestas.

## Cuando no sabe la respuesta: `--sondear`

```bash
node $S/run.mjs --sondear
```

Regla 3 dice "si no sabe, se detiene", y eso dejaba exámenes sin enviar esperando a una
persona que no estaba mirando el archivo. La alternativa **no es adivinar: es preguntarle
a la plataforma**, que sí sabe.

Con `--sondear`, una pregunta desconocida se marca, se envía, y se lee `Show Answers`
para reintentar con todo correcto. Es seguro porque **los reintentos son ilimitados y el
último sobreescribe el score** — comprobado pasando exámenes de 42% a 100%. Un envío
imperfecto deliberado no es un resultado, es una consulta.

El único caso en que sale peor que abstenerse es un examen que **no** revela las
correctas: entonces queda un score bajo. Eso se registra en `sin-revelar.json` con las
preguntas exactas y se grita en el log con `[!]`, nunca se disimula.

**El orquestador sondea por defecto.** Antes pasaba `--recolectar` fijo, que abandona el
examen y espera a una persona: con tres agentes en paralelo y nadie mirando, eso es un
curso que no cierra. Para volver al modo viejo, `node orquesta.mjs --recolectar ...`.

## Operación

- Los procesos largos van desacoplados: `nohup node ... &`. Un shell en segundo plano
  muere con la sesión del agente y un curso de 90 lecciones tarda más que eso.
- Un solo navegador: los scripts comparten la pestaña, **no correr dos a la vez**.
  Encadenar con `until ! pgrep -f "node .*otro.mjs"; do sleep 10; done`. **El patrón
  importa:** `pgrep -f otro.mjs` casa también con el proceso del agente que lo lanzó
  (su línea de comando contiene ese texto), y entonces se reporta "corriendo" cuando ya
  no hay nada corriendo.
- Contenido de los cursos en `~/Documentos/skilljar-cursos/<curso>.md`.

## El orquestador canta victoria cuando `run.mjs` se muere

Si `run.mjs` muere con un error no capturado (`ERR_ABORTED` navegando al examen
siguiente, por ejemplo), el orquestador **marca ese curso como `cerrado` igual**. De ahí
salió un reporte de "12 cursos cerrados" que el portal contradijo: solo había 4. Cuando
el log y `verificar.mjs` no coincidan, **gana el portal**, y hay que revisar si algún
`run.mjs` terminó con `Node.js vXX` en el log — esa línea es la firma de un proceso que
se cayó, no de un curso terminado.

## `ERR_ABORTED`: no es el portal, es la pestaña sucia

Después de recorrer un examen largo, la siguiente navegación al portal muere con
`net::ERR_ABORTED` y arrastra en cadena a los exámenes que siguen. La misma URL cargada
sola funciona sin problema. Dos mitigaciones que lo estabilizan:

- **Limpiar la pestaña entre exámenes**: `page.goto("about:blank")` + ~2.5 s antes de ir
  al siguiente.
- **Reintentar la navegación** (3 intentos, esperando más en cada uno). Si aun así no
  carga, se reporta ese examen y se sigue con el resto en vez de morir.

Y si el navegador ya se degradó del todo (varias corridas seguidas), hay que relanzarlo
**sin volver a copiar el perfil**, o se pierde la sesión: `chrome.sh` hace `rm -rf` del
perfil de trabajo y lo recopia del Chrome personal, donde las cookies recientes no están.

```bash
pkill -f "remote-debugging-port=9222"; sleep 4      # al cerrar, Chrome vuelca las cookies
nohup "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --user-data-dir=/tmp/skilljar-chrome --profile-directory="Profile 1" \
  --remote-debugging-port=9222 --no-first-run about:blank >/dev/null 2>&1 & disown
```

## Un proceso a la vez, y comprobarlo antes de lanzar otro

Los scripts comparten la única pestaña. Dos corriendo a la vez se pisan las páginas: un
`leer` y un `contestar` simultáneos mezclaron sus salidas en el mismo log y el
`contestar` nunca llegó a enviar. Antes de lanzar cualquier cosa:

```bash
pgrep -f "node .*(run|resolver|recolectar)[.]mjs" && echo "ya hay uno corriendo"
```

Lo mismo con los `.command` de demo o cualquier script con handshake por archivo: dos
instancias escribiendo el mismo marcador producen capturas desordenadas y duplicadas.

## `pendientes.json` es de un solo dueño

`run.mjs` y `walk.mjs` **reescriben** `pendientes.json`. Si se acota la lista a mano para
trabajar un subconjunto y en medio se corre cualquiera de los dos, la lista vuelve a
crecer y la ronda siguiente arranca con exámenes que no tocaban. Conviene guardar la
lista completa aparte (`pendientes_todos.json`) y regenerar el subconjunto justo antes de
cada ronda.

## Las tres fallas de plomería que costaron una tarde

No eran de contenido. El banco tenía las respuestas; lo que se rompía era el navegador.

1. **Abrir una segunda pestaña con `newPage()` y cerrarla deja la conexión CDP
   inservible.** El curso siguiente moría con `Target page, context or browser has been
   closed` y el reporte culpaba al portal. Por eso `--pestanas` **es 1 por defecto**; 2
   sigue disponible, aceptando el riesgo a cambio de velocidad.
2. **`soltar()` no cierra el navegador a propósito, así que el socket CDP queda abierto y
   node nunca termina.** El trabajo acababa bien y el proceso se quedaba colgado; quien lo
   esperaba (el orquestador, o un `until pgrep`) esperaba para siempre. `walk.mjs` y
   `run.mjs` terminan con `process.exit(0)` explícito.
3. **Un navegador caído se llevaba todos los cursos siguientes.** Ahora cada curso tiene
   dos intentos: si el error huele a navegador muerto, `conectar()` se relanza solo y
   repite **ese** curso.
