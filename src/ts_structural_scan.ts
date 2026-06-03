/**
 * ts_structural_scan.ts
 *
 * Core structural scanner. Uses the TypeScript Compiler API to extract
 * symbols, imports, and exports from a single source file.
 *
 * Principle: extract routing facts only. No semantic analysis, no type
 * resolution, no call graph. The AI reads the returned source ranges.
 */

import * as ts from "typescript";
import type {
  ExportKind,
  ExportRecord,
  ImportKind,
  ImportRecord,
  IndexDiagnostic,
  IndexedSymbol,
  SourceRange,
  SymbolKind,
} from "./ts_index_model";
import {
  exportId,
  importId,
  resolveModuleSpecifier,
  symbolId,
  DEFAULT_EXTENSIONS,
} from "./ts_index_utils";

// ---------------------------------------------------------------------------
// Scan result
// ---------------------------------------------------------------------------

export type ScanResult = {
  symbols: IndexedSymbol[];
  imports: ImportRecord[];
  exports: ExportRecord[];
  diagnostics: IndexDiagnostic[];
};

// ---------------------------------------------------------------------------
// Scanner context
// ---------------------------------------------------------------------------

type ScanContext = {
  fileId: string;
  relativePath: string;
  absolutePath: string;
  projectRoot: string;
  sourceFile: ts.SourceFile;
  qualifiedNameStack: string[];
  containerStack: string[];
  symbolOrder: number;
};

// ---------------------------------------------------------------------------
// Line number helpers
// ---------------------------------------------------------------------------

function lineOf(sourceFile: ts.SourceFile, pos: number): number {
  return sourceFile.getLineAndCharacterOfPosition(pos).line + 1;
}

function colOf(sourceFile: ts.SourceFile, pos: number): number {
  return sourceFile.getLineAndCharacterOfPosition(pos).character + 1;
}

function nodeRange(sourceFile: ts.SourceFile, node: ts.Node): SourceRange {
  const start = node.getStart(sourceFile);
  const end = node.getEnd();
  return {
    startLine: lineOf(sourceFile, start),
    endLine: lineOf(sourceFile, end),
    startColumn: colOf(sourceFile, start),
    endColumn: colOf(sourceFile, end),
  };
}

// ---------------------------------------------------------------------------
// Name extraction
// ---------------------------------------------------------------------------

function getNodeName(node: ts.Node): string | null {
  if (
    ts.isFunctionDeclaration(node) ||
    ts.isClassDeclaration(node) ||
    ts.isInterfaceDeclaration(node) ||
    ts.isTypeAliasDeclaration(node) ||
    ts.isEnumDeclaration(node) ||
    ts.isModuleDeclaration(node)
  ) {
    return node.name?.text ?? null;
  }

  if (ts.isMethodDeclaration(node) || ts.isMethodSignature(node)) {
    const name = node.name;
    if (ts.isIdentifier(name)) return name.text;
    if (ts.isStringLiteral(name)) return name.text;
    if (ts.isComputedPropertyName(name)) return "[computed]";
    return null;
  }

  if (ts.isConstructorDeclaration(node)) {
    return "constructor";
  }

  if (ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) {
    const name = node.name;
    return ts.isIdentifier(name) ? name.text : null;
  }

  if (ts.isPropertyDeclaration(node) || ts.isPropertySignature(node)) {
    const name = node.name;
    return ts.isIdentifier(name) ? name.text : null;
  }

  if (ts.isVariableDeclaration(node)) {
    return ts.isIdentifier(node.name) ? node.name.text : null;
  }

  if (ts.isEnumMember(node)) {
    const name = node.name;
    return ts.isIdentifier(name) ? name.text : null;
  }

  return null;
}

function buildQualifiedName(stack: string[], name: string): string {
  return stack.length > 0 ? `${stack.join(".")}::${name}` : name;
}

