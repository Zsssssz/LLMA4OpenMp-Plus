import * as vscode from "vscode";
import { eventEmitter } from "../events/eventEmitter";
import { AIProvider, GetReviewerFromSettings } from "../service/base";
import { AppMessage, ChatMessage } from "../types/Message";
import { InteractionSettings } from "../types/Settings";
import { loggingProvider } from "./loggingProvider";
import { check } from "./parser";
import { Reviewer } from "../service/reviewer";
import { ReviewResult } from "../types/Review";
const Parser = require("web-tree-sitter")

let abortController = new AbortController();

export class ChatViewProvider implements vscode.WebviewViewProvider {
	public static readonly viewType = "vscomp-chat-view";

	private _disposables: vscode.Disposable[] = [];
	private _reviewer: Reviewer | null;

	constructor(
		private readonly _aiProvider: AIProvider,
		private readonly _context: vscode.ExtensionContext,
		private readonly _interactionSettings: InteractionSettings
	) {
		this._reviewer = GetReviewerFromSettings();
	}

	dispose() {
		this._disposables.forEach((d) => d.dispose());
		this._disposables = [];
	}

	public resolveWebviewView(
		webviewView: vscode.WebviewView,
		context: vscode.WebviewViewResolveContext,
		token: vscode.CancellationToken
	) {
		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: [
				this._context.extensionUri,
				vscode.Uri.joinPath(
					this._context.extensionUri,
					"node_modules/vscode-codicons"
				),
			],
		};

		webviewView.webview.html = this.getHtmlForWebview(webviewView.webview);

		token.onCancellationRequested((e) => {
			abortController.abort();
			eventEmitter._onQueryComplete.fire();
		});

