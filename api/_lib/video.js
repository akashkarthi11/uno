// AI videos for private rooms. Files live in Vercel Blob; the video is made by Vercel's AI Gateway as a background job (so no
// request ever waits for it). GAME_VIDEO_FAKE=1 (tests) swaps both for in-memory stand-ins.
const fake = () => process.env.GAME_VIDEO_FAKE === '1'; // read at call time (tests set it after the imports)

export const videoDaily = () => Number(process.env.GAME_VIDEO_DAILY) || 5;
export const videoMonthly = () => Number(process.env.GAME_VIDEO_MONTHLY) || 30;
export const STORAGE_MAX = Number(process.env.GAME_VIDEO_STORAGE_MB || 900) * 1024 * 1024; // the free Blob store is about 1 GB: stop before it
export const IMAGE_MAX = 1.5 * 1024 * 1024;
const MODEL_T2V = process.env.GAME_VIDEO_MODEL_T2V || 'alibaba/wan-v2.6-t2v';
const MODEL_I2V = process.env.GAME_VIDEO_MODEL_I2V || 'alibaba/wan-v2.6-i2v';
const SECONDS = Number(process.env.GAME_VIDEO_SECONDS) || 5;

export const videoReady = () => fake() || Boolean(process.env.BLOB_READ_WRITE_TOKEN || process.env.BLOB_STORE_ID);

export async function putFile(name, bytes, contentType) {
  if (fake()) return { url: 'fake://blob/' + name };
  const { put } = await import('@vercel/blob');
  const r = await put(name, Buffer.from(bytes), { access: 'public', addRandomSuffix: true, contentType });
  return { url: r.url };
}

export async function delFiles(urls) {
  const list = urls.filter(Boolean);
  if (!list.length || fake()) return;
  const { del } = await import('@vercel/blob');
  await del(list);
}

/** Starts a background generation. Returns a small JSON value that is later handed to getStatus. */
export async function startVideo({ imageUrl, text }) {
  if (fake()) return { fake: true, text };
  const { experimental_startVideo: start } = await import('ai');
  const { operation } = await start({
    model: imageUrl ? MODEL_I2V : MODEL_T2V,
    prompt: imageUrl ? { image: imageUrl, text } : text,
    duration: SECONDS,
  });
  return operation;
}

/** One status check. { state: 'pending' } | { state: 'error', message } | { state: 'completed', url } | { state: 'completed', bytes } */
export async function getStatus(operation, modelId) {
  if (fake()) {
    if (/slow/.test(operation.text || '')) return { state: 'pending' };
    if (/boom/.test(operation.text || '')) return { state: 'error', message: 'The model refused that prompt.' };
    return { state: 'completed', bytes: Buffer.alloc(2000, 7) };
  }
  const { experimental_getVideoStatus: status } = await import('ai');
  const s = await status(modelId, { operation });
  if (s.status === 'pending') return { state: 'pending' };
  if (s.status === 'error') return { state: 'error', message: String(s.error && s.error.message || s.message || 'The video could not be made.').slice(0, 200) };
  const v = (s.videos || [])[0];
  if (!v) return { state: 'error', message: 'The model returned no video.' };
  if (v.url) return { state: 'completed', url: v.url };
  const raw = v.uint8Array || v.data || v.base64;
  if (raw instanceof Uint8Array) return { state: 'completed', bytes: raw };
  if (typeof raw === 'string') return { state: 'completed', bytes: Buffer.from(raw, 'base64') };
  return { state: 'error', message: 'Unrecognised video result.' };
}

export const modelFor = (hasImage) => (hasImage ? MODEL_I2V : MODEL_T2V);
