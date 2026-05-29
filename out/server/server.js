"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const url_1 = require("url");
const node_1 = require("vscode-languageserver/node");
const vscode_languageserver_textdocument_1 = require("vscode-languageserver-textdocument");
const parser_1 = require("./parser");
const connection = (0, node_1.createConnection)(node_1.ProposedFeatures.all);
const documents = new node_1.TextDocuments(vscode_languageserver_textdocument_1.TextDocument);
const parsedDocs = new Map();
connection.onInitialize((_params) => ({
    capabilities: {
        textDocumentSync: node_1.TextDocumentSyncKind.Incremental,
        completionProvider: { resolveProvider: false, triggerCharacters: [' '] },
        hoverProvider: true,
        definitionProvider: true,
        signatureHelpProvider: { triggerCharacters: ['(', ','] }
    }
}));
function makeResolver() {
    return (fromUri, name) => {
        try {
            const fromPath = (0, url_1.fileURLToPath)(fromUri);
            const dir = path.dirname(fromPath);
            for (const ext of ['.tama', '.tam']) {
                const includePath = path.join(dir, name + ext);
                if (fs.existsSync(includePath)) {
                    return {
                        uri: (0, url_1.pathToFileURL)(includePath).toString(),
                        text: fs.readFileSync(includePath, 'utf8')
                    };
                }
            }
        }
        catch { /* ignore unresolvable includes */ }
        return null;
    };
}
function validateDocument(doc) {
    const result = (0, parser_1.parse)(doc.getText(), doc.uri, makeResolver());
    parsedDocs.set(doc.uri, result);
    connection.sendDiagnostics({ uri: doc.uri, diagnostics: result.diagnostics });
}
documents.onDidChangeContent(e => validateDocument(e.document));
documents.onDidOpen(e => validateDocument(e.document));
documents.onDidClose(e => {
    parsedDocs.delete(e.document.uri);
    connection.sendDiagnostics({ uri: e.document.uri, diagnostics: [] });
});
// ── Hover ─────────────────────────────────────────────────────────────────────
const KEYWORD_DOCS = {
    main: 'Entry point. Executed when the emitter starts. One per executable script.',
    fire: 'Fire definition or fire call. Spawns bullets with the specified properties.',
    act: 'Action definition or action call. A named sequence of timed statements.',
    bullet: 'Bullet definition or bullet reference. Defines the bullet scene and behavior.',
    bul: 'Alias for `bullet`.',
    emitter: 'Emitter definition. An act attached to a bullet that fires more bullets.',
    emt: 'Alias for `emitter`.',
    repeat: 'Loop body.  `repeat` = infinite,  `repeat N` = N times,  `repeat N i` = N times with 1-based index `i`.',
    wait: 'Pause execution for N seconds (wall-clock).',
    waitf: 'Pause execution for N physics frames.',
    vanish: 'Destroy the current bullet and stop its act.',
    async: 'Run an act in parallel without blocking the current sequence.',
    dir: 'Set direction for the next fire.  Qualifiers: `aim` (default), `abs`, `rel`, `seq`.',
    speed: 'Set speed for the next fire.  Qualifiers: `abs` (default), `rel`, `seq`.',
    spd: 'Alias for `speed`.',
    offset: 'Set spawn position offset. Inline form offsets along the bullet\'s local axis; block form uses `x`/`y` axes (default qualifier `rel` — rotated by bullet angle).',
    pos: 'Set the bullet\'s spawn position directly (fire block only). Block form uses `x`/`y` axes. Default qualifier `abs` (world coordinates). Takes priority over `offset`.',
    chdir: 'Emit a direction-change command to the bullet. Requires `dir` and `over` sub-statements.',
    chspd: 'Emit a speed-change command to the bullet. Requires `speed`/`spd` and `over` sub-statements.',
    accel: 'Emit an acceleration command. Accepts `x`, `y`, and `over` sub-statements.',
    over: 'Duration in seconds for a `chdir`, `chspd`, or `accel` transition.',
    type: 'Set bullet type (looked up in TamaBulletRegistry). Usage: `type <name>`',
    x: 'X-axis component inside an `offset` or `accel` block.',
    y: 'Y-axis component inside an `offset` or `accel` block.',
    aim: 'Direction qualifier: aim toward player + offset degrees.',
    abs: 'Qualifier: absolute value.',
    rel: 'Qualifier: relative to current value.',
    seq: 'Qualifier: relative to last fired value.',
    export: 'Expose a variable as an inspector field. Usage: `export num|str NAME [DEFAULT]`',
    include: 'Include another TamaScript file by name. Usage: `include <filename>`',
};
function wordAtPosition(line, char) {
    let start = char;
    let end = char;
    while (start > 0 && /[a-zA-Z0-9_]/.test(line[start - 1]))
        start--;
    while (end < line.length && /[a-zA-Z0-9_]/.test(line[end]))
        end++;
    return line.slice(start, end);
}
function getLine(doc, lineNum) {
    return doc.getText({
        start: { line: lineNum, character: 0 },
        end: { line: lineNum, character: 10000 }
    });
}
connection.onHover((params) => {
    const doc = documents.get(params.textDocument.uri);
    if (!doc)
        return null;
    const line = getLine(doc, params.position.line);
    const word = wordAtPosition(line, params.position.character);
    if (!word)
        return null;
    if (KEYWORD_DOCS[word]) {
        return {
            contents: { kind: node_1.MarkupKind.Markdown, value: `**\`${word}\`** — ${KEYWORD_DOCS[word]}` }
        };
    }
    const result = parsedDocs.get(params.textDocument.uri);
    if (result) {
        const def = result.definitions.get(word);
        if (def) {
            const sig = def.params.length ? `(${def.params.join(', ')})` : '';
            let text = `**${def.kind}** \`${def.name}${sig}\``;
            if (def.sourceUri && def.sourceUri !== params.textDocument.uri) {
                try {
                    text += `\n\n*from* \`${path.basename((0, url_1.fileURLToPath)(def.sourceUri))}\``;
                }
                catch { /* ignore */ }
            }
            return { contents: { kind: node_1.MarkupKind.Markdown, value: text } };
        }
        const exp = result.exports.find(e => e.name === word);
        if (exp) {
            const def2 = exp.defaultValue ? ` = ${exp.defaultValue}` : '';
            return {
                contents: { kind: node_1.MarkupKind.Markdown, value: `**export** \`${exp.typeName} ${exp.name}${def2}\`` }
            };
        }
    }
    return null;
});
// ── Go to Definition ──────────────────────────────────────────────────────────
connection.onDefinition((params) => {
    const doc = documents.get(params.textDocument.uri);
    if (!doc)
        return null;
    const line = getLine(doc, params.position.line);
    const word = wordAtPosition(line, params.position.character);
    if (!word)
        return null;
    const result = parsedDocs.get(params.textDocument.uri);
    if (!result)
        return null;
    // Ctrl+click on an include filename → open that file
    const inc = result.includes.find(i => i.name === word &&
        i.resolvedUri &&
        params.position.line === i.nameRange.start.line &&
        params.position.character >= i.nameRange.start.character &&
        params.position.character <= i.nameRange.end.character);
    if (inc?.resolvedUri) {
        return { uri: inc.resolvedUri, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } } };
    }
    const def = result.definitions.get(word);
    if (!def)
        return null;
    return { uri: def.sourceUri || params.textDocument.uri, range: def.nameRange };
});
// ── Signature Help ────────────────────────────────────────────────────────────
/**
 * Walk backwards from `cursorChar` on the line to find the innermost unclosed
 * call site, returning the function name and the 0-based active parameter index.
 */
