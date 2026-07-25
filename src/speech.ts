import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  ELEVENLABS_API_KEY,
  ELEVENLABS_LANGUAGE,
  ELEVENLABS_MODEL,
  ELEVENLABS_TTS_MODEL,
  ELEVENLABS_TTS_OUTPUT_FORMAT,
  ELEVENLABS_TTS_VOICE_ID,
  GOOGLE_GENAI_API_KEY,
  GOOGLE_GENAI_STT_MODEL,
  GOOGLE_GENAI_STT_PROMPT,
  GOOGLE_GENAI_TTS_MODEL_NAME,
  GOOGLE_GENAI_TTS_VOICE,
  SPEECH_TO_TEXT_PROVIDER,
  TEXT_TO_SPEECH_PROVIDER,
  TRANSCRIPTION_FETCH_ATTEMPTS,
  TRANSCRIPTION_FETCH_TIMEOUT_MS,
  TRANSCRIPTION_MAX_FILE_SIZE,
  TRANSCRIPTION_RETRY_BASE_DELAY_MS,
  type SpeechProvider,
} from './config.ts';
import type { TranscriptionResult } from './types.ts';
import { errorMessage } from './util.ts';

const GEMINI_GENERATE_CONTENT_API = 'https://generativelanguage.googleapis.com/v1beta/models';
const GOOGLE_TTS_SAMPLE_RATE = 24_000;
const GOOGLE_TTS_CHANNELS = 1;

interface SpeechAttempt<T> {
  ok: boolean;
  value?: T;
  error: string;
  retryable: boolean;
}

export interface TtsAudioResult {
  audio: ArrayBuffer;
  provider: SpeechProvider;
  model: string;
  outputFormat: string;
}

export async function transcribeAudio(
  filePath: string,
  mimeType?: string,
  filename = path.basename(filePath),
): Promise<TranscriptionResult> {
  const fileCheck = checkAudioFile(filePath);
  if (fileCheck) return fileCheck;

  const errors: string[] = [];
  for (const provider of providerOrder(SPEECH_TO_TEXT_PROVIDER)) {
    if (!speechToTextProviderConfigured(provider)) continue;
    const result =
      provider === 'google-genai'
        ? await transcribeWithGoogleGenAI(filePath, mimeType, filename)
        : await transcribeWithElevenLabs(filePath);
    if (result.ok) return result;
    if (result.error) errors.push(`${provider}: ${result.error}`);
  }

  if (errors.length) return { ok: false, error: errors.join('; ') };
  return {
    ok: false,
    error: 'Set GOOGLE_GENAI_API_KEY or ELEVENLABS_API_KEY to enable transcription.',
  };
}

export function textToSpeechStatusText(): string {
  const configured = providerOrder(TEXT_TO_SPEECH_PROVIDER).filter((provider) =>
    textToSpeechProviderConfigured(provider),
  );
  if (configured.length) {
    return `registered and configured (${configured.map(providerLabel).join(', ')})`;
  }
  return 'registered, but missing GOOGLE_GENAI_API_KEY or ElevenLabs TTS settings';
}

export async function synthesizeTtsAudio(text: string): Promise<TtsAudioResult> {
  const errors: string[] = [];
  for (const provider of providerOrder(TEXT_TO_SPEECH_PROVIDER)) {
    if (!textToSpeechProviderConfigured(provider)) continue;
    try {
      return provider === 'google-genai'
        ? await synthesizeWithGoogleGenAI(text)
        : await synthesizeWithElevenLabs(text);
    } catch (error) {
      errors.push(`${provider}: ${errorMessage(error)}`);
    }
  }

  if (errors.length) throw new Error(errors.join('; '));
  throw new Error('Set GOOGLE_GENAI_API_KEY or ElevenLabs TTS settings to enable voice notes.');
}

