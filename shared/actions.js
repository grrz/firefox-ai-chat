export const ACTIONS = [
  {
    id: 'summarize',
    label: 'Summarize',
    icon: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="17" y1="10" x2="3" y2="10"/><line x1="21" y1="6" x2="3" y2="6"/><line x1="21" y1="14" x2="3" y2="14"/><line x1="17" y1="18" x2="3" y2="18"/></svg>`,
    prompt: 'Provide a concise summary (TL;DR) of this page, in a structured way, with readers or bullet points - starting from the most important message or idea. Keep every idea in 1-2 paragraphs maximum.',
    includeContext: true,
    contextScope: 'full',
  },
  {
    id: 'analyze',
    label: 'Analyze',
    icon: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>`,
    prompt: 'Analyze this page. Provide a structured summary covering: main topic, key arguments or information presented, intended audience, and any notable bias or perspective. Be concise.',
    includeContext: true,
    contextScope: 'full',
  },
  {
    id: 'key-points',
    label: 'Key Points',
    icon: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>`,
    prompt: 'Extract the key points from this page as a bullet-point list. Focus on the most important facts, arguments, or takeaways.',
    includeContext: true,
    contextScope: 'full',
  },
  {
    id: 'explain',
    label: 'Explain',
    icon: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`,
    prompt: 'Explain the content of this page in simple, easy-to-understand terms. Avoid jargon and assume the reader has no prior knowledge of the topic.',
    includeContext: true,
    contextScope: 'full',
  },
];
