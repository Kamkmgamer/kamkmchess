export type ProviderProtocol =
  | 'chat-completions'
  | 'responses'
  | 'anthropic-messages';

export type ProtocolTerminal =
  | 'complete'
  | 'incomplete'
  | 'failed'
  | 'truncated'
  | 'malformed'
  | 'aborted';

export type ResponsesSchema = 'openai' | 'openrouter-r12';

export type ProtocolContent =
  | 'answer'
  | 'refusal'
  | 'tool-only'
  | 'tool-interrupted'
  | 'empty';

export interface ProtocolRawEvent {
  event: string;
  data: string;
  dataLines: readonly string[];
  frameTerminated: boolean;
  rawBytes: Uint8Array;
  id?: string;
  retry?: number;
  payload?: unknown;
  parseError?: string;
}

export interface ProtocolStreamResult {
  protocol: ProviderProtocol;
  httpStatus?: number;
  terminal: ProtocolTerminal;
  content: ProtocolContent;
  answerText: string;
  reasoningText: string;
  planText: string;
  refusalText: string;
  usage: unknown | null;
  usageRecords: readonly unknown[];
  errors: readonly unknown[];
  incompleteDetails: readonly unknown[];
  toolRecords: readonly unknown[];
  otherChoices: readonly unknown[];
  unknownEvents: readonly ProtocolRawEvent[];
  raw: {
    chunks: readonly Uint8Array[];
    events: readonly ProtocolRawEvent[];
  };
}

export interface ProtocolStreamDecoder {
  push(chunk: Uint8Array): void;
  abort(): void;
  finish(): ProtocolStreamResult;
}

export interface ProtocolStreamMetadata {
  httpStatus?: number;
  responsesSchema?: ResponsesSchema;
}

export interface ProtocolTextRecord {
  id: string;
  role: 'user' | 'assistant';
  text: string;
}

export interface ProtocolHistory {
  instructions: string;
  records: readonly ProtocolTextRecord[];
}

export interface ProtocolGenerationConfig {
  model: string;
  maxOutputTokens: number;
  temperature?: number;
  topP?: number;
}

export interface EncodedProtocolRequest {
  body: Readonly<Record<string, unknown>>;
  sourceRecordIds: readonly string[];
}
