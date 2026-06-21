import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { MAX_TTS_CHARS, VOICE_UPLOAD_LIMIT } from './config.ts';
import {
  synthesizeTtsAudio,
  textToSpeechStatusText,
  transcodeAudioToMp3,
  type TtsAudioResult,
} from './speech.ts';
import { register as registerAsset } from './web/assets.ts';
import * as gateway from './web/gateway.ts';

const EFFECTIVE_TTS_CHAR_LIMIT = MAX_TTS_CHARS;

const SendVoiceNoteParams = Type.Object({
  text: Type.String({
    description: 'Text to synthesize and send as a voice note. Keep it concise and conversational.',
  }),
});

export function voiceStatusText(): string {
  return textToSpeechStatusText();
}

export function webVoiceNoteExtension(chatId: string): (pi: ExtensionAPI) => void {
  return (pi: ExtensionAPI) => {
    pi.registerTool({
      name: 'send_voice_note',
      label: 'Send Voice Note',
      description:
        'Send the user a voice note using the configured text-to-speech provider. Use when the user asks for a voice/audio reply, or when a brief spoken response is clearly more appropriate than text. Avoid using for long code, long lists, or dense technical details unless explicitly requested.',
      promptSnippet: 'Send a voice note to the user using the configured TTS provider',
      promptGuidelines: [
        'Use send_voice_note when the user asks for a voice note, audio reply, spoken summary, or says to reply by voice.',
        'You may use it proactively for short personal or time-sensitive messages where voice is clearly helpful.',
        'Keep voice-note text concise and natural. Do not read long code blocks or large tables aloud unless the user explicitly asks.',
        "After sending a voice note, keep the final text response brief, e.g. 'Sent a voice note.'",
      ],
      parameters: SendVoiceNoteParams,

      async execute(_toolCallId, params) {
        const result = await sendVoiceNote(chatId, params.text);
        return {
          content: [
            {
              type: 'text',
              text: `Voice note sent (${prepareTtsText(params.text).length} characters).`,
            },
          ],
          details: result,
        };
      },
    });
  };
}

export async function sendVoiceNote(chatId: string, text: string): Promise<TtsAudioResult> {
  const speechText = prepareTtsText(text);
  if (!speechText) {
    throw new Error('Voice note text is empty after cleanup.');
  }

  const result = await synthesizeTtsAudio(speechText);
  const audio = isMp3Output(result.outputFormat)
    ? result.audio
    : await transcodeAudioToMp3(result.audio);
  if (audio.byteLength > VOICE_UPLOAD_LIMIT) {
    throw new Error(
      `Generated voice note is too large: ${(audio.byteLength / 1024 / 1024).toFixed(1)}MB`,
    );
  }

  const mimeType = 'audio/mpeg';
  const assetId = registerAsset({
    source: Buffer.from(audio),
    mimeType,
    kind: 'voice',
    name: 'pi-reply.mp3',
    origin: 'generated',
  });
  gateway.emit(chatId, {
    type: 'voice',
    payload: { assetId, url: `/api/files/${assetId}`, mimeType },
  });
  return result;
}

function isMp3Output(outputFormat: string): boolean {
  return /\b(?:mp3|mpeg)\b/i.test(outputFormat);
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

  if (cleaned.length > EFFECTIVE_TTS_CHAR_LIMIT) {
    cleaned = `${cleaned.slice(0, EFFECTIVE_TTS_CHAR_LIMIT).trimEnd()}… This response was shortened for the voice note.`;
  }

  return cleaned;
}
