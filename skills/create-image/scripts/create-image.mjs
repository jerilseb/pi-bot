#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const BASE_URL = 'https://api.kie.ai';
const CREATE_ENDPOINT = new URL('/api/v1/jobs/createTask', BASE_URL).toString();
const QUERY_ENDPOINT =
  process.env.KIE_QUERY_ENDPOINT || new URL('/api/v1/jobs/recordInfo', BASE_URL).toString();
const GENERATE_MODEL_ID = 'gpt-image-2-text-to-image';
const EDIT_MODEL_ID = 'gpt-image-2-image-to-image';
const SUPPORTED_ASPECT_RATIOS = new Set(['auto', '1:1', '9:16', '16:9', '4:3', '3:4']);
const SUPPORTED_RESOLUTIONS = new Set(['1K', '2K', '4K']);

function usage(exitCode = 0) {
  const stream = exitCode === 0 ? process.stdout : process.stderr;
  stream.write(`Generate or edit one image with KIE GPT Image 2.

Usage:
  create-image.mjs --prompt "prompt text" [options]
  create-image.mjs --edit --image-url "https://.../input.png" --prompt "edit instructions" [options]
  create-image.mjs "prompt text" [options]

The script creates a KIE task, polls for completion, downloads the returned image, and saves it locally.

Options:
  --prompt <text>             Required image prompt or edit instructions. Positional prompt is also accepted.
  --edit                      Use KIE image-to-image mode. Also implied by --image-url.
  --generate                  Force text-to-image generation mode.
  --mode <generate|edit>      Explicitly choose generation or editing mode.
  --image-url <url>           Input/reference image URL for edit mode. Repeat for multiple images.
  --image-urls <urls>         Comma-separated or JSON array of input image URLs for edit mode.
  --aspect-ratio <ratio>      auto, 1:1, 9:16, 16:9, 4:3, or 3:4. Default: auto.
  --size <preset|json>        Compatibility alias mapped to KIE aspect ratios.
  --resolution <1K|2K|4K>     KIE output resolution. Default: 1K.
  --callback-url <url>        Optional KIE callback URL.
  --quality <value>           Compatibility option; only "medium" is accepted and is not sent to KIE.
  --out <dir>                 Directory for downloaded images. Default: /tmp/create-image
  --timeout-ms <ms>           Overall task timeout in milliseconds. Default: 600000
  --poll-interval-ms <ms>     Poll interval for KIE task status. Default: 3000
  --dry-run                   Print request payload and exit without calling KIE.
  -h, --help                  Show this help.

Environment:
  KIE_API_KEY                 Required KIE API key. It is never printed.
  KIE_QUERY_ENDPOINT          Optional full task detail endpoint. Default: https://api.kie.ai/api/v1/jobs/recordInfo
`);
  process.exit(exitCode);
}

function readValue(args, index, flag) {
  const value = args[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function parseJson(value, label) {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`Invalid ${label} JSON: ${error.message}`);
  }
}

function normalizeAspectRatio(value, label = '--aspect-ratio') {
  if (!value) return undefined;
  const trimmed = String(value).trim();
  if (!trimmed) return undefined;

  if (trimmed.startsWith('{')) {
    const parsed = parseJson(trimmed, label);
    if (!Number.isFinite(parsed.width) || !Number.isFinite(parsed.height)) {
      throw new Error(`${label} JSON must include numeric width and height`);
    }
    return aspectRatioFromDimensions(parsed.width, parsed.height, label);
  }

  const lower = trimmed.toLowerCase().replace(/-/g, '_');
  const aliases = new Map([
    ['auto', 'auto'],
    ['1:1', '1:1'],
    ['square', '1:1'],
    ['square_hd', '1:1'],
    ['16:9', '16:9'],
    ['landscape_16_9', '16:9'],
    ['wide', '16:9'],
    ['9:16', '9:16'],
    ['portrait_16_9', '9:16'],
    ['vertical', '9:16'],
    ['4:3', '4:3'],
    ['landscape_4_3', '4:3'],
    ['landscape', '4:3'],
    ['3:4', '3:4'],
    ['portrait_4_3', '3:4'],
    ['portrait', '3:4'],
  ]);
  const ratio = aliases.get(lower) || trimmed;
  if (!SUPPORTED_ASPECT_RATIOS.has(ratio)) {
    throw new Error(`${label} must be one of: ${[...SUPPORTED_ASPECT_RATIOS].join(', ')}`);
  }
  return ratio;
}

