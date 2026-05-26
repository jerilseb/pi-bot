#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const GENERATE_ENDPOINT = "https://fal.run/openai/gpt-image-2";
const GENERATE_MODEL_ID = "openai/gpt-image-2";
const EDIT_ENDPOINT = "https://fal.run/openai/gpt-image-2/edit";
const EDIT_MODEL_ID = "openai/gpt-image-2/edit";

function usage(exitCode = 0) {
	const stream = exitCode === 0 ? process.stdout : process.stderr;
	stream.write(`Generate or edit one PNG image with fal.ai GPT Image 2.

Usage:
  create-image.mjs --prompt "prompt text" [options]
  create-image.mjs --edit --image-url "https://.../input.png" --prompt "edit instructions" [options]
  create-image.mjs "prompt text" [options]

This skill always requests exactly 1 image in PNG format.

Options:
  --prompt <text>         Required image prompt or edit instructions. Positional prompt is also accepted.
  --edit                  Use the image-edit endpoint. Also implied by --image-url.
  --generate              Force text-to-image generation mode.
  --mode <generate|edit>  Explicitly choose generation or editing mode.
  --image-url <url>       Input/reference image URL for edit mode. Repeat for multiple images.
  --image-urls <urls>     Comma-separated or JSON array of input image URLs for edit mode.
  --mask-url <url>        Optional mask image URL indicating what part of the image to edit.
  --size <preset|json>    Image size preset or JSON object. Defaults: landscape_4_3 for generate, auto for edit.
  --quality <value>       Fixed to medium; only "medium" is accepted for compatibility.
  --sync-mode             Request data URI output instead of fal-hosted media URLs.
  --out <dir>             Directory for downloaded images. Default: /tmp/create-image
  --timeout-ms <ms>       Request timeout in milliseconds. Default: 600000
  --dry-run               Print request payload and exit without calling fal.
  -h, --help              Show this help.

Environment:
  FAL_KEY                 Required fal.ai API key. It is never printed.
`);
	process.exit(exitCode);
}

function readValue(args, index, flag) {
	const value = args[index + 1];
	if (!value || value.startsWith("--")) {
		throw new Error(`${flag} requires a value`);
	}
	return value;
}

function parseImageSize(value) {
	if (!value) return undefined;
	const trimmed = value.trim();
	if (trimmed.startsWith("{")) {
		try {
			const parsed = JSON.parse(trimmed);
			if (!Number.isInteger(parsed.width) || !Number.isInteger(parsed.height)) {
				throw new Error("JSON size must include integer width and height");
			}
			return parsed;
		} catch (error) {
			throw new Error(`Invalid --size JSON: ${error.message}`);
		}
	}
	return trimmed;
}

function parseImageUrlList(value, flag) {
	const trimmed = value.trim();
	if (!trimmed) throw new Error(`${flag} requires at least one URL`);

	if (trimmed.startsWith("[")) {
		let parsed;
		try {
			parsed = JSON.parse(trimmed);
		} catch (error) {
			throw new Error(`Invalid ${flag} JSON array: ${error.message}`);
		}
		if (
			!Array.isArray(parsed) ||
			parsed.some((item) => typeof item !== "string" || item.trim() === "")
		) {
			throw new Error(`${flag} JSON must be an array of non-empty strings`);
		}
		return parsed.map((item) => item.trim());
	}

	return trimmed
		.split(",")
		.map((item) => item.trim())
		.filter(Boolean);
}

function assertUrl(value, label) {
	try {
		const parsed = new URL(value);
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
			throw new Error("unsupported protocol");
		}
	} catch {
		throw new Error(
			`${label} must be an http(s) URL accessible by fal.ai. Local files are not uploaded by this helper.`,
		);
	}
}

function parseMode(value) {
	if (value !== "generate" && value !== "edit") {
		throw new Error('--mode must be either "generate" or "edit"');
	}
	return value;
}

