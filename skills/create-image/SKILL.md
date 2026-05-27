---
name: create-image
description: Generate or edit images using KIE GPT Image 2, save the resulting image file locally, and report its path. Use when the user asks to create, generate, render, design, make, edit, modify, retouch, transform, or revise an image/illustration/logo/poster/mockup.
---

# Create or Edit Image

Generate images with KIE's `gpt-image-2-text-to-image` model, or edit/reference existing images with `gpt-image-2-image-to-image`, and save the returned image file locally.

## When to Use

Use this skill when the user asks for image generation from text, including:

- illustrations, posters, banners, logos, icons, or mockups
- realistic or stylized images
- images requiring fine typography
- multiple variations of an image prompt

Also use it when the user asks to edit or transform an existing image, including:

- changing objects, backgrounds, colors, clothing, poses, lighting, or style
- preserving part of an image while revising another part
- using one or more reference images to create an edited result

Do **not** use it just to edit existing code or create HTML/SVG by hand unless the user specifically wants generated raster imagery.

## Requirements

- `KIE_API_KEY` must be available in the environment. Do not print it.
- The helper script uses Node.js 18+ built-in `fetch`; no npm install is required.
- Image editing requires input images as `http(s)` URLs accessible by KIE. Local files are not uploaded by this helper.
- KIE GPT Image 2 does not support mask URLs in this helper.
- API details are summarized below and in `references/gpt-image-2.md`; the source docs are in project-root `gpt_image.md`.

## Generate an Image

From the project root, run:

```bash
.agents/skills/create-image/scripts/create-image.mjs \
  --prompt "A concise, detailed image prompt" \
  --out /tmp/create-image
```

Equivalent path through pi's skill symlink:

```bash
.pi/skills/create-image/scripts/create-image.mjs --prompt "..."
```

The script creates a KIE task, polls for completion, downloads the first returned image, and prints one `SAVED ...` line for the local file.

## Edit an Image

Use image-to-image mode by passing `--edit` and at least one input image URL:

```bash
.agents/skills/create-image/scripts/create-image.mjs \
  --edit \
  --image-url "https://example.com/input.png" \
  --prompt "Keep the same composition, but change the car to bright red and add rainy nighttime lighting" \
  --out /tmp/create-image
```

`--edit` is also implied when `--image-url` is present:

```bash
.pi/skills/create-image/scripts/create-image.mjs \
  --image-url "https://example.com/input.png" \
  --prompt "Remove the background and place the subject in a clean white studio"
```

For multiple reference images, repeat `--image-url` or pass `--image-urls` as a comma-separated list or JSON array. KIE accepts up to 16 input URLs.

## Common Options

```bash
.agents/skills/create-image/scripts/create-image.mjs \
  --prompt "A vintage travel poster for Mars, bold readable text: VISIT MARS" \
  --aspect-ratio 3:4 \
  --resolution 1K \
  --out /tmp/create-image
```

Options:

- `--prompt <text>`: required prompt or edit instructions. Positional prompt text is also accepted. KIE limit: 20,000 characters.
- `--edit`: use `gpt-image-2-image-to-image`.
- `--mode <generate|edit>`: explicitly choose text-to-image generation or image-to-image editing.
- `--image-url <url>`: input/reference image URL for edit mode. Repeat to pass multiple images.
- `--image-urls <urls>`: comma-separated list or JSON array of input/reference image URLs.
- `--aspect-ratio <ratio>`: `auto`, `1:1`, `9:16`, `16:9`, `4:3`, or `3:4`. Default: `auto`.
- `--size <preset|json>`: compatibility alias mapped to KIE aspect ratios. Examples: `landscape_4_3` -> `4:3`, `portrait_4_3` -> `3:4`, `landscape_16_9` -> `16:9`, `portrait_16_9` -> `9:16`.
- `--resolution <1K|2K|4K>`: default `1K`. KIE only allows `1K` with `aspect_ratio: auto`; KIE does not allow `4K` with `1:1`.
- `--callback-url <url>`: optional KIE task completion callback URL.
- `--out <dir>`: output directory. Default `/tmp/create-image`.
- `--timeout-ms <ms>`: overall create+poll timeout. Default `600000`.
- `--poll-interval-ms <ms>`: task polling interval. Default `3000`.
- `--dry-run`: print model, endpoints, and request payload without calling KIE.

## Prompting Guidance

- Ask a clarifying question if the user did not provide enough visual direction (subject, style, text, aspect ratio, intended use, or edit instructions).
- For edits, ask for or locate an accessible input image URL before running the helper.
- Include exact typography in quotes when text must appear in the image.
- Include composition, style, lighting, palette, camera/lens, and aspect ratio when relevant.
- The output file extension is chosen from the returned image content type; generated files are normally suitable for Telegram upload.

## After Generation or Editing

Report:

1. The saved local image file path.
2. The image size and format/content type, if returned.
3. The KIE task ID and image URL, if present.

Do not expose `KIE_API_KEY` or include it in command output.
