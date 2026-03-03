export const PROVIDERS = {
  claude: {
    id: 'claude',
    name: 'Claude (Anthropic)',
    defaultModel: 'claude-sonnet-4-20250514',
    apiEndpoint: 'https://api.anthropic.com/v1/messages',
    requiresKey: true,
  },
  openai: {
    id: 'openai',
    name: 'OpenAI',
    defaultModel: 'gpt-4o',
    apiEndpoint: 'https://api.openai.com/v1/chat/completions',
    requiresKey: true,
  },
  grok: {
    id: 'grok',
    name: 'Grok (xAI)',
    defaultModel: 'grok-3',
    apiEndpoint: 'https://api.x.ai/v1/chat/completions',
    requiresKey: true,
  },
  lmstudio: {
    id: 'lmstudio',
    name: 'LM Studio (Local)',
    defaultModel: '',
    apiEndpoint: 'http://localhost:1234',
    requiresKey: false,
  },
};

export const DEFAULT_SETTINGS = {
  activeProvider: 'claude',
  providers: {
    claude: { apiKey: '', model: PROVIDERS.claude.defaultModel },
    openai: { apiKey: '', model: PROVIDERS.openai.defaultModel },
    grok: { apiKey: '', model: PROVIDERS.grok.defaultModel },
    lmstudio: { endpoint: PROVIDERS.lmstudio.apiEndpoint, model: '' },
  },
  ui: {
    theme: 'auto',
  },
};

export const SYSTEM_PROMPT = `You are a helpful AI assistant integrated into a web browser sidebar. The user may provide you with the content of the web page they are currently viewing. Use this context to provide relevant, accurate, and concise answers. If page content is provided, reference it directly in your responses when relevant. Format your responses using Markdown when appropriate.`;