function checkAudioFile(filePath: string): TranscriptionResult | null {
  if (!fs.existsSync(filePath)) {
    return { ok: false, error: `File not found: ${filePath}` };
  }
  const stat = fs.statSync(filePath);
  if (stat.size === 0) return { ok: false, error: 'File is empty' };
  if (stat.size > TRANSCRIPTION_MAX_FILE_SIZE) {
    return {
      ok: false,
      error: `File too large: ${(stat.size / 1024 / 1024).toFixed(1)}MB (max 25MB)`,
    };
  }
  return null;
}

function providerOrder(preferred: SpeechProvider): SpeechProvider[] {
  return [preferred, 'google-genai', 'elevenlabs'].filter(
    (provider, index, providers): provider is SpeechProvider =>
      providers.indexOf(provider) === index,
  );
}

function speechToTextProviderConfigured(provider: SpeechProvider): boolean {
  return provider === 'google-genai'
    ? Boolean(GOOGLE_GENAI_API_KEY && GOOGLE_GENAI_STT_MODEL)
    : Boolean(ELEVENLABS_API_KEY);
}

function textToSpeechProviderConfigured(provider: SpeechProvider): boolean {
  return provider === 'google-genai'
    ? Boolean(GOOGLE_GENAI_API_KEY && GOOGLE_GENAI_TTS_MODEL_NAME && GOOGLE_GENAI_TTS_VOICE)
    : Boolean(ELEVENLABS_API_KEY && ELEVENLABS_TTS_VOICE_ID);
}

function providerLabel(provider: SpeechProvider): string {
  return provider === 'google-genai' ? 'Google GenAI' : 'ElevenLabs';
}

async function transcribeWithGoogleGenAI(
  filePath: string,
  mimeType: string | undefined,
  filename: string,
): Promise<TranscriptionResult> {
  const fileBuffer = fs.readFileSync(filePath);
  const requestBody = {
    contents: [
      {
        parts: [
          { text: GOOGLE_GENAI_STT_PROMPT },
          {
            inlineData: {
              mimeType: mimeType ?? guessAudioMimeType(filename),
              data: fileBuffer.toString('base64'),
            },
          },
        ],
      },
    ],
    generationConfig: { temperature: 0 },
  };

  const result = await retrySpeechRequest(() =>
    requestGoogleGenerateContent(GOOGLE_GENAI_STT_MODEL, requestBody),
  );
  if (!result.ok) return { ok: false, error: result.error };

  const text = extractGeminiText(result.value).trim();
  if (!text) {
    return { ok: false, error: 'Google GenAI returned empty transcription' };
  }
  return { ok: true, text };
}

async function transcribeWithElevenLabs(filePath: string): Promise<TranscriptionResult> {
  const apiKey = ELEVENLABS_API_KEY;
  if (!apiKey) {
    return {
      ok: false,
      error: 'Set ELEVENLABS_API_KEY to enable ElevenLabs transcription.',
    };
  }

  const fileBuffer = fs.readFileSync(filePath);
  const result = await retrySpeechRequest(() =>
    requestElevenLabsTranscription(fileBuffer, path.basename(filePath), apiKey),
  );
  if (!result.ok) return { ok: false, error: result.error };
  return { ok: true, text: result.value };
}

async function synthesizeWithGoogleGenAI(text: string): Promise<TtsAudioResult> {
  const requestBody = {
    contents: [
      {
        parts: [
          {
            text: `Say in a clear, natural voice: ${text}`,
          },
        ],
      },
    ],
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: {
            voiceName: GOOGLE_GENAI_TTS_VOICE,
          },
        },
      },
    },
  };

  const result = await retrySpeechRequest(() =>
    requestGoogleGenerateContent(GOOGLE_GENAI_TTS_MODEL_NAME, requestBody),
  );
  if (!result.ok) throw new Error(result.error);

  const inlineAudio = extractGeminiInlineAudio(result.value);
  if (!inlineAudio?.data) {
    throw new Error('Google GenAI returned no audio data');
  }

  const audioBuffer = Buffer.from(inlineAudio.data, 'base64');
  const oggBuffer = await convertToOggOpus(
    audioBuffer,
    inlineAudio.mimeType ?? 'audio/L16;codec=pcm;rate=24000',
  );
  return {
    audio: bufferToArrayBuffer(oggBuffer),
    provider: 'google-genai',
    model: GOOGLE_GENAI_TTS_MODEL_NAME,
    outputFormat: 'audio/ogg;codec=opus',
  };
}

