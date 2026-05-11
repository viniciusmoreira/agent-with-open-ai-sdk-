import { decode as defaultDecode, encode as defaultEncode } from "gpt-tokenizer";

const DEFAULT_CHUNK_SIZE = 1000;
const DEFAULT_OVERLAP = 150;

export type Tokenizer = {
  encode: (text: string) => number[];
  decode: (ids: number[]) => string;
};

export type ChunkOptions = {
  chunkSize?: number;
  overlap?: number;
  tokenizer?: Tokenizer;
};

export function chunkText(text: string, options: ChunkOptions = {}): string[] {
  const chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const overlap = options.overlap ?? DEFAULT_OVERLAP;
  if (chunkSize <= 0) {
    throw new Error("chunkSize must be > 0");
  }
  if (overlap < 0 || overlap >= chunkSize) {
    throw new Error("overlap must satisfy 0 <= overlap < chunkSize");
  }

  const tokenizer: Tokenizer =
    options.tokenizer ?? { encode: defaultEncode, decode: defaultDecode };

  const trimmed = text.trim();
  if (trimmed.length === 0) return [];

  const tokens = tokenizer.encode(trimmed);
  if (tokens.length === 0) return [];
  if (tokens.length <= chunkSize) return [trimmed];

  const stride = chunkSize - overlap;
  const chunks: string[] = [];
  for (let start = 0; start < tokens.length; start += stride) {
    const end = Math.min(start + chunkSize, tokens.length);
    const piece = tokenizer.decode(tokens.slice(start, end)).trim();
    if (piece.length > 0) chunks.push(piece);
    if (end === tokens.length) break;
  }
  return chunks;
}

export const CHUNK_DEFAULTS = {
  chunkSize: DEFAULT_CHUNK_SIZE,
  overlap: DEFAULT_OVERLAP,
} as const;
