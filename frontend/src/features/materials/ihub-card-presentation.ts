/** Reproduce iHub's first, case-insensitive highlighted substring. */
export function splitIHubHighlight(source: string, target: string) {
  const index = source.toLocaleLowerCase().indexOf(target.toLocaleLowerCase());
  if (!target || index < 0) return [{ text: source, marked: false }];
  return [
    { text: source.slice(0, index), marked: false },
    { text: source.slice(index, index + target.length), marked: true },
    { text: source.slice(index + target.length), marked: false },
  ].filter((part) => part.text);
}
