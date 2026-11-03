import * as vscode from "vscode";
import { eventEmitter } from "../events/eventEmitter";
import { AIProvider, GetReviewerFromSettings } from "../service/base";
import { AppMessage, ChatMessage } from "../types/Message";
import { InteractionSettings } from "../types/Settings";
import { loggingProvider } from "./loggingProvider";
import { check } from "./parser";
import { Reviewer } from "../service/reviewer";
import { ValidationConfig, ValidationInput } from "../types/Validation";
import { ValidationService } from "../service/validation/validationService";
import { OptimizationController } from "../service/optimizationController";
import * as path from "node:path";
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

	private async handleParallelize({ webviewView }: Pick<AppMessage, "value"> & { webviewView: vscode.WebviewView }) {
		const editor = vscode.window.activeTextEditor;
		if (!editor || editor.selection.isEmpty) {
			webviewView.webview.postMessage({ command: "response", value: "请先选中目标循环。\n" });
			webviewView.webview.postMessage({ command: "done", value: null });
			return;
		}
		if (!vscode.workspace.isTrusted || editor.document.uri.scheme !== "file") {
			webviewView.webview.postMessage({ command: "response", value: "工具反馈需要可信工作区中的源文件；请保存文件并在可信项目中运行。\n" });
			webviewView.webview.postMessage({ command: "done", value: null });
			return;
		}
		abortController.abort();
		const requestController = new AbortController();
		abortController = requestController;
		const document = editor.document, selection = editor.selection;
		const sourcePath = document.uri.fsPath;
		const workspaceRoot = vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath ?? path.dirname(sourcePath);
		const fullSource = document.getText();
		const input: ValidationInput = {
			workspaceRoot, sourcePath, fullSource,
			selectionStart: document.offsetAt(selection.start), selectionEnd: document.offsetAt(selection.end),
			unsavedFiles: Object.fromEntries(vscode.workspace.textDocuments
				.filter(doc => doc.isDirty && doc.uri.scheme === "file" && vscode.workspace.getWorkspaceFolder(doc.uri)?.uri.fsPath === workspaceRoot)
				.map(doc => [doc.uri.fsPath, doc.getText()])),
		};
		eventEmitter._onQueryStart.fire();
		let session: ValidationService | undefined;
		const emit = (value: string) => {
			if (abortController === requestController) webviewView.webview.postMessage({ command: "response", value });
		};
		try {
			let tutorial = "";
			try {
				await Parser.init();
				const language = await Parser.Language.load(vscode.Uri.joinPath(this._context.extensionUri, "out", `tree-sitter-${document.languageId}.wasm`).fsPath);
				const parser = new Parser();
				parser.setLanguage(language);
				const tree = parser.parse(fullSource.slice(input.selectionStart, input.selectionEnd));
				try { tutorial = check(tree); } finally { tree.delete(); parser.delete(); }
			} catch (cause) {
				loggingProvider.logInfo(`Static analysis unavailable: ${String(cause)}`);
				tutorial = "静态分析未完成；请根据代码和工具诊断分析，不能假定已证明依赖安全。";
			}
			if (requestController.signal.aborted) return;
			if (tutorial === "false") {
				emit("静态分析拒绝该循环的并行化，保留原始代码。\n");
				return;
			}
			const settings = vscode.workspace.getConfiguration("VscOMP", document.uri);
			const config = settings.get<ValidationConfig>("Validation") ?? { enabled: true };
			session = new ValidationService(input, { ...config, enabled: config.enabled !== false });
			const sourceContext = fullSource.length <= 60000 ? fullSource :
				"文件较长，以下为选区附近上下文；其余项目源码仍参与工具构建：\n" +
				fullSource.slice(Math.max(0, input.selectionStart - 20000), Math.min(fullSource.length, input.selectionEnd + 20000));
			const controller = new OptimizationController(this._aiProvider, session, this._reviewer);
			const result = await controller.optimize({
				originalCode: fullSource.slice(input.selectionStart, input.selectionEnd), sourceContext, staticAnalysis: tutorial,
				maxIterations: settings.get<number>("Reviewer.maxIterations") ?? 3,
				onProgress: message => emit(message + "\n"),
				onIteration: async record => {
					await session!.record(record);
					for (const item of record.validation.checks) {
						emit(`[${item.kind}] ${item.status}\n`);
						for (const diagnostic of item.diagnostics.slice(0, 12)) emit(`  ${diagnostic.message.slice(0, 2000)}\n`);
					}
					if (record.review) emit(`语义诊断：${record.review.summary}\n`);
				},
			}, requestController.signal);
			emit(`\n状态：${result.status}\n${result.message}\n\n保留的代码：\n\`\`\`c\n${result.code}\n\`\`\`\n`);
			if (result.status !== "validated" && result.candidate)
				emit(`\n未通过完整验证的候选（未采用）：\n\`\`\`c\n${result.candidate}\n\`\`\`\n`);
			if (session.reportDirectory) emit(`\n逐轮诊断记录：${session.reportDirectory}\n`);
		} catch (cause) {
			emit(`工具反馈流程未完成，原始文件未修改：${String(cause)}\n`);
		} finally {
			try { await session?.dispose(); } catch (cause) { loggingProvider.logError(`Validation cleanup: ${String(cause)}`); }
			if (abortController === requestController) {
				eventEmitter._onQueryComplete.fire();
				webviewView.webview.postMessage({ command: "done", value: null });
			}
		}
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
