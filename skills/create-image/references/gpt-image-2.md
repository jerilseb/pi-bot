# GPT Image 2 via fal.ai

Reference summary for `openai/gpt-image-2` and `openai/gpt-image-2/edit`.

## Generation

- Endpoint: `https://fal.run/openai/gpt-image-2`
- Model ID: `openai/gpt-image-2`
- Category: text-to-image
- Authorization header: `Authorization: Key $FAL_KEY`

### Generation Input

Required:

- `prompt` (`string`): text prompt for image generation.

Optional:

- `image_size` (`ImageSize | Enum`): preset name or explicit `{ "width": number, "height": number }`.
  - Default: `landscape_4_3`
  - Explicit dimensions must be multiples of 16, max edge 3840px, aspect ratio <= 3:1, total pixels from 655,360 to 8,294,400.
- `quality` (`low | medium | high`): this skill always sends `medium`.
- `sync_mode` (`boolean`): if true, media can be returned as a data URI and output data will not be available in request history.

This skill always sends `quality: "medium"`, `num_images: 1`, and `output_format: "png"`.

### Generation cURL

```bash
curl --request POST \
  --url https://fal.run/openai/gpt-image-2 \
  --header "Authorization: Key $FAL_KEY" \
  --header "Content-Type: application/json" \
  --data '{
    "prompt": "create a realistic image taken with iphone at these coordinates 41°43′32″N 49°56′49″W 15 April 1912",
    "image_size": "landscape_4_3",
    "quality": "medium",
    "num_images": 1,
    "output_format": "png"
  }'
```

## Editing

- Endpoint: `https://fal.run/openai/gpt-image-2/edit`
- Model ID: `openai/gpt-image-2/edit`
- Category: image-to-image
- Authorization header: `Authorization: Key $FAL_KEY`

### Editing Input

Required:

- `prompt` (`string`): edit instructions / prompt for the result.
- `image_urls` (`list<string>`): URLs of input/reference images to use for the edit.

Optional:

- `image_size` (`ImageSize | Enum`): preset name, explicit `{ "width": number, "height": number }`, or `auto`.
  - Default: `auto`
- `mask_url` (`string`): URL of a mask image indicating what part of the image to edit.
- `quality` (`low | medium | high`): this skill always sends `medium`.
- `sync_mode` (`boolean`): if true, media can be returned as a data URI and output data will not be available in request history.

This skill always sends `quality: "medium"`, `num_images: 1`, and `output_format: "png"`.

### Editing cURL

```bash
curl --request POST \
  --url https://fal.run/openai/gpt-image-2/edit \
  --header "Authorization: Key $FAL_KEY" \
  --header "Content-Type: application/json" \
  --data '{
    "prompt": "Same workers, same beam, same lunch boxes - but they are all on their phones now.",
    "image_urls": [
      "https://v3b.fal.media/files/b/0a8691af/9Se_1_VX1wzTjjTOpWbs9_bb39c2eb-1a41-4749-b1d0-cf134abc8bbf.png"
    ],
    "image_size": "auto",
    "quality": "medium",
    "num_images": 1,
    "output_format": "png"
  }'
```

## Example Response

Both endpoints return images in the same shape:

```json
{
  "images": [
    {
      "content_type": "image/png",
      "file_name": "EnWrO3XWjPE0nxBDpaQrj.png",
      "width": 1024,
      "url": "https://v3b.fal.media/files/b/0a869129/EnWrO3XWjPE0nxBDpaQrj.png",
      "height": 1024
    }
  ]
}
```
