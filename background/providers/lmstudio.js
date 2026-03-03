import { OpenAIProvider } from './openai.js';

export class LMStudioProvider extends OpenAIProvider {
  validate() {
    // No API key needed for local LM Studio
    return { valid: true };
  }

  buildHeaders() {
    return {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer lm-studio',
    };
  }

  getEndpoint() {
    const base = (this.config.endpoint || 'http://localhost:1234').replace(/\/+$/, '');
    return `${base}/v1/chat/completions`;
  }
}
