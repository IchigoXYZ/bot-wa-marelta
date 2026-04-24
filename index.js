require("dotenv").config();
const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcodeTerminal = require("qrcode-terminal");
const { Groq } = require("groq-sdk");
const QRCode = require("qrcode");
const fs = require("fs");
const express = require("express");
const path = require("path");
const TelegramBot = require("node-telegram-bot-api");

const app = express();

// --- CONFIGURACIÓN DE MEMORIA ---
const sessions = {}; // Almacena el historial por número de teléfono
const MAX_HISTORY = 5; // Cantidad de mensajes a recordar

// --- CONFIGURACIÓN DE DEBUG ---
const DEBUG_CONFIG = {
  enabled: false, // true: muestra logs y BLOQUEA el envío de mensajes. false: funcionamiento normal.
};

// --- CONFIGURACIÓN DE TELEGRAM ---
let telegramBot = null;
if (process.env.TELEGRAM_TOKEN && process.env.TELEGRAM_CHAT_ID) {
  telegramBot = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: false });
  console.log("✅ Bot de Telegram configurado");
}

async function sendToTelegram(message) {
  if (!DEBUG_CONFIG.enabled && telegramBot && process.env.TELEGRAM_CHAT_ID) {
    try {
      await telegramBot.sendMessage(process.env.TELEGRAM_CHAT_ID, message);
    } catch (err) {
      console.error("Error enviando a Telegram:", err.message);
    }
  }
}

function debugLog(step, data) {
  if (DEBUG_CONFIG.enabled) {
    console.log(`[${step}]`);
    console.log(data);
    console.log("-----------------------------------------");
  }
}

// --- MODIFICACIÓN: INSTANCIAS DE GROQ Y VARIABLE DE ALTERNANCIA ---
const groq1 = new Groq({
  apiKey: process.env.GROQ_API_KEY,
});

const groq2 = new Groq({
  apiKey: process.env.GROQ_API_KEY_2,
});

let useFirstGroqKey = true; // Variable para alternar las llamadas
// ------------------------------------------------------------------

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
  authStrategy: new LocalAuth({ dataPath: '/app/data' }), // <-- ÚNICA MODIFICACIÓN: Ruta específica para el volumen
  puppeteer: puppeteerConfig,
});

const SYSTEM_PROMPT = `
### ROL Y PERSONALIDAD ###
Eres el asistente comercial de "Marelta Ferretería". Tu objetivo es vender materiales de construcción, pero puede haber otros productos tambien que no sean de construcción.
Personalidad: Profesional, directo, eficiente y enfocado en cerrar el negocio.
Ubicación: Diez de Octubre, Rodríguez 119/ San Indalecio y San Benigno, Santo Suárez, Havana, Cuba.
Horario de atención: 9 am a 4 pm de lunes a viernes.

### MÉTODOS DE PAGO ###
Dejar claro al cliente que aceptamos:
- Moneda nacional (Efectivo)
- USD (Efectivo)
- Euro (Efectivo)
- Transferencia (ACLARACIÓN: Las transferencias son de hasta el 30% del total según el monto. El resto se paga en el local).

### CONDICIONES DE MENSAJERÍA ###
El bot debe informar automáticamente las siguientes condiciones según la cantidad:
- Hasta 3 productos: Se puede enviar a domicilio. BAJO NINGÚN CONCEPTO debes inventar, adivinar o dar un precio de envío a domicilio. Debes informar explícitamente al cliente que el precio exacto del domicilio se lo dará el comercial al final de la venta cuando hable directamente con él.
- Más de 3 productos: SOLO recogida en local.

### REGLAS DE RESPUESTA (PRIORIDAD MÁXIMA) ###
1. NUNCA inventes existencias ni precios que no tengas. Usa exclusivamente el "CONTEXTO DE INVENTARIO" proporcionado. NUNCA menciones un precio para la mensajería.
2. Si el producto no aparece en el inventario o la pregunta no es de ferretería, responde con un mensaje vacío.
3. Usa negritas para precios y productos.
4. Para dudas técnicas o ver fotos, remite al catálogo: https://elyerromenu.com/b/marleta-ferreteria

### REGLA DE STOCK E INVENTARIO ###
- NUNCA menciones la cantidad exacta de productos en stock al cliente en conversaciones normales.
- Solo debes informar que no hay suficiente cantidad si el cliente solicita una cifra que supera el stock actual disponible en el "CONTEXTO DE INVENTARIO".
- Si el cliente no pregunta por cantidades o pide una cantidad disponible, confirma la existencia sin decir el número de stock.
- Tienes acceso a precios unitarios y precios mayoristas en USD y CUP. Informa el precio mayorista solo si el cliente pide cantidades iguales o superiores al mínimo requerido o si pregunta por descuentos/compras al por mayor.

### CIERRE DE VENTA Y PAGO ANTICIPADO (30%) ###
- Cuando el cliente quiera comprar, DEBES solicitar PRIMERO su nombre.
- Una vez te dé su nombre, envía un mensaje automático exacto con este formato para el anticipo:
  "Perfecto, [Nombre del cliente] 🙌 Puedes asegurar tu mercancía con un anticipo del 30% 💳\n📌 Tarjeta: 9212 9598 7166 1908\n📲 Envíanos el comprobante por este chat para confirmar." (Aclara que el resto se paga en el local).
- Diferencia correctamente el método de entrega (Entrega a domicilio o Recogida en tienda).
- NO generes el objeto JSON hasta que el cliente haya proporcionado su nombre, confirmado el pago y la dirección (si aplica domicilio).
- Solo al confirmar, responde ÚNICAMENTE con un objeto JSON siguiendo este formato exacto:
{"finalizar": true, "cliente": "Nombre", "metodo_entrega": "Entrega a domicilio / Recogida en tienda", "direccion": "Dirección o N/A", "pedido": "Producto 1, Producto 2", "total": "Monto total"}

Si aún estás en la fase de conversación, asesoría, o pidiendo los datos, responde con texto normal de forma profesional.
`;

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