function parseArgs(argv) {
	const options = {
		quality: "medium",
		num_images: 1,
		output_format: "png",
		image_urls: [],
		outDir: "/tmp/create-image",
		timeoutMs: 600_000,
		dryRun: false,
	};
	const positional = [];

	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		switch (arg) {
			case "-h":
			case "--help":
				usage(0);
				break;
			case "--prompt":
				options.prompt = readValue(argv, i, arg);
				i += 1;
				break;
			case "--mode":
				options.mode = parseMode(readValue(argv, i, arg));
				i += 1;
				break;
			case "--edit":
				options.mode = "edit";
				break;
			case "--generate":
				options.mode = "generate";
				break;
			case "--image-url":
			case "--image_url":
			case "--reference-image":
			case "--reference_image":
				options.image_urls.push(readValue(argv, i, arg));
				i += 1;
				break;
			case "--image-urls":
			case "--image_urls":
				options.image_urls.push(
					...parseImageUrlList(readValue(argv, i, arg), arg),
				);
				i += 1;
				break;
			case "--mask-url":
			case "--mask_url":
				options.mask_url = readValue(argv, i, arg);
				i += 1;
				break;
			case "--size":
			case "--image-size":
				options.image_size = parseImageSize(readValue(argv, i, arg));
				i += 1;
				break;
			case "--quality": {
				const quality = readValue(argv, i, arg);
				if (quality !== "medium")
					throw new Error("This skill always uses medium quality");
				options.quality = "medium";
				i += 1;
				break;
			}
			case "--num-images":
			case "--num_images":
			case "-n": {
				const numImages = Number.parseInt(readValue(argv, i, arg), 10);
				if (numImages !== 1)
					throw new Error("This skill always generates exactly 1 image");
				i += 1;
				break;
			}
			case "--format":
			case "--output-format":
			case "--output_format": {
				const format = readValue(argv, i, arg);
				if (format !== "png")
					throw new Error("This skill always outputs PNG images");
				i += 1;
				break;
			}
			case "--sync-mode":
			case "--sync_mode":
				options.sync_mode = true;
				break;
			case "--out":
			case "--output-dir":
				options.outDir = readValue(argv, i, arg);
				i += 1;
				break;
			case "--timeout-ms":
				options.timeoutMs = Number.parseInt(readValue(argv, i, arg), 10);
				i += 1;
				break;
			case "--dry-run":
				options.dryRun = true;
				break;
			default:
				if (arg.startsWith("--")) throw new Error(`Unknown option: ${arg}`);
				positional.push(arg);
		}
	}

	if (!options.prompt && positional.length > 0)
		options.prompt = positional.join(" ");
	if (!options.prompt) throw new Error("Missing required --prompt");

	const hasEditInputs =
		options.image_urls.length > 0 || Boolean(options.mask_url);
	if (!options.mode) options.mode = hasEditInputs ? "edit" : "generate";
	if (options.mode === "generate" && hasEditInputs) {
		throw new Error("Image URLs and mask URLs are only valid in edit mode");
	}
	if (options.mode === "edit" && options.image_urls.length === 0) {
		throw new Error("Edit mode requires at least one --image-url");
	}

	for (const [index, url] of options.image_urls.entries()) {
		assertUrl(url, `--image-url #${index + 1}`);
	}
	if (options.mask_url) assertUrl(options.mask_url, "--mask-url");

	if (!options.image_size)
		options.image_size = options.mode === "edit" ? "auto" : "landscape_4_3";
	options.num_images = 1;
	options.output_format = "png";
	options.quality = "medium";
	if (!Number.isInteger(options.timeoutMs) || options.timeoutMs <= 0) {
		throw new Error("--timeout-ms must be a positive integer");
	}

	if (options.mode === "generate") {
		delete options.image_urls;
		delete options.mask_url;
	}

	return options;
}

function extensionFromContentType(contentType, fallback) {
	const lower = (contentType || "").toLowerCase();
	if (lower.includes("png")) return "png";
	if (lower.includes("jpeg") || lower.includes("jpg")) return "jpg";
	if (lower.includes("webp")) return "webp";
	return fallback === "jpeg" ? "jpg" : fallback;
}

function safeBaseName(prompt) {
	const slug = prompt
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 64);
	return slug || "gpt-image-2";
}