// ---------------------------------------------------------------------------
// Symbol kind detection
// ---------------------------------------------------------------------------

function getSymbolKind(node: ts.Node): SymbolKind | null {
  if (ts.isClassDeclaration(node)) {
    const isAbstract = node.modifiers?.some(
      (m) => m.kind === ts.SyntaxKind.AbstractKeyword,
    ) ?? false;
    return isAbstract ? "abstract_class" : "class";
  }
  if (ts.isInterfaceDeclaration(node)) return "interface";
  if (ts.isTypeAliasDeclaration(node)) return "type_alias";
  if (ts.isEnumDeclaration(node)) return "enum";
  if (ts.isEnumMember(node)) return "enum_member";
  if (ts.isModuleDeclaration(node)) return "namespace";
  if (ts.isFunctionDeclaration(node)) return "function";
  if (ts.isMethodDeclaration(node)) return "method";
  if (ts.isMethodSignature(node)) return "method_declaration";
  if (ts.isConstructorDeclaration(node)) return "constructor";
  if (ts.isGetAccessorDeclaration(node)) return "getter";
  if (ts.isSetAccessorDeclaration(node)) return "setter";
  if (ts.isPropertyDeclaration(node) || ts.isPropertySignature(node)) return "property";
  if (ts.isVariableDeclaration(node)) {
    // Check if it's an arrow function
    if (
      node.initializer &&
      (ts.isArrowFunction(node.initializer) ||
        ts.isFunctionExpression(node.initializer))
    ) {
      return "arrow_function";
    }
    return "variable";
  }

  return null;
}

// ---------------------------------------------------------------------------
// Modifier helpers
// ---------------------------------------------------------------------------

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  if (!ts.canHaveModifiers(node)) return false;
  return ts.getModifiers(node)?.some((m) => m.kind === kind) ?? false;
}

function isExported(node: ts.Node): boolean {
  return (
    hasModifier(node, ts.SyntaxKind.ExportKeyword) ||
    hasModifier(node, ts.SyntaxKind.DefaultKeyword)
  );
}

function isAsync(node: ts.Node): boolean {
  return hasModifier(node, ts.SyntaxKind.AsyncKeyword);
}

function isAbstractNode(node: ts.Node): boolean {
  return hasModifier(node, ts.SyntaxKind.AbstractKeyword);
}

function isStaticNode(node: ts.Node): boolean {
  return hasModifier(node, ts.SyntaxKind.StaticKeyword);
}

function isReadonlyNode(node: ts.Node): boolean {
  return hasModifier(node, ts.SyntaxKind.ReadonlyKeyword);
}

// ---------------------------------------------------------------------------
// Signature extraction
// ---------------------------------------------------------------------------

function extractSignature(
  node: ts.Node,
  sourceFile: ts.SourceFile,
  name: string,
): string {
  if (
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isMethodSignature(node)
  ) {
    // Extract up to the body start or end of parameters
    const body = (node as ts.FunctionLikeDeclaration).body;
    const endPos = body ? body.getStart(sourceFile) - 1 : node.getEnd();
    const text = sourceFile.text.slice(node.getStart(sourceFile), endPos).trim();
    // Limit length
    return text.length > 200 ? text.slice(0, 197) + "..." : text;
  }

  if (ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node)) {
    const body = (node as ts.ClassDeclaration).members;
    if (body) {
      const endPos = node.getStart(sourceFile) +
        sourceFile.text.slice(node.getStart(sourceFile)).indexOf("{");
      if (endPos > node.getStart(sourceFile)) {
        const text = sourceFile.text
          .slice(node.getStart(sourceFile), endPos)
          .trim();
        return text.length > 200 ? text.slice(0, 197) + "..." : text;
      }
    }
  }

  if (ts.isTypeAliasDeclaration(node)) {
    const text = sourceFile.text
      .slice(node.getStart(sourceFile), node.getEnd())
      .trim();
    return text.length > 200 ? text.slice(0, 197) + "..." : text;
  }

  return name;
}

