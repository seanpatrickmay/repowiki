/**
 * A label as mermaidLabel() writes it: no quote, bracket, brace, pipe, colon, percent, angle
 * bracket, backtick or backslash, and `#` / `;` only inside an entity such as `#58;` or `#quot;`.
 * So a label can hold no URL scheme (`javascript:`, `img:`), no `@{` shape data, no `%%` comment
 * or `%%{init}` directive, and no markup.
 */
const LABEL = /^(?:[^"#;<>{}[\]|:%`\\\n\r]|#(?:\d+|quot|amp|lt|gt);)*$/;
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
 * Everything wrong with a diagram's Mermaid source, empty when it is safe to store. Mermaid's
 * "strict" security level still loads images from labels and `img:` shapes (M5 Task 17 review),
 * so this is the control: only the four line shapes the diagram builder writes are accepted
 * (`flowchart LR`, a box node, a subroutine node, a labelled arrow), each matched as a WHOLE line
 * by an anchored pattern, with labels in the entity-encoded alphabet above. Any other line
 * (`click`, `call`, `href`, `style`, `classDef`, `%%{init}`, `n1@{ img: … }`, raw `<img>`, two
 * statements on one line) is rejected, so is any line holding a control or bidirectional
 * character, and every arrow must join nodes declared above it.
 * Words such as "click" or "calls" inside a quoted label are only text: a label cannot contain
 * a quote, so it cannot end early and start a directive.
 */
export function diagramProblems(source: string): string[] {
  const problems: string[] = [];
  const lines = source.split("\n");
  if (lines[0] !== "flowchart LR") problems.push('the diagram must start with "flowchart LR"');
  const declared = new Set<string>();
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
      if (!LABEL.test(label)) problems.push(`${where}: the label holds characters it may not`);
      if (declared.has(id)) problems.push(`${where}: node ${id} is declared twice`);
      declared.add(id);
      return;
    }
    const edge = EDGE.exec(line);
    if (edge !== null) {
      const [, from = "", label = "", to = ""] = edge;
      if (!LABEL.test(label)) problems.push(`${where}: the label holds characters it may not`);
      if (!declared.has(from) || !declared.has(to)) {
        problems.push(`${where}: an arrow must join two nodes declared above it`);
      }
      return;
    }
    problems.push(`${where} is not a node or a labelled arrow`);
  });
  return problems;
}
