import * as vscode from "vscode";

export const supportedLanguages: vscode.DocumentSelector = [
	{ scheme: "file", language: "c" },
	{ scheme: "file", language: "cpp" }
];

export function isArrowFunction(
	symbol: vscode.DocumentSymbol,
	document: vscode.TextDocument
) {
	const isProperty =
		symbol.kind === vscode.SymbolKind.Property ||
		symbol.kind === vscode.SymbolKind.Variable;
	if (!isProperty) {
		return false;
	}

	return (
		document
			.getText(new vscode.Range(symbol.range.start, symbol.range.end))
			.includes("=>") ||
		document.lineAt(symbol.range.start.line).text.includes("=>")
	);
}

export function extractCodeBlock(text: string) {
	const regex = /```.*?\n([\s\S]*?)\n```/g;
	const matches = [];
	let match;
	while ((match = regex.exec(text)) !== null) {
		matches.push(match[1]);
	}
	return matches.join("\n");
}