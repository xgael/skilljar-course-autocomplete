import { decidir } from "./lib.mjs";

const casos = [
  { nombre: "pregunta exacta + respuesta literal → decide",
    banco: [["what is mcp?", { respuesta: "standardized protocol", verificada: false, origen: "importada" }]],
    texto: "What is MCP?",
    opciones: ["A standardized protocol for connections", "A programming language", "A database", "A cache"],
    espera: 0 },

  { nombre: "pregunta parecida + respuesta literal → decide (una sola aproximación)",
    banco: [["you're building a chat app where users ask claude about their github data. without mcp, what's the main problem?",
             { respuesta: "write and maintain all the github tool code", verificada: true, origen: "confirmada por score 100%" }]],
    texto: "You're building a chat app where users ask Claude about their GitHub data. Without MCP, what's the main problem you'd face?",
    opciones: ["GitHub blocks API access", "You'd have to write and maintain all the GitHub tool code yourself", "Claude can't read JSON", "Users can't type"],
    espera: 1 },

  { nombre: "pregunta parecida + respuesta parecida → SE ABSTIENE (dos suposiciones)",
    banco: [["where should you store your api key when building a web app that talks to claude?",
             { respuesta: "on your server that users cannot access", verificada: false, origen: "importada" }]],
    texto: "You're building a web application that communicates with Claude. Where must the API key live?",
    opciones: ["Inside the mobile bundle", "On your backend, hidden from clients", "In localStorage", "In the query string"],
    espera: -1 },

  { nombre: "entrada sin confirmar + respuesta no literal → SE ABSTIENE",
    banco: [["what is the primary purpose of tool use in claude?", { respuesta: "access real-time information beyond training data", verificada: false, origen: "importada" }]],
    texto: "What is the primary purpose of tool use in Claude?",
    opciones: ["To save memory", "To extend capabilities past its training by reaching external systems", "To speed up replies", "To shorten prompts"],
    espera: -1 },

  { nombre: "misma entrada YA CONFIRMADA + respuesta parecida → decide",
    banco: [["what is the primary purpose of tool use in claude?", { respuesta: "access real-time information beyond training data", verificada: true, origen: "confirmada por score 100%" }]],
    texto: "What is the primary purpose of tool use in Claude?",
    opciones: ["To save memory", "To reach real-time information beyond its training data", "To speed up replies", "To shorten prompts"],
    espera: 1 },

  { nombre: "dos opciones igual de parecidas → SE ABSTIENE (sin margen)",
    banco: [["which competency decides what work goes to ai?", { respuesta: "delegation", verificada: true, origen: "confirmada por score 100%" }]],
    texto: "Which competency decides what work goes to AI?",
    opciones: ["Description", "Discernment", "Diligence", "Documentation"],
    espera: -1 },
];

let bien = 0;
for (const c of casos) {
  const d = decidir(new Map(c.banco), c.texto, c.opciones);
  const ok = d.indice === c.espera;
  if (ok) bien++;
  console.log(`${ok ? "OK  " : "FALLA"} ${c.nombre}`);
  console.log(`      esperaba ${c.espera}, devolvió ${d.indice}${d.motivo ? ` — ${d.motivo}` : ` — ${d.fuente}`}`);
}
console.log(`\n${bien}/${casos.length} casos correctos`);
process.exit(bien === casos.length ? 0 : 1);
