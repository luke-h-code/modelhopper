/**
 * Pull something readable out of whatever was thrown.
 *
 * Not everything that reaches a catch is an Error: a runtime can wrap one, a
 * rejected Tauri call arrives as a plain value, and an object falling through
 * to String() renders as "[object Object]" — which tells the reader nothing
 * and costs whoever is debugging it a round trip through the console.
 *
 * Returns "" when there is nothing worth showing, so each caller supplies the
 * sentence that fits where it is read: the thread says the reply failed, the
 * tool loop points at the console it has just logged to.
 */
export function readThrown(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value.trim();
  if (value instanceof Error) return value.message;

  if (typeof value === "object") {
    const bag = value as Record<string, unknown>;
    for (const key of ["message", "error", "detail", "reason"]) {
      const inner = bag[key];
      if (typeof inner === "string" && inner.trim()) return inner;
      // One level down: { error: { message } } is a common wrapping.
      if (inner && typeof inner === "object") {
        const nested = (inner as Record<string, unknown>).message;
        if (typeof nested === "string" && nested.trim()) return nested;
      }
    }
    try {
      const json = JSON.stringify(value);
      if (json && json !== "{}") {
        return json.length > 300 ? `${json.slice(0, 300)}…` : json;
      }
    } catch {
      // Circular or otherwise unserialisable; nothing readable here.
    }
    // An object with nothing readable in it. String() would produce the
    // "[object Object]" this function exists to prevent, so say nothing and
    // let the caller's own sentence stand.
    return "";
  }

  return String(value);
}
