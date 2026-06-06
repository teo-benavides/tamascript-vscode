import { Diagnostic, DiagnosticSeverity, Range } from 'vscode-languageserver-types';
import { DefKind, ExportDecl, IncludeDecl, ParseResult, TamaDefinition, TamaReference } from './types';

/** Called by the parser when it encounters an include directive.
 *  Returns the resolved URI and file text, or null if unresolvable. */
export type IncludeResolver = (fromUri: string, includeName: string) => { uri: string; text: string } | null;

const KEYWORDS = new Set([
	'main', 'fire', 'act', 'bullet', 'bul',
	'repeat', 'repeatf', 'wait', 'waitf', 'vanish', 'async',
	'while', 'if', 'elif', 'else', 'var', 'break', 'true', 'false',
	'chdir', 'chspd', 'chpos', 'accel', 'over',
	'dir', 'speed', 'spd', 'offset', 'pos', 'mvmt',
	'aim', 'abs', 'rel', 'seq',
	'x', 'y', 'type',
	'emitter', 'emt',
	'export', 'include'
]);

type TokType =
	| 'KEYWORD' | 'IDENT' | 'NUMBER'
	| 'LPAREN' | 'RPAREN' | 'COMMA' | 'OP'
	| 'NEWLINE' | 'INDENT' | 'DEDENT' | 'EOF';

interface Token {
	type: TokType;
	value: string;
	line: number;
	char: number;
}

function makeRange(startLine: number, startChar: number, endLine: number, endChar: number): Range {
	return {
		start: { line: startLine, character: startChar },
		end: { line: endLine, character: endChar }
	};
}

function tokenRange(tok: Token): Range {
	return makeRange(tok.line, tok.char, tok.line, tok.char + tok.value.length);
}

function tokenize(text: string): Token[] {
	const tokens: Token[] = [];
	const rawLines = text.split(/\r?\n/);
	const indentStack = [0];

	for (let lineNum = 0; lineNum < rawLines.length; lineNum++) {
		const rawLine = rawLines[lineNum];

		// Strip comment and trailing whitespace
		const commentIdx = rawLine.indexOf('#');
		const line = (commentIdx >= 0 ? rawLine.slice(0, commentIdx) : rawLine).trimEnd();

		if (line.trim() === '') continue;

		// Compute indent level
		let indent = 0;
		let i = 0;
		while (i < line.length && (line[i] === ' ' || line[i] === '\t')) {
			indent += line[i] === '\t' ? 4 : 1;
			i++;
		}

		// Emit INDENT/DEDENT tokens
		const curIndent = indentStack[indentStack.length - 1];
		if (indent > curIndent) {
			indentStack.push(indent);
			tokens.push({ type: 'INDENT', value: '', line: lineNum, char: 0 });
		} else if (indent < curIndent) {
			while (indentStack.length > 1 && indentStack[indentStack.length - 1] > indent) {
				indentStack.pop();
				tokens.push({ type: 'DEDENT', value: '', line: lineNum, char: 0 });
			}
		}

		// Tokenize line content
		while (i < line.length) {
			const ch = line[i];

			if (ch === ' ' || ch === '\t') { i++; continue; }

			if (ch === '(') {
				tokens.push({ type: 'LPAREN', value: '(', line: lineNum, char: i++ });
			} else if (ch === ')') {
				tokens.push({ type: 'RPAREN', value: ')', line: lineNum, char: i++ });
			} else if (ch === ',') {
				tokens.push({ type: 'COMMA', value: ',', line: lineNum, char: i++ });
			} else if (/\d/.test(ch)) {
				const start = i;
				let num = '';
				while (i < line.length && /[\d.]/.test(line[i])) num += line[i++];
				tokens.push({ type: 'NUMBER', value: num, line: lineNum, char: start });
			} else if (/[a-zA-Z_]/.test(ch)) {
				const start = i;
				let word = '';
				while (i < line.length && /[a-zA-Z0-9_]/.test(line[i])) word += line[i++];
				tokens.push({ type: KEYWORDS.has(word) ? 'KEYWORD' : 'IDENT', value: word, line: lineNum, char: start });
			} else {
				const two = line.slice(i, i + 2);
				if (['==', '!=', '<=', '>=', '&&', '||'].includes(two)) {
					tokens.push({ type: 'OP', value: two, line: lineNum, char: i });
					i += 2;
				} else if ('*/+-<>!&|=%'.includes(ch)) {
					tokens.push({ type: 'OP', value: ch, line: lineNum, char: i++ });
				} else {
					i++;
				}
			}
		}

		tokens.push({ type: 'NEWLINE', value: '', line: lineNum, char: line.length });
	}

	// Close remaining open indents
	const lastLine = rawLines.length - 1;
	while (indentStack.length > 1) {
		indentStack.pop();
		tokens.push({ type: 'DEDENT', value: '', line: lastLine, char: 0 });
	}

	tokens.push({ type: 'EOF', value: '', line: rawLines.length, char: 0 });
	return tokens;
}

