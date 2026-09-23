export function createPdfRenderSequence() {
  let current = 0;

  return {
    next() {
      current += 1;
      return current;
    },
    isCurrent(sequence) {
      return sequence === current;
    }
  };
}
