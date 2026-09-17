// ── Built-in topic extractor (heuristic, no LLM required) ────────────────────

const STOP_WORDS = new Set([
  'the','a','an','is','are','was','were','be','been','being',
  'have','has','had','do','does','did','will','would','shall','should',
  'may','might','must','can','could','to','of','in','for','on','with',
  'at','by','from','as','it','its','this','that','these','those',
  'i','you','he','she','we','they','my','your','his','her','our','their',
  'and','or','but','not','no','if','so','just','very','also','more',
  'than','then','what','when','where','who','how','which','about',
])

/**
 * Extract up to `max` topic words from content using stopword filtering.
 * Deterministic. No network calls.
 */
export function extractTopicsLocal(content: string, max: number): string[] {
  const words = content
    .toLowerCase()
    .replace(/[^a-z0-9\s'-]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOP_WORDS.has(w))

  // Deduplicate while preserving order
  const seen = new Set<string>()
  const result: string[] = []
  for (const w of words) {
    if (!seen.has(w)) {
      seen.add(w)
      result.push(w)
      if (result.length >= max) break
    }
  }

  return result.length > 0 ? result : ['general']
}
