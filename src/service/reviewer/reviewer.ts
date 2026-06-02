import { ReviewerConfig, ReviewResult, ReviewIssue } from "../../types/Review";

export class Reviewer {
	private config: ReviewerConfig;
	private systemPrompt: string;

	constructor(config: ReviewerConfig, openmpRules: string[]) {
		this.config = config;
		this.systemPrompt = this.buildSystemPrompt(openmpRules);
	}

	private buildSystemPrompt(rules: string[]): string {
		return `
你是精通OpenMP并行编程的专业技术助手，严格遵循以下OpenMP for循环全部核心规则为用户评审代码，不可提出重构的建议！
所有回答必须完全贴合、不违背、不遗漏这些规则，仅针对OpenMP并行for循环提供精准、规范、可直接使用的技术指导。

${rules.join('\n')}

==========================================

评审要求：
【步骤1：代码分析】
- 分析原始代码和并行化代码的结构
- 识别循环类型、变量使用方式、数据依赖关系

【步骤2：子句匹配】
- 根据代码特征，列出需要检查的 OpenMP 规则
- 例如：如果有累加操作，需要检查 reduction 规则；如果有循环后使用的变量，需要检查 lastprivate 规则

【步骤3：规则校验】
- 对每个匹配的规则进行详细检查
- 记录发现的问题和证据

【步骤4：总结结论】
- 根据检查结果给出分数和建议

输出格式要求（必须严格遵守）：
【评审分数】数字（0-100）
【问题列表】
1....
2....
...
【优化建议】
1....
2....
...
【是否通过】是或否
【摘要】简要总结评审结果
`;
	}

	async review(
		originalCode: string,
		parallelizedCode: string,
		signal: AbortSignal
	): Promise<ReviewResult> {
		const userPrompt = `
原始代码：
\`\`\`c
${originalCode}
\`\`\`

并行化代码：
\`\`\`c
${parallelizedCode}
\`\`\`

请进行评审。
`;

		console.log("\n═════════════════════════════════════════════════════════════");
		console.log("🔍 【评审器 LLM 请求】");
		console.log("═════════════════════════════════════════════════════════════");
		console.log(`系统提示词（前500字符）:\n${this.systemPrompt.substring(0, 500)}...`);
		console.log(`用户提示词:\n${userPrompt}`);
		console.log("═════════════════════════════════════════════════════════════");

		try {
			const requestBody = {
				model: this.config.model,
				messages: [
					{ role: "system", content: this.systemPrompt },
					{ role: "user", content: userPrompt },
				],
				temperature: 0.2,
			};

			const response = await fetch(this.config.apiEndpoint, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${this.config.apiKey}`,
				},
				body: JSON.stringify(requestBody),
				signal,
			});

			if (!response.ok) {
				throw new Error(`API request failed with status ${response.status}`);
			}

			const result = await response.json();
			
			console.log("\n═════════════════════════════════════════════════════════════");
			console.log("📊 【评审器 LLM 响应】");
			console.log("═════════════════════════════════════════════════════════════");
			console.log("原始响应:", JSON.stringify(result, null, 2));
			
			const content = result.choices?.[0]?.message?.content || "";
			console.log("评审内容:", content);
			console.log("═════════════════════════════════════════════════════════════");

			const reviewResult = this.parseReviewResult(result);
			
			console.log("\n═════════════════════════════════════════════════════════════");
			console.log("📈 【解析后的评审结果】");
			console.log("═════════════════════════════════════════════════════════════");
			console.log("Score:", reviewResult.score + "/100");
			console.log("Has Issues:", reviewResult.hasIssues);
			console.log("Summary:", reviewResult.summary);
			console.log("Issues:", JSON.stringify(reviewResult.issues, null, 2));
			console.log("Suggestions:", reviewResult.suggestions);
			console.log("═════════════════════════════════════════════════════════════");

			return reviewResult;
		} catch (error) {
			console.error("Review API error:", error);
			return {
				hasIssues: true,
				score: 0,
				issues: [],
				suggestions: [],
				summary: "评审服务调用失败",
			};
		}
	}

	private parseReviewResult(rawResult: any): ReviewResult {
		const content = rawResult.choices?.[0]?.message?.content || "";
		
		
		const scoreMatch = content.match(/【评审分数】(\d+)/);
		const passedMatch = content.match(/【是否通过】(是|否)/);
		const summaryMatch = content.match(/【摘要】(.+)/);

		const score = scoreMatch ? parseInt(scoreMatch[1]) : 50;
		const passed = passedMatch?.[1] === "是";
		const summary = summaryMatch?.[1] || "未提供摘要";

		// 提取问题列表（仅支持新格式：1. ... 2. ...）
		const issues: ReviewIssue[] = [];
		const issuesSection = content.match(/【问题列表】\s*\n([\s\S]*?)(?=\n【|$)/);
		
		if (issuesSection) {
			
			// 只匹配新格式：1. ... 2. ...
			const newFormatLines = issuesSection[1].split("\n").filter((line: string) => line.trim() && line.match(/^\d+\./));
			
			for (const line of newFormatLines) {
				const issueText = line.replace(/^\d+\.\s*/, "").trim();
				issues.push({
					severity: score < 50 ? "critical" : "warning",
					type: "correctness",
					description: issueText,
					suggestion: "",
				});
			}
		}

		// 如果没有提取到 issues，但 summary 中有问题描述，从 summary 提取
		if (issues.length === 0 && summary && score < 85) {
			issues.push({
				severity: score < 50 ? "critical" : "warning",
				type: "correctness",
				description: summary,
				suggestion: "",
			});
		}

		
		const suggestionIndex = content.indexOf("【优化建议】");
		
		if (suggestionIndex !== -1) {
			const start = Math.max(0, suggestionIndex - 10);
			const end = Math.min(content.length, suggestionIndex + 80);
		}
		
		// 使用更宽松的正则表达式，允许【优化建议】后面有任意空白字符
		const suggestionMatches = content.match(/【优化建议】\s*\n([\s\S]*?)(?=\n【|$)/);
		console.log(`🔍 suggestionMatches:`, suggestionMatches);
		
		// 允许数字前面有空格（如 " 1." 而不是 "1."）
		const suggestions = suggestionMatches ? 
			suggestionMatches[1].split("\n").filter((s: string) => s.trim() && s.match(/^\s*\d+\./)).map((s: string) => s.replace(/^\s*\d+\.\s*/, "").trim()) : [];
		
		console.log(`🔍 提取到 ${suggestions.length} 条优化建议:`, suggestions);

		return {
			hasIssues: !passed || issues.length > 0,
			score,
			issues,
			suggestions,
			summary,
		};
	}
}