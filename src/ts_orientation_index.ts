import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

export const ORIENTATION_SCHEMA = "ts.project_orientation.v1";

const DOC_NAMES = new Set([
  "readme.md",
  "agents.md",
  "topology.md",
  "system_topology.md",
  "system-topology.md",
]);
const EXCLUDED_DIRS = new Set([
  ".git",
  ".mcp-ts-project-indexer",
  ".mcp-project-indexer-control",
  ".vs",
  ".vscode",
  "node_modules",
  "dist",
  "build",
  "out",
]);

export type OrientationNode = {
  orientationId: string;
  kind: "folder_orientation" | "topology";
  file: string;
  folder: string;
  title: string;
  purpose: string;
  useWhen: string[];
  doNotUseFirstWhen: string[];
  map: Array<{ path: string; description: string }>;
  startHere: string[];
  boundaries: string;
  headings: string[];
  lineCount: number;
  contentHash: string;
  parentFolder: string | null;
  parentOrientationId: string | null;
  childFolders: string[];
};

export type OrientationIndex = {
  schema: string;
  root: string;
  counts: { nodes: number };
  nodes: OrientationNode[];
};

export function orientationIndexPath(indexRoot: string): string {
  return path.join(indexRoot, "orientation.json");
}

function sha1(text: string): string {
  return crypto.createHash("sha1").update(text, "utf-8").digest("hex");
}

function rel(file: string, root: string): string {
  return path.relative(root, file).replace(/\\/g, "/") || ".";
}

function compact(text: string, max: number): string {
  const value = text.replace(/\s+/g, " ").trim();
  return value.length <= max ? value : `${value.slice(0, max - 1).trim()}…`;
}

const LABEL_SECTION_NAMES = [
  "Purpose",
  "Use this folder when the question is about",
  "Do not use this folder first when the question is about",
];

function labelSection(line: string): { heading: string; inlineBody: string } | null {
  const trimmed = line.trim();
  const match = /^([A-Za-z0-9][A-Za-z0-9 /_-]{2,80}):\s*(.*)$/.exec(trimmed);
  if (!match) return null;

  const rawHeading = match[1]!.trim();
  if (!LABEL_SECTION_NAMES.includes(rawHeading)) return null;

  return { heading: rawHeading, inlineBody: match[2]!.trim() };
}

