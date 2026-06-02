export interface AppMessage {
	command: string;
	value: unknown;
}

export interface ChatMessage {
	from: "assistant" | "user";
	message: string;
	loading?: boolean;
}