export function textResult(text: string): {
  content: Array<{ type: 'text'; text: string }>;
  details: Record<string, never>;
} {
  return { content: [{ type: 'text', text }], details: {} };
}
