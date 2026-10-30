import chatgpt from './logos/chatgpt.svg';
import claude from './logos/claude.svg';
import gemini from './logos/gemini.svg';
import grok from './logos/grok.svg';
import kimi from './logos/kimi.svg';
import glm from './logos/glm.svg';
import deepseek from './logos/deepseek.svg';
import qwen from './logos/qwen.svg';
import llama from './logos/llama.svg';
import mistral from './logos/mistral.svg';
import minimax from './logos/minimax.svg';
import stockfish from './logos/stockfish.webp';
import leela from './logos/leela.svg';

export const OPPONENT_BRANDS = {
  chatgpt: { name: 'ChatGPT', logo: chatgpt },
  claude: { name: 'Claude', logo: claude },
  gemini: { name: 'Gemini', logo: gemini },
  grok: { name: 'Grok', logo: grok },
  kimi: { name: 'Kimi', logo: kimi },
  glm: { name: 'GLM / Z.ai', logo: glm },
  deepseek: { name: 'DeepSeek', logo: deepseek },
  qwen: { name: 'Qwen', logo: qwen },
  llama: { name: 'Llama / Meta', logo: llama },
  mistral: { name: 'Mistral', logo: mistral },
  minimax: { name: 'MiniMax', logo: minimax },
  stockfish: { name: 'Stockfish', logo: stockfish },
  leela: { name: 'Leela Chess Zero', logo: leela },
} as const;

export type OpponentBrand = keyof typeof OPPONENT_BRANDS;

const families: readonly [OpponentBrand, RegExp][] = [
  ['stockfish', /(?:^|[^a-z0-9])stockfish(?=$|[^a-z])/],
  ['leela', /(?:^|[^a-z0-9])(?:leela|lila-chess|lc0|lczero)(?=$|[^a-z])/],
  ['chatgpt', /(?:^|[^a-z0-9])(?:chat-?gpt|gpt|codex)(?=$|[^a-z])|(?:^|[^a-z0-9])o[134](?=$|[^a-z0-9])/],
  ['claude', /(?:^|[^a-z0-9])(?:claude|sonnet|opus|haiku)(?=$|[^a-z])/],
  ['gemini', /(?:^|[^a-z0-9])gemini(?=$|[^a-z])/],
  ['grok', /(?:^|[^a-z0-9])grok(?=$|[^a-z])/],
  ['kimi', /(?:^|[^a-z0-9])(?:kimi|moonshot)(?=$|[^a-z])/],
  ['glm', /(?:^|[^a-z0-9])(?:chatglm|glm|z[.-]?ai|zhipu)(?=$|[^a-z])/],
  ['deepseek', /(?:^|[^a-z0-9])deepseek(?=$|[^a-z])/],
  ['qwen', /(?:^|[^a-z0-9])(?:qwen|qwq|qvq)(?=$|[^a-z])/],
  ['llama', /(?:^|[^a-z0-9])llama(?=$|[^a-z])/],
  ['mistral', /(?:^|[^a-z0-9])(?:mistral|mixtral|codestral|devstral|ministral|magistral)(?=$|[^a-z])/],
  ['minimax', /(?:^|[^a-z0-9])minimax(?=$|[^a-z])/],
];

/** Match the model or agent name before its routing namespace, never the proxy connection. */
export function resolveOpponentBrand(modelId: string): OpponentBrand | null {
  const segments = modelId.trim().toLowerCase().replace(/[_\s]+/g, '-').split('/').reverse();
  for (const segment of segments) {
    const match = families.find(([, pattern]) => pattern.test(segment));
    if (match) return match[0];
  }
  return null;
}

/** The marker the server and the page append to a name an agent chose itself. */
const SELF_REPORTED = /\s*\(self-reported\)\s*$/i;

/** A self-reported agent name without the marker, ready to display and to match. */
export function cleanReportedName(label: string): string {
  return label.replace(SELF_REPORTED, '').trim();
}

/** The family of a name an agent reported for itself, marker removed first. */
export function resolveReportedBrand(label: string): OpponentBrand | null {
  return resolveOpponentBrand(cleanReportedName(label));
}