// ---------------------------------------------------------------------------
// Leading comment extraction
// ---------------------------------------------------------------------------

function extractLeadingCommentRange(
  node: ts.Node,
  sourceFile: ts.SourceFile,
): SourceRange | undefined {
  const fullStart = node.getFullStart();
  const start = node.getStart(sourceFile);
  if (fullStart >= start) return undefined;

  const leadingText = sourceFile.text.slice(fullStart, start);
  const commentRanges = ts.getLeadingCommentRanges(sourceFile.text, fullStart);
  if (!commentRanges || commentRanges.length === 0) return undefined;

  const last = commentRanges[commentRanges.length - 1];
  if (!last) return undefined;

  return {
    startLine: lineOf(sourceFile, last.pos),
    endLine: lineOf(sourceFile, last.end),
  };
}

// ---------------------------------------------------------------------------
// Import extraction
// ---------------------------------------------------------------------------

function extractImports(
  sourceFile: ts.SourceFile,
  fileId: string,
  absolutePath: string,
  projectRoot: string,
): ImportRecord[] {
  const imports: ImportRecord[] = [];

  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node)) {
      const specifier = (node.moduleSpecifier as ts.StringLiteral).text;
      const resolved = resolveModuleSpecifier(
        specifier,
        absolutePath,
        projectRoot,
        DEFAULT_EXTENSIONS,
      );
      const isExternal = !specifier.startsWith(".") && !specifier.startsWith("/");
      const clause = node.importClause;
      const isTypeOnly = clause?.isTypeOnly ?? false;
      const defaultBinding = clause?.name?.text ?? null;
      const namedBindings: string[] = [];
      let namespaceBinding: string | null = null;

      if (clause?.namedBindings) {
        if (ts.isNamespaceImport(clause.namedBindings)) {
          namespaceBinding = clause.namedBindings.name.text;
        } else if (ts.isNamedImports(clause.namedBindings)) {
          for (const el of clause.namedBindings.elements) {
            namedBindings.push(el.name.text);
          }
        }
      }

      const line = lineOf(sourceFile, node.getStart(sourceFile));
      const kind: ImportKind = isTypeOnly
        ? "type_import"
        : clause == null
          ? "side_effect_import"
          : "static_import";

      imports.push({
        importId: importId(fileId, specifier, line),
        fileId,
        kind,
        moduleSpecifier: specifier,
        resolvedRelativePath: resolved,
        isExternal,
        namedBindings,
        defaultBinding,
        namespaceBinding,
        isTypeOnly,
        line,
      });
    }

    // Dynamic imports: import("...")
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      const specifier = (node.arguments[0] as ts.StringLiteral).text;
      const resolved = resolveModuleSpecifier(
        specifier,
        absolutePath,
        projectRoot,
        DEFAULT_EXTENSIONS,
      );
      const isExternal = !specifier.startsWith(".") && !specifier.startsWith("/");
      const line = lineOf(sourceFile, node.getStart(sourceFile));

      imports.push({
        importId: importId(fileId, specifier, line),
        fileId,
        kind: "dynamic_import",
        moduleSpecifier: specifier,
        resolvedRelativePath: resolved,
        isExternal,
        namedBindings: [],
        defaultBinding: null,
        namespaceBinding: null,
        isTypeOnly: false,
        line,
      });
    }

    // require("...")
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "require" &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      const specifier = (node.arguments[0] as ts.StringLiteral).text;
      const resolved = resolveModuleSpecifier(
        specifier,
        absolutePath,
        projectRoot,
        DEFAULT_EXTENSIONS,
      );
      const isExternal = !specifier.startsWith(".") && !specifier.startsWith("/");
      const line = lineOf(sourceFile, node.getStart(sourceFile));

      imports.push({
        importId: importId(fileId, specifier, line),
        fileId,
        kind: "require_call",
        moduleSpecifier: specifier,
        resolvedRelativePath: resolved,
        isExternal,
        namedBindings: [],
        defaultBinding: null,
        namespaceBinding: null,
        isTypeOnly: false,
        line,
      });
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return imports;
}