// --- FUNCIÓN JARO-WINKLER INTEGRADA ---
function calcularSimilitud(s1, s2) {
  if (!s1 || !s2) return 0;
  if (s1 === s2) return 1;
  let l1 = s1.length,
    l2 = s2.length;
  let range = Math.floor(Math.max(l1, l2) / 2) - 1;
  let m1 = new Array(l1).fill(false),
    m2 = new Array(l2).fill(false);
  let matches = 0;
  for (let i = 0; i < l1; i++) {
    let start = Math.max(0, i - range),
      end = Math.min(i + range + 1, l2);
    for (let j = start; j < end; j++) {
      if (!m2[j] && s1[i] === s2[j]) {
        m1[i] = true;
        m2[j] = true;
        matches++;
        break;
      }
    }
  }
  if (matches === 0) return 0;
  let t = 0,
    k = 0;
  for (let i = 0; i < l1; i++) {
    if (m1[i]) {
      while (!m2[k]) k++;
      if (s1[i] !== m2[k]) t++;
      k++;
    }
  }
  let jaro = (matches / l1 + matches / l2 + (matches - t / 2) / matches) / 3;
  let p = 0;
  for (let i = 0; i < Math.min(4, l1, l2); i++) {
    if (s1[i] === s2[i]) p++;
    else break;
  }
  return jaro + p * 0.1 * (1 - jaro);
}

