// Encuestas por estructura, no por palabras clave.
//
// El caso que importa es el cuarto: una pregunta CALIFICADA que menciona "satisfied".
// Con la detección vieja se dejaba en blanco y perdía el punto en silencio.

import { esEncuesta, esEscala } from "./lib.mjs";

const casos = [
  { n: "encuesta clásica de 5 grados → encuesta",
    t: "How satisfied are you with the content provided in this course?",
    o: ["Not at all satisfied", "Not very satisfied", "Neutral", "Satisfied", "Very satisfied"],
    espera: true },

  { n: "escala numérica 1-5 → encuesta",
    t: "On a scale of one to five, how likely are you to recommend this course to a colleague?",
    o: ["5 - Very likely", "4 - Likely", "3 - Maybe", "2 - Unlikely", "1 - Very unlikely", "Too soon to tell"],
    espera: true },

  { n: "encuesta redactada distinto pero con escala → encuesta",
    t: "How would you rate your experience with this material?",
    o: ["Not at all satisfied", "Slightly satisfied", "Moderately satisfied", "Satisfied", "Extremely satisfied"],
    espera: true },

  { n: "pregunta CALIFICADA que dice 'satisfied' → NO es encuesta (el caso peligroso)",
    t: "A client says their users are not satisfied with response times. How satisfied a customer feels is measured by which metric?",
    o: ["Latency percentiles at p95", "The number of tokens per request", "Model temperature setting", "Cache hit ratio"],
    espera: false },

  { n: "pregunta de opción múltiple normal → NO es encuesta",
    t: "What is the primary purpose of tool use in Claude?",
    o: ["To save memory", "To extend capabilities beyond training data", "To speed up replies", "To shorten prompts"],
    espera: false },

  { n: "escala sin polos (solo grados medios) → NO cuenta como escala",
    t: "How satisfied are you?",
    o: ["Somewhat", "Moderately", "Neutral", "Unsure"],
    espera: false },
];

let bien = 0;
for (const c of casos) {
  const r = esEncuesta(c.t, c.o);
  const ok = r === c.espera;
  if (ok) bien++;
  console.log(`${ok ? "OK   " : "FALLA"} ${c.n}`);
  if (!ok) console.log(`        esperaba ${c.espera}, devolvió ${r} (escala: ${esEscala(c.o)})`);
}
console.log(`\n${bien}/${casos.length} casos correctos`);
process.exit(bien === casos.length ? 0 : 1);