		this._disposables.push(
			webviewView.webview.onDidReceiveMessage((data: AppMessage) => {
				if (!data) {
					return;
				}

				const { command, value } = data;

				switch (command) {
					case "chat": {
						this.handleChatMessage({ value, webviewView });
						break;
					}
					case "parallelize": {
						this.handleParallelize({ value, webviewView });
						break;
					}
					case "cancel": {
						abortController.abort();
						break;
					}
					case "clipboard": {
						vscode.env.clipboard.writeText(value as string);
						break;
					}
					case "copyToFile": {
						this.sendContentToNewDocument(value as string);
						break;
					}
					case "clear": {
						this._aiProvider.clearChatHistory();
						break;
					}
					case "ready": {
						webviewView.webview.postMessage({
							command: "init",
							value: {
								workspaceFolder: getActiveWorkspace(),
								theme: vscode.window.activeColorTheme.kind,
							},
						});
						break;
					}
					case "log": {
						this.log(value);
						break;
					}
				}
			}),
			vscode.window.onDidChangeActiveColorTheme(
				(theme: vscode.ColorTheme) => {
					webviewView.webview.postMessage({
						command: "setTheme",
						value: theme.kind,
					});
				}
			)
		);
	}

	private async sendContentToNewDocument(content: string) {
		const newFile = await vscode.workspace.openTextDocument({
			content,
		});
		vscode.window.showTextDocument(newFile);
	}

	private async handleParallelize({
		value,
		webviewView,
	}: Pick<AppMessage, "value"> & { webviewView: vscode.WebviewView }) {
		abortController = new AbortController();

		let editor = vscode.window.activeTextEditor;
        if (!editor) {
            return undefined;
        }
		let { document, selection } = editor;
		let tutorial: string = "";
		Parser.init().then(async() => {
			console.log(vscode.Uri.joinPath(this._context.extensionUri, 'out', `tree-sitter-${document.languageId}.wasm`).fsPath);
			const language = await Parser.Language.load(vscode.Uri.joinPath(this._context.extensionUri, 'out', `tree-sitter-${document.languageId}.wasm`).fsPath);
			const parser = new Parser;
			parser.setLanguage(language);
			let tree = parser.parse(editor.document.getText(selection));
			tutorial = check(tree);
			console.log(tutorial);
			
			await this.streamParallelizeResponse(
				tutorial as string,
				webviewView
			);
		});
	}

	private async streamParallelizeResponse(
		tutorial: string,
		webviewView: vscode.WebviewView
	) {

		eventEmitter._onQueryStart.fire();

		let editor = vscode.window.activeTextEditor;
		if (!editor) {
			return undefined;
		}
		let selection = editor.selection;
		let originalCode = editor.document.getText(selection);
		
		if (originalCode === "") {
			webviewView.webview.postMessage({
				command: "response",
				value: "You need to select some code first!\n",
			});
			eventEmitter._onQueryComplete.fire();
			webviewView.webview.postMessage({ command: "done", value: null });
			return;
		}

		if (tutorial === "false") {
			webviewView.webview.postMessage({
				command: "response",
				value: "Sorry, we can not parallelize this loop.\n",
			});
			eventEmitter._onQueryComplete.fire();
			webviewView.webview.postMessage({ command: "done", value: null });
			return;
		}

		const maxIterations = vscode.workspace.getConfiguration("VscOMP")
			.get<number>("Reviewer.maxIterations") || 3;

		webviewView.webview.postMessage({
			command: "response",
			value: `=== 开始并行化优化 (最大迭代次数: ${maxIterations}) ===\n\n`,
		});

		let currentCode = originalCode;
		let ragContent = tutorial;
		let iteration = 0;
		let lastReviewResult: ReviewResult | null = null;
		let bestCode = originalCode;
		let bestScore = 0;

		for (iteration = 1; iteration <= maxIterations; iteration++) {
			if (abortController.signal.aborted) {
				webviewView.webview.postMessage({
					command: "response",
					value: "\n[已取消]\n",
				});
				break;
			}

			webviewView.webview.postMessage({
				command: "response",
				value: `--- 第 ${iteration} 轮优化 ---\n`,
			});

			// 根据迭代次数使用不同的提示词
			let prompt: string;
			if (iteration === 1) {
				prompt = "You need to parallelize the following C code using OpenMP:\n\`\`\`\n" + currentCode + "\n\`\`\`\n\n【重要规则】只允许添加 OpenMP 指令，**禁止修改原有代码的任何逻辑**，包括变量名、循环结构、赋值语句等。保持原有代码完全不变，只添加必要的并行化指令。\n\nHere are some parallelizing experiences:\n";
			} else {
				prompt = "Please fix the following OpenMP code based on the review feedback:\n\`\`\`\n" + currentCode + "\n\`\`\`\n\n【重要规则】只允许修改或调整 OpenMP 指令部分），**禁止修改原有代码的任何逻辑**，包括变量名、循环结构、赋值语句等。保持原有代码完全不变。\n";
			}
			// 输出代码 LLM 的完整请求
			console.log("\n═════════════════════════════════════════════════════════════");
			console.log("📝 【代码 LLM 请求】");
			console.log("═════════════════════════════════════════════════════════════");
			console.log(`提示词:\n${prompt}`);
			if (ragContent) {
				console.log(`优化指令:\n${ragContent}`);
			}
			console.log("═════════════════════════════════════════════════════════════");

			let rawResponse = await this._aiProvider.parallelize(prompt, ragContent, abortController.signal);

			if (abortController.signal.aborted) {
				console.log("⏹️ 用户取消");
				webviewView.webview.postMessage({
					command: "response",
					value: "\n[已取消]\n",
				});
				break;
			}

			// 输出代码 LLM 的完整响应
			console.log("\n═════════════════════════════════════════════════════════════");
			console.log("📤 【代码 LLM 响应】");
			console.log("═════════════════════════════════════════════════════════════");
			console.log(rawResponse);
			console.log("═════════════════════════════════════════════════════════════");

			currentCode = this.extractCodeBlock(rawResponse);

			webviewView.webview.postMessage({
				command: "response",
				value: `并行化代码:\n\`\`\`c\n${currentCode}\n\`\`\`\n`,
			});

			if (!this._reviewer) {
				webviewView.webview.postMessage({
					command: "response",
					value: "(评审器未配置，跳过评审)\n",
				});
				continue;
			}
			console.log("🔍 正在评审...");
			webviewView.webview.postMessage({
				command: "response",
				value: "正在评审...\n",
			});

			// 输出评审 LLM 的完整请求
			console.log("\n═════════════════════════════════════════════════════════════");
			console.log("🔍 【评审 LLM 请求】");
			console.log("═════════════════════════════════════════════════════════════");
			console.log(`原始代码:\n${originalCode}`);
			console.log(`并行化代码:\n${currentCode}`);
			console.log("═════════════════════════════════════════════════════════════");

			lastReviewResult = await this._reviewer.review(originalCode, currentCode, abortController.signal);

			if (abortController.signal.aborted) {
				webviewView.webview.postMessage({
					command: "response",
					value: "\n[已取消]\n",
				});
				break;
			}

			console.log("\n═════════════════════════════════════════════════════════════");
			console.log("📊 【评审 LLM 响应】");
			console.log("═════════════════════════════════════════════════════════════");
			console.log("Score: " + lastReviewResult.score + "/100");
			console.log("Passed: " + !lastReviewResult.hasIssues);
			console.log("Summary: " + lastReviewResult.summary);
			if (lastReviewResult.issues.length > 0) {
				console.log("Issues:");
				lastReviewResult.issues.forEach(function(issue) {
					console.log("  - [" + issue.severity + "] " + issue.description);
				});
			}
			console.log("═════════════════════════════════════════════════════════════");

			webviewView.webview.postMessage({
				command: "response",
				value: `评审结果: 分数=${lastReviewResult.score}/100, 通过=${!lastReviewResult.hasIssues}\n`,
			});

			if (lastReviewResult.summary) {
				webviewView.webview.postMessage({
					command: "response",
					value: `摘要: ${lastReviewResult.summary}\n`,
				});
			}

			if (lastReviewResult.issues.length > 0) {
				webviewView.webview.postMessage({
					command: "response",
					value: "问题列表:\n",
				});
				lastReviewResult.issues.forEach((issue, idx) => {
					webviewView.webview.postMessage({
						command: "response",
						value: `${idx + 1}. ${issue.description}\n`,
					});
				});
			}

			if (lastReviewResult.score > bestScore) {
				bestScore = lastReviewResult.score;
				bestCode = currentCode;
			}

			if (!lastReviewResult.hasIssues || lastReviewResult.score >=90) {
				webviewView.webview.postMessage({
					command: "response",
					value: "\n✅ 评审通过！\n",
				});
				break;
			}

			// 构建优化指令，只使用最新的评审反馈
			let optimizationInstructions = "\n【优化指令】请根据评审反馈修改代码：\n";
			
			// 优先使用评审器返回的详细优化建议
			if (lastReviewResult.suggestions.length > 0) {
				lastReviewResult.suggestions.forEach((suggestion: string, idx: number) => {
					optimizationInstructions += `${idx + 1}. ${suggestion}\n`;
				});
			} 
			// 如果没有详细建议，则使用问题描述
			else if (lastReviewResult.issues.length === 0) {
				optimizationInstructions += "1. 评审未发现问题，但请确保代码符合 OpenMP 最佳实践\n";
			} else {
				lastReviewResult.issues.forEach((issue: any, idx: number) => {
					optimizationInstructions += `${idx + 1}. ${issue.description}\n`;
					if (issue.suggestion) {
						optimizationInstructions += `   建议：${issue.suggestion}\n`;
					}
				});
			}
			
			// 第二轮及以后只使用最新的优化指令，不包含第一轮的代码分析经验
			// 第一轮已经使用过 tutorial，后续迭代只需要最新的评审反馈
			ragContent = tutorial + "\n\n" + optimizationInstructions;
			
			console.log(`🔄 优化指令已更新:\n${optimizationInstructions}`);
			webviewView.webview.postMessage({
				command: "response",
				value: "\n--- 继续优化 ---\n",
			});
		}

		if (iteration > maxIterations) {
			webviewView.webview.postMessage({
				command: "response",
				value: `\n⚠️ 已达到最大迭代次数 (${maxIterations})，返回最后一轮结果\n`,
			});
		}

		webviewView.webview.postMessage({
			command: "response",
			value: `\n=== 最终结果 ===\n\n原始代码:\n\`\`\`c\n${originalCode}\n\`\`\`\n\n并行化代码:\n\`\`\`c\n${currentCode}\n\`\`\`\n\n评审分数: ${lastReviewResult?.score || bestScore}/100\n`,
		});

		eventEmitter._onQueryComplete.fire();
		webviewView.webview.postMessage({ command: "done", value: null });
	}

	private extractCodeBlock(text: string): string {
		const match = text.match(/```c\s*([\s\S]*?)\s*```/);
		if (match) {
			return match[1].trim();
		}
		return text.trim();
	}

	private async handleChatMessage({
		value,
		webviewView,
	}: Pick<AppMessage, "value"> & { webviewView: vscode.WebviewView }) {
		abortController = new AbortController();

		await this.streamChatResponse(
			value as string,
			webviewView
		);
	}

	private async streamChatResponse(
		prompt: string,
		webviewView: vscode.WebviewView
	) {
		let ragContext = "";

		eventEmitter._onQueryStart.fire();

		const response = this._aiProvider.chat(
			prompt,
			ragContext,
			abortController.signal
		);

		for await (const chunk of response) {
			webviewView.webview.postMessage({
				command: "response",
				value: chunk,
			});
		}

		eventEmitter._onQueryComplete.fire();

		webviewView.webview.postMessage({
			command: "done",
			value: null,
		});
	}

	private getHtmlForWebview(webview: vscode.Webview) {
		// Get the local path to main script run in the webview, then convert it to a uri we can use in the webview.
		const scriptUri = webview.asWebviewUri(
			vscode.Uri.joinPath(
				this._context.extensionUri,
				"out",
				"index.es.js"
			)
		);

		const codiconsUri = webview.asWebviewUri(
			vscode.Uri.joinPath(
				this._context.extensionUri,
				"node_modules",
				"@vscode/codicons",
				"dist",
				"codicon.css"
			)
		);

		const nonce = getNonce();

		return `<!DOCTYPE html>
        <html lang="en" style="height: 100%">
          <head>
            <meta charset="UTF-8" />
            <meta name="viewport" content="width=device-width, initial-scale=1.0" />
            <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; font-src ${webview.cspSource}; style-src ${webview.cspSource} 'unsafe-inline';">
			<title>VscOMP</title>
			<link rel="stylesheet" href="${codiconsUri}" nonce="${nonce}">
          </head>
          <body style="height: 100%">
            <div id="root" style="height: 100%"></div>
            <script type="module" nonce="${nonce}" src="${scriptUri}"></script>
          </body>
        </html>`;
	}

	private log = (value: unknown) => {
		loggingProvider.logInfo(JSON.stringify(value ?? ""));
	};
}

function getActiveWorkspace() {
	const defaultWorkspace = "default";

	const activeEditor = vscode.window.activeTextEditor;
	if (activeEditor) {
		return (
			vscode.workspace.getWorkspaceFolder(activeEditor.document.uri)
				?.name ?? defaultWorkspace
		);
	}

	return vscode.workspace.workspaceFolders?.[0].name ?? defaultWorkspace;
}

function getNonce() {
	let text = "";
	const possible =
		"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
	for (let i = 0; i < 32; i++) {
		text += possible.charAt(Math.floor(Math.random() * possible.length));
	}
	return text;
}