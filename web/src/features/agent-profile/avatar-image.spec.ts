import { afterEach, describe, expect, it, vi } from 'vitest'
import { AvatarImageError, MAX_AVATAR_BYTES, scaleAvatarImage } from './avatar-image'

afterEach(() => vi.unstubAllGlobals())

// A synthetic bitmap and canvas: jsdom draws nothing, so the encoder answers by step.
function stubCanvas(sizes: number[]) {
  const drawn: Array<{ width: number; quality: number }> = []
  const bitmap = { width: 400, height: 300, close: vi.fn() }
  vi.stubGlobal('createImageBitmap', vi.fn(async () => bitmap))
  const context = { drawImage: vi.fn(), imageSmoothingQuality: 'low' }
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as never)
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (this: HTMLCanvasElement, done, _type, quality) {
    drawn.push({ width: this.width, quality: quality as number })
    const size = sizes[drawn.length - 1] ?? 1
    done(new Blob([new Uint8Array(size).fill(65)], { type: 'image/webp' }))
  })
  return { drawn, bitmap, context }
}

describe('scaling a picture for an Agent', () => {
  it('refuses SVG and other types before reading them', async () => {
    await expect(scaleAvatarImage(new Blob(['<svg/>'], { type: 'image/svg+xml' }))).rejects.toEqual(new AvatarImageError('type'))
  })

  it('centre-crops to a square and lowers quality until it fits', async () => {
    const { drawn, bitmap, context } = stubCanvas([MAX_AVATAR_BYTES + 1, 3])
    const data = await scaleAvatarImage(new Blob(['x'], { type: 'image/png' }))
    expect(drawn).toEqual([{ width: 256, quality: 0.85 }, { width: 256, quality: 0.7 }])
    expect(context.drawImage).toHaveBeenLastCalledWith(bitmap, 50, 0, 300, 300, 0, 0, 256, 256)
    expect(atob(data)).toBe('AAA')
    expect(bitmap.close).toHaveBeenCalled()
  })

  it('says a picture is too large when even the smallest step does not fit', async () => {
    stubCanvas(Array(5).fill(MAX_AVATAR_BYTES + 1))
    await expect(scaleAvatarImage(new Blob(['x'], { type: 'image/jpeg' }))).rejects.toEqual(new AvatarImageError('too_large'))
  })
})
