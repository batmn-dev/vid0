const rawDecoder = "  const match = DIRECTIVE_PATTERN.exec(text)"
const markdownDecoder = String.raw`  // The rich composer serializes literal brackets with Markdown escapes.
  const match = DIRECTIVE_PATTERN.exec(text.replace(/\\(\[|\])/g, "$1"))`

/** Permit only the audited marker decoder change; fixture output and timing stay identical. */
export function validateDirectiveOverlay(base: string, head: string) {
  if (base === head) return false
  if (!base.includes(rawDecoder) || base.replace(rawDecoder, markdownDecoder) !== head) {
    throw new Error("Deterministic provider differs beyond Markdown directive decoding")
  }
  return true
}
