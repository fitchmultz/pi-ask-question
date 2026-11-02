/** Text rendering helpers that preserve exact answer text. */

import { sliceByColumn, Text, visibleWidth, type Component } from "@earendil-works/pi-tui";

/** Word wrapping drops spaces at line breaks; JSON answer text must keep them. */
export function wrapByColumn(text: string, width: number): string[] {
  const lines: string[] = [];
  let rest = text;
  while (visibleWidth(rest) > width) {
    const wide = sliceByColumn(rest, 0, width, true);
    const part = wide !== "" ? wide : sliceByColumn(rest, 0, width);
    lines.push(part);
    rest = rest.slice(part.length);
  }
  return [...lines, rest];
}

/** Render text without re-wrapping, so exact JSON answer text survives. */
export function exactText(text: string): Component {
  return {
    render(width: number): string[] {
      const wrapped = text
        .split("\n")
        .flatMap((line) => wrapByColumn(line, width))
        .join("\n");
      return new Text(wrapped, 0, 0).render(width);
    },
    invalidate() {
      // Nothing is cached; every render recomputes from the exact text.
    },
  };
}
