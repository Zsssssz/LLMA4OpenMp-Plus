import * as vscode from "vscode";
import { eventEmitter } from "../../events/eventEmitter";
import { loggingProvider } from "../../providers/loggingProvider";
import { OllamaAIModel } from "./types";
import { InteractionSettings, Settings } from "../../types/Settings";
import { asyncIterator } from "../asyncIterator";
import { AIProvider, GetInteractionSettings } from "../base";
import { delay } from "../delay";
import {
	OllamaRequest,
	OllamaResponse,
	OllamaChatMessage,
	OllamaChatRequest,
	OllamaChatResponse,
} from "./types";
import { commonChatPrompt, commonParallelizePrompt, commonReviewPrompt } from "../common";
import { ReviewResult } from "../../types/Review";

export class Ollama implements AIProvider {
	decoder = new TextDecoder();
	settings: Settings["ollama"];
	chatHistory: OllamaChatMessage[] = [];
	chatModel: OllamaAIModel | undefined;
	interactionSettings: InteractionSettings | undefined;

	constructor() {
		const config = vscode.workspace.getConfiguration("VscOMP");

		const activeProvider = config.get<Settings["aiProvider"]>("Provider");

		if (activeProvider !== "Ollama") {
			return;
		}

		const ollamaConfig = config.get<Settings["ollama"]>("Ollama");

		loggingProvider.logInfo(
			`Ollama settings loaded: ${JSON.stringify(ollamaConfig)}`
		);

		if (!ollamaConfig) {
			this.handleError("Unable to load Ollama settings.");
			return;
		}

		this.settings = ollamaConfig;

		this.interactionSettings = GetInteractionSettings();

		this.validateSettings();
	}

	private handleError(message: string) {
		vscode.window.showErrorMessage(message);
		loggingProvider.logError(message);
		//eventEmitter._onFatalError.fire();
	}

	private async validateSettings() {
		if (
			!(await this.validateModelExists(
				this.settings?.chatModel ?? "unknown"
			))
		) {
			this.handleError(
				`Unable to verify Ollama has chat model: ${this.settings?.chatModel}, have you pulled the model or is the config wrong?`
			);
		}
	}

	public async validateModelExists(modelName: string): Promise<boolean> {
		try {
			const response = await fetch(
				new URL(
					`${this.settings?.baseUrl}${this.settings?.modelInfoPath}`
				),
				{
					method: "POST",
					body: JSON.stringify({
						name: modelName,
					}),
				}
			);

			if (response.status === 200) {
				return true;
			}
		} catch (error) {
			loggingProvider.logInfo(JSON.stringify(error));
		}

		return false;
	}

	private async fetchModelResponse(
		payload: OllamaRequest,
		signal: AbortSignal
	) {
		if (signal.aborted) {
			return undefined;
		}
		return await fetch(
			new URL(`${this.settings?.baseUrl}${this.settings?.apiPath}`),
			{
				method: "POST",
				body: JSON.stringify(payload),
				signal,
			}
		);
	}

	private async fetchChatResponse(
		payload: OllamaChatRequest,
		signal: AbortSignal
	) {
		if (signal.aborted) {
			return undefined;
		}
		return await fetch(new URL(`${this.settings?.baseUrl}/api/chat`), {
			method: "POST",
			body: JSON.stringify(payload),
			signal,
		});
	}

	async *generate(payload: OllamaChatRequest, signal: AbortSignal) {
		const startTime = new Date().getTime();
		let response: Response | undefined;

		try {
			response = await this.fetchChatResponse(payload, signal);
		} catch (error) {
			loggingProvider.logError(
				`Ollama chat request with model: ${payload.model} failed with the following error: ${error}`
			);
		}

		if (!response?.body) {
			return "";
		}

		const endTime = new Date().getTime();
		const executionTime = (endTime - startTime) / 1000;

		loggingProvider.logInfo(
			`Ollama - Chat Time To First Token execution time: ${executionTime} seconds`
		);

		for await (const chunk of asyncIterator(response.body)) {
			if (signal.aborted) {
				return;
			}

			try {
				const jsonString = this.decoder.decode(chunk);
				const message = JSON.parse(jsonString) as OllamaChatResponse;
				if (message.error) {
					throw new Error(message.error);
				}
				yield message;
			} catch (e) {
				console.warn(e);
			}
		}
	}