function aspectRatioFromDimensions(width, height, label) {
  const ratio = width / height;
  const candidates = [
    ['1:1', 1],
    ['16:9', 16 / 9],
    ['9:16', 9 / 16],
    ['4:3', 4 / 3],
    ['3:4', 3 / 4],
  ];
  let best;
  for (const candidate of candidates) {
    const diff = Math.abs(ratio - candidate[1]);
    if (!best || diff < best.diff) best = { ratio: candidate[0], diff };
  }
  if (!best || best.diff > 0.03) {
    throw new Error(
      `${label} dimensions must match one of KIE's supported ratios: 1:1, 9:16, 16:9, 4:3, 3:4`,
    );
  }
  return best.ratio;
}

function normalizeResolution(value) {
  const resolution = String(value || '1K')
    .trim()
    .toUpperCase();
  if (!SUPPORTED_RESOLUTIONS.has(resolution)) {
    throw new Error(`--resolution must be one of: ${[...SUPPORTED_RESOLUTIONS].join(', ')}`);
  }
  return resolution;
}

function parseImageUrlList(value, flag) {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${flag} requires at least one URL`);

  if (trimmed.startsWith('[')) {
    const parsed = parseJson(trimmed, flag);
    if (
      !Array.isArray(parsed) ||
      parsed.some((item) => typeof item !== 'string' || item.trim() === '')
    ) {
      throw new Error(`${flag} JSON must be an array of non-empty strings`);
    }
    return parsed.map((item) => item.trim());
  }

  return trimmed
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function assertUrl(value, label) {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('unsupported protocol');
    }
  } catch {
    throw new Error(
      `${label} must be an http(s) URL accessible by KIE. Local files are not uploaded by this helper.`,
    );
  }
}

function parseMode(value) {
  if (value !== 'generate' && value !== 'edit') {
    throw new Error('--mode must be either "generate" or "edit"');
  }
  return value;
}

function parseArgs(argv) {
  const options = {
    aspect_ratio: 'auto',
    resolution: '1K',
    input_urls: [],
    outDir: '/tmp/create-image',
    timeoutMs: 600_000,
    pollIntervalMs: 3_000,
    dryRun: false,
  };
  const positional = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '-h':
      case '--help':
        usage(0);
        break;
      case '--prompt':
        options.prompt = readValue(argv, i, arg);
        i += 1;
        break;
      case '--mode':
        options.mode = parseMode(readValue(argv, i, arg));
        i += 1;
        break;
      case '--edit':
        options.mode = 'edit';
        break;
      case '--generate':
        options.mode = 'generate';
        break;
      case '--image-url':
      case '--image_url':
      case '--reference-image':
      case '--reference_image':
        options.input_urls.push(readValue(argv, i, arg));
        i += 1;
        break;
      case '--image-urls':
      case '--image_urls':
        options.input_urls.push(...parseImageUrlList(readValue(argv, i, arg), arg));
        i += 1;
        break;
      case '--aspect-ratio':
      case '--aspect_ratio':
        options.aspect_ratio = normalizeAspectRatio(readValue(argv, i, arg), arg);
        i += 1;
        break;
      case '--size':
      case '--image-size':
        options.aspect_ratio = normalizeAspectRatio(readValue(argv, i, arg), arg);
        i += 1;
        break;
      case '--resolution':
        options.resolution = normalizeResolution(readValue(argv, i, arg));
        i += 1;
        break;
      case '--callback-url':
      case '--callback_url':
        options.callBackUrl = readValue(argv, i, arg);
        assertUrl(options.callBackUrl, arg);
        i += 1;
        break;
      case '--mask-url':
      case '--mask_url':
        throw new Error('KIE GPT Image 2 does not support --mask-url in this helper');
      case '--quality': {
        const quality = readValue(argv, i, arg);
        if (quality !== 'medium')
          throw new Error('This skill only accepts --quality medium for compatibility');
        i += 1;
        break;
      }
      case '--num-images':
      case '--num_images':
      case '-n': {
        const numImages = Number.parseInt(readValue(argv, i, arg), 10);
        if (numImages !== 1) throw new Error('This skill downloads exactly 1 image result');
        i += 1;
        break;
      }
      case '--format':
      case '--output-format':
      case '--output_format': {
        const format = readValue(argv, i, arg);
        if (format !== 'png')
          throw new Error('This skill only accepts PNG output format for compatibility');
        i += 1;
        break;
      }
      case '--sync-mode':
      case '--sync_mode':
        // KIE does not expose this option. Accept and ignore for CLI compatibility.
        break;
      case '--out':
      case '--output-dir':
        options.outDir = readValue(argv, i, arg);
        i += 1;
        break;
      case '--timeout-ms':
        options.timeoutMs = Number.parseInt(readValue(argv, i, arg), 10);
        i += 1;
        break;
      case '--poll-interval-ms':
        options.pollIntervalMs = Number.parseInt(readValue(argv, i, arg), 10);
        i += 1;
        break;
      case '--dry-run':
        options.dryRun = true;
        break;
      default:
        if (arg.startsWith('--')) throw new Error(`Unknown option: ${arg}`);
        positional.push(arg);
    }
  }

  if (!options.prompt && positional.length > 0) options.prompt = positional.join(' ');
  if (!options.prompt) throw new Error('Missing required --prompt');
  if (options.prompt.length > 20_000) throw new Error('KIE prompt maximum is 20,000 characters');

  const hasEditInputs = options.input_urls.length > 0;
  if (!options.mode) options.mode = hasEditInputs ? 'edit' : 'generate';
  if (options.mode === 'generate' && hasEditInputs) {
    throw new Error('Image URLs are only valid in edit mode');
  }
  if (options.mode === 'edit' && options.input_urls.length === 0) {
    throw new Error('Edit mode requires at least one --image-url');
  }
  if (options.input_urls.length > 16) {
    throw new Error('KIE image-to-image accepts at most 16 input URLs');
  }

  for (const [index, url] of options.input_urls.entries()) {
    assertUrl(url, `--image-url #${index + 1}`);
  }

  options.resolution = normalizeResolution(options.resolution);
  if (options.aspect_ratio === 'auto' && options.resolution !== '1K') {
    throw new Error('KIE only allows resolution "1K" when aspect ratio is "auto"');
  }
  if (options.aspect_ratio === '1:1' && options.resolution === '4K') {
    throw new Error('KIE does not allow resolution "4K" with aspect ratio "1:1"');
  }
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error('--timeout-ms must be a positive integer');
  }
  if (!Number.isInteger(options.pollIntervalMs) || options.pollIntervalMs <= 0) {
    throw new Error('--poll-interval-ms must be a positive integer');
  }

  return options;
}

