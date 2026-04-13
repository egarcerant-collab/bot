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
import {
  obtenerAnaliticaSheet,
  formatearAnalitica,
  buscarPorCedula,
  formatearEvolucion,
} from "./sheets_reader.js";

// ── Config ────────────────────────────────────────────────────────────────────
const BOT_TOKEN       = process.env.TELEGRAM_BOT_TOKEN;
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const LANGUAGE        = process.env.LANGUAGE || "es";
const MAX_HISTORY     = parseInt(process.env.MAX_HISTORY || "10") * 2;
const ADMIN_CHAT_ID   = process.env.ADMIN_CHAT_ID;

if (!BOT_TOKEN || !DEEPGRAM_API_KEY || !ANTHROPIC_API_KEY) {
  console.error("❌ Faltan variables: TELEGRAM_BOT_TOKEN, DEEPGRAM_API_KEY, ANTHROPIC_API_KEY");
  process.exit(1);
}

// ── Clients ───────────────────────────────────────────────────────────────────
const bot      = new Telegraf(BOT_TOKEN);
const deepgram = new DeepgramClient(DEEPGRAM_API_KEY);
const claude   = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// ── State ─────────────────────────────────────────────────────────────────────
const histories  = new Map();  // userId → [{role, content}]
const processing = new Set();  // userId → en proceso

const SYSTEM_PROMPT = process.env.SYSTEM_PROMPT ||
  "Eres un asistente inteligente especializado en auditoría hospitalaria para Dusakawi EPSI. " +
  "Analizas datos de concurrencias hospitalarias: usuarios, tipos de internación, estados de auditoría, IPS/sedes, diagnósticos. " +
  "Cuando te compartan datos o reportes, interprétalos con claridad y da insights útiles. " +
  "Si el usuario habla por voz, responde de forma breve y natural. " +
  "Si escribe texto, puedes ser más detallado. Siempre en español.";

// ── Helpers de audio/LLM ──────────────────────────────────────────────────────

async function downloadBuffer(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks)));
      res.on("error", reject);
    }).on("error", reject);
  });
}

async function transcribeAudio(buf) {
  const { result, error } = await deepgram.listen.prerecorded.transcribeFile(buf, {
    model: "nova-2", language: LANGUAGE, smart_format: true, punctuate: true, mimetype: "audio/ogg",
  });
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
    max_tokens: 600,
    system: SYSTEM_PROMPT,
    messages: history,
  });

  const text = response.content[0].text;
  history.push({ role: "assistant", content: text });
  return text;
}

async function synthesizeSpeech(text) {
  try {
    const model = LANGUAGE === "en" ? "aura-asteria-en" : "aura-luna-es";
    const res = await deepgram.speak.request({ text }, { model, encoding: "mp3" });
    const stream = await res.getStream();
    if (!stream) return null;
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    return Buffer.concat(chunks);
  } catch { return null; }
}

// ── Enviar mensaje largo (respeta límite 4096 chars de Telegram) ──────────────
async function enviarMensajeLargo(chatId, texto) {
  if (texto.length <= 4096) {
    await bot.telegram.sendMessage(chatId, texto, { parse_mode: "Markdown" });
    return;
  }
  const partes = [];
  let bloque = "";
  for (const linea of texto.split("\n")) {
    if ((bloque + linea + "\n").length > 4000) { partes.push(bloque); bloque = ""; }
    bloque += linea + "\n";
  }
  if (bloque) partes.push(bloque);
  for (const p of partes)
    await bot.telegram.sendMessage(chatId, p, { parse_mode: "Markdown" });
}

// ── Descarga + analítica automática ──────────────────────────────────────────

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
            { text: "📊 Ver analítica", callback_data: "ver_analitica" },
            { text: "🔄 Volver a descargar", callback_data: "redownload" },
          ]]
        }
      }
    );
    // Generar analítica automáticamente
    await ejecutarAnalitica(chatId);
  } catch (err) {
    console.error("Error en descarga:", err.message);
    await bot.telegram.sendMessage(chatId,
      `❌ Error al descargar el reporte:\n\`${err.message}\``,
      {
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: [[{ text: "🔄 Reintentar", callback_data: "redownload" }]] }
      }
    );
  } finally {
    descargaEnCurso = false;
  }
}

