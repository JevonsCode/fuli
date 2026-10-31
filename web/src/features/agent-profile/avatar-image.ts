// A picture the person picked, made small enough to send as an Agent's look
// (rec#11 D-89): centre-cropped to a square, drawn at 256 px and encoded as
// WebP, with lower quality and then a smaller size until it fits the server's
// 44 KiB. SVG is refused before it is read; the server checks the bytes again.
export const MAX_AVATAR_BYTES = 44 * 1024
export const AVATAR_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const
const STEPS: ReadonlyArray<readonly [size: number, quality: number]> = [[256, 0.85], [256, 0.7], [256, 0.55], [192, 0.55], [128, 0.5]]

export class AvatarImageError extends Error {
  constructor(readonly reason: 'type' | 'unreadable' | 'too_large') {
    super(reason)
    this.name = 'AvatarImageError'
  }
}

function encode(canvas: HTMLCanvasElement, quality: number): Promise<Blob | null> {
  return new Promise(resolve => canvas.toBlob(resolve, 'image/webp', quality))
}

async function base64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let text = ''
  for (let at = 0; at < bytes.length; at += 0x8000) text += String.fromCharCode(...bytes.subarray(at, at + 0x8000))
  return btoa(text)
}

/** The picture as base64, ready for `{ kind: 'image', data }`. */
export async function scaleAvatarImage(file: Blob): Promise<string> {
  if (!(AVATAR_TYPES as readonly string[]).includes(file.type)) throw new AvatarImageError('type')
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file)
  } catch {
    throw new AvatarImageError('unreadable')
  }
  try {
    const side = Math.min(bitmap.width, bitmap.height)
    const canvas = document.createElement('canvas')
    for (const [size, quality] of STEPS) {
      canvas.width = size
      canvas.height = size
      const context = canvas.getContext('2d')
      if (!context) throw new AvatarImageError('unreadable')
      context.imageSmoothingQuality = 'high'
      context.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, size, size)
      const blob = await encode(canvas, quality)
      if (blob && blob.size <= MAX_AVATAR_BYTES) return base64(blob)
    }
    throw new AvatarImageError('too_large')
  } finally {
    bitmap.close()
  }
}
