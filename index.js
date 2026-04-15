require("dotenv").config();
const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcodeTerminal = require("qrcode-terminal");
const { Groq } = require("groq-sdk");
const QRCode = require("qrcode");
const fs = require("fs");
const express = require("express");
const path = require("path");

const app = express();

const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY,
});

const isWindows = process.platform === "win32";

const puppeteerConfig = {
  headless: true,
  args: isWindows
    ? []
    : [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-accelerated-2d-canvas",
        "--no-first-run",
        "--no-zygote",
        "--disable-gpu",
        "--single-process",
        "--disable-extensions",
        "--disable-notifications",
        "--disable-remote-fonts",
        "--disable-voice-input",
        "--disable-software-rasterizer",
        "--mute-audio",
        "--js-flags=--max-old-space-size=350",
      ],
};

console.log(`💻 Sistema detectado: ${isWindows ? "Windows" : "Linux/Railway"}`);

const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: puppeteerConfig,
});

const SYSTEM_PROMPT = `
### ROL Y PERSONALIDAD ###
Eres el asistente comercial de "Marelta Ferretería". Tu objetivo es vender materiales de construcción.
Personalidad: Profesional, directo, eficiente y enfocado en cerrar el negocio.
Ubicación: Diez de Octubre, Rodríguez 119/ San Indalecio y San Benigno, Santo Suárez, Havana, Cuba.
Horario de atención: 9 am a 4 pm de lunes a viernes.

### REGLAS DE RESPUESTA (PRIORIDAD MÁXIMA) ###
1. NUNCA inventes existencias. Usa exclusivamente el "CONTEXTO DE INVENTARIO" proporcionado.
2. Si el producto no aparece en el inventario o la pregunta no es de ferretería, responde con un mensaje vacío.
3. El servicio de domicilio tiene un COSTO ADICIONAL.
4. Usa negritas para precios y productos.
5. Para dudas técnicas o ver fotos, remite al catálogo: https://elyerromenu.com/b/marleta-ferreteria/info#info

### ESPECIFICACIONES TÉCNICAS (USAR SI EL PRODUCTO COINCIDE) ###
- **Masilla:** Interior, alisar paredes, acabado fino.
- **Pasta de juntas:** Rellenar rajaduras e imperfecciones.
- **Cemento P450:** Estructural, saco de 25kg.
- **Pladur:** 12mm de espesor, planchas de 1.20x2.40.
- **Pintura Vinil TOR:** Interior y exterior.

### OBJETIVOS COMERCIALES ###
1. Venta: Prioriza pedidos de mayoreo.
2. Domicilio: Si preguntan por envío, solicita ubicación exacta.
3. Proveedores: Si ofrecen mercancía, capta contacto, precio y volumen.
`;

// --- FUNCIÓN DE NORMALIZACIÓN ---
function normalizarTexto(texto) {
  if (!texto) return "";
  return texto
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/([a-z])\1+/g, "$1")
    .replace(/v/g, "b")
    .replace(/c|z/g, "s")
    .replace(/n/g, "m")
    .replace(/h/g, "")
    .replace(/y/g, "i")
    .trim();
}

// --- FUNCIÓN DE BÚSQUEDA EN API REAL ---
async function buscarEnApi(query) {
  try {
    const response = await fetch("https://marelta.com/productos/");
    if (!response.ok) throw new Error("Error al conectar con la API");

    const productos = await response.json();
    const queryNorm = normalizarTexto(query);
    const palabrasUsuario = queryNorm.split(/\s+/).filter((p) => p.length >= 3);

    const coincidencias = productos
      .filter((item) => {
        if (!item.name) return false;
        const nombreNorm = normalizarTexto(item.name);
        const palabrasProducto = nombreNorm.split(/\s+/);

        if (nombreNorm.length > 2 && queryNorm.includes(nombreNorm))
          return true;

        return palabrasUsuario.some((palabra) =>
          palabrasProducto.includes(palabra)
        );
      })
      .map((item) => {
        // Lógica de precio: Priorizar USD, si es 0 usar CUP
        const precioDisplay =
          item.price_sell_usd > 0
            ? `${item.price_sell_usd} USD`
            : `${item.price_sell_cup} CUP`;

        return `${item.name} - Precio: ${precioDisplay} (Stock: ${item.stock})`;
      });

    return coincidencias.length > 0
      ? coincidencias.slice(0, 15).join(", ")
      : null;
  } catch (error) {
    console.error("Error consultando API:", error);
    return null;
  }
}

// --- SERVIDOR WEB QR ---
app.get("/qr", (req, res) => {
  const qrPath = path.join(__dirname, "qr.png");
  if (fs.existsSync(qrPath)) {
    res.sendFile(qrPath);
  } else {
    res.send(
      `<html><body style="font-family:sans-serif;text-align:center;padding-top:50px;"><h1>Esperando código QR... ⏳</h1><script>setTimeout(()=>{location.reload();},5000);</script></body></html>`
    );
  }
});

app.get("/", (req, res) => {
  res.redirect("/qr");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ Servidor comercial (API Mode) listo en puerto ${PORT}`);
});

// --- EVENTOS WHATSAPP ---
client.on("qr", (qr) => {
  qrcodeTerminal.generate(qr, { small: true });
  QRCode.toFile("./qr.png", qr, {
    color: { dark: "#000000", light: "#ffffff" },
  });
});

client.on("ready", () => {
  console.log("¡Bot de Ferretería conectado y sincronizado con API!");
  if (fs.existsSync("./qr.png")) {
    fs.unlinkSync("./qr.png");
  }
});

client.on("message", async (msg) => {
  if (
    msg.isStatus ||
    msg.fromMe ||
    msg.from.includes("@g.us") ||
    msg.from.includes("@newsletter")
  )
    return;

  const contact = await msg.getContact();
  if (contact.isEnterprise) return;

  try {
    // Buscamos directamente en la API de la web
    const hallazgos = await buscarEnApi(msg.body);

    const messages = [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "system",
        content: `CONTEXTO DE INVENTARIO (API REAL): [${
          hallazgos || "PRODUCTO NO ENCONTRADO O SIN STOCK"
        }].`,
      },
      { role: "user", content: msg.body },
    ];

    const completion = await groq.chat.completions.create({
      messages: messages,
      model: "llama-3.3-70b-versatile",
      temperature: 0.1, // Bajamos temperatura para evitar alucinaciones con el inventario
      max_tokens: 300,
    });

    const respuesta = completion.choices[0].message.content;

    if (respuesta.trim() !== "") {
      await msg.reply(respuesta);
    }
  } catch (error) {
    console.error("Error en proceso de respuesta:", error);
  }

  if (global.gc) {
    global.gc();
  }
});

client.initialize();
