import { ReviewIssue, ReviewResult } from "../../types/Review";

export function reviewError(message: string): ReviewResult {
	return { status: "error", issues: [], suggestions: [], unresolvedQuestions: [], summary: message };
}

export function parseReview(content: string): ReviewResult {
	try {
		if (content.length > 65536) throw new Error("评审响应超过大小上限");
		const json = content.trim().replace(/^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/i, "$1");
		const result = JSON.parse(json);
		if (result?.status !== undefined && result.status !== "ok") throw new Error("模型报告评审未完成");
		const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === "string");
		if (!result || typeof result !== "object" || !Array.isArray(result.issues)
			|| !strings(result.suggestions) || !strings(result.unresolvedQuestions) || typeof result.summary !== "string")
			throw new Error("缺少issues/suggestions/unresolvedQuestions/summary字段");
		const issues: ReviewIssue[] = result.issues.map((issue: ReviewIssue) => {
			if (!issue || !["correctness", "performance", "style"].includes(issue.type)
				|| !["critical", "warning", "info"].includes(issue.severity)
				|| typeof issue.description !== "string" || !issue.description.trim()
				|| typeof issue.evidence !== "string" || !issue.evidence.trim() || typeof issue.suggestion !== "string"
				|| issue.lineNumber !== undefined && (!Number.isInteger(issue.lineNumber) || issue.lineNumber < 1))
				throw new Error("问题条目必须包含合法类型、严重程度和具体证据");
			return { type: issue.type, severity: issue.severity, description: issue.description,
				evidence: issue.evidence, suggestion: issue.suggestion, lineNumber: issue.lineNumber };
		});
		return { status: "ok", issues, suggestions: result.suggestions,
			unresolvedQuestions: result.unresolvedQuestions, summary: result.summary };
	} catch (cause) { return reviewError(`评审响应格式无效：${String(cause)}`); }
}