	private async *generateCode(
		payload: OllamaRequest,
		signal: AbortSignal
	): AsyncGenerator<string> {
		const startTime = Date.now();
		let response: Response | undefined;

		try {
			response = await this.fetchModelResponse(payload, signal);
		} catch (error) {
			loggingProvider.logError(
				`Ollama chat request with model: ${payload.model} failed with the following error: ${error}`
			);
			eventEmitter._onQueryComplete.fire();
			return "";
		}

		if (!response?.body) {
			return "";
		}

		const endTime = Date.now();
		const executionTime = endTime - startTime;

		loggingProvider.logInfo(
			`Ollama - Code Time To First Token execution time: ${executionTime} ms`
		);

		for await (const chunk of asyncIterator(response.body)) {
			if (signal.aborted) {
				loggingProvider.logInfo("Aborted while reading chunks");
				return "";
			}
			const jsonString = this.decoder.decode(chunk);
			// we can have more then one ollama response
			const jsonStrings = jsonString
				.replace(/}\n{/gi, "}\u241e{")
				.split("\u241e");
			try {
				let codeLines: string[] = [];
				for (const json of jsonStrings) {
					const result = JSON.parse(json) as OllamaResponse;
					codeLines.push(result.response);
				}
				yield codeLines.join("");
			} catch (e) {
				loggingProvider.logError(
					`Error occured on ollama code generation ${e}`
				);
				eventEmitter._onQueryComplete.fire();
				return "";
			}
		}
	}

	public clearChatHistory(): void {
		this.chatHistory = [];
	}

	public async *chat(
		prompt: string,
		ragContent: string,
		signal: AbortSignal
	) {
		const systemMessage: OllamaChatMessage = {
			role: "assistant",
			content: !ragContent
				? commonChatPrompt
				: `Here's some additional information that may help you generate a more accurate response.
Please determine if this information is relevant and can be used to supplement your response: 
${ragContent}`,
		};

		const userMessage: OllamaChatMessage = {
			role: "user",
			content: prompt,
		};

		this.chatHistory.push(systemMessage, userMessage);

		const messages: OllamaChatMessage[] = [];

		if (this.chatHistory.length > 0) {
			messages.push(...this.truncateChatHistory());
		}

		const chatPayload: OllamaChatRequest = {
			model: this.settings?.chatModel!,
			stream: true,
			messages,
			options: {
				num_predict: this.interactionSettings?.chatMaxTokens ?? -1,
				temperature: 0.4,
				top_k: 30,
				top_p: 0.2,
				repeat_penalty: 1.1,
			},
		};

		loggingProvider.logInfo(
			`Ollama - Chat submitting request with body: ${JSON.stringify(
				chatPayload
			)}`
		);

		let lastAssistantMessage = "";
		for await (const chunk of this.generate(chatPayload, signal)) {
			lastAssistantMessage += chunk.message;
			yield chunk.message.content;
		}
		if (lastAssistantMessage?.trim()) {
			this.chatHistory.push({
				role: "assistant",
				content: lastAssistantMessage,
			});
		}
	}

	private truncateChatHistory(maxRecords: number = 2) {
		if (this.chatHistory.length > maxRecords) {
			this.chatHistory.splice(0, this.chatHistory.length - maxRecords);
		}
		return this.chatHistory;
	}

