import { config } from "dotenv";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
config({ path: join(dirname(fileURLToPath(import.meta.url)), ".env"), override: true });
import { Telegraf } from "telegraf";
import { DeepgramClient } from "@deepgram/sdk";
import Anthropic from "@anthropic-ai/sdk";
import https from "https";
import { Readable } from "stream";
import cron from "node-cron";
import { descargarAuditoria } from "./descarga_auditoria.js";
import { obtenerAnalitica, formatearReporte } from "./analytics_auditoria.js";

// ── Config ────────────────────────────────────────────────────────────────────
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const LANGUAGE = process.env.LANGUAGE || "es";
const MAX_HISTORY = parseInt(process.env.MAX_HISTORY || "10") * 2;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID; // Chat ID de Eduardo para notificaciones

if (!BOT_TOKEN || !DEEPGRAM_API_KEY || !ANTHROPIC_API_KEY) {
  console.error("❌ Faltan variables de entorno. Revisa TELEGRAM_BOT_TOKEN, DEEPGRAM_API_KEY, ANTHROPIC_API_KEY");
  process.exit(1);
}

// ── Clients ───────────────────────────────────────────────────────────────────
const bot = new Telegraf(BOT_TOKEN);
const deepgram = new DeepgramClient(DEEPGRAM_API_KEY);
const claude = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// ── State: per-user conversation history ─────────────────────────────────────
const histories = new Map();   // userId -> [{role, content}]
const processing = new Set();  // userId -> true if currently processing (concurrency guard)

const SYSTEM_PROMPT = process.env.SYSTEM_PROMPT ||
  "Eres un asistente inteligente especializado en analítica de auditoría hospitalaria para Dusakawi EPSI. " +
  "Tienes acceso a reportes de auditoría hospitalaria que incluyen datos de usuarios, tipos de internación, " +
  "estados de auditoría (abierta/cerrada), IPs/sedes, diagnósticos y fechas. " +
  "Cuando el usuario te pregunte sobre datos, estadísticas o analítica, interpreta los reportes que se te comparten " +
  "y responde con análisis claros, concisos y útiles. " +
  "Si el usuario habla por voz, responde de forma natural y conversacional. " +
  "Si responde por texto, puedes ser más detallado. " +
  "Siempre responde en español.";

// ── Helpers ───────────────────────────────────────────────────────────────────

async function downloadBuffer(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve(Buffer.concat(chunks)));
      res.on("error", reject);
    }).on("error", reject);
  });
}

async function transcribeAudio(audioBuffer) {
  const { result, error } = await deepgram.listen.prerecorded.transcribeFile(
    audioBuffer,
    {
      model: "nova-2",
      language: LANGUAGE,
      smart_format: true,
      punctuate: true,
      mimetype: "audio/ogg",
    }
  );
  if (error) throw error;
  return result.results.channels[0].alternatives[0].transcript.trim();
}

async function getClaudeResponse(userId, userMessage) {
  if (!histories.has(userId)) histories.set(userId, []);
  const history = histories.get(userId);

  history.push({ role: "user", content: userMessage });
  if (history.length > MAX_HISTORY) history.splice(0, history.length - MAX_HISTORY);

  const response = await claude.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 512,
    system: SYSTEM_PROMPT,
    messages: history,
  });

  const assistantText = response.content[0].text;
  history.push({ role: "assistant", content: assistantText });
  return assistantText;
}

