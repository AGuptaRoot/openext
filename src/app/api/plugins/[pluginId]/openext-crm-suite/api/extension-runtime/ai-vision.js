'use strict';

/**
 * sdk.ai.readImage — read an image with the CRM's vision model and return JSON.
 *
 * Same engine as the visiting-card scan on leads (services/lead-ocr.service.js):
 * the Groq API key from Settings → Integrations (encrypted) and the same model
 * choice and fallbacks. The extension only sends the image and what to read;
 * it never sees the key. The image is sent to the model and not kept, and
 * neither the image nor the answer is written to logs.
 */

const { runtimeError } = require('./values');

const GROQ_CHAT_URL = 'https://api.groq.com/openai/v1/chat/completions';
const IMAGE_RE = /^data:image\/(jpeg|jpg|png|webp);base64,[A-Za-z0-9+/=\s]+$/i;
const MAX_IMAGE_CHARS = 6_000_000;
const MAX_INSTRUCTION_CHARS = 6000;
const REQUEST_TIMEOUT_MS = 25000;

function stripCodeFences(text) {
  const raw = String(text || '').trim();
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return fenced ? String(fenced[1] || '').trim() : raw;
}

function parseJsonObject(text) {
  const cleaned = stripCodeFences(text);
  const tryParse = (t) => {
    try {
      const value = JSON.parse(t);
      return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
    } catch {
      return null;
    }
  };
  const direct = tryParse(cleaned);
  if (direct) return direct;
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  return start >= 0 && end > start ? tryParse(cleaned.slice(start, end + 1)) : null;
}

function isModelAccessError(message) {
  const msg = String(message || '').toLowerCase();
  return ['does not exist', 'do not have access', 'model_not_found', 'invalid_model', 'decommissioned', 'not available', 'forbidden'].some((s) =>
    msg.includes(s)
  );
}

async function callModel(apiKey, model, image, instructions, prompt) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(GROQ_CHAT_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: 1500,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: `${instructions}\nReturn ONLY one valid JSON object, no markdown, no commentary.` },
          {
            role: 'user',
            content: [
              { type: 'text', text: prompt || 'Read this image as instructed.' },
              { type: 'image_url', image_url: { url: image } }
            ]
          }
        ]
      })
    });
    const payload = await response.json().catch(() => ({}));
    return { response, payload };
  } finally {
    clearTimeout(timer);
  }
}

/** The sdk.ai object for one request. */
function createAiApi(req) {
  return Object.freeze({
    /**
     * @param {{ image: string, instructions: string, prompt?: string }} input
     *   image         data URL (JPG, PNG or WEBP)
     *   instructions  what to read and the JSON shape to return
     * @returns {{ data: object, model: string }}
     */
    async readImage(input = {}) {
      const image = String(input.image || '').trim();
      const instructions = String(input.instructions || '').trim();
      if (!IMAGE_RE.test(image)) throw runtimeError(400, 'ai.readImage: image must be a JPG, PNG or WEBP data URL', 'INVALID_IMAGE');
      if (image.length > MAX_IMAGE_CHARS) throw runtimeError(413, 'ai.readImage: the image is too large; use a smaller photo', 'IMAGE_TOO_LARGE');
      if (!instructions) throw runtimeError(400, 'ai.readImage: instructions are required', 'INVALID_INSTRUCTIONS');
      if (instructions.length > MAX_INSTRUCTION_CHARS) throw runtimeError(400, 'ai.readImage: instructions are too long', 'INVALID_INSTRUCTIONS');

      const SettingService = require('../services/setting.service');
      const { listAccessibleModelIds, buildModelTryList } = require('../services/lead-ocr.service');
      let apiKey = '';
      try {
        ({ apiKey } = await SettingService.resolveGroqApiKey(req));
      } catch (error) {
        // e.g. the saved key was encrypted with another secret: say so instead of a generic failure.
        throw runtimeError(
          503,
          String((error && error.message) || 'The OCR key in Settings → Integrations cannot be used').slice(0, 300),
          'OCR_KEY_UNREADABLE'
        );
      }
      if (!apiKey) {
        throw runtimeError(503, 'OCR is not set up: add the Groq API key in Settings → Integrations', 'OCR_NOT_CONFIGURED');
      }
      const preferred = await SettingService.resolveGroqOcrModel(req);
      const tryList = buildModelTryList(preferred, await listAccessibleModelIds(apiKey), { visionOnly: true });

      let lastError = '';
      for (const model of tryList) {
        let result;
        try {
          result = await callModel(apiKey, model, image, instructions, String(input.prompt || '').slice(0, 500));
        } catch (error) {
          lastError = error && error.name === 'AbortError' ? 'the OCR service did not answer in time' : 'the OCR service could not be reached';
          continue;
        }
        const { response, payload } = result;
        if (!response.ok) {
          lastError = (payload && payload.error && payload.error.message) || `OCR service error (HTTP ${response.status})`;
          if (isModelAccessError(lastError)) continue;
          throw runtimeError(502, `OCR failed: ${String(lastError).slice(0, 200)}`, 'OCR_FAILED');
        }
        const data = parseJsonObject(payload && payload.choices && payload.choices[0] && payload.choices[0].message && payload.choices[0].message.content);
        if (data) return { data, model };
        lastError = 'the OCR model returned an unreadable answer';
      }
      throw runtimeError(502, `OCR failed: ${String(lastError || 'no vision model is available').slice(0, 200)}`, 'OCR_FAILED');
    }
  });
}

module.exports = { createAiApi, parseJsonObject };
