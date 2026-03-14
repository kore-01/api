export const PROVIDER_PRESETS = [
  {
    name: 'OpenAI GPT-4o',
    base_url: 'https://api.openai.com/v1',
    api_type: 'openai-completions',
    model_id: 'gpt-4o',
  },
  {
    name: 'Anthropic Claude Sonnet 4',
    base_url: 'https://api.anthropic.com/v1',
    api_type: 'openai-completions',
    model_id: 'claude-sonnet-4-20250514',
  },
  {
    name: 'DeepSeek V3',
    base_url: 'https://api.deepseek.com/v1',
    api_type: 'openai-completions',
    model_id: 'deepseek-chat',
  },
  {
    name: 'Google Gemini 2.5 Pro',
    base_url: 'https://generativelanguage.googleapis.com/v1beta/openai',
    api_type: 'openai-completions',
    model_id: 'gemini-2.5-pro',
  },
  {
    name: 'Groq Llama 3 70B',
    base_url: 'https://api.groq.com/openai/v1',
    api_type: 'openai-completions',
    model_id: 'llama3-70b-8192',
  },
  {
    name: 'MiniMax M2.5 (OpenAI兼容)',
    base_url: 'https://api.minimaxi.com/v1',
    api_type: 'openai-completions',
    model_id: 'MiniMax-M2.5',
  },
  {
    name: 'MiniMax M2.5-highspeed (OpenAI兼容)',
    base_url: 'https://api.minimaxi.com/v1',
    api_type: 'openai-completions',
    model_id: 'MiniMax-M2.5-highspeed',
  },
  {
    name: 'MiniMax M2.5 (Anthropic兼容)',
    base_url: 'https://api.minimaxi.com/anthropic',
    api_type: 'anthropic-messages',
    model_id: 'MiniMax-M2.5',
  },
  {
    name: 'MiniMax M2.5-highspeed (Anthropic兼容)',
    base_url: 'https://api.minimaxi.com/anthropic',
    api_type: 'anthropic-messages',
    model_id: 'MiniMax-M2.5-highspeed',
  },
  {
    name: 'Kimi-for-coding',
    base_url: 'https://api.kimi.com/coding/v1',
    api_type: 'openai-completions',
    model_id: 'kimi-2.5',
    custom_headers: JSON.stringify({
      'user-agent': 'RooCode/3.31.0',
      'x-title': 'Roo Code',
      'accept': 'application/json',
      'accept-language': '*',
      'sec-fetch-mode': 'cors',
      'x-stainless-arch': 'x64',
      'x-stainless-lang': 'js',
      'x-stainless-os': 'Windows',
      'x-stainless-package-version': '5.12.2',
      'x-stainless-retry-count': '0',
      'x-stainless-runtime': 'node',
      'x-stainless-runtime-version': 'v22.19.0',
    }),
  },
];

export const HEALTH_THRESHOLDS = {
  GREEN: 95,   // ≥ 95%
  YELLOW: 80,  // 80% - 95%
  // < 80% = RED
};