async function synthesizeWithElevenLabs(text: string): Promise<TtsAudioResult> {
  const query = new URLSearchParams({
    output_format: ELEVENLABS_TTS_OUTPUT_FORMAT,
  });
  const result = await retrySpeechRequest(async () => {
    const response = await fetchWithTimeout(
      `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(ELEVENLABS_TTS_VOICE_ID)}?${query}`,
      {
        method: 'POST',
        headers: {
          'xi-api-key': ELEVENLABS_API_KEY ?? '',
          'Content-Type': 'application/json',
          Accept: 'audio/ogg',
        },
        body: JSON.stringify({
          text,
          model_id: ELEVENLABS_TTS_MODEL,
        }),
      },
    );

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      return {
        ok: false,
        error: `ElevenLabs TTS API error (${response.status}): ${body.slice(0, 300) || response.statusText}`,
        retryable: isRetryableSpeechStatus(response.status),
      };
    }

    return {
      ok: true,
      value: await response.arrayBuffer(),
      error: '',
      retryable: false,
    };
  });

  if (!result.ok) throw new Error(result.error);
  return {
    audio: result.value,
    provider: 'elevenlabs',
    model: ELEVENLABS_TTS_MODEL,
    outputFormat: ELEVENLABS_TTS_OUTPUT_FORMAT,
  };
}