function extensionFromContentType(contentType, fallback) {
  const lower = (contentType || '').toLowerCase();
  if (lower.includes('png')) return 'png';
  if (lower.includes('jpeg') || lower.includes('jpg')) return 'jpg';
  if (lower.includes('webp')) return 'webp';
  return fallback === 'jpeg' ? 'jpg' : fallback;
}

function safeBaseName(prompt) {
  const slug = prompt
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return slug || 'gpt-image-2';
}

function decodeDataUri(dataUri) {
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(dataUri);
  if (!match) throw new Error('Invalid data URI returned by KIE');
  const contentType = match[1] || 'application/octet-stream';
  const isBase64 = Boolean(match[2]);
  const data = isBase64
    ? Buffer.from(match[3], 'base64')
    : Buffer.from(decodeURIComponent(match[3]));
  return { contentType, data };
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function requestJson(url, options, timeoutMs, label) {
  const response = await fetchWithTimeout(url, options, timeoutMs);
  const responseText = await response.text();
  let result;
  try {
    result = JSON.parse(responseText);
  } catch {
    throw new Error(
      `${label} returned non-JSON response (HTTP ${response.status}): ${responseText}`,
    );
  }
  if (!response.ok) {
    throw new Error(
      `${label} failed (HTTP ${response.status}): ${JSON.stringify(result, null, 2)}`,
    );
  }
  if (Object.hasOwn(result, 'code') && Number(result.code) !== 200) {
    throw new Error(`${label} failed (code ${result.code}): ${JSON.stringify(result, null, 2)}`);
  }
  return result;
}

async function downloadImage(image, index, outDir, prompt, outputFormat, timeoutMs) {
  let contentType = image.content_type || image.contentType || image.mimeType;
  let data;

  if (typeof image.url === 'string' && image.url.startsWith('data:')) {
    const decoded = decodeDataUri(image.url);
    contentType = decoded.contentType;
    data = decoded.data;
  } else if (typeof image.url === 'string') {
    const response = await fetchWithTimeout(image.url, {}, timeoutMs);
    if (!response.ok) {
      throw new Error(
        `Failed to download image ${index + 1}: HTTP ${response.status} ${await response.text()}`,
      );
    }
    contentType = response.headers.get('content-type') || contentType;
    data = Buffer.from(await response.arrayBuffer());
  } else if (typeof image.data === 'string' && image.data.startsWith('data:')) {
    const decoded = decodeDataUri(image.data);
    contentType = decoded.contentType;
    data = decoded.data;
  } else {
    throw new Error(`Image ${index + 1} did not include a URL or data URI`);
  }

  const ext = extensionFromContentType(contentType, outputFormat);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `${safeBaseName(prompt)}-${timestamp}-${index + 1}.${ext}`;
  const filePath = path.join(outDir, filename);
  await writeFile(filePath, data);
  return {
    filePath,
    bytes: data.length,
    contentType,
    width: image.width,
    height: image.height,
    url: image.url,
  };
}

function maybeParseJson(value) {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed || (!trimmed.startsWith('{') && !trimmed.startsWith('['))) {
    return value;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function looksLikeImagePayload(value) {
  return (
    typeof value === 'string' &&
    (value.startsWith('http://') || value.startsWith('https://') || value.startsWith('data:'))
  );
}

function directImageFromObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const url =
    value.url ||
    value.image_url ||
    value.imageUrl ||
    value.output_url ||
    value.outputUrl ||
    value.result_url ||
    value.resultUrl ||
    value.src;
  const data = value.data;
  if (typeof url === 'string' && looksLikeImagePayload(url)) {
    return {
      url,
      content_type: value.content_type || value.contentType || value.mimeType,
      file_name: value.file_name || value.fileName || value.name,
      width: value.width,
      height: value.height,
    };
  }
  if (typeof data === 'string' && data.startsWith('data:')) {
    return {
      data,
      content_type: value.content_type || value.contentType || value.mimeType,
      file_name: value.file_name || value.fileName || value.name,
      width: value.width,
      height: value.height,
    };
  }
  return undefined;
}

function collectImages(value, out = [], seen = new Set()) {
  const parsed = maybeParseJson(value);
  if (!parsed) return out;

  if (typeof parsed === 'string') {
    if (looksLikeImagePayload(parsed) && !seen.has(parsed)) {
      seen.add(parsed);
      out.push({ url: parsed });
    }
    return out;
  }

  if (Array.isArray(parsed)) {
    for (const item of parsed) collectImages(item, out, seen);
    return out;
  }

  if (typeof parsed === 'object') {
    const direct = directImageFromObject(parsed);
    if (direct) {
      const key = direct.url || direct.data;
      if (!seen.has(key)) {
        seen.add(key);
        out.push(direct);
      }
    }

    for (const key of [
      'images',
      'image',
      'imageUrls',
      'image_urls',
      'resultUrls',
      'result_urls',
      'urls',
      'outputUrls',
      'output_urls',
      'outputs',
      'output',
      'result',
      'results',
      'files',
      'file',
    ]) {
      if (Object.hasOwn(parsed, key)) collectImages(parsed[key], out, seen);
    }
  }

  return out;
}

function extractImagesFromTaskData(data) {
  const images = [];
  const seen = new Set();
  for (const key of [
    'resultJson',
    'result_json',
    'response',
    'result',
    'results',
    'output',
    'outputs',
    'images',
    'image',
    'imageUrls',
    'image_urls',
    'resultUrls',
    'result_urls',
    'urls',
  ]) {
    if (data && Object.hasOwn(data, key)) collectImages(data[key], images, seen);
  }
  return images;
}

function stateFromTaskData(data) {
  const raw = data?.state ?? data?.status ?? data?.taskStatus ?? data?.task_status;
  return typeof raw === 'string' ? raw.toLowerCase() : '';
}

function isTerminalSuccess(state) {
  return ['success', 'succeeded', 'complete', 'completed', 'done', 'finished'].includes(state);
}

function isTerminalFailure(state) {
  return [
    'fail',
    'failed',
    'failure',
    'error',
    'cancelled',
    'canceled',
    'timeout',
    'rejected',
  ].includes(state);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildRequest(options) {
  const model = options.mode === 'edit' ? EDIT_MODEL_ID : GENERATE_MODEL_ID;
  const input = {
    prompt: options.prompt,
    aspect_ratio: options.aspect_ratio,
    resolution: options.resolution,
  };
  if (options.mode === 'edit') input.input_urls = options.input_urls;
  return {
    model,
    ...(options.callBackUrl ? { callBackUrl: options.callBackUrl } : {}),
    input,
  };
}

async function pollTask(taskId, key, timeoutMs, pollIntervalMs) {
  const deadline = Date.now() + timeoutMs;
  let lastState;

  while (Date.now() < deadline) {
    const queryUrl = new URL(QUERY_ENDPOINT);
    queryUrl.searchParams.set('taskId', taskId);
    const remaining = Math.max(1, deadline - Date.now());
    const result = await requestJson(
      queryUrl.toString(),
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${key}`,
        },
      },
      Math.min(remaining, 60_000),
      'KIE task query',
    );

    const data = result.data || result;
    const state = stateFromTaskData(data);
    if (state !== lastState) {
      console.log(`STATUS ${taskId}${state ? ` ${state}` : ''}`);
      lastState = state;
    }

    if (isTerminalFailure(state)) {
      throw new Error(
        `KIE task failed: ${data.failMsg || data.fail_msg || data.error || data.msg || JSON.stringify(data)}`,
      );
    }

    const images = extractImagesFromTaskData(data);
    if (isTerminalSuccess(state) || images.length > 0) {
      if (images.length === 0) {
        throw new Error(`KIE task completed without image URLs: ${JSON.stringify(data, null, 2)}`);
      }
      return { result, data, state, images };
    }

    await sleep(Math.min(pollIntervalMs, Math.max(1, deadline - Date.now())));
  }

  throw new Error(`KIE task timed out after ${timeoutMs}ms: ${taskId}`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const request = buildRequest(options);
  const modelId = request.model;

  const key = process.env.KIE_API_KEY;
  if (!options.dryRun && !key) {
    throw new Error('KIE_API_KEY is not set in the environment');
  }

  console.log(`MODEL ${modelId}`);
  console.log(`CREATE_ENDPOINT ${CREATE_ENDPOINT}`);
  console.log(`QUERY_ENDPOINT ${QUERY_ENDPOINT}`);
  console.log('REQUEST', JSON.stringify(request, null, 2));

  if (options.dryRun) return;

  await mkdir(options.outDir, { recursive: true });

  const createResult = await requestJson(
    CREATE_ENDPOINT,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(request),
    },
    Math.min(options.timeoutMs, 60_000),
    'KIE task create',
  );

  const taskId = createResult.data?.taskId || createResult.taskId;
  if (!taskId) {
    throw new Error(
      `KIE create response did not include taskId: ${JSON.stringify(createResult, null, 2)}`,
    );
  }
  console.log(
    'CREATE_RESPONSE',
    JSON.stringify(
      {
        code: createResult.code,
        msg: createResult.msg,
        taskId,
      },
      null,
    ),
  );

  const completed = await pollTask(taskId, key, options.timeoutMs, options.pollIntervalMs);

  console.log(
    'RESPONSE',
    JSON.stringify(
      {
        taskId,
        state: completed.state,
        image_count: completed.images.length,
        images: completed.images.map((image) => ({
          content_type: image.content_type || image.contentType || image.mimeType,
          file_name: image.file_name || image.fileName || image.name,
          width: image.width,
          height: image.height,
          url:
            typeof image.url === 'string' && image.url.startsWith('data:')
              ? 'data:(omitted)'
              : image.url,
        })),
      },
      null,
    ),
  );

  for (let i = 0; i < Math.min(completed.images.length, 1); i += 1) {
    const saved = await downloadImage(
      completed.images[i],
      i,
      options.outDir,
      options.prompt,
      'png',
      Math.min(options.timeoutMs, 120_000),
    );
    console.log(
      `SAVED ${saved.filePath} (${saved.bytes} bytes${saved.width && saved.height ? `, ${saved.width}x${saved.height}` : ''}${
        saved.contentType ? `, ${saved.contentType}` : ''
      })`,
    );
  }
}

try {
  await main();
} catch (error) {
  if (error.name === 'AbortError') {
    console.error('ERROR KIE request timed out');
  } else {
    console.error(`ERROR ${error.message}`);
  }
  process.exit(1);
}