function decodeDataUri(dataUri) {
	const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(dataUri);
	if (!match) throw new Error("Invalid data URI returned by fal");
	const contentType = match[1] || "application/octet-stream";
	const isBase64 = Boolean(match[2]);
	const data = isBase64
		? Buffer.from(match[3], "base64")
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

async function downloadImage(
	image,
	index,
	outDir,
	prompt,
	outputFormat,
	timeoutMs,
) {
	let contentType = image.content_type;
	let data;

	if (typeof image.url === "string" && image.url.startsWith("data:")) {
		const decoded = decodeDataUri(image.url);
		contentType = decoded.contentType;
		data = decoded.data;
	} else if (typeof image.url === "string") {
		const response = await fetchWithTimeout(image.url, {}, timeoutMs);
		if (!response.ok) {
			throw new Error(
				`Failed to download image ${index + 1}: HTTP ${response.status} ${await response.text()}`,
			);
		}
		contentType = response.headers.get("content-type") || contentType;
		data = Buffer.from(await response.arrayBuffer());
	} else if (typeof image.data === "string" && image.data.startsWith("data:")) {
		const decoded = decodeDataUri(image.data);
		contentType = decoded.contentType;
		data = decoded.data;
	} else {
		throw new Error(`Image ${index + 1} did not include a URL or data URI`);
	}

	const ext = extensionFromContentType(contentType, outputFormat);
	const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
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

async function main() {
	const options = parseArgs(process.argv.slice(2));
	const { outDir, timeoutMs, dryRun, mode, ...input } = options;
	const endpoint = mode === "edit" ? EDIT_ENDPOINT : GENERATE_ENDPOINT;
	const modelId = mode === "edit" ? EDIT_MODEL_ID : GENERATE_MODEL_ID;

	const key = process.env.FAL_KEY;
	if (!dryRun && !key) {
		throw new Error("FAL_KEY is not set in the environment");
	}

	console.log(`MODEL ${modelId}`);
	console.log(`ENDPOINT ${endpoint}`);
	console.log("REQUEST", JSON.stringify(input, null, 2));

	if (dryRun) return;

	await mkdir(outDir, { recursive: true });

	const response = await fetchWithTimeout(
		endpoint,
		{
			method: "POST",
			headers: {
				Authorization: `Key ${key}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(input),
		},
		timeoutMs,
	);

	const responseText = await response.text();
	let result;
	try {
		result = JSON.parse(responseText);
	} catch {
		throw new Error(
			`fal returned non-JSON response (HTTP ${response.status}): ${responseText}`,
		);
	}

	if (!response.ok) {
		throw new Error(
			`fal request failed (HTTP ${response.status}): ${JSON.stringify(result, null, 2)}`,
		);
	}

	const images = result.images || result.data?.images;
	if (!Array.isArray(images) || images.length === 0) {
		throw new Error(
			`fal response did not include images: ${JSON.stringify(result, null, 2)}`,
		);
	}

	console.log(
		"RESPONSE",
		JSON.stringify(
			{
				request_id: result.request_id || result.requestId,
				image_count: images.length,
				images: images.map((image) => ({
					content_type: image.content_type,
					file_name: image.file_name,
					width: image.width,
					height: image.height,
					url:
						typeof image.url === "string" && image.url.startsWith("data:")
							? "data:(omitted)"
							: image.url,
				})),
			},
			null,
			2,
		),
	);

	for (let i = 0; i < images.length; i += 1) {
		const saved = await downloadImage(
			images[i],
			i,
			outDir,
			input.prompt,
			input.output_format,
			timeoutMs,
		);
		console.log(
			`SAVED ${saved.filePath} (${saved.bytes} bytes${saved.width && saved.height ? `, ${saved.width}x${saved.height}` : ""}${
				saved.contentType ? `, ${saved.contentType}` : ""
			})`,
		);
	}
}

try {
	await main();
} catch (error) {
	if (error.name === "AbortError") {
		console.error("ERROR fal request timed out");
	} else {
		console.error(`ERROR ${error.message}`);
	}
	process.exit(1);
}
