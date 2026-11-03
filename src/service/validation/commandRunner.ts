import { spawn } from "node:child_process";
import * as path from "node:path";
import { ToolCommand } from "../../types/Validation";

export interface CommandResult {
	exitCode: number | null;
	stdout: string;
	stderr: string;
	error?: string;
	timedOut: boolean;
	aborted: boolean;
	truncated: boolean;
	durationMs: number;
}
export function runCommand(command: ToolCommand, cwd: string, signal: AbortSignal,
	timeoutMs: number, maxOutputBytes: number, stdin = ""): Promise<CommandResult> {
	return new Promise(resolve => {
		const started = Date.now();
		let stdout = "", stderr = "", bytes = 0;
		let timedOut = false, aborted = signal.aborted, truncated = false;
		let error: string | undefined, finished = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let stop = () => {};
		const finish = (exitCode: number | null) => {
			if (finished) return;
			finished = true;
			if (timer) clearTimeout(timer);
			signal.removeEventListener("abort", onAbort);
			resolve({ exitCode, stdout, stderr, error, timedOut, aborted, truncated, durationMs: Date.now() - started });
		};
		const onAbort = () => { aborted = true; stop(); };
		if (aborted) { finish(null); return; }
		try {
			const child = spawn(command.command, command.args, {
				cwd, shell: false, windowsHide: true, detached: process.platform !== "win32",
				env: { ...process.env, ...command.env }, stdio: ["pipe", "pipe", "pipe"],
			});
			let stopping = false;
			stop = () => {
				if (stopping || finished || !child.pid) return;
				stopping = true;
				if (process.platform === "win32") {
					const killer = spawn(path.join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe"),
						["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
					killer.on("error", () => child.kill());
					killer.on("exit", code => { if (code !== 0) child.kill(); });
				} else {
					try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
				}
			};
			const capture = (chunk: Buffer, target: "stdout" | "stderr") => {
				const text = chunk.subarray(0, Math.max(0, maxOutputBytes - bytes)).toString("utf8");
				if (target === "stdout") stdout += text; else stderr += text;
				bytes += chunk.length;
				if (bytes > maxOutputBytes) { truncated = true; stop(); }
			};
			child.stdout.on("data", chunk => capture(chunk, "stdout"));
			child.stderr.on("data", chunk => capture(chunk, "stderr"));
			child.on("error", cause => { error = cause.message; });
			child.on("close", finish);
			child.stdin.on("error", cause => { if ((cause as NodeJS.ErrnoException).code !== "EPIPE") error = cause.message; });
			timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
			signal.addEventListener("abort", onAbort, { once: true });
			if (signal.aborted) onAbort();
			child.stdin.end(stdin);
		} catch (cause) { error = String(cause); finish(null); }
	});
}