class Stream {
	private tokens: Token[];
	private pos = 0;

	constructor(tokens: Token[]) {
		this.tokens = tokens;
	}

	peek(offset = 0): Token {
		const idx = this.pos + offset;
		return idx < this.tokens.length ? this.tokens[idx] : this.tokens[this.tokens.length - 1];
	}

	consume(): Token {
		const tok = this.tokens[this.pos];
		if (this.pos < this.tokens.length - 1) this.pos++;
		return tok;
	}

	is(type: TokType, value?: string): boolean {
		const t = this.peek();
		return t.type === type && (value === undefined || t.value === value);
	}

	skipLine(): void {
		while (!this.is('NEWLINE') && !this.is('EOF')) this.consume();
		if (this.is('NEWLINE')) this.consume();
	}

	// Consume an entire indented block (INDENT ... DEDENT)
	skipBlock(): void {
		if (!this.is('INDENT')) return;
		this.consume();
		let depth = 1;
		while (!this.is('EOF') && depth > 0) {
			if (this.is('INDENT')) depth++;
			else if (this.is('DEDENT')) depth--;
			this.consume();
		}
	}
}

export function parse(
	text: string,
	uri = '',
	resolver?: IncludeResolver,
	_visited: ReadonlySet<string> = new Set()
): ParseResult {
	const visited = new Set([..._visited, uri]);
	const diagnostics: Diagnostic[] = [];
	const definitions = new Map<string, TamaDefinition>();
	const references: TamaReference[] = [];
	const exports: ExportDecl[] = [];
	const includes: IncludeDecl[] = [];

	const tokens = tokenize(text);
	const s = new Stream(tokens);

	function addDiag(range: Range, message: string, severity = DiagnosticSeverity.Error): void {
		diagnostics.push({ range, message, severity });
	}

	function parseParamList(): string[] {
		const params: string[] = [];
		if (!s.is('LPAREN')) return params;
		s.consume(); // (
		while (!s.is('RPAREN') && !s.is('NEWLINE') && !s.is('EOF')) {
			if (s.is('IDENT') || s.is('KEYWORD')) params.push(s.consume().value);
			if (s.is('COMMA')) s.consume();
		}
		if (s.is('RPAREN')) s.consume();
		return params;
	}

	function parseBlock(kind: 'action' | 'fire' | 'bullet', scope: Set<string> = new Set()): void {
		if (!s.is('INDENT')) return;
		s.consume();
		const blockScope = new Set(scope);
		while (!s.is('DEDENT') && !s.is('EOF')) parseStatement(kind, blockScope);
		if (s.is('DEDENT')) s.consume();
	}

	function parseStatement(ctx: 'action' | 'fire' | 'bullet', scope: Set<string>): void {
		const tok = s.peek();

		if (tok.type === 'NEWLINE') { s.consume(); return; }
		if (tok.type === 'INDENT') { s.skipBlock(); return; }
		if (tok.type === 'DEDENT' || tok.type === 'EOF') return;

		if (tok.type !== 'KEYWORD' && tok.type !== 'IDENT') {
			s.skipLine();
			return;
		}

		s.consume();

		switch (tok.value) {
			case 'fire': {
				const next = s.peek();
				if (next.type === 'NEWLINE' || next.type === 'EOF') {
					// inline fire block
					s.skipLine();
					parseBlock('fire', scope);
				} else if (next.type === 'IDENT') {
					const nameTok = s.consume();
					if (!scope.has(nameTok.value)) {
						references.push({ kind: 'fire', name: nameTok.value, range: tokenRange(nameTok) });
					}
					s.skipLine();
				} else {
					s.skipLine();
				}
				break;
			}
			case 'act': {
				const next = s.peek();
				if (next.type === 'NEWLINE' || next.type === 'EOF') {
					s.skipLine();
					parseBlock('action', scope);
				} else if (next.type === 'IDENT') {
					const nameTok = s.consume();
					if (!scope.has(nameTok.value)) {
						references.push({ kind: 'act', name: nameTok.value, range: tokenRange(nameTok) });
					}
					s.skipLine();
				} else {
					s.skipLine();
				}
				break;
			}
			case 'bullet':
			case 'bul': {
				const next = s.peek();
				if (next.type === 'NEWLINE' || next.type === 'EOF') {
					s.skipLine();
					parseBlock('bullet', scope);
				} else if (next.type === 'IDENT') {
					const nameTok = s.consume();
					if (!scope.has(nameTok.value)) {
						references.push({ kind: 'bullet', name: nameTok.value, range: tokenRange(nameTok) });
					}
					s.skipLine();
				} else {
					s.skipLine();
				}
				break;
			}
			case 'emitter':
			case 'emt': {
				const next = s.peek();
				if (next.type === 'NEWLINE' || next.type === 'EOF') {
					s.skipLine();
					parseBlock('action', scope);
				} else if (next.type === 'IDENT') {
					const nameTok = s.consume();
					if (!scope.has(nameTok.value)) {
						references.push({ kind: 'emitter', name: nameTok.value, range: tokenRange(nameTok) });
					}
					s.skipLine();
				} else {
					s.skipLine();
				}
				break;
			}
			case 'repeat': {
				// Collect any trailing IDENT as the index variable and add it to scope
				const lineTokens: Token[] = [];
				while (!s.is('NEWLINE') && !s.is('EOF')) lineTokens.push(s.consume());
				s.skipLine();
				const last = lineTokens[lineTokens.length - 1];
				const indexVar = last?.type === 'IDENT' ? last.value : null;
				const childScope = indexVar ? new Set([...scope, indexVar]) : new Set(scope);
				if (s.is('INDENT')) parseBlock('action', childScope);
				break;
			}
			case 'repeatf': {
				// repeatf [ N [ i ] ] — optional count and 0-based index, like repeat
				const rfTokens: Token[] = [];
				while (!s.is('NEWLINE') && !s.is('EOF')) rfTokens.push(s.consume());
				s.skipLine();
				const rfLast = rfTokens[rfTokens.length - 1];
				const rfIndex = rfLast?.type === 'IDENT' ? rfLast.value : null;
				const rfScope = rfIndex ? new Set([...scope, rfIndex]) : new Set(scope);
				if (s.is('INDENT')) parseBlock('action', rfScope);
				break;
			}
			case 'while':
				s.skipLine();
				if (s.is('INDENT')) parseBlock('action', scope);
				break;
			case 'if':
				s.skipLine();
				if (s.is('INDENT')) parseBlock('action', scope);
				break;
			case 'elif':
				s.skipLine();
				if (s.is('INDENT')) parseBlock('action', scope);
				break;
			case 'else':
				s.skipLine();
				if (s.is('INDENT')) parseBlock('action', scope);
				break;
			case 'var': {
				const varTok = s.peek();
				if (varTok.type === 'IDENT') {
					scope.add(varTok.value);
					s.consume();
				}
				s.skipLine();
				break;
			}
			case 'break':
				s.skipLine();
				break;
			case 'async':
				// delegate to the next statement (act/fire call or inline)
				parseStatement(ctx, scope);
				break;
			case 'chdir':
			case 'chspd':
			case 'chpos':
			case 'accel':
				s.skipLine();
				if (s.is('INDENT')) parseBlock('action', scope);
				break;
			case 'mvmt':
				s.skipLine();
				if (s.is('INDENT')) parseBlock('action', scope);
				break;
			case 'offset':
			case 'pos':
				s.skipLine();
				if (s.is('INDENT')) parseBlock('action', scope);
				break;
			default:
				s.skipLine();
		}
	}

	// Top-level parse loop
	while (!s.is('EOF')) {
		const tok = s.peek();

		if (tok.type === 'NEWLINE' || tok.type === 'INDENT' || tok.type === 'DEDENT') {
			s.consume();
			continue;
		}

		if (tok.type !== 'KEYWORD' && tok.type !== 'IDENT') {
			s.skipLine();
			continue;
		}

		s.consume();

		switch (tok.value) {
			case 'include': {
				const nameTok = s.peek();
				if (nameTok.type === 'IDENT' || nameTok.type === 'KEYWORD') {
					s.consume();
					const resolved = resolver ? resolver(uri, nameTok.value) : null;
					includes.push({
						name: nameTok.value,
						nameRange: tokenRange(nameTok),
						resolvedUri: resolved?.uri ?? null
					});
					if (resolved && !visited.has(resolved.uri)) {
						const included = parse(resolved.text, resolved.uri, resolver, visited);
						for (const [name, def] of included.definitions) {
							if (!definitions.has(name)) definitions.set(name, def);
						}
					}
				}
				s.skipLine();
				break;
			}

			case 'export': {
				// export (num|str) IDENT [default]
				const typeTok = s.peek();
				if ((typeTok.type === 'IDENT' || typeTok.type === 'KEYWORD') &&
					(typeTok.value === 'num' || typeTok.value === 'str' || typeTok.value === 'bool')) {
					s.consume();
					const nameTok = s.peek();
					if (nameTok.type === 'IDENT') {
						s.consume();
						let defaultVal = '';
						while (!s.is('NEWLINE') && !s.is('EOF')) defaultVal += s.consume().value + ' ';
						exports.push({
							typeName: typeTok.value as 'num' | 'str' | 'bool',
							name: nameTok.value,
							nameRange: tokenRange(nameTok),
							defaultValue: defaultVal.trim() || undefined
						});
					} else {
						addDiag(tokenRange(typeTok), 'Expected identifier after export type');
					}
				} else {
					addDiag(tokenRange(typeTok), "Expected 'num', 'str', or 'bool' after export");
				}
				s.skipLine();
				break;
			}

			case 'main':
				s.skipLine();
				parseBlock('action', new Set(exports.map(e => e.name)));
				break;

			case 'fire': {
				const nameTok = s.peek();
				if (nameTok.type === 'IDENT') {
					s.consume();
					const params = parseParamList();
					definitions.set(nameTok.value, {
						kind: 'fire', name: nameTok.value, nameRange: tokenRange(nameTok), params, sourceUri: uri
					});
					s.skipLine();
					parseBlock('fire', new Set<string>(params));
				} else {
					s.skipLine();
				}
				break;
			}

			case 'act': {
				const nameTok = s.peek();
				if (nameTok.type === 'IDENT') {
					s.consume();
					const params = parseParamList();
					definitions.set(nameTok.value, {
						kind: 'act', name: nameTok.value, nameRange: tokenRange(nameTok), params, sourceUri: uri
					});
					s.skipLine();
					parseBlock('action', new Set<string>(params));
				} else {
					s.skipLine();
				}
				break;
			}

			case 'bullet':
			case 'bul': {
				const nameTok = s.peek();
				if (nameTok.type === 'IDENT') {
					s.consume();
					const params = parseParamList();
					definitions.set(nameTok.value, {
						kind: 'bullet', name: nameTok.value, nameRange: tokenRange(nameTok), params, sourceUri: uri
					});
					s.skipLine();
					parseBlock('bullet', new Set<string>(params));
				} else {
					s.skipLine();
				}
				break;
			}

			default:
				s.skipLine();
		}
	}

	// Validate references against definitions
	for (const ref of references) {
		if (!definitions.has(ref.name)) {
			addDiag(ref.range, `Unknown ${ref.kind} '${ref.name}'`);
		}
	}

	return { definitions, references, exports, includes, diagnostics };
}