async function ejecutarAnalitica(chatId) {
  try {
    await bot.telegram.sendMessage(chatId, "🔍 Leyendo Google Sheet y generando analítica...");
    const analitica = await obtenerAnaliticaSheet();
    const reporte   = formatearAnalitica(analitica, "Google Sheet (Apps Script)");
    await enviarMensajeLargo(chatId, reporte);
  } catch (err) {
    console.error("Error analítica:", err.message);
    await bot.telegram.sendMessage(chatId,
      `❌ Error al generar analítica:\n\`${err.message}\``,
      { parse_mode: "Markdown" }
    );
  }
}

// ── Comandos ──────────────────────────────────────────────────────────────────

bot.command("start", ctx => ctx.reply(
  "👋 *Asistente de Auditoría Hospitalaria — Dusakawi EPSI*\n\n" +
  "🎤 Envíame un *mensaje de voz* y te respondo con voz.\n" +
  "💬 También respondo texto y analizo datos.\n\n" +
  "*Comandos:*\n" +
  "/analitica — Analítica del último reporte (Google Sheet)\n" +
  "/cedula — Buscar evolución de un paciente por cédula\n" +
  "/descargar — Descargar reporte ahora desde el sistema\n" +
  "/clear — Limpiar historial\n" +
  "/miid — Ver tu Chat ID\n" +
  "/help — Ayuda",
  { parse_mode: "Markdown" }
));

bot.command("help", ctx => ctx.reply(
  "🤖 *Asistente Auditoría Hospitalaria Dusakawi*\n\n" +
  "• `/analitica` — Lee el Google Sheet actualizado y muestra:\n" +
  "  – Totales y usuarios únicos\n" +
  "  – Auditorías abiertas / cerradas\n" +
  "  – Tipos de internación con %\n" +
  "  – IPS/sedes con más usuarios\n" +
  "  – Top diagnósticos\n\n" +
  "• `/cedula 1067815531` — Evolución completa de un paciente\n\n" +
  "• `/descargar` — Descarga fresca desde el sistema hospitalario\n\n" +
  "• 🎤 Voz — Habla y te respondo con voz",
  { parse_mode: "Markdown" }
));

bot.command("clear", ctx => {
  histories.delete(ctx.from.id);
  ctx.reply("✅ Historial limpiado.");
});

bot.command("miid", ctx =>
  ctx.reply(`Tu Chat ID es: \`${ctx.chat.id}\``, { parse_mode: "Markdown" })
);

bot.command("descargar", async ctx => {
  await ejecutarDescarga(ctx.chat.id);
});

bot.command("analitica", async ctx => {
  await ejecutarAnalitica(ctx.chat.id);
});

// /cedula 1067815531  O  /cedula con el número como argumento
bot.command("cedula", async ctx => {
  const args = ctx.message.text.split(/\s+/).slice(1);
  const cedula = args[0]?.trim();

  if (!cedula || !/^\d{5,12}$/.test(cedula)) {
    return ctx.reply(
      "📋 *Búsqueda por cédula*\n\n" +
      "Uso: `/cedula 1067815531`\n" +
      "Envía el número de identificación del paciente.",
      { parse_mode: "Markdown" }
    );
  }

  await ctx.reply(`🔍 Buscando cédula *${cedula}* en el reporte...`, { parse_mode: "Markdown" });
  try {
    const resultado = await buscarPorCedula(cedula);
    const reporte   = formatearEvolucion(cedula, resultado);
    await enviarMensajeLargo(ctx.chat.id, reporte);
  } catch (err) {
    console.error("Error búsqueda cédula:", err.message);
    await ctx.reply(`❌ Error al buscar:\n\`${err.message}\``, { parse_mode: "Markdown" });
  }
});

// Botones inline
bot.action("redownload", async ctx => {
  await ctx.answerCbQuery("Iniciando descarga...");
  await ejecutarDescarga(ctx.chat.id);
});

bot.action("ver_analitica", async ctx => {
  await ctx.answerCbQuery("Generando analítica...");
  await ejecutarAnalitica(ctx.chat.id);
});

// ── Mensajes de voz ───────────────────────────────────────────────────────────

