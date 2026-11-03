export type CheckKind = "edit_scope" | "compile" | "functional" | "race";
export type CheckStatus = "passed" | "failed" | "skipped" | "error";
export interface Diagnostic {
	message: string;
	file?: string;
	line?: number;
	column?: number;
	test?: string;
	threads?: number;
	expected?: string;
	actual?: string;
}
export interface CheckResult {
	kind: CheckKind;
	status: CheckStatus;
	diagnostics: Diagnostic[];
	durationMs?: number;
}
export interface ValidationResult {
	status: "passed" | "failed" | "inconclusive";
	checks: CheckResult[];
	context?: string;
}
/** Executable and argv are separate; never interpreted by a shell. */
export interface ToolCommand {
	command: string;
	args: string[];
	env?: Record<string, string>;
}
export interface FunctionalTest {
	name: string;
	args?: string[];
	stdin?: string;
	expectedStdout?: string;
	expectedExitCode?: number;
	/** A checker returns zero only when the captured result is correct. */
	verify?: ToolCommand;
	absoluteTolerance?: number;
	relativeTolerance?: number;
}
export interface ValidationConfig {
	enabled: boolean;
	compiler?: string;
	compilerArgs?: string[];
	build?: ToolCommand;
	tests?: FunctionalTest[];
	threadCounts?: number[];
	timeoutMs?: number;
	maxOutputBytes?: number;
	maxSnapshotBytes?: number;
	excludeDirectories?: string[];
	race?: {
		build: ToolCommand;
		/** Must match actual detector startup output, not its command line. */
		activationPattern: string;
		env?: Record<string, string>;
	};
}
export interface ValidationInput {
	workspaceRoot: string;
	sourcePath: string;
	fullSource: string;
	selectionStart: number;
	selectionEnd: number;
	unsavedFiles?: Record<string, string>;
}
export interface Validator {
	validate(candidate: string, signal: AbortSignal): Promise<ValidationResult>;
}
export function validationStatus(checks: CheckResult[]): ValidationResult["status"] {
	if (checks.some(check => check.status === "failed")) return "failed";
	const kinds: CheckKind[] = ["edit_scope", "compile", "functional", "race"];
	return kinds.every(kind => checks.some(check => check.kind === kind && check.status === "passed"))
		&& checks.every(check => check.status === "passed") ? "passed" : "inconclusive";
}
export function formatValidation(result: ValidationResult): string {
	return JSON.stringify(result, null, 2);
}

/** Bound model context without losing check status. Full evidence stays on disk. */
export function compactValidation(result: ValidationResult): ValidationResult {
	let budget = 24000;
	const text = (value: string | undefined) => {
		if (value === undefined) return undefined;
		const limit = Math.min(4000, Math.max(0, budget));
		budget -= Math.min(value.length, limit);
		return value.length > limit ? value.slice(0, limit) + " [诊断已截短，完整记录见本轮报告]" : value;
	};
	return { ...result, checks: result.checks.map(item => ({ ...item,
		diagnostics: item.diagnostics.slice(0, 12).map(diagnostic => ({ ...diagnostic,
			message: text(diagnostic.message) ?? "", actual: text(diagnostic.actual), expected: text(diagnostic.expected),
		})),
	})) };
}