function getSignatureContext(line, cursorChar) {
    let depth = 0;
    for (let i = cursorChar - 1; i >= 0; i--) {
        const ch = line[i];
        if (ch === ')') {
            depth++;
        }
        else if (ch === '(') {
            if (depth > 0) {
                depth--;
                continue;
            }
            // Found the unclosed '(' — count top-level commas between here and cursor
            let activeParam = 0;
            let inner = 0;
            for (let j = i + 1; j < cursorChar; j++) {
                if (line[j] === '(')
                    inner++;
                else if (line[j] === ')')
                    inner--;
                else if (line[j] === ',' && inner === 0)
                    activeParam++;
            }
            // Extract the identifier immediately before '('
            let nameEnd = i - 1;
            while (nameEnd >= 0 && line[nameEnd] === ' ')
                nameEnd--;
            let nameStart = nameEnd;
            while (nameStart > 0 && /[a-zA-Z0-9_]/.test(line[nameStart - 1]))
                nameStart--;
            const funcName = line.slice(nameStart, nameEnd + 1);
            if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(funcName)) {
                return { funcName, activeParam };
            }
            return null;
        }
    }
    return null;
}
connection.onSignatureHelp((params) => {
    const doc = documents.get(params.textDocument.uri);
    if (!doc)
        return null;
    const line = getLine(doc, params.position.line);
    const ctx = getSignatureContext(line, params.position.character);
    if (!ctx)
        return null;
    const result = parsedDocs.get(params.textDocument.uri);
    const def = result?.definitions.get(ctx.funcName);
    if (!def || def.params.length === 0)
        return null;
    const parameters = def.params.map(p => ({ label: p }));
    const label = `${def.name}(${def.params.join(', ')})`;
    const activeParameter = Math.min(ctx.activeParam, def.params.length - 1);
    return {
        signatures: [{ label, parameters }],
        activeSignature: 0,
        activeParameter
    };
});
// ── Completions ───────────────────────────────────────────────────────────────
const COMPLETIONS = {
    top: ['main', 'fire', 'act', 'bullet', 'include', 'export'],
    action: ['repeat', 'wait', 'waitf', 'vanish', 'async', 'fire', 'act', 'dir', 'speed', 'spd', 'offset', 'chdir', 'chspd', 'accel'],
    fire: ['dir', 'speed', 'spd', 'offset', 'pos', 'bullet', 'bul'],
    bullet: ['type', 'emitter', 'emt', 'act'],
    chdir: ['dir', 'over'],
    chspd: ['speed', 'spd', 'over'],
    accel: ['x', 'y', 'over'],
    offset: ['x', 'y'],
    pos: ['x', 'y'],
};
function getCompletionContext(lines, lineNum) {
    const curLine = lines[lineNum] ?? '';
    // Compute indent of current line
    let curIndent = 0;
    for (const ch of curLine) {
        if (ch === ' ')
            curIndent++;
        else if (ch === '\t')
            curIndent += 4;
        else
            break;
    }
    if (curIndent === 0)
        return 'top';
    // Find the parent line (first non-blank line with less indent)
    let parentKeyword = null;
    for (let i = lineNum - 1; i >= 0; i--) {
        const l = lines[i];
        if (!l || l.trim() === '' || l.trim().startsWith('#'))
            continue;
        let lineIndent = 0;
        let j = 0;
        while (j < l.length && (l[j] === ' ' || l[j] === '\t')) {
            lineIndent += l[j] === '\t' ? 4 : 1;
            j++;
        }
        if (lineIndent < curIndent) {
            parentKeyword = l.trim().match(/^([a-zA-Z_][a-zA-Z0-9_]*)/)?.[1] ?? null;
            break;
        }
    }
    if (!parentKeyword)
        return 'action';
    if (parentKeyword === 'chdir')
        return 'chdir';
    if (parentKeyword === 'chspd')
        return 'chspd';
    if (parentKeyword === 'accel')
        return 'accel';
    if (parentKeyword === 'offset')
        return 'offset';
    if (parentKeyword === 'pos')
        return 'pos';
    if (parentKeyword === 'fire')
        return 'fire';
    if (parentKeyword === 'bullet' || parentKeyword === 'bul')
        return 'bullet';
    // repeat/async/act/main/emitter/emt all contain action blocks
    return 'action';
}
connection.onCompletion((params) => {
    const doc = documents.get(params.textDocument.uri);
    if (!doc)
        return [];
    const lines = doc.getText().split(/\r?\n/);
    const ctx = getCompletionContext(lines, params.position.line);
    const keywords = COMPLETIONS[ctx] ?? COMPLETIONS['action'];
    const items = keywords.map(kw => ({
        label: kw,
        kind: node_1.CompletionItemKind.Keyword,
        detail: KEYWORD_DOCS[kw]
    }));
    const result = parsedDocs.get(params.textDocument.uri);
    if (result) {
        for (const [name, def] of result.definitions) {
            const sig = def.params.length ? `(${def.params.join(', ')})` : '';
            items.push({
                label: name,
                kind: def.kind === 'act' ? node_1.CompletionItemKind.Function :
                    def.kind === 'fire' ? node_1.CompletionItemKind.Event :
                        def.kind === 'bullet' ? node_1.CompletionItemKind.Class :
                            node_1.CompletionItemKind.Module,
                detail: `${def.kind} ${name}${sig}`,
            });
        }
        for (const exp of result.exports) {
            items.push({
                label: exp.name,
                kind: node_1.CompletionItemKind.Variable,
                detail: `export ${exp.typeName} ${exp.name}`,
            });
        }
    }
    return items;
});
documents.listen(connection);
connection.listen();
//# sourceMappingURL=server.js.map