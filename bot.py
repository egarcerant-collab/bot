import asyncio
import io
import os
from collections import defaultdict
from typing import Optional

import anthropic
from aiogram import Bot, Dispatcher, F
from aiogram.filters import Command
from aiogram.fsm.storage.memory import MemoryStorage
from aiogram.types import BufferedInputFile, Message
from deepgram import DeepgramClient, PrerecordedOptions, SpeakOptions

# ── Config ──────────────────────────────────────────────────────────────────
BOT_TOKEN = os.environ["TELEGRAM_BOT_TOKEN"]
DEEPGRAM_API_KEY = os.environ["DEEPGRAM_API_KEY"]
ANTHROPIC_API_KEY = os.environ["ANTHROPIC_API_KEY"]
LANGUAGE = os.getenv("LANGUAGE", "es")          # es = Spanish, en = English
MAX_HISTORY_TURNS = int(os.getenv("MAX_HISTORY", "10"))

SYSTEM_PROMPT = os.getenv(
    "SYSTEM_PROMPT",
    "Eres un asistente de voz inteligente y amigable. "
    "Responde de manera concisa y natural, como si estuvieras hablando con alguien. "
    "Mantén las respuestas breves para que sean cómodas de escuchar.",
)

# ── Clients ──────────────────────────────────────────────────────────────────
bot = Bot(token=BOT_TOKEN)
dp = Dispatcher(storage=MemoryStorage())
dg = DeepgramClient(DEEPGRAM_API_KEY)
claude = anthropic.AsyncAnthropic(api_key=ANTHROPIC_API_KEY)

# ── State (concurrency-safe: asyncio is single-threaded) ─────────────────────
conversation_histories: dict[int, list] = defaultdict(list)
user_locks: dict[int, asyncio.Lock] = defaultdict(asyncio.Lock)


# ── Handlers ─────────────────────────────────────────────────────────────────

@dp.message(Command("start"))
async def cmd_start(message: Message):
    await message.answer(
        "👋 *¡Hola! Soy tu asistente de voz con IA.*\n\n"
        "🎤 Envíame un *mensaje de voz* y te responderé con voz.\n"
        "💬 También puedo responder texto.\n\n"
        "Comandos disponibles:\n"
        "• /clear — Limpiar historial de conversación\n"
        "• /help — Ayuda",
        parse_mode="Markdown",
    )


@dp.message(Command("help"))
async def cmd_help(message: Message):
    await message.answer(
        "🤖 *Asistente de Voz IA*\n\n"
        "Envíame un mensaje de voz o texto y te responderé.\n\n"
        "Comandos:\n"
        "• /start — Mensaje de bienvenida\n"
        "• /clear — Borrar historial\n"
        "• /help — Esta ayuda",
        parse_mode="Markdown",
    )


@dp.message(Command("clear"))
async def cmd_clear(message: Message):
    conversation_histories[message.from_user.id].clear()
    await message.answer("✅ Historial limpiado. ¡Empezamos de nuevo!")


@dp.message(F.voice)
async def handle_voice(message: Message):
    user_id = message.from_user.id

    # Per-user lock: prevents race conditions if user sends multiple msgs fast
    async with user_locks[user_id]:
        await bot.send_chat_action(message.chat.id, "typing")

        try:
            # 1. Download OGG voice from Telegram
            file = await bot.get_file(message.voice.file_id)
            buf = io.BytesIO()
            await bot.download_file(file.file_path, buf)
            audio_bytes = buf.getvalue()

            # 2. Speech-to-text with Deepgram
            transcript = await transcribe_audio(audio_bytes)
            if not transcript:
                await message.reply("❌ No pude entender el audio. Intenta de nuevo.")
                return

            # 3. LLM response with Claude
            response_text = await get_claude_response(user_id, transcript)

            # 4. Text-to-speech with Deepgram Aura
            speech_bytes = await synthesize_speech(response_text)

            if speech_bytes:
                await message.reply_voice(
                    BufferedInputFile(speech_bytes, filename="response.mp3"),
                    caption=f"🗣 _{transcript}_",
                    parse_mode="Markdown",
                )
            else:
                # Fallback: text response
                await message.reply(
                    f"🗣 *Tú:* _{transcript}_\n\n🤖 {response_text}",
                    parse_mode="Markdown",
                )

        except Exception as exc:
            await message.reply(f"❌ Error: {exc}")


@dp.message(F.text & ~F.text.startswith("/"))
async def handle_text(message: Message):
    user_id = message.from_user.id

    async with user_locks[user_id]:
        await bot.send_chat_action(message.chat.id, "typing")
        try:
            response = await get_claude_response(user_id, message.text)
            await message.reply(response)
        except Exception as exc:
            await message.reply(f"❌ Error: {exc}")


# ── Core functions ────────────────────────────────────────────────────────────

async def transcribe_audio(audio_bytes: bytes) -> str:
    """Send audio to Deepgram and return the transcript."""
    options = PrerecordedOptions(
        model="nova-2",
        language=LANGUAGE,
        smart_format=True,
        punctuate=True,
    )
    payload = {"buffer": audio_bytes, "mimetype": "audio/ogg"}

    # Run sync Deepgram call off the event loop to avoid blocking
    response = await asyncio.to_thread(
        dg.listen.rest.v("1").transcribe_file, payload, options
    )
    return response.results.channels[0].alternatives[0].transcript.strip()


async def get_claude_response(user_id: int, user_message: str) -> str:
    """Send message to Claude and maintain per-user conversation history."""
    history = conversation_histories[user_id]
    history.append({"role": "user", "content": user_message})

    # Trim to avoid token overflow (keep last N turns)
    max_msgs = MAX_HISTORY_TURNS * 2
    if len(history) > max_msgs:
        conversation_histories[user_id] = history[-max_msgs:]
        history = conversation_histories[user_id]

    response = await claude.messages.create(
        model="claude-sonnet-4-6",
        max_tokens=512,
        system=SYSTEM_PROMPT,
        messages=history,
    )

    assistant_text = response.content[0].text
    history.append({"role": "assistant", "content": assistant_text})
    return assistant_text


async def synthesize_speech(text: str) -> Optional[bytes]:
    """Convert text to speech using Deepgram Aura TTS."""
    try:
        tts_model = "aura-asteria-en" if LANGUAGE == "en" else "aura-luna-es"
        options = SpeakOptions(model=tts_model, encoding="mp3")

        response = await asyncio.to_thread(
            dg.speak.rest.v("1").stream,
            {"text": text},
            options,
        )
        return response.stream_memory.read()
    except Exception:
        return None


# ── Entry point ───────────────────────────────────────────────────────────────

async def main():
    print("🤖 Bot iniciado...")
    await dp.start_polling(bot, allowed_updates=dp.resolve_used_update_types())


if __name__ == "__main__":
    asyncio.run(main())
