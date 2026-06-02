import * as vscode from "vscode";
import { loggingProvider } from "../providers/loggingProvider";
import { InteractionSettings, Settings } from "../types/Settings";
import { Ollama } from "./ollama/ollama";
import { OpenAI } from "./openai/openai";
import { Reviewer } from "./reviewer";
import { ReviewResult, ReviewerConfig } from "../types/Review";

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
	let model = config.get<string>("Reviewer.model") || "gpt-4o";
	let rules = config.get<string[]>("Reviewer.openmpRules") || [];

	if (!apiKey || apiKey === "YOUR_REVIEWER_API_KEY") {
		apiKey = "YOUR_REVIEWER_API_KEY";
		apiEndpoint = "https://api.openai.com/v1/chat/completions";
	}

const defaultRules = [
    "1. 【基础指令规则】",
    "   - 必须使用：#pragma omp parallel for",
	"   - 对于多层循环，只并行那些没有依赖的循环层（可以是外层，也可以是内层，还能多层一起collapse）;若有依赖的循环层，则必须保持串行",
    "",
    "2. 【循环变量规则】",
    "   - 循环变量var如果声明在指令外部，必须显式声明 private(var)，不得默认私有化",
    "",
    "3. 【数据依赖规则】",
	"   - 对于多层循环，只并行那些没有依赖的循环层（可以是外层，也可以是内层，还能多层一起collapse）;若有依赖的循环层，则必须保持串行",
    "",
    "4. 【共享/私有变量规则】",
    "  - firstprivate：循环开始前需要特定值的变量使用",
    "   - lastprivate：循环内赋值但循环后使用的变量使用,**默认赋值变量在循环后使用**",
	"   - lastprivate 不会产生竞争，是正确用法",
    "",
    "5. 【规约 reduction 规则】",
    "   - 聚合操作（sum +=、max=、min=、*=、&、|、^）必须加 reduction",
    "   - 格式必须正确：reduction(+:sum)、reduction(max:val)",
    "",
    "6. 【collapse 规则】",
    "   - 仅用于多层连续独立嵌套循环",
    "   - 层数必须匹配，不能误用",
    "",
	"7. 【重要约束 · 绝对禁止】",
    "   -绝不评价代码美观、简洁、冗余",
    "   -绝不提出任何代码重构、逻辑修改、算法优化",
    "   -只判断是否符合OpenMP安全与语法规则",
    "   -只针对可并行的for循环提出问题",
    "   -不允许添加规则外的任何建议"
];

	const openmpRules = rules.length > 0 ? rules : defaultRules;

	if (!apiKey || apiKey === "YOUR_REVIEWER_API_KEY") {
		loggingProvider.logInfo("Reviewer API key not configured, skipping");
		return null;
	}

	const reviewerConfig: ReviewerConfig = {
		apiKey,
		apiEndpoint,
		model,
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
		signal: AbortSignal
	): Promise<ReviewResult>;
}
