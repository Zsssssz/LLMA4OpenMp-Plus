import * as vscode from "vscode";
import { asyncIterator } from "../asyncIterator";
import { AIProvider, GetInteractionSettings } from "../base";
import {
	InteractionSettings,
	Settings,
	defaultMaxTokens,
} from "../../types/Settings";
import { loggingProvider } from "../../providers/loggingProvider";
import { eventEmitter } from "../../events/eventEmitter";
import {
	commonChatPrompt,
	commonParallelizePrompt,
	commonReviewPrompt,
} from "../common";
import { OpenAIMessages, OpenAIRequest } from "./types/OpenAIRequest";
import { OpenAIResponse, OpenAIStreamResponse } from "./types/OpenAIResponse";
import { OpenAIModel } from "../../types/Models";
import { ReviewResult } from "../../types/Review";

export class OpenAI implements AIProvider {
	decoder = new TextDecoder();
	settings: Settings["openai"];
	chatHistory: OpenAIMessages[] = [];
	chatModel: OpenAIModel | undefined;
	interactionSettings: InteractionSettings | undefined;

	constructor() {
		const config = vscode.workspace.getConfiguration("VscOMP");

		const openaiConfig = config.get<Settings["openai"]>("OpenAI");

		loggingProvider.logInfo(
			`OpenAI settings loaded: ${JSON.stringify(openaiConfig)}`
		);

		if (!openaiConfig) {
			this.handleError("Unable to load OpenAI settings.");
			return;
		}

		this.settings = openaiConfig;

		this.interactionSettings = GetInteractionSettings();
	}

	private handleError(message: string) {
		vscode.window.showErrorMessage(message);
		loggingProvider.logError(message);
		eventEmitter._onFatalError.fire();
	}

