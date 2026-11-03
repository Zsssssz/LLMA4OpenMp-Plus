import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	CheckKind, CheckResult, Diagnostic, FunctionalTest, ToolCommand,
	ValidationConfig, ValidationInput, ValidationResult, Validator, validationStatus,
} from "../../types/Validation";
import { IterationRecord } from "../../types/Review";
import { CommandResult, runCommand } from "./commandRunner";
import { replaceSelection, sameComputation } from "./editScope";

export function isWithin(root: string, target: string): boolean {
	const relative = path.relative(path.resolve(root), path.resolve(target));
	return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(".." + path.sep));
}

export function compareOutput(expected: string, actual: string, absolute = 0, relative = 0): boolean {
	const normalize = (text: string) => text.replace(/\r\n/g, "\n");
	expected = normalize(expected); actual = normalize(actual);
	if (absolute === 0 && relative === 0) return expected === actual;
	const number = /([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)/g;
	const left = expected.split(number), right = actual.split(number);
	return left.length === right.length && left.every((value, i) => {
		if (i % 2 === 0) return value === right[i];
		const a = Number(value), b = Number(right[i]);
		return Number.isFinite(a) && Number.isFinite(b)
			&& Math.abs(a - b) <= absolute + relative * Math.max(Math.abs(a), Math.abs(b));
	});
}

function check(kind: CheckKind, status: CheckResult["status"], message: string): CheckResult {
	return { kind, status, diagnostics: [{ message }] };
}

function commandError(result: CommandResult): string | undefined {
	if (result.aborted) return "执行已取消";
	if (result.error) return result.error;
	if (result.truncated) return "工具输出超过上限，已终止；不能据截断输出判定通过";
	if (result.timedOut) return "执行超过配置的时间限制";
	return undefined;
}

/** One session freezes the editor snapshot; only the selected range is replaced.
 * All commands run in disposable copies, never in the original project directory.
 */
export class ValidationService implements Validator {
	private root = "";
	private relativeSource = "";
	private prepared = false;
	private baselineBuilt = false;
	private referenceOutputs = new Map<string, CommandResult>();
	private readonly timeout: number;
	private readonly outputLimit: number;
	private readonly threads: number[];
	private readonly build: ToolCommand;

	constructor(private input: ValidationInput, private config: ValidationConfig) {
		this.timeout = config.timeoutMs ?? 30000;
		this.outputLimit = config.maxOutputBytes ?? 1048576;
		this.threads = config.threadCounts ?? [1, 2, 4];
		this.build = config.build ?? {
			command: config.compiler || (/\.(cpp|cc|cxx|C)$/.test(input.sourcePath) ? "g++" : "gcc"),
			args: config.compilerArgs ?? ["-O3", "-g", "-fopenmp", "-Wall", "-Wextra", "{source}", "-o", "{binary}"],
		};
	}

	get reportDirectory(): string { return this.root; }

	private validateConfig() {
		if (!isWithin(this.input.workspaceRoot, this.input.sourcePath)) throw new Error("源文件必须位于所选工作区内");
		if (!Number.isInteger(this.input.selectionStart) || !Number.isInteger(this.input.selectionEnd)
			|| this.input.selectionStart < 0 || this.input.selectionEnd <= this.input.selectionStart
			|| this.input.selectionEnd > this.input.fullSource.length) throw new Error("代码选区范围无效");
		if (!Number.isFinite(this.timeout) || this.timeout < 1 || !Number.isFinite(this.outputLimit) || this.outputLimit < 1)
			throw new Error("工具超时和输出上限必须为正数");
		if (!Array.isArray(this.threads) || !this.threads.length || this.threads.some(n => !Number.isInteger(n) || n < 1 || n > 1024))
			throw new Error("threadCounts 必须是非空的正整数数组（最大1024）");
		const validCommand = (cmd: ToolCommand) => {
			if (!cmd || typeof cmd.command !== "string" || !cmd.command.trim() || !Array.isArray(cmd.args)
				|| cmd.args.some(arg => typeof arg !== "string")) throw new Error("工具必须配置 command 和字符串 args 数组");
			if (cmd.env && Object.values(cmd.env).some(value => typeof value !== "string")) throw new Error("环境变量值必须是字符串");
		};
		validCommand(this.build);
		if (this.config.tests && !Array.isArray(this.config.tests)) throw new Error("tests 必须为数组");
		for (const test of this.config.tests ?? []) {
			if (!test.name || (test.args && (!Array.isArray(test.args) || test.args.some(arg => typeof arg !== "string"))))
				throw new Error("每个测试必须有名称和有效的参数数组");
			for (const value of [test.absoluteTolerance ?? 0, test.relativeTolerance ?? 0])
				if (!Number.isFinite(value) || value < 0) throw new Error("数值比较容差必须是非负有限数");
			if (test.expectedStdout !== undefined && typeof test.expectedStdout !== "string") throw new Error("expectedStdout 必须是字符串");
			if (test.verify) validCommand(test.verify);
		}
		if (this.config.race) {
			validCommand(this.config.race.build);
			if (!this.config.race.activationPattern?.trim()) throw new Error("竞态检测必须配置 activationPattern，以确认检测器实际启动");
			const activation = new RegExp(this.config.race.activationPattern, "m");
			if (activation.test("")) throw new Error("activationPattern 不能匹配空文本");
		}
	}

	private async copyProject(from: string, to: string, signal: AbortSignal) {
		let bytes = 0, files = 0;
		const limit = this.config.maxSnapshotBytes ?? 128 * 1024 * 1024;
		if (!Number.isFinite(limit) || limit < 1) throw new Error("maxSnapshotBytes 必须为正数");
		const excluded = new Set([".git", "node_modules", ".vscode", ".codex", ".agents", ".workbuddy", ".vscomp-validation",
			...(this.config.excludeDirectories ?? [])]);
		const copy = async (source: string, target: string) => {
			if (signal.aborted) throw new Error("快照复制已取消");
			const stat = await fs.lstat(source);
			if (stat.isSymbolicLink()) throw new Error(`快照不支持符号链接：${source}`);
			if (stat.isDirectory()) {
				await fs.mkdir(target, { recursive: true });
				for (const name of await fs.readdir(source)) {
					if (!excluded.has(name)) await copy(path.join(source, name), path.join(target, name));
				}
			} else if (stat.isFile()) {
				bytes += stat.size;
				if (++files > 10000 || bytes > limit) throw new Error("项目快照超过文件数或大小上限；请缩小工作区或配置 excludeDirectories");
				await fs.copyFile(source, target);
			}
		};
		await copy(from, to);
	}

	private async prepare(signal: AbortSignal) {
		if (this.prepared) return;
		this.validateConfig();
		this.relativeSource = path.relative(this.input.workspaceRoot, this.input.sourcePath);
		this.root = await fs.mkdtemp(path.join(os.tmpdir(), "vscomp-validation-"));
		await fs.writeFile(path.join(this.root, "source-context.json"), JSON.stringify({
			workspaceRoot: this.input.workspaceRoot, sourcePath: this.input.sourcePath,
			fullSource: this.input.fullSource, selectionStart: this.input.selectionStart,
			selectionEnd: this.input.selectionEnd, unsavedFiles: this.input.unsavedFiles,
		}, null, 2), "utf8");
		await this.copyProject(this.input.workspaceRoot, path.join(this.root, "project"), signal);
		for (const [file, content] of Object.entries({ ...this.input.unsavedFiles, [this.input.sourcePath]: this.input.fullSource })) {
			if (!isWithin(this.input.workspaceRoot, file)) throw new Error("未保存文件不在工作区内");
			const target = path.join(this.root, "project", path.relative(this.input.workspaceRoot, file));
			await fs.mkdir(path.dirname(target), { recursive: true });
			await fs.writeFile(target, content, "utf8");
		}
		await this.copyProject(path.join(this.root, "project"), path.join(this.root, "reference"), signal);
		await fs.mkdir(path.join(this.root, "build"), { recursive: true });
		this.prepared = true;
	}

	private variables(flavor: "candidate" | "reference", race = false): Record<string, string> {
		const workspace = path.join(this.root, flavor);
		return {
			workspace, source: path.join(workspace, this.relativeSource),
			binary: path.join(this.root, "build", flavor + (race ? "-race" : "") + (process.platform === "win32" ? ".exe" : "")),
		};
	}

	private expand(command: ToolCommand, variables: Record<string, string>): ToolCommand {
		const expand = (value: string) => value.replace(/\{(workspace|source|binary|stdoutFile|stderrFile|exitCode)\}/g, (match, key) => {
			if (variables[key] === undefined) throw new Error(`当前步骤不支持占位符 ${match}`);
			return variables[key];
		});
		return { command: expand(command.command), args: command.args.map(expand),
			env: Object.fromEntries(Object.entries(command.env ?? {}).map(([key, value]) => [key, expand(value)])) };
	}

	private async execute(command: ToolCommand, flavor: "candidate" | "reference", signal: AbortSignal,
		stdin = "", variables = this.variables(flavor)): Promise<CommandResult> {
		return runCommand(this.expand(command, variables), variables.workspace, signal, this.timeout, this.outputLimit, stdin);
	}

	private compilerCheck(result: CommandResult, baseline: boolean): CheckResult {
		const problem = commandError(result);
		const status = problem || baseline && result.exitCode !== 0 ? "error" : result.exitCode === 0 ? "passed" : "failed";
		const output = (result.stderr + "\n" + result.stdout).trim();
		const diagnostics: Diagnostic[] = output ? output.split(/\r?\n/).filter(Boolean).map(message => {
			const location = /^(.*?):(\d+):(\d+):\s*(?:fatal error|error|warning|note):/.exec(message);
			return { message, ...(location ? { file: location[1], line: Number(location[2]), column: Number(location[3]) } : {}) };
		}) : [];
		if (problem || baseline && result.exitCode !== 0) diagnostics.unshift({ message: `${baseline ? "原始程序构建失败，不能归因于候选修改：" : ""}${problem ?? `退出码 ${result.exitCode}`}` });
		return { kind: "compile", status, diagnostics, durationMs: result.durationMs };
	}

	private async runTest(test: FunctionalTest, threads: number, flavor: "candidate" | "reference", signal: AbortSignal, race = false) {
		const variables = this.variables(flavor, race);
		return this.execute({ command: "{binary}", args: test.args ?? [],
			env: { ...(race ? this.config.race?.env : {}), OMP_NUM_THREADS: String(threads), OMP_DYNAMIC: "FALSE" } },
			flavor, signal, test.stdin ?? "", variables);
	}

	private async functionalCheck(signal: AbortSignal): Promise<CheckResult> {
		const tests = this.config.tests ?? [];
		if (!tests.length) return check("functional", "skipped", "未配置功能测试；编译成功不代表计算结果正确");
		const diagnostics: Diagnostic[] = [];
		let failed = false, error = false;
		for (let i = 0; i < tests.length; i++) for (const threads of this.threads) {
			const test = tests[i], expectedExit = test.expectedExitCode ?? 0;
			const meta = { test: test.name, threads };
			let expected = test.expectedStdout;
			if (expected === undefined && !test.verify) {
				const key = `${i}:${threads}`;
				let reference = this.referenceOutputs.get(key);
				if (!reference) {
					reference = await this.runTest(test, threads, "reference", signal);
					this.referenceOutputs.set(key, reference);
				}
				if (commandError(reference) || reference.exitCode !== expectedExit) {
					error = true; diagnostics.push({ ...meta, message: `参考程序执行失败：${commandError(reference) ?? reference.stderr}` }); continue;
				}
				expected = reference.stdout;
				if (!expected.trim()) {
					error = true; diagnostics.push({ ...meta, message: "参考输出为空；请配置 expectedStdout 或 verify，不能仅比较退出码" }); continue;
				}
			}
			const actual = await this.runTest(test, threads, "candidate", signal);
			const problem = commandError(actual);
			if (problem || actual.exitCode !== expectedExit) {
				if (actual.error || actual.truncated || actual.aborted) error = true; else failed = true;
				diagnostics.push({ ...meta, message: problem ?? `候选退出码 ${actual.exitCode}，预期 ${expectedExit}`, actual: actual.stderr }); continue;
			}
			if (expected !== undefined && !compareOutput(expected, actual.stdout, test.absoluteTolerance, test.relativeTolerance)) {
				failed = true; diagnostics.push({ ...meta, message: "候选计算结果与参考结果不一致", expected: expected.slice(0, 8000), actual: actual.stdout.slice(0, 8000) });
			}
			if (test.verify) {
				const stdoutFile = path.join(this.root, "build", "stdout.txt"), stderrFile = path.join(this.root, "build", "stderr.txt");
				await fs.writeFile(stdoutFile, actual.stdout); await fs.writeFile(stderrFile, actual.stderr);
				const verified = await this.execute(test.verify, "candidate", signal, "", {
					...this.variables("candidate"), stdoutFile, stderrFile, exitCode: String(actual.exitCode),
				});
				if (commandError(verified)) { error = true; diagnostics.push({ ...meta, message: `校验器执行异常：${commandError(verified)}` }); }
				else if (verified.exitCode !== 0) { failed = true; diagnostics.push({ ...meta, message: "功能校验器判定失败", actual: verified.stderr + verified.stdout }); }
			}
			if (signal.aborted) break;
		}
		return { kind: "functional", status: error ? "error" : failed ? "failed" : "passed", diagnostics };
	}

	private async raceCheck(signal: AbortSignal): Promise<CheckResult> {
		const race = this.config.race, tests = this.config.tests ?? [], threads = this.threads.filter(n => n > 1);
		if (!race) return check("race", "skipped", "未配置竞态检测工具链；未执行检测不能视为无竞态");
		if (!tests.length || !threads.length) return check("race", "skipped", "竞态检测需要测试输入和大于1的线程数");
		const built = await this.execute(race.build, "candidate", signal, "", this.variables("candidate", true));
		if (commandError(built) || built.exitCode !== 0)
			return check("race", "error", `检测构建未就绪：${commandError(built) ?? built.stderr + built.stdout}`);
		const diagnostics: Diagnostic[] = [];
		let failed = false, error = false;
		for (const test of tests) for (const count of threads) {
			const result = await this.runTest(test, count, "candidate", signal, true);
			const output = result.stderr + "\n" + result.stdout, meta = { test: test.name, threads: count };
			const detected = /(?:WARNING|SUMMARY):\s*ThreadSanitizer:\s*(?:data race|race on|lock-order-inversion)/i.test(output);
			const active = new RegExp(race.activationPattern, "m").test(output);
			const disabled = /Archer detected OpenMP application without TSan/i.test(output);
			if (commandError(result) || /FATAL:\s*ThreadSanitizer/i.test(output) || !active || disabled) {
				error = true; diagnostics.push({ ...meta, message: commandError(result) ?? (disabled ? "Archer因缺少TSan插桩而禁用，未完成竞态检测" : !active ? "未观察到检测器启动标识，检测覆盖未确认" : "竞态检测器运行异常"), actual: output });
			} else if (detected) {
				failed = true; diagnostics.push({ ...meta, message: "检测器报告并发缺陷", actual: output });
			} else if (result.exitCode !== (test.expectedExitCode ?? 0)) {
				error = true; diagnostics.push({ ...meta, message: `检测程序异常退出：${result.exitCode}`, actual: output });
			} else {
				diagnostics.push({ ...meta, message: "已确认检测器启动；本次执行未报告并发缺陷", actual: output });
			}
			if (signal.aborted) break;
		}
		return { kind: "race", status: error ? "error" : failed ? "failed" : "passed", diagnostics };
	}

	async validate(candidate: string, signal: AbortSignal): Promise<ValidationResult> {
		const checks: CheckResult[] = [];
		const complete = (): ValidationResult => {
			for (const kind of ["edit_scope", "compile", "functional", "race"] as CheckKind[])
				if (!checks.some(item => item.kind === kind)) checks.push(check(kind, "skipped", "前置检查未完成，此项未执行"));
			return { status: validationStatus(checks), checks,
				context: `只验证当前选区替换后的完整程序。源文件：${this.relativeSource || this.input.sourcePath}；线程数：${this.threads.join(",")}；测试：${(this.config.tests ?? []).map(t => t.name).join(",") || "未配置"}` };
		};
		try {
			const original = this.input.fullSource.slice(this.input.selectionStart, this.input.selectionEnd);
			if (!candidate.trim() || !sameComputation(original, candidate)) {
				checks.push(check("edit_scope", "failed", "候选改变了非OpenMP计算代码，或不是有效的代码片段；只能调整OpenMP指令")); return complete();
			}
			checks.push(check("edit_scope", "passed", "除OpenMP指令、注释和格式外，词法标记保持一致（不是语义等价证明）"));
			if (!this.config.enabled) { checks.push(check("compile", "skipped", "外部工具验证已禁用")); return complete(); }
			await this.prepare(signal);
			if (!this.baselineBuilt) {
				const baseline = this.compilerCheck(await this.execute(this.build, "reference", signal), true);
				if (baseline.status !== "passed") { checks.push(baseline); return complete(); }
				this.baselineBuilt = true;
			}
			await this.removeOwned(path.join(this.root, "candidate"));
			await this.copyProject(path.join(this.root, "project"), path.join(this.root, "candidate"), signal);
			await fs.writeFile(path.join(this.root, "candidate", this.relativeSource), replaceSelection(
				this.input.fullSource, this.input.selectionStart, this.input.selectionEnd, candidate), "utf8");
			// A custom build must produce a fresh artifact; never reuse a previous round's binary.
			await fs.rm(this.variables("candidate").binary, { force: true });
			checks.push(this.compilerCheck(await this.execute(this.build, "candidate", signal), false));
			if (checks.at(-1)!.status !== "passed") return complete();
			checks.push(await this.functionalCheck(signal));
			if (checks.at(-1)!.status === "error" || signal.aborted) return complete();
			await fs.rm(this.variables("candidate", true).binary, { force: true });
			checks.push(await this.raceCheck(signal));
			return complete();
		} catch (cause) {
			checks.push(check("compile", "error", `验证环境或配置异常：${String(cause)}`)); return complete();
		}
	}

	async record(record: IterationRecord) {
		if (this.root) await fs.writeFile(path.join(this.root, `iteration-${record.iteration}.json`), JSON.stringify(record, null, 2), "utf8");
	}
	private async removeOwned(target: string) {
		if (!this.root || !isWithin(this.root, target) || path.resolve(target) === path.resolve(this.root))
			throw new Error("拒绝清理验证目录以外的路径");
		await fs.rm(target, { recursive: true, force: true });
	}
	async dispose() {
		if (!this.root) return;
		// Keep only per-round evidence; discard source copies and executables.
		for (const name of ["project", "reference", "candidate", "build"]) await this.removeOwned(path.join(this.root, name));
	}
}
