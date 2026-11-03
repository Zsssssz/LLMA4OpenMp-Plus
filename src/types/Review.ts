import { ValidationResult } from "./Validation";

export interface ReviewIssue {
	type: "correctness" | "performance" | "style";
	severity: "critical" | "warning" | "info";
	description: string;
	evidence: string;
	suggestion: string;
	lineNumber?: number;
}

export interface ReviewResult {
	status: "ok" | "error";
	issues: ReviewIssue[];
	suggestions: string[];
	unresolvedQuestions: string[];
	summary: string;
}

export interface ReviewerConfig {
	apiKey: string;
	apiEndpoint: string;
	model: string;
	useStructuredAnalysis?: boolean;
	useExamples?: boolean;
}

export interface ReviewContext {
	validation?: ValidationResult;
	sourceContext?: string;
	staticAnalysis?: string;
}

export interface IterationRecord {
	iteration: number;
	code: string;
	validation: ValidationResult;
	review?: ReviewResult;
	durationMs: number;
}

export interface OptimizationResult {
	/** Accepted candidate or unchanged original when validation is incomplete. */
	code: string;
	candidate?: string;
	iterations: number;
	status: "validated" | "unverified" | "failed" | "cancelled";
	history: IterationRecord[];
	message: string;
}
