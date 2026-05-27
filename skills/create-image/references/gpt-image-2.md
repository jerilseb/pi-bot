# GPT Image 2 via KIE

Reference summary for KIE GPT Image 2 based on project-root `gpt_image.md`.

## Base API

- Base URL: `https://api.kie.ai`
- Create task endpoint: `POST /api/v1/jobs/createTask`
- Task detail endpoint used by helper: `GET /api/v1/jobs/recordInfo?taskId=...`
- Authorization header: `Authorization: Bearer $KIE_API_KEY`
- Responses use KIE's common envelope: `code`, `msg`, `data`.

## Text to Image

- Model ID: `gpt-image-2-text-to-image`
- Category: text-to-image

### Request Body

```json
{
  "model": "gpt-image-2-text-to-image",
  "input": {
    "prompt": "A cinematic night city poster with neon reflections on a rainy street.",
    "aspect_ratio": "auto",
    "resolution": "1K"
  }
}
```

Required:

- `model`: must be `gpt-image-2-text-to-image`.
- `input.prompt`: text prompt, 1 to 20,000 characters.

Optional:

- `callBackUrl`: callback URL for task completion notifications.
- `input.aspect_ratio`: `auto`, `1:1`, `9:16`, `16:9`, `4:3`, or `3:4`. Default: `auto`.
- `input.resolution`: `1K`, `2K`, or `4K`.

KIE constraints from the docs:

- If `aspect_ratio` is `auto` or omitted, only `1K` resolution is allowed.
- `1:1` images cannot use `4K` resolution.

### cURL

```bash
curl --request POST \
  --url https://api.kie.ai/api/v1/jobs/createTask \
  --header "Authorization: Bearer $KIE_API_KEY" \
  --header "Content-Type: application/json" \
  --data '{
    "model": "gpt-image-2-text-to-image",
    "input": {
      "prompt": "A cinematic night city poster with neon reflections on a rainy street.",
      "aspect_ratio": "auto",
      "resolution": "1K"
    }
  }'
```

## Image to Image

- Model ID: `gpt-image-2-image-to-image`
- Category: image-to-image

### Request Body

```json
{
  "model": "gpt-image-2-image-to-image",
  "input": {
    "prompt": "Transform this product image into a premium e-commerce poster style.",
    "input_urls": ["https://example.com/input.png"],
    "aspect_ratio": "auto",
    "resolution": "1K"
  }
}
```

Required:

- `model`: must be `gpt-image-2-image-to-image`.
- `input.prompt`: text prompt / edit instructions, up to 20,000 characters.
- `input.input_urls`: array of input image URLs, maximum 16.

Optional:

- `callBackUrl`: callback URL for task completion notifications.
- `input.aspect_ratio`: `auto`, `1:1`, `9:16`, `16:9`, `4:3`, or `3:4`.
- `input.resolution`: `1K`, `2K`, or `4K`.

### cURL

```bash
curl --request POST \
  --url https://api.kie.ai/api/v1/jobs/createTask \
  --header "Authorization: Bearer $KIE_API_KEY" \
  --header "Content-Type: application/json" \
  --data '{
    "model": "gpt-image-2-image-to-image",
    "input": {
      "prompt": "Take a photo with Sam Altman in the conference room",
      "input_urls": [
        "https://static.aiquickdraw.com/tools/example/1776782793756_wrogXTdd.png"
      ],
      "aspect_ratio": "auto",
      "resolution": "1K"
    }
  }'
```

## Create Task Response

Both create-task modes return a task ID:

```json
{
  "code": 200,
  "msg": "success",
  "data": {
    "taskId": "task_gptimage_1765180586443"
  }
}
```

The helper polls the task detail endpoint until the task succeeds/fails, extracts generated image URL(s) from the result payload, downloads the first image, and prints a `SAVED ...` line.