function splitSections(text: string): { title: string | null; sections: Map<string, string> } {
  let title: string | null = null;
  let current = "__intro__";
  let inFence = false;
  const sections = new Map<string, string[]>();
  sections.set(current, []);

  for (const line of text.split(/\r?\n/)) {
    const fenceMatch = /^\s*```/.test(line);
    if (fenceMatch) {
      inFence = !inFence;
      sections.get(current)!.push(line.trimEnd());
      continue;
    }

    const match = inFence ? null : /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (match) {
      const heading = match[2]!.trim();
      if (!title && match[1]!.length === 1) title = heading;
      current = heading;
      if (!sections.has(current)) sections.set(current, []);
      continue;
    }
    const label = inFence ? null : labelSection(line);
    if (label) {
      current = label.heading;
      if (!sections.has(current)) sections.set(current, []);
      if (label.inlineBody) sections.get(current)!.push(label.inlineBody);
      continue;
    }
    sections.get(current)!.push(line.trimEnd());
  }

  const result = new Map<string, string>();
  for (const [heading, lines] of sections.entries()) {
    const body = lines.join("\n").trim();
    if (body) result.set(heading, body);
  }
  return { title, sections: result };
}

function section(sections: Map<string, string>, names: string[]): string {
  const wanted = new Set(names);
  for (const [heading, body] of sections.entries()) {
    if (wanted.has(heading)) return body;
  }
  return "";
}

function bullets(text: string): string[] {
  const result: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^[-*]\s+(.+)$/.exec(line.trim());
    if (match) result.push(match[1]!.trim());
    if (result.length >= 30) break;
  }
  return result;
}

function mapEntries(text: string): Array<{ path: string; description: string }> {
  const result: Array<{ path: string; description: string }> = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^([A-Za-z0-9_./\\:-]+)\s{2,}(.+)$/.exec(line.trim());
    if (match) result.push({ path: match[1]!.trim(), description: match[2]!.trim() });
    if (result.length >= 80) break;
  }
  return result;
}

function discover(root: string): string[] {
  const result: string[] = [];

  function walk(dir: string): void {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRS.has(entry.name)) walk(full);
      } else if (
        entry.isFile() &&
        (DOC_NAMES.has(entry.name.toLowerCase()) || path.parse(entry.name).name.toLowerCase().includes("topology"))
      ) {
        result.push(full);
      }
    }
  }

  walk(root);
  result.sort((a, b) => rel(a, root).localeCompare(rel(b, root)));
  return result;
}

function buildNode(root: string, file: string): OrientationNode {
  const relativeFile = rel(file, root);
  const folder = rel(path.dirname(file), root);
  const text = fs.readFileSync(file, "utf-8");
  const { title, sections } = splitSections(text);
  const purpose = section(sections, ["Purpose"]);
  const useWhen = section(sections, ["Use this folder when the question is about"]);
  const doNotUse = section(sections, ["Do not use this folder first when the question is about"]);
  const map = section(sections, ["Map"]);
  const startHere = section(sections, ["Start Here"]);
  const boundaries = section(sections, ["Boundaries"]);

  return {
    orientationId: `doc_${sha1(relativeFile).slice(0, 24)}`,
    kind: (path.parse(file).name.toLowerCase().includes("topology") || (title || "").toLowerCase().includes("topology"))
      ? "topology"
      : "folder_orientation",
    file: relativeFile,
    folder,
    title: title || path.basename(file),
    purpose: compact(purpose, 1200),
    useWhen: bullets(useWhen),
    doNotUseFirstWhen: bullets(doNotUse),
    map: mapEntries(map),
    startHere: bullets(startHere),
    boundaries: compact(boundaries, 1200),
    headings: [...sections.keys()].filter((heading) => heading !== "__intro__"),
    lineCount: text.split(/\r?\n/).length,
    contentHash: sha1(text),
    parentFolder: null,
    parentOrientationId: null,
    childFolders: [],
  };
}

function hasStructuredOrientation(node: OrientationNode): boolean {
  if (node.kind === "topology") return true;
  return Boolean(
    node.purpose ||
    node.useWhen.length ||
    node.doNotUseFirstWhen.length ||
    node.map.length ||
    node.startHere.length ||
    node.boundaries,
  );
}

export function buildOrientationIndex(projectRoot: string): OrientationIndex {
  const root = path.resolve(projectRoot);
  const nodes = discover(root).map((file) => buildNode(root, file)).filter(hasStructuredOrientation);
  const idByFolder = new Map(nodes.map((node) => [node.folder, node.orientationId]));
  for (const node of nodes) {
    const parent = node.folder === "." ? null : (path.posix.dirname(node.folder) || ".");
    node.parentFolder = parent;
    node.parentOrientationId = parent ? idByFolder.get(parent) ?? null : null;
    node.childFolders = nodes
      .map((candidate) => candidate.folder)
      .filter((folder) => folder !== node.folder && path.posix.dirname(folder) === node.folder)
      .sort();
  }
  return { schema: ORIENTATION_SCHEMA, root: root.replace(/\\/g, "/"), counts: { nodes: nodes.length }, nodes };
}

export function writeOrientationIndex(indexRoot: string, orientation: OrientationIndex): void {
  fs.writeFileSync(orientationIndexPath(indexRoot), JSON.stringify(orientation, null, 2), "utf-8");
}

export function loadOrientationIndex(indexRoot: string): OrientationIndex {
  const file = orientationIndexPath(indexRoot);
  if (!fs.existsSync(file)) return { schema: ORIENTATION_SCHEMA, root: "", counts: { nodes: 0 }, nodes: [] };
  return JSON.parse(fs.readFileSync(file, "utf-8")) as OrientationIndex;
}