async function buscarEnApi(query) {
  try {
    debugLog(
      "SOLICITUD API",
      `Iniciando fetch a: https://marelta.com/productos/`
    );
    const response = await fetch("https://marelta.com/productos/");
    if (!response.ok) throw new Error("Error al conectar con la API");

    const productos = await response.json();
    const queryNorm = normalizarTexto(query);
    debugLog(
      "NORMALIZACIÓN",
      `Query original: "${query}" -> Normalizado: "${queryNorm}"`
    );

    const stopWords = [
      "hola",
      "tienes",
      "vendes",
      "busco",
      "quiero",
      "precio",
      "cuanto",
      "vale",
      "necesito",
    ];
    const palabrasUsuario = queryNorm
      .split(/\s+/)
      .filter((p) => p.length >= 3 && !stopWords.includes(p));

    const coincidencias = productos
      .map((item) => {
        const nombreNorm = normalizarTexto(item.name);
        const palabrasProducto = nombreNorm.split(/\s+/);
        let maxScore = calcularSimilitud(queryNorm, nombreNorm);
        let matchCount = 0;

        palabrasUsuario.forEach((uP) => {
          let bestWordScore = 0;
          palabrasProducto.forEach((pP) => {
            const s = calcularSimilitud(uP, pP);
            if (s > bestWordScore) bestWordScore = s;
          });
          if (bestWordScore > 0.85) matchCount++;
          if (bestWordScore > maxScore) maxScore = bestWordScore;
        });

        const finalScore = matchCount > 0 ? Math.max(maxScore, 0.8) : maxScore;
        return { ...item, score: finalScore };
      })
      .filter((item) => item.score > 0.72)
      .sort((a, b) => b.score - a.score)
      .map((item) => {
        // Formatear la información extendida del producto para el bot
        const precioNormal = `${item.price_sell_usd} USD / ${item.price_sell_cup} CUP`;
        let mayoristaInfo = "";
        
        if (item.mayorista_min_qty > 0) {
          mayoristaInfo = ` | Mayorista (desde ${item.mayorista_min_qty} unid): ${item.price_sell_mayorista_usd} USD / ${item.price_sell_mayorista_cup} CUP`;
        }
        
        let detallesInfo = "";
        if (item.detalles && item.detalles.trim() !== "") {
          detallesInfo = ` | Detalles: ${item.detalles}`;
        }

        return `${item.name} - Precio: ${precioNormal}${mayoristaInfo} (Stock: ${item.stock})${detallesInfo}`;
      });

    debugLog(
      "FILTRADO DE COINCIDENCIAS",
      coincidencias.length > 0
        ? coincidencias
        : "No se encontraron productos tras filtrar"
    );

    return coincidencias.length > 0
      ? coincidencias.slice(0, 15).join(", ")
      : null;
  } catch (error) {
    console.error("Error consultando API:", error);
    return null;
  }
}

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
  // Ignorar estados, mensajes propios, grupos y newsletters
  if (
    msg.isStatus ||
    msg.fromMe ||
    msg.from.includes("@g.us") ||
    msg.from.includes("@newsletter")
  )
    return;

  // FILTRO DE NÚMERO AUTORIZADO (Solo responde a este número)
  // const numeroAutorizado = "280779343003800@lid"; // anthony
  // const numeroAutorizado2 = "77425526444166@lid"; // ossuan
  // if (msg.from !== numeroAutorizado && msg.from !== numeroAutorizado2) return;

  const contact = await msg.getContact();
  if (contact.isEnterprise) return;

  const sender = msg.from;

  try {
    // 1. MANEJO DE AUDIOS
    if (msg.hasMedia && (msg.type === "ptt" || msg.type === "audio")) {
      await msg.reply("Para poder ayudarte mejor, por favor escríbenos tu consulta ✍️🙏");
      return; // Detenemos la ejecución aquí
    }

    // 2. ATENCIÓN HUMANA
    const msgTextoNormalizado = normalizarTexto(msg.body);
    const humanKeywords = ["humano", "persona", "vendedor", "comercial", "asesor"];
    if (humanKeywords.some((kw) => msgTextoNormalizado.includes(kw))) {
      await msg.reply("Un comercial te contactará a la brevedad 📲✨ Puedes seguir consultando por aquí mientras tanto.");
      
      // Enviar notificación a Telegram (como sistema de registro/alerta centralizado)
      const userName = contact.pushname || contact.number;
      await sendToTelegram(`🚨 *ALERTA DE ATENCIÓN HUMANA*\nEl cliente ${userName} (${contact.number}) ha solicitado hablar con un vendedor.\nMensaje: "${msg.body}"`);
      return; // Detenemos la ejecución para que el bot no intente responder al pedido de ayuda humana
    }

    if (DEBUG_CONFIG.enabled) {
      console.log(
        "\n========================================================="
      );
      console.log(
        `🚀 INICIANDO PROCESAMIENTO: ${new Date().toLocaleTimeString()}`
      );
      console.log("=========================================================");
    }

    debugLog("MENSAJE RECIBIDO", `De: ${sender} - Mensaje: ${msg.body}`);

    // Inicializar o limpiar historial antiguo
    if (!sessions[sender]) {
      sessions[sender] = [];
    }

    // --- LÓGICA DE BÚSQUEDA MEJORADA CON MEMORIA ---
    let hallazgos = await buscarEnApi(msg.body);

    // Si no hay hallazgos con el mensaje actual, intentamos buscar con el historial
    if (!hallazgos && sessions[sender].length > 0) {
      debugLog("MEMORIA", "Buscando contexto en el historial completo (usuario + bot)...");
      const contextoAnterior = sessions[sender]
        .map((m) => m.content)
        .join(" ");
      hallazgos = await buscarEnApi(contextoAnterior);
    }

    const ahora = new Date();
    const fechaHoraActual = ahora.toLocaleString("es-ES", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });

    const contextPayload = `FECHA Y HORA ACTUAL: ${fechaHoraActual}. CONTEXTO DE INVENTARIO (API REAL): [${
      hallazgos || "PRODUCTO NO ENCONTRADO O SIN STOCK"
    }].`;

    // Construir los mensajes incluyendo el historial
    const messages = [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "system", content: contextPayload },
      ...sessions[sender], // Insertar los últimos mensajes recordados
      { role: "user", content: msg.body },
    ];

    debugLog("PROMPT ENVIADO A GROQ (CON MEMORIA)", messages);

    // --- MODIFICACIÓN: INTERCALAR API KEYS PARA LA LLAMADA ---
    const currentGroq = useFirstGroqKey ? groq1 : groq2;
    useFirstGroqKey = !useFirstGroqKey; // Alterna para el próximo mensaje

    const completion = await currentGroq.chat.completions.create({
      messages: messages,
      model: "llama-3.3-70b-versatile",
      temperature: 0.1,
      max_tokens: 300,
    });
    // -----------------------------------------------------------

    let respuesta = completion.choices[0].message.content;

    debugLog(
      "RESPUESTA GENERADA POR IA",
      respuesta || "MENSAJE VACÍO (No se envía)"
    );

    // --- LÓGICA DE PROCESAMIENTO DE CIERRE DE VENTA ---
    if (respuesta.includes('"finalizar": true')) {
      try {
        const datos = JSON.parse(
          respuesta.substring(
            respuesta.indexOf("{"),
            respuesta.lastIndexOf("}") + 1
          )
        );

        // Actualizamos la plantilla para reflejar "método de entrega" y ocultar "dirección de recogida"
        const plantilla = `🛒 "Marelta Ferretería" 🛠️\n👤 Cliente: ${
          datos.cliente || "No especificado"
        }\n📱 Teléfono: ${contact.number}\n📍 Entrega: ${
          datos.metodo_entrega || "No especificada"
        }\n📍 Dirección: ${
          datos.direccion || "N/A"
        }\n📋 Pedido:\n - ${datos.pedido
          .split(", ")
          .join("\n - ")}\n💵 A pagar: ${datos.total || "Por definir"}`;

        // Cambio a api.whatsapp.com en lugar de wa.me para evitar perdida de codificación en el redireccionamiento
        const linkWhatsApp = `https://api.whatsapp.com/send?phone=5355102257&text=${encodeURIComponent(
          plantilla
        )}`;

        // Agregamos iconos también a la respuesta directa del bot
        respuesta = `✅ ¡Perfecto! Para concretar su compra, por favor haga clic en el siguiente enlace y envíenos el mensaje pre-cargado:\n\n👉 ${linkWhatsApp}`;
      } catch (e) {
        debugLog("ERROR JSON", "No se pudo parsear el objeto de cierre.");
      }
    }

    if (respuesta.trim() !== "") {
      // Guardar en la memoria (Usuario + Bot)
      sessions[sender].push({ role: "user", content: msg.body });
      sessions[sender].push({ role: "assistant", content: respuesta });

      // Mantener solo los últimos MAX_HISTORY mensajes (cada interacción son 2 mensajes)
      if (sessions[sender].length > MAX_HISTORY * 2) {
        sessions[sender] = sessions[sender].slice(-MAX_HISTORY * 2);
      }

      if (DEBUG_CONFIG.enabled) {
        debugLog("ESTADO FINAL", "ENVÍO BLOQUEADO: El modo debug está activo.");
        console.log("Respuesta final:", respuesta);
      } else {
        const userName = contact.pushname || contact.number;
        await sendToTelegram(
          `📩 *De ${userName} (${contact.number}):*\n${msg.body}`
        );
        await msg.reply(respuesta);
        await sendToTelegram(`📤 *Respuesta a ${userName}:*\n${respuesta}`);
      }
    }

    if (DEBUG_CONFIG.enabled) {
      console.log(
        "=========================================================\n"
      );
    }
  } catch (error) {
    console.error("Error en proceso de respuesta:", error);
  }

  if (global.gc) {
    global.gc();
  }
});

client.initialize();