"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parse = parse;
const vscode_languageserver_types_1 = require("vscode-languageserver-types");
const KEYWORDS = new Set([
    'main', 'fire', 'act', 'bullet', 'bul',
    'repeat', 'wait', 'waitf', 'vanish', 'async',
    'chdir', 'chspd', 'accel', 'over',
    'dir', 'speed', 'spd', 'offset', 'pos',
    'aim', 'abs', 'rel', 'seq',
    'x', 'y', 'type',
    'emitter', 'emt',
    'export', 'include'
]);
function makeRange(startLine, startChar, endLine, endChar) {
    return {
        start: { line: startLine, character: startChar },
        end: { line: endLine, character: endChar }
    };
}
function tokenRange(tok) {
    return makeRange(tok.line, tok.char, tok.line, tok.char + tok.value.length);
}
function tokenize(text) {
    const tokens = [];
    const rawLines = text.split(/\r?\n/);
    const indentStack = [0];
    for (let lineNum = 0; lineNum < rawLines.length; lineNum++) {
        const rawLine = rawLines[lineNum];
        // Strip comment and trailing whitespace
        const commentIdx = rawLine.indexOf('#');
        const line = (commentIdx >= 0 ? rawLine.slice(0, commentIdx) : rawLine).trimEnd();
        if (line.trim() === '')
            continue;
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
        }
        else if (indent < curIndent) {
            while (indentStack.length > 1 && indentStack[indentStack.length - 1] > indent) {
                indentStack.pop();
                tokens.push({ type: 'DEDENT', value: '', line: lineNum, char: 0 });
            }
        }
        // Tokenize line content
        while (i < line.length) {
            const ch = line[i];
            if (ch === ' ' || ch === '\t') {
                i++;
                continue;
            }
            if (ch === '(') {
                tokens.push({ type: 'LPAREN', value: '(', line: lineNum, char: i++ });
            }
            else if (ch === ')') {
                tokens.push({ type: 'RPAREN', value: ')', line: lineNum, char: i++ });
            }
            else if (ch === ',') {
                tokens.push({ type: 'COMMA', value: ',', line: lineNum, char: i++ });
            }
            else if (/\d/.test(ch)) {
                const start = i;
                let num = '';
                while (i < line.length && /[\d.]/.test(line[i]))
                    num += line[i++];
                tokens.push({ type: 'NUMBER', value: num, line: lineNum, char: start });
            }
            else if (/[a-zA-Z_]/.test(ch)) {
                const start = i;
                let word = '';
                while (i < line.length && /[a-zA-Z0-9_]/.test(line[i]))
                    word += line[i++];
                tokens.push({ type: KEYWORDS.has(word) ? 'KEYWORD' : 'IDENT', value: word, line: lineNum, char: start });
            }
            else {
                const two = line.slice(i, i + 2);
                if (['==', '!=', '<=', '>=', '&&', '||'].includes(two)) {
                    tokens.push({ type: 'OP', value: two, line: lineNum, char: i });
                    i += 2;
                }
                else if ('*/+-<>!&|=%'.includes(ch)) {
                    tokens.push({ type: 'OP', value: ch, line: lineNum, char: i++ });
                }
                else {
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
    constructor(tokens) {
        this.pos = 0;
        this.tokens = tokens;
    }
    peek(offset = 0) {
        const idx = this.pos + offset;
        return idx < this.tokens.length ? this.tokens[idx] : this.tokens[this.tokens.length - 1];
    }
    consume() {
        const tok = this.tokens[this.pos];
        if (this.pos < this.tokens.length - 1)
            this.pos++;
        return tok;
    }
    is(type, value) {
        const t = this.peek();
        return t.type === type && (value === undefined || t.value === value);
    }
    skipLine() {
        while (!this.is('NEWLINE') && !this.is('EOF'))
            this.consume();
        if (this.is('NEWLINE'))
            this.consume();
    }
    // Consume an entire indented block (INDENT ... DEDENT)
    skipBlock() {
        if (!this.is('INDENT'))
            return;
        this.consume();
        let depth = 1;
        while (!this.is('EOF') && depth > 0) {
            if (this.is('INDENT'))
                depth++;
            else if (this.is('DEDENT'))
                depth--;
            this.consume();
        }
    }
}
function parse(text, uri = '', resolver, _visited = new Set()) {
    const visited = new Set([..._visited, uri]);
    const diagnostics = [];
    const definitions = new Map();
    const references = [];
    const exports = [];
    const includes = [];
    const tokens = tokenize(text);
    const s = new Stream(tokens);
    function addDiag(range, message, severity = vscode_languageserver_types_1.DiagnosticSeverity.Error) {
        diagnostics.push({ range, message, severity });
    }
    function parseParamList() {
        const params = [];
        if (!s.is('LPAREN'))
            return params;
        s.consume(); // (
        while (!s.is('RPAREN') && !s.is('NEWLINE') && !s.is('EOF')) {
            if (s.is('IDENT') || s.is('KEYWORD'))
                params.push(s.consume().value);
            if (s.is('COMMA'))
                s.consume();
        }
        if (s.is('RPAREN'))
            s.consume();
        return params;
    }
    function parseBlock(kind, scope = new Set()) {
        if (!s.is('INDENT'))
            return;
        s.consume();
        while (!s.is('DEDENT') && !s.is('EOF'))
            parseStatement(kind, scope);
        if (s.is('DEDENT'))
            s.consume();
    }
    function parseStatement(ctx, scope) {
        const tok = s.peek();
        if (tok.type === 'NEWLINE') {
            s.consume();
            return;
        }
        if (tok.type === 'INDENT') {
            s.skipBlock();
            return;
        }
        if (tok.type === 'DEDENT' || tok.type === 'EOF')
            return;
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
                }
                else if (next.type === 'IDENT') {
                    const nameTok = s.consume();
                    if (!scope.has(nameTok.value)) {
                        references.push({ kind: 'fire', name: nameTok.value, range: tokenRange(nameTok) });
                    }
                    s.skipLine();
                }
                else {
                    s.skipLine();
                }
                break;
            }
            case 'act': {
                const next = s.peek();
                if (next.type === 'NEWLINE' || next.type === 'EOF') {
                    s.skipLine();
                    parseBlock('action', scope);
                }
                else if (next.type === 'IDENT') {
                    const nameTok = s.consume();
                    if (!scope.has(nameTok.value)) {
                        references.push({ kind: 'act', name: nameTok.value, range: tokenRange(nameTok) });
                    }
                    s.skipLine();
                }
                else {
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
                }
                else if (next.type === 'IDENT') {
                    const nameTok = s.consume();
                    if (!scope.has(nameTok.value)) {
                        references.push({ kind: 'bullet', name: nameTok.value, range: tokenRange(nameTok) });
                    }
                    s.skipLine();
                }
                else {
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
                }
                else if (next.type === 'IDENT') {
                    const nameTok = s.consume();
                    if (!scope.has(nameTok.value)) {
                        references.push({ kind: 'emitter', name: nameTok.value, range: tokenRange(nameTok) });
                    }
                    s.skipLine();
                }
                else {
                    s.skipLine();
                }
                break;
            }
            case 'repeat': {
                // Collect any trailing IDENT as the index variable and add it to scope
                const lineTokens = [];
                while (!s.is('NEWLINE') && !s.is('EOF'))
                    lineTokens.push(s.consume());
                s.skipLine();
                const last = lineTokens[lineTokens.length - 1];
                const indexVar = last?.type === 'IDENT' ? last.value : null;
                const childScope = indexVar ? new Set([...scope, indexVar]) : scope;
                if (s.is('INDENT'))
                    parseBlock('action', childScope);
                break;
            }
            case 'async':
                // delegate to the next statement (act/fire call or inline)
                parseStatement(ctx, scope);
                break;
            case 'chdir':
            case 'chspd':
            case 'accel':
                s.skipLine();
                if (s.is('INDENT'))
                    parseBlock('action', scope);
                break;
            case 'offset':
            case 'pos':
                s.skipLine();
                if (s.is('INDENT'))
                    parseBlock('action', scope);
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
                            if (!definitions.has(name))
                                definitions.set(name, def);
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
                    (typeTok.value === 'num' || typeTok.value === 'str')) {
                    s.consume();
                    const nameTok = s.peek();
                    if (nameTok.type === 'IDENT') {
                        s.consume();
                        let defaultVal = '';
                        while (!s.is('NEWLINE') && !s.is('EOF'))
                            defaultVal += s.consume().value + ' ';
                        exports.push({
                            typeName: typeTok.value,
                            name: nameTok.value,
                            nameRange: tokenRange(nameTok),
                            defaultValue: defaultVal.trim() || undefined
                        });
                    }
                    else {
                        addDiag(tokenRange(typeTok), 'Expected identifier after export type');
                    }
                }
                else {
                    addDiag(tokenRange(typeTok), "Expected 'num' or 'str' after export");
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
                    parseBlock('fire', new Set(params));
                }
                else {
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
                    parseBlock('action', new Set(params));
                }
                else {
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
                    parseBlock('bullet', new Set(params));
                }
                else {
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
//# sourceMappingURL=parser.js.map