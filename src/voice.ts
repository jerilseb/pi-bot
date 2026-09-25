import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { deleteLocalFile } from './attachments.ts';
import { heldDeliveryNote } from './background-outbox.ts';
import { MAX_TTS_CHARS, TMP_DIR } from './config.ts';
import { synthesizeTtsAudio, textToSpeechStatusText, type TtsAudioResult } from './speech.ts';
import { describeReceipts, toolHost } from './tool-host.ts';
import type { SessionKind } from './types.ts';

/**
 * send_voice_note. Speech is synthesized only when some connected interface
 * plays voice notes; the others show the text. The audio is a temp file that
 * is deleted once the note has gone out.
 */

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
      const speechText = prepareTtsText(params.text);
      if (!speechText) {
        throw new Error('Voice note text is empty after cleanup.');
      }
      const host = toolHost();
      // Synthesized now, so a TTS failure still reaches the agent; only the
      // send waits when it is held.
      const audio = host.anyChannelCan('voice') ? await synthesizeVoiceNote(speechText) : null;
      const result = await host.deliver(
        session,
        'voice note',
        () => ({ kind: 'voice', text: speechText, ...(audio ? { path: audio.path } : {}) }),
        () => {
          if (audio) deleteLocalFile(audio.path);
        },
      );
      const characters = speechText.length;
      return {
        content: [
          {
            type: 'text',
            text:
              result.outcome === 'held'
                ? heldDeliveryNote(`Voice note (${characters} characters)`)
                : `Voice note sent (${characters} characters).${describeReceipts('voice notes', result.receipts)}`,
          },
        ],
        details: audio?.result ?? { synthesized: false },
      };
    },
  });
}

/** Synthesizes `speechText` into a temp file for the channels to send. */
async function synthesizeVoiceNote(
  speechText: string,
): Promise<{ path: string; result: Omit<TtsAudioResult, 'audio'> }> {
  const { audio, ...result } = await synthesizeTtsAudio(speechText);
  fs.mkdirSync(TMP_DIR, { recursive: true });
  const file = path.join(TMP_DIR, `voice-note-${randomBytes(4).toString('hex')}.ogg`);
  fs.writeFileSync(file, Buffer.from(audio));
  return { path: file, result };
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
