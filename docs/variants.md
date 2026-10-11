# Picture Variants

Confirming a JPEG, PNG or WebP File generates three WebP Variants before the
confirmation replies. Small fits inside 150 × 150 pixels, medium inside
600 × 600, and large inside 1200 × 1200. Pictures retain their aspect ratio,
respect their orientation, and are never enlarged. Generation uses
[sharp's resize options](https://sharp.pixelplumbing.com/api-resize/).

Every File response includes a `variants` array. Pending uploads and other
types, including GIF, return `[]`. Confirm and view responses for a picture
include entries in small, medium, large order:

```json
{
  "variants": [
    { "name": "small", "status": "ready", "url": "https://cdn.example/<id>/small.webp" },
    { "name": "medium", "status": "failed", "url": null },
    { "name": "large", "status": "ready", "url": "https://cdn.example/<id>/large.webp" }
  ]
}
```

Each Variant is saved under its File's prefix in the same bucket as the original,
with content type `image/webp`. Public Variants use CDN addresses. Private
Variants use signed addresses valid for five minutes, freshly issued on each
confirm or view response.

Generation and storage failures mark the affected Variant as `failed` with no
address. They do not reject the File or prevent other Variants from being made.
If the original cannot be read or decoded, all three Variants fail. Variant
statuses are persisted with the Active File; repeated confirmation returns
the saved statuses without regenerating or retrying failed Variants.

Apply migration `0003_variants.sql` before deploying this change. Existing
Active Files retain an empty Variant list; this migration does not backfill them.
