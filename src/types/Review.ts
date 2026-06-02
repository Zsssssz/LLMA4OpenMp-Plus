export interface ReviewIssue {
	type: 'correctness' | 'performance' | 'style';
	severity: 'critical' | 'warning' | 'info';
	description: string;
	suggestion: string;
	lineNumber?: number;
}

export interface ReviewResult {
	hasIssues: boolean;
	score: number;
	issues: ReviewIssue[];
	suggestions: string[];
	summary: string;
}

export interface ReviewerConfig {
	apiKey: string;
	apiEndpoint: string;
	model: string;
}

export interface OptimizationResult {
	code: string;
	iterations: number;
	status: 'success' | 'partial' | 'failed';
	reviewHistory: ReviewResult[];
	message: string;
}