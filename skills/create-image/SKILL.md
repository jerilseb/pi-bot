---
name: create-image
description: Generate or edit images using fal.ai GPT Image 2, save the resulting PNG files locally, and report their paths. Use when the user asks to create, generate, render, design, make, edit, modify, retouch, transform, or revise an image/illustration/logo/poster/mockup.
---

# Create or Edit Image

Generate images with fal.ai's `openai/gpt-image-2` model, or edit existing images with `openai/gpt-image-2/edit`, and save the returned image files locally.

## When to Use

Use this skill when the user asks for image generation from text, including:

- illustrations, posters, banners, logos, icons, or mockups
- realistic or stylized images
- images requiring fine typography
- multiple variations of an image prompt

Also use it when the user asks to edit an existing image, including:

- changing objects, backgrounds, colors, clothing, poses, lighting, or style
- preserving part of an image while revising another part
- using one or more reference images to create an edited result
- applying a mask image to constrain where edits occur

Do **not** use it just to edit existing code or create HTML/SVG by hand unless the user specifically wants generated raster imagery.

## Requirements

- `FAL_KEY` must be available in the environment. Do not print it.
- The helper script uses Node.js 18+ built-in `fetch`; no npm install is required.
- Image editing requires input images as `http(s)` URLs accessible by fal.ai. Local files are not uploaded by this helper.
- API details are summarized below and in `references/gpt-image-2.md`.

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

The script always requests exactly **one PNG image** at **medium quality**. It prints the fal request payload (without secrets), the raw response metadata, and one `SAVED ...` line for the downloaded image.

## Edit an Image

Use the edit endpoint by passing `--edit` and at least one input image URL:

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

For multiple reference images, repeat `--image-url` or pass `--image-urls` as a comma-separated list or JSON array. To constrain the edit area, pass `--mask-url "https://example.com/mask.png"`.

Edit mode defaults to `--size auto`, which asks the model to infer the output size from the input images.

## Common Options

```bash
.agents/skills/create-image/scripts/create-image.mjs \
  --prompt "A vintage travel poster for Mars, bold readable text: VISIT MARS" \
  --size portrait_4_3 \
  --out /tmp/create-image
```

Options:

- `--prompt <text>`: required prompt or edit instructions. Positional prompt text is also accepted.
- `--edit`: use `openai/gpt-image-2/edit`.
- `--mode <generate|edit>`: explicitly choose text-to-image generation or image editing.
- `--image-url <url>`: input/reference image URL for edit mode. Repeat to pass multiple images.
- `--image-urls <urls>`: comma-separated list or JSON array of input/reference image URLs.
- `--mask-url <url>`: optional mask image URL indicating what part of the image to edit.
- `--size <preset|json>`: image size. Defaults to `landscape_4_3` for generation and `auto` for editing. Can be a preset string or JSON like `'{"width":1024,"height":1024}'`.
- Quality is fixed to `medium`; do not pass alternate quality values.
- The skill always requests `quality: "medium"`, `num_images: 1`, and `output_format: "png"`; do not pass alternate counts or formats.
- `--sync-mode`: ask fal to return data URIs and avoid request-history media storage.
- `--out <dir>`: output directory. Default `/tmp/create-image`.
- `--timeout-ms <ms>`: request timeout. Default `600000`.
- `--dry-run`: print model, endpoint, and request payload without calling fal.

## Prompting Guidance

- Ask a clarifying question if the user did not provide enough visual direction (subject, style, text, aspect ratio, intended use, or edit instructions).
- For edits, ask for or locate an accessible input image URL before running the helper.
- For masked edits, ask for an accessible mask URL and explain that the mask indicates what part of the image to edit.
- Include exact typography in quotes when text must appear in the image.
- Include composition, style, lighting, palette, camera/lens, and aspect ratio when relevant.
- Always use medium quality for every generation or edit.
- Output format is always PNG.

## After Generation or Editing

Report:

1. The saved local PNG file path.
2. The image size and format, if returned.
3. The fal URL, if present.

Do not expose `FAL_KEY` or include it in command output.
