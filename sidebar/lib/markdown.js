import { marked } from './marked.esm.js';

marked.setOptions({
  breaks: true,
  gfm: true,
});

export function renderMarkdown(text) {
  return marked.parse(text);
}

/**
 * Render partial markdown during streaming.
 * Auto-closes unclosed code fences so the output is valid.
 */
export function renderPartialMarkdown(partialText) {
  let text = partialText;

  // Count code fences
  const fenceMatches = text.match(/```/g);
  const fenceCount = fenceMatches ? fenceMatches.length : 0;

  // If odd number of fences, we have an unclosed code block — close it
  if (fenceCount % 2 !== 0) {
    text += '\n```';
  }

  return marked.parse(text);
}
