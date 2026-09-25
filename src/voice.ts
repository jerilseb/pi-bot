import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import {
  ALLOWED_CHAT_ID,
  MAX_TTS_CHARS,
  TELEGRAM_MEDIA_TIMEOUT_MS,
  TELEGRAM_VOICE_UPLOAD_LIMIT,
} from './config.ts';
import { synthesizeTtsAudio, textToSpeechStatusText, type TtsAudioResult } from './speech.ts';
import { deliverToChat, heldDeliveryNote } from './background-outbox.ts';
import { telegram } from './channels/telegram/telegram.ts';
import type { SessionKind } from './types.ts';

const SendVoiceNoteParams = Type.Object({
  text: Type.String({
    description:
      'Text to synthesize and send as a Telegram voice note. Keep it concise and conversational.',
  }),
});

export function voiceStatusText(): string {
  return textToSpeechStatusText();
}

/** send_voice_note for one of the bot's sessions; the background session's sends are held. */
export function telegramVoiceNoteExtension(session: SessionKind): (pi: ExtensionAPI) => void {
  return (pi) => registerSendVoiceNote(pi, session);
}

function registerSendVoiceNote(pi: ExtensionAPI, session: SessionKind): void {
  pi.registerTool({
    name: 'send_voice_note',
    label: 'Send Voice Note',
    description:
      'Send the Telegram user a voice note using the configured text-to-speech provider. Use when the user asks for a voice/audio reply, or when a brief spoken response is clearly more appropriate than text. Avoid using for long code, long lists, or dense technical details unless explicitly requested.',
    promptSnippet: 'Send a Telegram voice note to the user using the configured TTS provider',
    promptGuidelines: [
      'Use send_voice_note when the user asks for a voice note, audio reply, spoken summary, or says to reply by voice.',
      'You may use it proactively for short personal or time-sensitive messages where voice is clearly helpful.',
      'Keep voice-note text concise and natural. Do not read long code blocks or large tables aloud unless the user explicitly asks.',
      "After sending a voice note, keep the final text response brief, e.g. 'Sent a voice note.'",
    ],
    parameters: SendVoiceNoteParams,

    async execute(_toolCallId, params) {
      // Synthesized now, so a TTS failure still reaches the agent; only the
      // upload waits when the send is held.
      const result = await synthesizeVoiceNote(params.text);
      const outcome = await deliverToChat(session, 'voice note', () =>
        uploadVoiceNote(result.audio),
      );
      const characters = prepareTtsText(params.text).length;
      return {
        content: [
          {
            type: 'text',
            text:
              outcome === 'held'
                ? heldDeliveryNote(`Voice note (${characters} characters)`)
                : `Voice note sent (${characters} characters).`,
          },
        ],
        details: result,
      };
    },
  });
}

async function synthesizeVoiceNote(text: string): Promise<TtsAudioResult> {
  const speechText = prepareTtsText(text);
  if (!speechText) {
    throw new Error('Voice note text is empty after cleanup.');
  }

  const result = await synthesizeTtsAudio(speechText);
  if (result.audio.byteLength > TELEGRAM_VOICE_UPLOAD_LIMIT) {
    throw new Error(
      `Generated voice note is too large: ${(result.audio.byteLength / 1024 / 1024).toFixed(1)}MB`,
    );
  }
  return result;
}

async function uploadVoiceNote(audio: TtsAudioResult['audio']): Promise<void> {
  const form = new FormData();
  form.append('chat_id', ALLOWED_CHAT_ID);
  form.append('voice', new Blob([audio], { type: 'audio/ogg' }), 'pi-reply.ogg');
  await telegram('sendVoice', { method: 'POST', body: form }, TELEGRAM_MEDIA_TIMEOUT_MS);
}

function prepareTtsText(text: string): string {
  let cleaned = text
    .replace(/```[\s\S]*?```/g, 'Code block omitted from voice note.')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^[-*+]\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (cleaned.length > MAX_TTS_CHARS) {
    cleaned = `${cleaned.slice(0, MAX_TTS_CHARS).trimEnd()}… This response was shortened for the voice note.`;
  }

  return cleaned;
}
