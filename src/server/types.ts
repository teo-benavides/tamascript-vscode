import { Diagnostic, Range } from 'vscode-languageserver-types';

export type DefKind = 'fire' | 'act' | 'bullet' | 'emitter';

export interface TamaDefinition {
	kind: DefKind;
	name: string;
	nameRange: Range;
	params: string[];
	sourceUri: string;
}

export interface TamaReference {
	kind: DefKind;
	name: string;
	range: Range;
}

export interface ExportDecl {
	typeName: 'num' | 'str' | 'bool';
	name: string;
	nameRange: Range;
	defaultValue?: string;
}

export interface IncludeDecl {
	name: string;
	nameRange: Range;
	resolvedUri: string | null;
}

export interface ParseResult {
	definitions: Map<string, TamaDefinition>;
	references: TamaReference[];
	exports: ExportDecl[];
	includes: IncludeDecl[];
	diagnostics: Diagnostic[];
}
