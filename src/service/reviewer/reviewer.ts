import { ReviewerConfig, ReviewContext, ReviewResult } from "../../types/Review";
import { buildReviewSystem, selectReviewExamples } from "./prompts";
import { parseReview, reviewError } from "./parseReview";
import { compactValidation } from "../../types/Validation";

export class Reviewer {
	constructor(private config: ReviewerConfig, private openmpRules: string[] = []) {}

	async review(originalCode: string, parallelizedCode: string, signal: AbortSignal, context?: ReviewContext): Promise<ReviewResult> {
		const examples = this.config.useExamples === false ? "" : selectReviewExamples(parallelizedCode, context);
		const systemPrompt = buildReviewSystem(this.openmpRules, this.config.useStructuredAnalysis !== false, examples);
		const userPrompt = JSON.stringify({
			originalCode, candidateCode: parallelizedCode,
			sourceContext: context?.sourceContext,
			staticAnalysis: context?.staticAnalysis,
			toolFeedback: context?.validation ? compactValidation(context.validation) : undefined,
		});
		const requestAbort = new AbortController();
		const abort = () => requestAbort.abort();
		signal.addEventListener("abort", abort, { once: true });
		if (signal.aborted) abort();
		const timeout = setTimeout(abort, 120000);
		try {
			const response = await fetch(this.config.apiEndpoint, {
				method: "POST",
				headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.config.apiKey}` },
				body: JSON.stringify({ model: this.config.model, messages: [
					{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt },
				], temperature: 0.2 }), signal: requestAbort.signal,
			});
			if (!response.ok) return reviewError(`评审请求失败：HTTP ${response.status}`);
			const result = await response.json();
			return parseReview(result.choices?.[0]?.message?.content ?? "");
		} catch (cause) {
			return reviewError(signal.aborted ? "评审已取消" : `评审服务异常或超时：${String(cause)}`);
		} finally { clearTimeout(timeout); signal.removeEventListener("abort", abort); }
	}
}
