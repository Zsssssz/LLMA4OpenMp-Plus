import * as vscode from "vscode";
import { AIProvider } from "../service/base";
import {
	extractCodeBlock,
	supportedLanguages,
} from "./utilities";
import { eventEmitter } from "../events/eventEmitter";

let abortController = new AbortController();

export class RefactorProvider implements vscode.CodeActionProvider {
	public static readonly command = "vscompai.refactorcode";

	public static readonly selector = supportedLanguages;

	public static readonly providedCodeActionKinds = [
		vscode.CodeActionKind.Refactor,
	];

	constructor(private readonly _aiProvider: AIProvider) {}

	provideCodeActions(
		document: vscode.TextDocument,
		range: vscode.Range | vscode.Selection,
		context: vscode.CodeActionContext,
		token: vscode.CancellationToken
	) {
		if (context.triggerKind !== vscode.CodeActionTriggerKind.Invoke) {
			return [];
		}

		const codeAction = new vscode.CodeAction(
			"✈️ Refactor using VscOMP",
			vscode.CodeActionKind.Refactor
		);
		codeAction.edit = new vscode.WorkspaceEdit();
		codeAction.command = {
			command: RefactorProvider.command,
			title: "✈️ Refactor using VscOMP",
			arguments: [
				document,
				range,
				this._aiProvider,
				vscode.window.activeTextEditor,
			],
		};
		return [codeAction];
	}

	static refactorCode(
		document: vscode.TextDocument,
		range: vscode.Range | vscode.Selection,
		aiProvider: AIProvider,
		editor: vscode.TextEditor
	) {
		return vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Window,
				title: "Refactoring...",
			},
			async (process, token) => {
				if (token.isCancellationRequested && abortController) {
					abortController.abort();
				}

				eventEmitter._onQueryStart.fire();
				const codeContextRange = new vscode.Range(
					range.start,
					range.end
				);
				const highlightedCode = document.getText(codeContextRange);

				const result = await aiProvider.parallelize(
					`Code to refactor:
\`\`\`${document.languageId}
${highlightedCode}
\`\`\``,
					"symbols",
					abortController.signal
				);

				const newCode = extractCodeBlock(result);

				if (newCode) {
					editor?.edit((builder) => {
						builder.replace(codeContextRange, newCode);
					});
				}
				eventEmitter._onQueryComplete.fire();
			}
		);
	}
}
