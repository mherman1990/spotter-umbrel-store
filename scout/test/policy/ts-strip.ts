/**
 * Comment stripping for the policy tests, built on the TypeScript parser instead of a regex: a regex that
 * removes `//...` also removes the REST OF A LINE after a `//` inside a string (`'http://x'; fetch(url)`),
 * hiding real code from the scan. Here the parser decides what is a comment, so strings, template literals and
 * regex literals are never mistaken for one. Comments are replaced by spaces (newlines kept) so line numbers and
 * offsets stay stable.
 */
import ts from 'typescript';

export function stripComments(source: string, fileName = 'x.ts'): string {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.ES2023, true, ts.ScriptKind.TS);
  const ranges = new Map<number, number>();
  const collect = (list: ts.CommentRange[] | undefined): void => {
    for (const r of list ?? []) ranges.set(r.pos, r.end);
  };
  const visit = (node: ts.Node): void => {
    collect(ts.getLeadingCommentRanges(source, node.pos));
    collect(ts.getTrailingCommentRanges(source, node.end));
    for (const child of node.getChildren(sf)) visit(child);
  };
  visit(sf);
  let out = '';
  let cursor = 0;
  for (const [pos, end] of [...ranges.entries()].sort((a, b) => a[0] - b[0])) {
    if (pos < cursor) continue;
    out += source.slice(cursor, pos) + source.slice(pos, end).replace(/[^\n]/g, ' ');
    cursor = end;
  }
  return out + source.slice(cursor);
}
