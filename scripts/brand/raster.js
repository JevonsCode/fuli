// RGBA images ({ width, height, data }) with straight alpha: blending, placing
// one image on another, cropping and area-weighted resizing.
export function blankImage(width, height = width) {
  return { width, height, data: new Uint8Array(width * height * 4) };
}

// Source-over blending of [rgb] at [alpha] (0..1) onto the pixel at byte offset [at].
export function blendPixel(image, at, rgb, alpha) {
  if (alpha <= 0) return;
  const underAlpha = image.data[at + 3] / 255;
  const outAlpha = alpha + underAlpha * (1 - alpha);
  for (let c = 0; c < 3; c++) {
    image.data[at + c] = Math.round((rgb[c] * alpha + image.data[at + c] * underAlpha * (1 - alpha)) / outAlpha);
  }
  image.data[at + 3] = Math.round(outAlpha * 255);
}

// Blends [layer] onto [canvas] with its top left corner at ([left], [top]).
export function composite(canvas, layer, left, top) {
  for (let y = 0; y < layer.height; y++) {
    for (let x = 0; x < layer.width; x++) {
      const from = (y * layer.width + x) * 4;
      const to = ((top + y) * canvas.width + left + x) * 4;
      blendPixel(canvas, to, layer.data.subarray(from, from + 3), layer.data[from + 3] / 255);
    }
  }
}

// The smallest part of [image] that holds every visible pixel.
export function cropToContent(image) {
  let [left, top, right, bottom] = [image.width, image.height, -1, -1];
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      if (image.data[(y * image.width + x) * 4 + 3] === 0) continue;
      left = Math.min(left, x);
      right = Math.max(right, x);
      top = Math.min(top, y);
      bottom = Math.max(bottom, y);
    }
  }
  const cropped = blankImage(right - left + 1, bottom - top + 1);
  for (let y = 0; y < cropped.height; y++) {
    const from = ((top + y) * image.width + left) * 4;
    cropped.data.set(image.data.subarray(from, from + cropped.width * 4), y * cropped.width * 4);
  }
  return cropped;
}

// Each target pixel averages the source area it covers, weighted by alpha so
// transparent pixels lend no colour.
export function resizeArea(source, width, height = width) {
  const target = blankImage(width, height);
  const stepX = source.width / width;
  const stepY = source.height / height;
  for (let y = 0; y < height; y++) {
    const [y0, y1] = [y * stepY, (y + 1) * stepY];
    for (let x = 0; x < width; x++) {
      const [x0, x1] = [x * stepX, (x + 1) * stepX];
      let alpha = 0;
      const colour = [0, 0, 0];
      for (let sy = Math.floor(y0); sy < Math.ceil(y1); sy++) {
        const wy = Math.min(y1, sy + 1) - Math.max(y0, sy);
        for (let sx = Math.floor(x0); sx < Math.ceil(x1); sx++) {
          const at = (sy * source.width + sx) * 4;
          const weight = wy * (Math.min(x1, sx + 1) - Math.max(x0, sx)) * source.data[at + 3];
          alpha += weight;
          for (let c = 0; c < 3; c++) colour[c] += weight * source.data[at + c];
        }
      }
      const out = (y * width + x) * 4;
      if (alpha === 0) continue;
      for (let c = 0; c < 3; c++) target.data[out + c] = Math.round(colour[c] / alpha);
      target.data[out + 3] = Math.round(alpha / (stepX * stepY));
    }
  }
  return target;
}
