/**
 * Thin wrapper over @toon-format/toon, shared by manifest decoding, the
 * generate report, and `templates list` output — the two LLM-facing
 * boundaries (intent manifest in, report out) plus any other CLI output
 * that benefits from the same compact wire format.
 */

import { encode, decode } from '@toon-format/toon';

export function encodeToon(data: unknown): string {
  return encode(data);
}

export function decodeToon(text: string): unknown {
  return decode(text);
}
