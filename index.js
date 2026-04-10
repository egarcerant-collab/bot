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
  "Eres un asistente de voz inteligente y amigable. " +
  "Responde de manera concisa y natural, como si estuvieras hablando con alguien. " +
  "Mantén las respuestas breves para que sean cómodas de escuchar.";

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
            { text: "🔄 Volver a descargar", callback_data: "redownload" }
          ]]
        }
      }
    );
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
    "👋 ¡Hola! Soy tu asistente de voz con IA.\n\n" +
    "🎤 Envíame un *mensaje de voz* y te responderé con voz.\n" +
    "💬 También puedo responder texto.\n\n" +
    "Comandos:\n" +
    "/clear — Limpiar historial\n" +
    "/descargar — Descargar reporte de auditoría ahora\n" +
    "/miid — Ver tu Chat ID",
    { parse_mode: "Markdown" }
  );
});

bot.command("help", (ctx) => {
  ctx.reply(
    "🤖 *Asistente de Voz IA*\n\n" +
    "• Envíame audio → transcribo con Deepgram → respondo con Claude → te mando voz\n\n" +
    "Comandos:\n/start — Bienvenida\n/clear — Borrar historial\n/descargar — Descargar reporte ahora\n/miid — Ver tu Chat ID\n/help — Ayuda",
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

bot.action("redownload", async (ctx) => {
  await ctx.answerCbQuery("Iniciando descarga...");
  await ejecutarDescarga(ctx.chat.id);
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
bot.launch().then(() => {
  console.log("🤖 Bot @concurrencias_dsk_bot iniciado y escuchando...");
  console.log("📅 Descargas programadas: 7:00 AM y 6:00 PM (hora Colombia)");
  if (!ADMIN_CHAT_ID) {
    console.log("⚠️  ADMIN_CHAT_ID no configurado — usa /miid en Telegram para obtener tu ID");
  }
});

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