async function synthesizeSpeech(text) {
  try {
    const ttsModel = LANGUAGE === "en" ? "aura-asteria-en" : "aura-luna-es";
    const response = await deepgram.speak.request(
      { text },
      { model: ttsModel, encoding: "mp3" }
    );
    const stream = await response.getStream();
    if (!stream) return null;

    const chunks = [];
    for await (const chunk of stream) {
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  } catch {
    return null;
  }
}

// ── Handlers ──────────────────────────────────────────────────────────────────

// ── Analítica ─────────────────────────────────────────────────────────────────

async function ejecutarAnalitica(chatId) {
  try {
    await bot.telegram.sendMessage(chatId,
      "🔍 Analizando último reporte de auditoría...",
      { parse_mode: "Markdown" }
    );
    const { analytics, archivoNombre } = await obtenerAnalitica();
    const reporte = formatearReporte(analytics, archivoNombre);

    // Telegram tiene límite de 4096 chars por mensaje
    if (reporte.length <= 4096) {
      await bot.telegram.sendMessage(chatId, reporte, { parse_mode: "Markdown" });
    } else {
      // Partir en bloques respetando límite
      const partes = [];
      let bloque = "";
      for (const linea of reporte.split("\n")) {
        if ((bloque + linea + "\n").length > 4000) {
          partes.push(bloque);
          bloque = "";
        }
        bloque += linea + "\n";
      }
      if (bloque) partes.push(bloque);
      for (const parte of partes) {
        await bot.telegram.sendMessage(chatId, parte, { parse_mode: "Markdown" });
      }
    }
  } catch (err) {
    console.error("Error en analítica:", err.message);
    await bot.telegram.sendMessage(chatId,
      `❌ Error al generar analítica:\n\`${err.message}\``,
      { parse_mode: "Markdown" }
    );
  }
}

// ── Descarga de Auditoría ─────────────────────────────────────────────────────

let descargaEnCurso = false;

async function ejecutarDescarga(chatId) {
  if (descargaEnCurso) {
    await bot.telegram.sendMessage(chatId, "⏳ Ya hay una descarga en curso, espera un momento...");
    return;
  }
  descargaEnCurso = true;
  try {
    await bot.telegram.sendMessage(chatId,
      "⏳ Iniciando descarga del reporte *Auditoría Hospitalaria*...",
      { parse_mode: "Markdown" }
    );
    const result = await descargarAuditoria({ headless: true });
    await bot.telegram.sendMessage(chatId,
      `✅ *Reporte guardado en Supabase*\n\n` +
      `📁 \`${result.fileName}\`\n` +
      `📊 Tamaño: ${result.sizeKB} KB\n` +
      `📅 Período: ${result.fechaInicio} → ${result.fechaFin}`,
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [[
            { text: "🔄 Volver a descargar", callback_data: "redownload" },
            { text: "📊 Ver analítica", callback_data: "ver_analitica" },
          ]]
        }
      }
    );

    // Generar analítica automáticamente después de la descarga
    await ejecutarAnalitica(chatId);
  } catch (err) {
    console.error("Error en descarga:", err.message);
    await bot.telegram.sendMessage(chatId,
      `❌ Error al descargar el reporte:\n\`${err.message}\``,
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [[
            { text: "🔄 Reintentar", callback_data: "redownload" }
          ]]
        }
      }
    );
  } finally {
    descargaEnCurso = false;
  }
}

// ── Handlers ──────────────────────────────────────────────────────────────────

bot.command("start", (ctx) => {
  ctx.reply(
    "👋 ¡Hola! Soy el asistente de *Auditoría Hospitalaria Dusakawi*.\n\n" +
    "🎤 Envíame un *mensaje de voz* y te responderé con voz.\n" +
    "💬 También puedo responder texto y analizar datos.\n\n" +
    "Comandos:\n" +
    "/analitica — Ver analítica completa del último reporte\n" +
    "/descargar — Descargar reporte de auditoría ahora\n" +
    "/clear — Limpiar historial\n" +
    "/miid — Ver tu Chat ID",
    { parse_mode: "Markdown" }
  );
});

bot.command("help", (ctx) => {
  ctx.reply(
    "🤖 *Asistente Auditoría Hospitalaria Dusakawi*\n\n" +
    "• Envíame audio → transcribo con Deepgram → respondo con Claude → te mando voz\n" +
    "• Pregúntame sobre los datos del último reporte de auditoría\n\n" +
    "Comandos:\n" +
    "/analitica — Analítica completa del último reporte\n" +
    "/descargar — Descargar reporte ahora y generar analítica\n" +
    "/start — Bienvenida\n" +
    "/clear — Borrar historial\n" +
    "/miid — Ver tu Chat ID\n" +
    "/help — Ayuda",
    { parse_mode: "Markdown" }
  );
});

bot.command("clear", (ctx) => {
  histories.delete(ctx.from.id);
  ctx.reply("✅ Historial limpiado.");
});

bot.command("miid", (ctx) => {
  ctx.reply(`Tu Chat ID es: \`${ctx.chat.id}\`\nGuárdalo como variable ADMIN_CHAT_ID`, { parse_mode: "Markdown" });
});

bot.command("descargar", async (ctx) => {
  await ejecutarDescarga(ctx.chat.id);
});

bot.command("analitica", async (ctx) => {
  await ejecutarAnalitica(ctx.chat.id);
});

