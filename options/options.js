import { loadSettings, saveSettings } from '../shared/settings.js';

const $ = (sel) => document.querySelector(sel);

function showProviderConfig(providerId) {
  document.querySelectorAll('.provider-config').forEach(el => {
    el.classList.toggle('active', el.dataset.provider === providerId);
  });
}

async function loadForm() {
  const settings = await loadSettings();

  $('#activeProvider').value = settings.activeProvider;
  showProviderConfig(settings.activeProvider);

  // Claude
  $('#claude-apiKey').value = settings.providers.claude.apiKey || '';
  $('#claude-model').value = settings.providers.claude.model || '';

  // OpenAI
  $('#openai-apiKey').value = settings.providers.openai.apiKey || '';
  $('#openai-model').value = settings.providers.openai.model || '';

  // Grok
  $('#grok-apiKey').value = settings.providers.grok.apiKey || '';
  $('#grok-model').value = settings.providers.grok.model || '';

  // LM Studio
  $('#lmstudio-endpoint').value = settings.providers.lmstudio.endpoint || '';
  $('#lmstudio-model').value = settings.providers.lmstudio.model || '';

  // Theme
  $('#theme').value = settings.ui.theme || 'auto';
}

async function saveForm() {
  const settings = {
    activeProvider: $('#activeProvider').value,
    providers: {
      claude: {
        apiKey: $('#claude-apiKey').value.trim(),
        model: $('#claude-model').value.trim(),
      },
      openai: {
        apiKey: $('#openai-apiKey').value.trim(),
        model: $('#openai-model').value.trim(),
      },
      grok: {
        apiKey: $('#grok-apiKey').value.trim(),
        model: $('#grok-model').value.trim(),
      },
      lmstudio: {
        endpoint: $('#lmstudio-endpoint').value.trim(),
        model: $('#lmstudio-model').value.trim(),
      },
    },
    ui: {
      theme: $('#theme').value,
    },
  };

  await saveSettings(settings);
  const status = $('#status');
  status.textContent = 'Settings saved!';
  setTimeout(() => { status.textContent = ''; }, 2000);
}

$('#activeProvider').addEventListener('change', (e) => {
  showProviderConfig(e.target.value);
});

$('#save').addEventListener('click', saveForm);

loadForm();
