export class ProviderError extends Error {
  constructor(message, { retryable = false, status = null } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.retryable = retryable;
    this.status = status;
  }
}

export class BaseProvider {
  constructor(config) {
    this.config = config;
  }

  /**
   * Send a chat message and stream the response.
   * @param {Array} messages - Array of {role, content} message objects
   * @param {Object} options - { signal: AbortSignal, onToken: (token: string) => void }
   * @returns {Promise<string>} - The full response text
   */
  async sendMessage(messages, { signal, onToken } = {}) {
    throw new Error('sendMessage must be implemented by subclass');
  }

  /**
   * Validate provider configuration.
   * @returns {{valid: boolean, error?: string}}
   */
  validate() {
    if (this.config.requiresKey && !this.config.apiKey) {
      return { valid: false, error: `API key required for ${this.config.name}` };
    }
    return { valid: true };
  }

  buildHeaders() {
    return { 'Content-Type': 'application/json' };
  }

  getEndpoint() {
    return this.config.apiEndpoint;
  }

  getModel() {
    return this.config.model || this.config.defaultModel;
  }
}
