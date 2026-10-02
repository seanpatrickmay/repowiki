import { decodeMermaidEntities, mermaidLabel } from "./mermaid-label.ts";

/** Mermaid's defaults (maxTextSize, maxEdges): past either it renders an error, not the diagram. */
export const MAX_DIAGRAM_CHARS = 50_000;
export const MAX_DIAGRAM_EDGES = 500;

const NODE = /^ {2}(n\d+)(\["|\[\[")(.*?)("\]|"\]\])$/;
const EDGE = /^ {2}(n\d+) -->\|"(.*)"\| (n\d+)$/;

/**
 * Any control character (C0, DEL, C1, so NUL, tab, CR, escape), any format character (the bidi
 * marks, embeddings, overrides and isolates, zero-width characters, the byte-order mark), a line or
 * paragraph separator, or a lone surrogate. None can appear anywhere in a line: the only
 * whitespace a line may hold is the two-space indent and the single spaces around an arrow.
 */
const UNSAFE_CHARACTER = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;

/**
 * A label is safe only if it is non-empty and is exactly what mermaidLabel() writes for the text
 * its entities decode to. That is an allowlist: letters, marks, numbers, single spaces and
 * `.,-_/+!?@*` as they are, everything else (quotes, brackets, `$` for KaTeX, `ﬂ°¶ß`, which
 * Mermaid turns back into entities, `;`, `#`, `%`, `:`) as an entity. An entity for a control or
 * bidirectional character, or for a character that is not written as an entity, is not what
 * mermaidLabel writes, so it is refused too.
 */
function isMermaidLabel(label: string): boolean {
  if (label === "") return false;
  const decoded = decodeMermaidEntities(label);
  return decoded !== null && mermaidLabel(decoded) === label;
}

/**
 * Everything wrong with a diagram's Mermaid source, empty when it is safe to store. Mermaid's
 * "strict" security level still loads images from labels and `img:` shapes (M5 Task 17 review),
 * so this is the control: only the four line shapes the diagram builder writes are accepted
 * (`flowchart LR`, a box node, a subroutine node, a labelled arrow), each matched as a WHOLE line
 * by an anchored pattern, with labels in the alphabet mermaidLabel writes. Any other line
 * (`click`, `call`, `href`, `style`, `classDef`, `%%{init}`, `n1@{ img: … }`, raw `<img>`, two
 * statements on one line) is rejected, so is any line holding a control or bidirectional
 * character, and every arrow must join nodes declared above it. A source over Mermaid's size
 * limits is rejected too, so a stored diagram always renders.
 * Words such as "click" or "calls" inside a quoted label are only text: a label cannot contain
 * a quote, so it cannot end early and start a directive.
 */
export function diagramProblems(source: string): string[] {
  if (source.length > MAX_DIAGRAM_CHARS) {
    return [`the diagram is longer than ${MAX_DIAGRAM_CHARS} characters`];
  }
  const problems: string[] = [];
  const lines = source.split("\n");
  if (lines[0] !== "flowchart LR") problems.push('the diagram must start with "flowchart LR"');
  const declared = new Set<string>();
  let edges = 0;
  lines.slice(1).forEach((line, i) => {
    const where = `diagram line ${i + 2}`;
    if (UNSAFE_CHARACTER.test(line)) {
      problems.push(`${where} holds a control or bidirectional character`);
      return;
    }
    const node = NODE.exec(line);
    if (node !== null) {
      const [, id = "", open = "", label = "", close = ""] = node;
      if ((open === '[["') !== (close === '"]]')) problems.push(`${where}: mismatched brackets`);
      if (!isMermaidLabel(label)) problems.push(`${where}: the label holds characters it may not`);
      if (declared.has(id)) problems.push(`${where}: node ${id} is declared twice`);
      declared.add(id);
      return;
    }
    const edge = EDGE.exec(line);
    if (edge !== null) {
      const [, from = "", label = "", to = ""] = edge;
      edges += 1;
      if (!isMermaidLabel(label)) problems.push(`${where}: the label holds characters it may not`);
      if (!declared.has(from) || !declared.has(to)) {
        problems.push(`${where}: an arrow must join two nodes declared above it`);
      }
      return;
    }
    problems.push(`${where} is not a node or a labelled arrow`);
  });
  if (edges > MAX_DIAGRAM_EDGES) {
    problems.push(`the diagram has more than ${MAX_DIAGRAM_EDGES} arrows`);
  }
  return problems;
}
