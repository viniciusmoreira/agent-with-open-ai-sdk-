export interface EmbeddingsPort {
  embedTexts(texts: string[]): Promise<number[][]>;
}
