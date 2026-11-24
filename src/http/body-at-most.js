// A response body's bytes, or null once more than maxBytes arrived: the rest is
// not read, so a body larger than a caller takes is never held in memory whole
// (the paired channel's envelope, host-connection.js; a Provider's export,
// graphiti/provider-client.js).
export async function readBodyAtMost(response, maxBytes) {
  if (Number(response.headers.get('content-length')) > maxBytes) {
    await response.body?.cancel();
    return null;
  }
  const chunks = [];
  let size = 0;
  const reader = response.body?.getReader();
  for (let read = await reader?.read(); read && !read.done; read = await reader.read()) {
    size += read.value.length;
    if (size > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(read.value);
  }
  return Buffer.concat(chunks);
}