	public async parallelize(
		prompt: string,
		ragContent: string,
		signal: AbortSignal
	): Promise<string> {
		const systemPrompt = commonParallelizePrompt;

		let userPrompt = prompt;
		if (ragContent) {
			userPrompt += `\n\n【优化反馈】请根据以下反馈修改代码：\n${ragContent}`;
		}

		const refactorPayload: OllamaRequest = {
			model: this.settings?.chatModel!,
			prompt: userPrompt,
			system: systemPrompt,
			stream: false,
			options: {
				num_predict: this.interactionSettings?.chatMaxTokens ?? -1,
				temperature: 0.4,
				top_k: 20,
				top_p: 0.2,
				repeat_penalty: 1.1,
				stop: [
					"<｜end▁of▁sentence｜>",
					"<｜EOT｜>",
					"</s>",
					"<|eot_id|>",
					"<｜fim▁end｜>",
				],
			},
		};

		loggingProvider.logInfo(
			`Ollama - Refactor submitting request with body: ${JSON.stringify(
				refactorPayload
			)}`
		);

		const response = await this.fetchModelResponse(refactorPayload, signal);
		if (!response) {
			return "";
		}
		const responseObject = (await response.json()) as OllamaResponse;
		return responseObject.response;
	}

	public async review(
		originalCode: string,
		parallelizedCode: string,
		signal: AbortSignal
	): Promise<ReviewResult> {
		const prompt = `
原始代码：
\`\`\`c
${originalCode}
\`\`\`

并行化代码：
\`\`\`c
${parallelizedCode}
\`\`\`

请进行评审。
`;

		const reviewPayload: OllamaRequest = {
			model: this.settings?.chatModel!,
			prompt: prompt,
			system: commonReviewPrompt,
			stream: false,
			options: {
				num_predict: this.interactionSettings?.chatMaxTokens ?? -1,
				temperature: 0.2,
				top_k: 20,
				top_p: 0.2,
				repeat_penalty: 1.1,
				stop: [
					"<｜end▁of▁sentence｜>",
					"<｜EOT｜>",
					"</s>",
					"<|eot_id|>",
					"<｜fim▁end｜>",
				],
			},
		};

		loggingProvider.logInfo(
			`Ollama - Review submitting request with body: ${JSON.stringify(
				reviewPayload
			)}`
		);

		try {
			const response = await this.fetchModelResponse(reviewPayload, signal);
			if (!response) {
				return {
					hasIssues: true,
					score: 0,
					issues: [],
					suggestions: [],
					summary: "评审请求失败",
				};
			}
			const responseObject = (await response.json()) as OllamaResponse;
			return this.parseReviewResult(responseObject.response);
		} catch (error) {
			loggingProvider.logError(`Ollama review error: ${error}`);
			return {
				hasIssues: true,
				score: 0,
				issues: [],
				suggestions: [],
				summary: "评审服务调用失败",
			};
		}
	}

	private parseReviewResult(content: string): ReviewResult {
		const scoreMatch = content.match(/【评审分数】(\d+)/);
		const passedMatch = content.match(/【是否通过】(是|否)/);
		const summaryMatch = content.match(/【摘要】(.+)/);

		const score = scoreMatch ? parseInt(scoreMatch[1]) : 50;
		const passed = passedMatch?.[1] === "是";
		const summary = summaryMatch?.[1] || "未提供摘要";

		const issueMatches = content.match(/- \[(严重|警告|提示)\] \[(.+?)\]：(.+?)(?=\n建议：)/g) || [];
		const issues = issueMatches.map((match) => {
			const parts = match.match(/- \[(严重|警告|提示)\] \[(.+?)\]：(.+)/);
			if (!parts) return null;
			const severity = parts[1] === "严重" ? "critical" : parts[1] === "警告" ? "warning" : "info";
			const type = parts[2] === "correctness" || parts[2] === "性能" ? "performance" : 
				parts[2] === "style" || parts[2] === "规范" ? "style" : "correctness";
			return {
				severity,
				type,
				description: parts[3],
				suggestion: "",
			};
		}).filter((i): i is ReviewResult["issues"][0] => i !== null);

		const suggestionMatches = content.match(/【优化建议】\n([\s\S]*?)(?=\n【|$)/);
		const suggestions = suggestionMatches ? 
			suggestionMatches[1].split("\n").filter(s => s.trim() && !s.startsWith("【")).map(s => s.replace(/^\d+\.\s*/, "").trim()) : [];

		return {
			hasIssues: !passed || issues.length > 0,
			score,
			issues,
			suggestions,
			summary,
		};
	}
}
