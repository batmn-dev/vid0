const originalResponse = `    return createUIMessageStreamResponse({
      stream: observedResponseStream,`
const utf8Response = `    return createUIMessageStreamResponse({
      headers: { "content-type": "text/event-stream; charset=utf-8" },
      stream: observedResponseStream,`

/** Clarify SSE decoding without copying other runtime changes into the baseline. */
export function applySseCharsetOverlay(source: string) {
  if (source.split("return createUIMessageStreamResponse({").length !== 2) {
    throw new Error("Unrecognized SSE response; review the UTF-8 header overlay")
  }
  if (source.split(utf8Response).length === 2) return { source, applied: false }
  if (source.split(originalResponse).length !== 2) {
    throw new Error("Unrecognized SSE response; review the UTF-8 header overlay")
  }
  return { source: source.replace(originalResponse, utf8Response), applied: true }
}
