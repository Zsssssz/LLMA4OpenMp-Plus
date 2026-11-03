/** Conservative lexical comparison: only #pragma omp directives may change. */
export function codeTokens(source: string): string[] {
	// C/C++ removes escaped newlines before recognizing comments and tokens.
	source = source.replace(/\\\r?\n/g, "");
	const tokens: string[] = [];
	let i = 0, lineStart = true;
	while (i < source.length) {
		const rest = source.slice(i);
		const whitespace = /^\s+/.exec(rest);
		if (whitespace) {
			if (/\n/.test(whitespace[0])) lineStart = true;
			i += whitespace[0].length; continue;
		}
		if (rest.startsWith("//")) {
			const end = source.indexOf("\n", i + 2);
			i = end < 0 ? source.length : end; continue;
		}
		if (rest.startsWith("/*")) {
			const end = source.indexOf("*/", i + 2);
			if (end < 0) throw new Error("Unterminated C/C++ comment");
			if (source.slice(i, end + 2).includes("\n")) lineStart = true;
			i = end + 2; continue;
		}
		if (lineStart && rest[0] === "#") {
			const directive = /^(?:[^\n]*\\\r?\n)*[^\n]*/.exec(rest)![0];
			if (!/^#\s*pragma\s+omp\b/.test(directive)) tokens.push(directive.trim());
			i += directive.length; lineStart = false; continue;
		}
		lineStart = false;
		const raw = /^(?:u8|u|U|L)?R"([^ ()\\\t\r\n]{0,16})\(/.exec(rest);
		if (raw) {
			const terminator = ")" + raw[1] + '"';
			const end = source.indexOf(terminator, i + raw[0].length);
			if (end < 0) throw new Error("Unterminated raw string literal");
			tokens.push(source.slice(i, end + terminator.length)); i = end + terminator.length; continue;
		}
		const literal = /^(?:u8|u|U|L)?(?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*')/.exec(rest);
		if (literal) { tokens.push(literal[0]); i += literal[0].length; continue; }
		const token = /^(?:[A-Za-z_$][\w$]*|(?:\d|\.\d)(?:[eEpP][+-]|[\w.])*|>>=|<<=|->\*|\.\.\.|\+\+|--|->|::|\.\*|<<|>>|<=|>=|==|!=|&&|\|\||\+=|-=|\*=|\/=|%=|&=|\^=|\|=|##|[^\s])/.exec(rest)!;
		tokens.push(token[0]); i += token[0].length;
	}
	return tokens;
}
export function sameComputation(original: string, candidate: string): boolean {
	return JSON.stringify(codeTokens(original)) === JSON.stringify(codeTokens(candidate));
}
export function replaceSelection(source: string, start: number, end: number, candidate: string): string {
	const prefix = source.slice(0, start), suffix = source.slice(end);
	const before = prefix && !/\n[\t ]*$/.test(prefix) && !/^[\t ]*$/.test(prefix) ? "\n" : "";
	const after = suffix && !/^\s*\n/.test(suffix) ? "\n" : "";
	return prefix + before + candidate + after + suffix;
}