async function requestGoogleGenerateContent(
  model: string,
  body: unknown,
): Promise<SpeechAttempt<unknown>> {
  try {
    const response = await fetchWithTimeout(
      `${GEMINI_GENERATE_CONTENT_API}/${encodeURIComponent(model)}:generateContent`,
      {
        method: 'POST',
        headers: {
          'x-goog-api-key': GOOGLE_GENAI_API_KEY,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      },
    );

    if (!response.ok) {
      const errorBody = await response.text().catch(() => '');
      return {
        ok: false,
        error: `Google GenAI API error (${response.status}): ${errorBody.slice(0, 300) || response.statusText}`,
        retryable: isRetryableSpeechStatus(response.status),
      };
    }

    return {
      ok: true,
      value: await response.json(),
      error: '',
      retryable: false,
    };
  } catch (error) {
    return {
      ok: false,
      error: errorMessage(error),
      retryable: true,
    };
  }
}

async function requestElevenLabsTranscription(
  fileBuffer: Buffer,
  filename: string,
  apiKey: string,
): Promise<SpeechAttempt<string>> {
  try {
    const form = new FormData();
    form.append('file', new Blob([bufferToArrayBuffer(fileBuffer)]), filename);
    form.append('model_id', ELEVENLABS_MODEL);
    if (ELEVENLABS_LANGUAGE) form.append('language_code', ELEVENLABS_LANGUAGE);

    const response = await fetchWithTimeout('https://api.elevenlabs.io/v1/speech-to-text', {
      method: 'POST',
      headers: { 'xi-api-key': apiKey },
      body: form,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      return {
        ok: false,
        error: `ElevenLabs API error (${response.status}): ${body.slice(0, 200)}`,
        retryable: isRetryableSpeechStatus(response.status),
      };
    }

    const data = (await response.json()) as { text?: string };
    if (!data.text) {
      return {
        ok: false,
        error: 'ElevenLabs returned empty transcription',
        retryable: false,
      };
    }
    return { ok: true, value: data.text, error: '', retryable: false };
  } catch (error) {
    return {
      ok: false,
      error: errorMessage(error),
      retryable: true,
    };
  }
}

async function retrySpeechRequest<T>(
  request: () => Promise<SpeechAttempt<T>>,
): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  let lastError = '';
  let attempt = 1;
  for (; attempt <= TRANSCRIPTION_FETCH_ATTEMPTS; attempt++) {
    const result = await request();
    if (result.ok) return { ok: true, value: result.value as T };

    lastError = result.error;
    if (!result.retryable || attempt >= TRANSCRIPTION_FETCH_ATTEMPTS) break;
    await delay(transcriptionRetryDelayMs(attempt));
  }

  return {
    ok: false,
    error: attempt > 1 && lastError ? `${lastError} after ${attempt} attempts` : lastError,
  };
}

async function fetchWithTimeout(input: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TRANSCRIPTION_FETCH_TIMEOUT_MS);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function isRetryableSpeechStatus(status: number): boolean {
  return [408, 409, 425, 429, 500, 502, 503, 504].includes(status);
}

function transcriptionRetryDelayMs(attempt: number): number {
  return TRANSCRIPTION_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractGeminiText(data: unknown): string {
  const response = data as {
    candidates?: Array<{
      content?: { parts?: Array<{ text?: string }> };
    }>;
  };
  return (response.candidates ?? [])
    .flatMap((candidate) => candidate.content?.parts ?? [])
    .map((part) => part.text ?? '')
    .join('\n')
    .trim();
}

function extractGeminiInlineAudio(data: unknown):
  | {
      data: string;
      mimeType?: string;
    }
  | undefined {
  const response = data as {
    candidates?: Array<{
      content?: {
        parts?: Array<{
          inlineData?: { data?: string; mimeType?: string };
          inline_data?: { data?: string; mime_type?: string };
        }>;
      };
    }>;
  };
  for (const candidate of response.candidates ?? []) {
    for (const part of candidate.content?.parts ?? []) {
      const inlineData = part.inlineData;
      if (inlineData?.data) {
        return { data: inlineData.data, mimeType: inlineData.mimeType };
      }
      const inlineDataSnake = part.inline_data;
      if (inlineDataSnake?.data) {
        return {
          data: inlineDataSnake.data,
          mimeType: inlineDataSnake.mime_type,
        };
      }
    }
  }
  return undefined;
}

function guessAudioMimeType(filename: string): string {
  switch (path.extname(filename).toLowerCase()) {
    case '.mp3':
      return 'audio/mpeg';
    case '.m4a':
      return 'audio/mp4';
    case '.ogg':
    case '.oga':
      return 'audio/ogg';
    case '.wav':
      return 'audio/wav';
    case '.webm':
      return 'audio/webm';
    case '.flac':
      return 'audio/flac';
    case '.aac':
      return 'audio/aac';
    default:
      return 'application/octet-stream';
  }
}

async function convertToOggOpus(input: Buffer, mimeType: string): Promise<Buffer> {
  const args = ['-hide_banner', '-loglevel', 'error'];
  if (isRawPcmMimeType(mimeType)) {
    args.push(
      '-f',
      's16le',
      '-ar',
      String(parsePcmSampleRate(mimeType) ?? GOOGLE_TTS_SAMPLE_RATE),
      '-ac',
      String(GOOGLE_TTS_CHANNELS),
    );
  }
  args.push('-i', 'pipe:0', '-c:a', 'libopus', '-b:a', '32k', '-vbr', 'on', '-f', 'ogg', 'pipe:1');
  return runFfmpeg(args, input);
}

function isRawPcmMimeType(mimeType: string): boolean {
  return /audio\/(?:L16|pcm)/i.test(mimeType) || /codec=pcm/i.test(mimeType);
}

function parsePcmSampleRate(mimeType: string): number | null {
  const match = /rate=(\d+)/i.exec(mimeType);
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : null;
}

function runFfmpeg(args: string[], input: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', args);
    const stdoutChunks: Buffer[] = [];
    let stderr = '';

    child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-5_000);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve(Buffer.concat(stdoutChunks));
        return;
      }
      reject(new Error(`ffmpeg failed (${code ?? 'unknown'}): ${stderr}`));
    });
    child.stdin.end(input);
  });
}

function bufferToArrayBuffer(buffer: Buffer): ArrayBuffer {
  return buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength,
  ) as ArrayBuffer;
}
