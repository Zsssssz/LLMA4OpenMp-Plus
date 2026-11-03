import * as vscode from "vscode";
import { loggingProvider } from "../providers/loggingProvider";
import { InteractionSettings, Settings } from "../types/Settings";
import { Ollama } from "./ollama/ollama";
import { OpenAI } from "./openai/openai";
import { Reviewer } from "./reviewer";
import { ReviewResult, ReviewerConfig, ReviewContext } from "../types/Review";
import { defaultOpenMPRules } from "./reviewer/prompts";

export function GetAllSettings(): vscode.WorkspaceConfiguration {
	return vscode.workspace.getConfiguration("VscOMP");
}

export function GetInteractionSettings(): InteractionSettings {
	const config = vscode.workspace.getConfiguration("VscOMP");

	const interactionSettings = config.get<Settings["interactionSettings"]>(
		"InteractionSettings"
	)!;

	if (interactionSettings) {
		return interactionSettings;
	}

	return {
		codeMaxTokens: -1,
		chatContextWindow: 4096,
		chatMaxTokens: 4096,
	};
}

export function GetProviderFromSettings(): AIProvider {
	const config = vscode.workspace.getConfiguration("VscOMP");

	const aiProvider = config
		.get<Settings["aiProvider"]>("Provider")
		?.toLocaleLowerCase()
		.trim();

	loggingProvider.logInfo(`AI Provider: ${aiProvider} found.`);

	if (aiProvider === "openai") {
		return new OpenAI();
	}

	return new Ollama();
}

export function GetReviewerFromSettings(): Reviewer | null {
	const config = vscode.workspace.getConfiguration("VscOMP");

	let apiKey = config.get<string>("Reviewer.apiKey") || "";
	let apiEndpoint = config.get<string>("Reviewer.apiEndpoint") || "";
	let model = config.get<string>("Reviewer.model") || "deepseek-ai/DeepSeek-V3.2";
	let rules = config.get<string[]>("Reviewer.openmpRules") || [];

	if (!apiKey || apiKey === "YOUR_REVIEWER_API_KEY") {
		apiKey = "YOUR_REVIEWER_API_KEY";
		apiEndpoint = "https://api.openai.com/v1/chat/completions";
	}

	const defaultRules = defaultOpenMPRules;

	const openmpRules = rules.length > 0 ? rules : defaultRules;

	if (!apiKey || apiKey === "YOUR_REVIEWER_API_KEY") {
		loggingProvider.logInfo("Reviewer API key not configured, skipping");
		return null;
	}

	const reviewerConfig: ReviewerConfig = {
		apiKey,
		apiEndpoint,
		model,
		useStructuredAnalysis: config.get<boolean>("Reviewer.useStructuredAnalysis") ?? true,
		useExamples: config.get<boolean>("Reviewer.useExamples") ?? true,
	};

	loggingProvider.logInfo(`Reviewer configured with model: ${model}`);
	return new Reviewer(reviewerConfig, openmpRules);
}

export interface AIProvider {
	clearChatHistory(): void;
	chat(
		prompt: string,
		ragContent: string,
		signal: AbortSignal
	): AsyncGenerator<string>;
	parallelize(
		prompt: string,
		ragContent: string,
		signal: AbortSignal
	): Promise<string>;
	review(
		originalCode: string,
		parallelizedCode: string,
		signal: AbortSignal,
		context?: ReviewContext
	): Promise<ReviewResult>;
}
