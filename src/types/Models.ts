export interface AIModel {
	get parallelizePrompt(): string;
	get chatPrompt(): string;
}

export interface OpenAIModel extends AIModel {}

export interface OllamaAIModel extends AIModel {}