bot.on("voice", async ctx => {
  const userId = ctx.from.id;
  if (processing.has(userId)) return ctx.reply("⏳ Aún procesando tu mensaje anterior...");
  processing.add(userId);

  try {
    await ctx.sendChatAction("typing");
    const fileLink   = await ctx.telegram.getFileLink(ctx.message.voice.file_id);
    const audioBuf   = await downloadBuffer(fileLink.href);
    const transcript = await transcribeAudio(audioBuf);
    if (!transcript) return ctx.reply("❌ No pude entender el audio. Intenta de nuevo.");

    const responseText = await getClaudeResponse(userId, transcript);
    const speechBuf    = await synthesizeSpeech(responseText);

    if (speechBuf) {
      await ctx.replyWithVoice(
        { source: Readable.from(speechBuf), filename: "response.mp3" },
        { caption: `🗣 _${transcript}_`, parse_mode: "Markdown" }
      );
    } else {
      await ctx.reply(`🗣 *Tú:* _${transcript}_\n\n🤖 ${responseText}`, { parse_mode: "Markdown" });
    }
  } catch (err) {
    console.error("Error voz:", err);
    await ctx.reply(`❌ Error: ${err.message}`);
  } finally {
    processing.delete(userId);
  }
});

// ── Mensajes de texto ─────────────────────────────────────────────────────────

bot.on("text", async ctx => {
  if (ctx.message.text.startsWith("/")) return;
  const userId = ctx.from.id;
  if (processing.has(userId)) return ctx.reply("⏳ Aún procesando tu mensaje anterior...");
  processing.add(userId);

  try {
    await ctx.sendChatAction("typing");

    // Detectar si el usuario escribió solo una cédula (5-12 dígitos)
    const texto = ctx.message.text.trim();
    if (/^\d{5,12}$/.test(texto)) {
      await ctx.reply(`🔍 Buscando cédula *${texto}*...`, { parse_mode: "Markdown" });
      const resultado = await buscarPorCedula(texto);
      const reporte   = formatearEvolucion(texto, resultado);
      await enviarMensajeLargo(ctx.chat.id, reporte);
      return;
    }

    const response = await getClaudeResponse(userId, ctx.message.text);
    await ctx.reply(response);
  } catch (err) {
    console.error("Error texto:", err);
    await ctx.reply(`❌ Error: ${err.message}`);
  } finally {
    processing.delete(userId);
  }
});

// ── Cron: 7 AM y 6 PM hora Colombia ──────────────────────────────────────────

cron.schedule("0 7 * * *", () => {
  console.log("⏰ 7 AM — descarga automática...");
  if (ADMIN_CHAT_ID) ejecutarDescarga(ADMIN_CHAT_ID);
}, { timezone: "America/Bogota" });

cron.schedule("0 18 * * *", () => {
  console.log("⏰ 6 PM — descarga automática...");
  if (ADMIN_CHAT_ID) ejecutarDescarga(ADMIN_CHAT_ID);
}, { timezone: "America/Bogota" });

// ── Launch ────────────────────────────────────────────────────────────────────

// Forzar desconexión de instancia anterior y arrancar
bot.telegram.deleteWebhook({ drop_pending_updates: true })
  .catch(() => {})
  .finally(() => {
    setTimeout(() => {
      bot.launch({ dropPendingUpdates: true })
        .then(async () => {
          console.log("🤖 Bot @concurrencias_dsk_bot ACTIVO — version nueva");
          try {
            await bot.telegram.setMyCommands([
              { command: "analitica", description: "Analitica del ultimo reporte" },
              { command: "cedula",    description: "Buscar paciente por cedula" },
              { command: "descargar", description: "Descargar reporte ahora" },
              { command: "start",     description: "Iniciar el asistente" },
              { command: "clear",     description: "Limpiar historial" },
              { command: "miid",      description: "Ver tu Chat ID" },
              { command: "help",      description: "Ayuda" },
            ]);
            console.log("✅ Comandos registrados");
          } catch (e) { console.error("setMyCommands:", e.message); }

          if (ADMIN_CHAT_ID) {
            bot.telegram.sendMessage(ADMIN_CHAT_ID,
              "✅ *Bot actualizado y activo*\n\n/analitica — Analitica Google Sheet\n/cedula — Buscar paciente\n/descargar — Descargar reporte",
              { parse_mode: "Markdown" }
            ).catch(() => {});
          }
        })
        .catch(err => {
          console.error("❌ Launch error:", err.message);
          process.exit(1);
        });
    }, 5000); // 5s de espera para que muera la instancia vieja
  });

process.once("SIGINT",  () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