	private async fetchModelResponse(
		payload: OpenAIRequest,
		signal: AbortSignal
	) {
		if (signal.aborted) {
			return undefined;
		}
		return fetch(new URL(this.settings?.baseUrl!), {
			method: "POST",
			body: JSON.stringify(payload),
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${this.settings?.apiKey}`,
			},
			signal,
		});
	}

	async *generate(payload: OpenAIRequest, signal: AbortSignal) {
		const startTime = new Date().getTime();
		let response: Response | undefined;

		try {
			response = await this.fetchModelResponse(payload, signal);
		} catch (error) {
			loggingProvider.logError(
				`OpenAI chat request with model: ${payload.model} failed with the following error: ${error}`
			);
		}

		if (!response?.ok) {
			loggingProvider.logError(
				`OpenAI - Chat failed with the following status code: ${response?.status}`
			);
			vscode.window.showErrorMessage(
				`OpenAI - Chat failed with the following status code: ${response?.status}`
			);
		}

		if (!response?.body) {
			return "";
		}

		const endTime = new Date().getTime();
		const executionTime = (endTime - startTime) / 1000;

		loggingProvider.logInfo(
			`OpenAI - Chat Time To First Token execution time: ${executionTime} seconds`
		);

		let currentMessage = "";
		for await (const chunk of asyncIterator(response.body)) {
			if (signal.aborted) {
				return "";
			}

			const decodedValue = this.decoder.decode(chunk);

			currentMessage += decodedValue;

			// Check if we have a complete event
			const eventEndIndex = currentMessage.indexOf("\n\n");
			if (eventEndIndex !== -1) {
				// Extract the event data
				const eventData = currentMessage.substring(0, eventEndIndex);

				// Remove the event data from currentMessage
				currentMessage = currentMessage.substring(eventEndIndex + 2);

				// Remove the "data: " prefix and parse the JSON
				const jsonStr = eventData.replace(/^data: /, "");
				yield JSON.parse(jsonStr) as OpenAIStreamResponse;
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
		let systemPrompt = commonChatPrompt;

		if (ragContent) {
			systemPrompt += `Here's some additional information that may help you generate a more accurate response.
            Please determine if this information is relevant and can be used to supplement your response: 
            ${ragContent}
			---------------`;
		}

		systemPrompt += `\n${prompt}`;

		systemPrompt = systemPrompt.replace(/\t/, "");

		const chatPayload: OpenAIRequest = {
			model: this.settings?.chatModel!,
			messages: [
				...this.chatHistory,
				{
					role: "user",
					content: systemPrompt,
				},
			],
			stream: true,
			temperature: 0.8,
		};

		loggingProvider.logInfo(
			`OpenAI - Chat submitting request with body: ${JSON.stringify(
				chatPayload
			)}`
		);

		this.clearChatHistory();

		let completeMessage = "";
		for await (const chunk of this.generate(chatPayload, signal)) {
			if (!chunk?.choices) {
				continue;
			}

			const { content } = chunk.choices[0].delta;
			if (!content) {
				continue;
			}

			completeMessage += content;
			yield content;
		}

		this.chatHistory = this.chatHistory.concat({
			role: "assistant",
			content: completeMessage,
		});
	}

	public async parallelize(
		prompt: string,
		ragContent: string,
		signal: AbortSignal
	): Promise<string> {

		const startTime = new Date().getTime();

		const systemPrompt = commonParallelizePrompt;

		let userPrompt = prompt;
		if (ragContent) {
			userPrompt += `\n\n【优化反馈】请根据以下反馈修改代码：\n${ragContent}`;
		}

		const refactorPayload: OpenAIRequest = {
			model: this.settings?.chatModel!,
			messages: [
				{
					role: "system" as unknown as "user" | "assistant",
					content: systemPrompt,
				},
				{
					role: "user",
					content: userPrompt,
				},
			],
			temperature: 0.4,
			top_p: 0.3,
		};

		let response: Response | undefined;
		try {
			response = await this.fetchModelResponse(refactorPayload, signal);
		} catch (error) {
			loggingProvider.logError(
				`OpenAI - Refactor request failed with the following error: ${error}`
			);
		}

		const endTime = new Date().getTime();
		const executionTime = (endTime - startTime) / 1000;

		loggingProvider.logInfo(
			`OpenAI - Refactor execution time: ${executionTime} seconds`
		);

		if (!response?.ok) {
			loggingProvider.logError(
				`OpenAI - Refactor failed with the following status code: ${response?.status}`
			);
			vscode.window.showErrorMessage(
				`OpenAI - Refactor failed with the following status code: ${response?.status}`
			);
		}

		if (!response?.body) {
			return "";
		}

		const openAiResponse = (await response.json()) as OpenAIResponse;
		return openAiResponse.choices[0].message.content;
	}

	public async review(
		originalCode: string,
		parallelizedCode: string,
		signal: AbortSignal
	): Promise<ReviewResult> {
		const userPrompt = `
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

		const reviewPayload: OpenAIRequest = {
			model: this.settings?.chatModel!,
			messages: [
				{
					role: "system" as unknown as "user" | "assistant",
					content: commonReviewPrompt,
				},
				{
					role: "user",
					content: userPrompt,
				},
			],
			temperature: 0.2,
			top_p: 0.3,
		};

		loggingProvider.logInfo(
			`OpenAI - Review submitting request with body: ${JSON.stringify(
				reviewPayload
			)}`
		);

		try {
			const response = await this.fetchModelResponse(reviewPayload, signal);
			if (!response?.ok) {
				loggingProvider.logError(
					`OpenAI - Review failed with status: ${response?.status}`
				);
				return {
					hasIssues: true,
					score: 0,
					issues: [],
					suggestions: [],
					summary: "评审请求失败",
				};
			}

			const openAiResponse = (await response.json()) as OpenAIResponse;
			return this.parseReviewResult(openAiResponse.choices[0].message.content);
		} catch (error) {
			loggingProvider.logError(`OpenAI review error: ${error}`);
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