// ---------------------------------------------------------------------------
// Export extraction
// ---------------------------------------------------------------------------

function extractExports(
  sourceFile: ts.SourceFile,
  fileId: string,
): ExportRecord[] {
  const exports: ExportRecord[] = [];

  function visit(node: ts.Node): void {
    if (ts.isExportDeclaration(node)) {
      const specifier = node.moduleSpecifier
        ? (node.moduleSpecifier as ts.StringLiteral).text
        : null;
      const isTypeOnly = node.isTypeOnly;
      const line = lineOf(sourceFile, node.getStart(sourceFile));

      if (node.exportClause == null) {
        // export * from "..."
        exports.push({
          exportId: exportId(fileId, null, "export_all", line),
          fileId,
          kind: "export_all",
          name: null,
          moduleSpecifier: specifier,
          resolvedRelativePath: null,
          isTypeOnly,
          line,
        });
      } else if (ts.isNamedExports(node.exportClause)) {
        for (const el of node.exportClause.elements) {
          const name = el.name.text;
          const kind: ExportKind = specifier ? "re_export" : isTypeOnly ? "type_export" : "named_export";
          exports.push({
            exportId: exportId(fileId, name, kind, line),
            fileId,
            kind,
            name,
            moduleSpecifier: specifier,
            resolvedRelativePath: null,
            isTypeOnly: el.isTypeOnly || isTypeOnly,
            line,
          });
        }
      }
      return;
    }

    if (ts.isExportAssignment(node)) {
      const line = lineOf(sourceFile, node.getStart(sourceFile));
      exports.push({
        exportId: exportId(fileId, "default", "default_export", line),
        fileId,
        kind: "default_export",
        name: "default",
        moduleSpecifier: null,
        resolvedRelativePath: null,
        isTypeOnly: false,
        line,
      });
      return;
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return exports;
}

// ---------------------------------------------------------------------------
// Symbol scanning
// ---------------------------------------------------------------------------

function shouldIndexNode(node: ts.Node): boolean {
  return (
    ts.isClassDeclaration(node) ||
    ts.isInterfaceDeclaration(node) ||
    ts.isTypeAliasDeclaration(node) ||
    ts.isEnumDeclaration(node) ||
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isMethodSignature(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isPropertyDeclaration(node) ||
    ts.isPropertySignature(node) ||
    ts.isEnumMember(node) ||
    ts.isModuleDeclaration(node) ||
    // Variable with arrow function or function expression
    (ts.isVariableDeclaration(node) &&
      node.initializer != null &&
      (ts.isArrowFunction(node.initializer) ||
        ts.isFunctionExpression(node.initializer)))
  );
}

function isContainerNode(node: ts.Node): boolean {
  return (
    ts.isClassDeclaration(node) ||
    ts.isClassExpression(node) ||
    ts.isInterfaceDeclaration(node) ||
    ts.isEnumDeclaration(node) ||
    ts.isModuleDeclaration(node) ||
    ts.isNamespaceExportDeclaration(node)
  );
}

function scanSymbols(ctx: ScanContext): IndexedSymbol[] {
  const symbols: IndexedSymbol[] = [];

  function visit(node: ts.Node): void {
    if (!shouldIndexNode(node)) {
      // Still recurse into containers
      if (isContainerNode(node)) {
        const name = getNodeName(node);
        if (name) {
          ctx.qualifiedNameStack.push(name);
          ctx.containerStack.push(name);
          ts.forEachChild(node, visit);
          ctx.qualifiedNameStack.pop();
          ctx.containerStack.pop();
        } else {
          ts.forEachChild(node, visit);
        }
      } else {
        ts.forEachChild(node, visit);
      }
      return;
    }

    const kind = getSymbolKind(node);
    const name = getNodeName(node);
    if (!kind || !name) {
      ts.forEachChild(node, visit);
      return;
    }

    const qualifiedName = buildQualifiedName(ctx.qualifiedNameStack, name);
    const container =
      ctx.containerStack.length > 0
        ? ctx.containerStack[ctx.containerStack.length - 1] ?? null
        : null;
    const range = nodeRange(ctx.sourceFile, node);
    const leadingCommentRange = extractLeadingCommentRange(node, ctx.sourceFile);
    const signature = extractSignature(node, ctx.sourceFile, name);
    const sid = symbolId(ctx.fileId, qualifiedName, range.startLine, ctx.symbolOrder);

    symbols.push({
      symbolId: sid,
      fileId: ctx.fileId,
      relativePath: ctx.relativePath,
      kind,
      name,
      qualifiedName,
      signature,
      container,
      isExported: isExported(node),
      isAsync: isAsync(node),
      isAbstract: isAbstractNode(node),
      isStatic: isStaticNode(node),
      isReadonly: isReadonlyNode(node),
      range,
      leadingCommentRange,
    });

    ctx.symbolOrder++;

    // Recurse into containers
    if (isContainerNode(node)) {
      ctx.qualifiedNameStack.push(name);
      ctx.containerStack.push(name);
      ts.forEachChild(node, visit);
      ctx.qualifiedNameStack.pop();
      ctx.containerStack.pop();
    } else {
      ts.forEachChild(node, visit);
    }
  }

  ts.forEachChild(ctx.sourceFile, visit);
  return symbols;
}

// ---------------------------------------------------------------------------
// Parse diagnostics
// ---------------------------------------------------------------------------

function extractParseDiagnostics(
  sourceFile: ts.SourceFile,
  program?: ts.Program,
): IndexDiagnostic[] {
  const diagnostics: IndexDiagnostic[] = [];

  // Use program diagnostics if available, otherwise syntactic diagnostics
  const rawDiags: readonly ts.Diagnostic[] = program
    ? program.getSyntacticDiagnostics(sourceFile)
    : ts.createProgram([sourceFile.fileName], {
        noResolve: true,
        noLib: true,
      }).getSyntacticDiagnostics(sourceFile);

  for (const diag of rawDiags) {
    const range = diag.start != null
      ? {
          startLine: lineOf(sourceFile, diag.start),
          endLine: lineOf(sourceFile, diag.start + (diag.length ?? 0)),
        }
      : undefined;
    diagnostics.push({
      severity: "error",
      code: "parse_error",
      message: typeof diag.messageText === "string"
        ? diag.messageText
        : diag.messageText.messageText,
      range,
    });
  }
  return diagnostics;
}

// ---------------------------------------------------------------------------
// Main scan entry point
// ---------------------------------------------------------------------------

export type ScanOptions = {
  fileId: string;
  relativePath: string;
  absolutePath: string;
  projectRoot: string;
  sourceText: string;
};

export function scanFile(options: ScanOptions): ScanResult {
  const { fileId, relativePath, absolutePath, projectRoot, sourceText } = options;

  const sourceFile = ts.createSourceFile(
    relativePath,
    sourceText,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.Unknown,
  );

  const diagnostics: IndexDiagnostic[] = extractParseDiagnostics(sourceFile);

  const ctx: ScanContext = {
    fileId,
    relativePath,
    absolutePath,
    projectRoot,
    sourceFile,
    qualifiedNameStack: [],
    containerStack: [],
    symbolOrder: 0,
  };

  const symbols = scanSymbols(ctx);
  const imports = extractImports(sourceFile, fileId, absolutePath, projectRoot);
  const exports = extractExports(sourceFile, fileId);

  return { symbols, imports, exports, diagnostics };
}