bot.action("redownload", async (ctx) => {
  await ctx.answerCbQuery("Iniciando descarga...");
  await ejecutarDescarga(ctx.chat.id);
});

bot.action("ver_analitica", async (ctx) => {
  await ctx.answerCbQuery("Generando analítica...");
  await ejecutarAnalitica(ctx.chat.id);
});

bot.on("voice", async (ctx) => {
  const userId = ctx.from.id;

  // Concurrency guard: skip if already processing for this user
  if (processing.has(userId)) {
    return ctx.reply("⏳ Aún procesando tu mensaje anterior...");
  }
  processing.add(userId);

  try {
    await ctx.sendChatAction("typing");

    // 1. Download voice from Telegram
    const fileLink = await ctx.telegram.getFileLink(ctx.message.voice.file_id);
    const audioBuffer = await downloadBuffer(fileLink.href);

    // 2. Speech-to-text with Deepgram
    const transcript = await transcribeAudio(audioBuffer);
    if (!transcript) {
      return ctx.reply("❌ No pude entender el audio. Intenta de nuevo.");
    }

    // 3. LLM response with Claude
    const responseText = await getClaudeResponse(userId, transcript);

    // 4. Text-to-speech with Deepgram Aura
    const speechBuffer = await synthesizeSpeech(responseText);

    if (speechBuffer) {
      await ctx.replyWithVoice(
        { source: Readable.from(speechBuffer), filename: "response.mp3" },
        { caption: `🗣 _${transcript}_`, parse_mode: "Markdown" }
      );
    } else {
      await ctx.reply(
        `🗣 *Tú:* _${transcript}_\n\n🤖 ${responseText}`,
        { parse_mode: "Markdown" }
      );
    }
  } catch (err) {
    console.error("Error en voice handler:", err);
    await ctx.reply(`❌ Error: ${err.message}`);
  } finally {
    processing.delete(userId);
  }
});

bot.on("text", async (ctx) => {
  if (ctx.message.text.startsWith("/")) return;

  const userId = ctx.from.id;
  if (processing.has(userId)) {
    return ctx.reply("⏳ Aún procesando tu mensaje anterior...");
  }
  processing.add(userId);

  try {
    await ctx.sendChatAction("typing");
    const response = await getClaudeResponse(userId, ctx.message.text);
    await ctx.reply(response);
  } catch (err) {
    console.error("Error en text handler:", err);
    await ctx.reply(`❌ Error: ${err.message}`);
  } finally {
    processing.delete(userId);
  }
});

// ── Schedules automáticos (hora Colombia UTC-5) ───────────────────────────────
// 7:00 AM y 6:00 PM todos los días
cron.schedule("0 7 * * *", () => {
  console.log("⏰ Schedule 7 AM — ejecutando descarga...");
  if (ADMIN_CHAT_ID) ejecutarDescarga(ADMIN_CHAT_ID);
}, { timezone: "America/Bogota" });

cron.schedule("0 18 * * *", () => {
  console.log("⏰ Schedule 6 PM — ejecutando descarga...");
  if (ADMIN_CHAT_ID) ejecutarDescarga(ADMIN_CHAT_ID);
}, { timezone: "America/Bogota" });

// ── Launch ────────────────────────────────────────────────────────────────────
bot.launch().then(async () => {
  console.log("🤖 Bot @concurrencias_dsk_bot iniciado y escuchando...");
  console.log("📅 Descargas programadas: 7:00 AM y 6:00 PM (hora Colombia)");
  if (!ADMIN_CHAT_ID) {
    console.log("⚠️  ADMIN_CHAT_ID no configurado — usa /miid en Telegram para obtener tu ID");
  }

  // Registrar comandos en el menú de Telegram
  try {
    await bot.telegram.setMyCommands([
      { command: "analitica",  description: "Ver analítica completa del último reporte" },
      { command: "descargar",  description: "Descargar reporte de auditoría ahora" },
      { command: "start",      description: "Iniciar el asistente" },
      { command: "clear",      description: "Limpiar historial de conversación" },
      { command: "miid",       description: "Ver tu Chat ID" },
      { command: "help",       description: "Mostrar ayuda" },
    ]);
    console.log("✅ Comandos registrados en Telegram");
  } catch (e) {
    console.error("⚠️  No se pudieron registrar comandos:", e.message);
  }
});

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
