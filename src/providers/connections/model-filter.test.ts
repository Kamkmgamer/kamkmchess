import { describe, expect, it } from 'vitest';
import { isImageGenerationModel } from './model-filter';

describe('image-generation model filtering', () => {
  it.each([
    { id: 'gpt-image-1' },
    { id: 'openai/gpt-image1' },
    { id: 'google/imagen-4.0-generate-preview', displayName: 'Imagen 4' },
    { id: 'google/imagen4' },
    { id: 'gemini-2.5-flash-image', displayName: 'Nano Banana' },
    { id: 'nano_banana_pro' },
    { id: 'black-forest-labs/FLUX.1-dev' },
    { id: 'black-forest-labs/flux1-schnell' },
    { id: 'openai/dalle3' },
    { id: 'stabilityai/stable-diffusion-xl-base-1.0' },
    { id: 'vendor/custom-model', displayName: 'Text to Image' },
    { id: 'vendor/custom-model', displayName: 'Image Generation Preview' },
    { id: 'gemini-2.5-flash-image-preview' },
    { id: 'Qwen/Qwen-Image' },
  ])('recognizes $id as an image-generation model', model => {
    expect(isImageGenerationModel(model)).toBe(true);
  });

  it.each([
    { id: 'openai/gpt-4.1', displayName: 'GPT-4.1' },
    { id: 'anthropic/claude-sonnet-4' },
    { id: 'google/gemini-2.5-flash' },
    { id: 'deepseek/deepseek-r1' },
    { id: 'vendor/visual-reasoner', displayName: 'Vision language model' },
    { id: 'openai/gpt-4o', displayName: 'GPT-4o (text + image input)' },
    { id: 'meta-llama/llama-3.2-11b-vision-instruct', displayName: 'Llama 3.2 Vision: image understanding' },
    { id: 'qwen/qwen2.5-vl-72b', displayName: 'Qwen2.5 VL (image-to-text)' },
    { id: 'mistralai/pixtral-large' },
    { id: 'playground-chat-v1' },
    { id: 'fluxion-7b' },
    { id: 'imaginary-llm' },
  ])('keeps conversational model $id available', model => {
    expect(isImageGenerationModel(model)).toBe(false);
  });

  it('considers the display name as well as the routing id', () => {
    expect(isImageGenerationModel({ id: 'vendor/model', displayName: 'Imagen' })).toBe(true);
  });
});
