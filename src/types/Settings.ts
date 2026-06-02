export const defaultMaxTokens = -1;

interface BaseServiceSettings {
	chatModel: string;
	baseUrl: string;
}

export interface InteractionSettings {
	codeMaxTokens: number;
	chatContextWindow: number;
	chatMaxTokens: number;
}

const AiProviders = ["Ollama", "OpenAI"] as const;
export const AiProvidersList: string[] = [...AiProviders];

export type OllamaSettingsType = BaseServiceSettings & {
	apiPath: string;
	modelInfoPath: string;
};

export type ApiSettingsType = BaseServiceSettings & {
	apiKey: string;
};

export const defaultOllamaSettings: OllamaSettingsType = {
	chatModel: "deepseek-coder-v2:16b-lite-instruct-q4_0",
	baseUrl: "http://localhost:11434",
	apiPath: "/api/generate",
	modelInfoPath: "/api/show",
};

export const defaultOpenAISettings: ApiSettingsType = {
	chatModel: "gpt-4-turbo",
	baseUrl: "https://api.openai.com/v1/chat/completions",
	apiKey: "Add me",
};

export interface Settings {
	aiProvider: (typeof AiProviders)[number];
	interactionSettings: InteractionSettings;
	ollama?: OllamaSettingsType;
	openai?: ApiSettingsType;
}
