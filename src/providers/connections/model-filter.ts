export interface ModelCatalogMetadata {
  readonly id: string;
  readonly displayName?: string;
}

/** Image-model words that are trusted anywhere in the routing id or display name. */
const IMAGE_MODEL_NAMES = new Set([
  'imagen',
  'imagine',
  'dalle',
  'midjourney',
  'flux',
  'sdxl',
  'sd3',
  'ideogram',
  'recraft',
  'leonardo',
  'kandinsky',
  'seedream',
  'seededit',
  'pixart',
  'cogview',
  'kolors',
]);

/** Ids such as `gpt-image1`, `imagen4`, `dalle3` and `flux1-schnell`. */
const VERSIONED_IMAGE_MODEL = /^(?:image|imagen|dalle|flux)\d+$/;

/**
 * Image model names that are commonly joined without separators by providers.
 * Matched against the id or display name with all separators removed.
 */
const IMAGE_MODEL_COMPACT_PATTERNS = [
  'nanobanana',
  'qwenimage',
  'hunyuanimage',
  'stablediffusion',
  'text2image',
  'txt2image',
  'img2img',
  'image2image',
] as const;

/**
 * Display-name phrases that describe image output. A bare "image" in a
 * display name usually describes image input on a chat model, so it is not
 * enough on its own.
 */
const IMAGE_OUTPUT_PHRASES = [
  'image generation',
  'image generator',
  'image editing',
  'text to image',
] as const;

function words(value: string | undefined): string[] {
  if (!value) return [];
  const text = value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  return text ? text.split(' ') : [];
}

function namesImageModel(tokens: readonly string[]): boolean {
  if (tokens.some(token => IMAGE_MODEL_NAMES.has(token) || VERSIONED_IMAGE_MODEL.test(token))) return true;
  const compact = tokens.join('');
  return IMAGE_MODEL_COMPACT_PATTERNS.some(pattern => compact.includes(pattern));
}

/**
 * Returns whether a catalog entry identifies an image-generation model.
 *
 * Provider catalogs do not expose a portable capability field. The picker
 * therefore uses the model's advertised id and display name as a conservative
 * presentation filter. Routing ids are terse, so an `image` segment there
 * marks an image model (`gpt-image-1`, `gemini-2.5-flash-image`); display
 * names must name a known image model or describe image output, because chat
 * models often mention image input. This keeps image-only models out of the
 * chess opponent choices without changing the raw provider catalog or
 * preventing an explicit manual model id from being used.
 */
export function isImageGenerationModel(model: ModelCatalogMetadata): boolean {
  const idTokens = words(model.id);
  if (idTokens.includes('image') || idTokens.includes('images') || namesImageModel(idTokens)) return true;

  const nameTokens = words(model.displayName);
  if (namesImageModel(nameTokens)) return true;
  const name = nameTokens.join(' ');
  return IMAGE_OUTPUT_PHRASES.some(phrase => name.includes(phrase));
}
