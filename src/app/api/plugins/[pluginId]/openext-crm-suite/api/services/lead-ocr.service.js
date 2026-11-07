'use strict';

/**
 * Extract structured lead/contact fields from a visiting-card IMAGE via Groq vision.
 * The image is sent directly to the model (no client-side Tesseract OCR).
 *
 * API key resolution order:
 *   1) Tenant Settings → Integrations (AES-256-GCM encrypted)
 *   2) GROQ_API_KEY / CRM_GROQ_API_KEY environment variables
 *
 * Vision model preference: Llama 4 Scout/Maverick, then Qwen multimodal.
 *
 * Optional guesses (salutation, gender, leadType, requestType) are only returned
 * when confidence is high — never force uncertain values onto the form.
 */

const GROQ_CHAT_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODELS_URL = 'https://api.groq.com/openai/v1/models';
const SettingService = require('./setting.service');

/** Vision-capable models for reading the card image directly. */
const GROQ_VISION_MODEL_CANDIDATES = [
  'meta-llama/llama-4-scout-17b-16e-instruct',
  'meta-llama/llama-4-maverick-17b-128e-instruct',
  'qwen/qwen3.8-27b'
];

/** Legacy text-only fallback list (unused for image scan; kept for compatibility). */
const GROQ_OCR_MODEL_CANDIDATES = [
  ...GROQ_VISION_MODEL_CANDIDATES,
  'llama-3.3-70b-versatile',
  'llama-3.1-8b-instant',
  'qwen/qwen3.6-27b',
  'openai/gpt-oss-20b',
  'openai/gpt-oss-120b'
];

const PROMPT_GUARD_MODELS = new Set([
  'meta-llama/llama-prompt-guard-2-86m',
  'meta-llama/llama-prompt-guard-2-22m',
  'llama-prompt-guard-2-86m',
  'llama-prompt-guard-2-22m'
]);

const DEFAULT_CHAT_MODEL = 'auto';

const SALUTATIONS = ['Mr', 'Mrs', 'Ms', 'Miss', 'Dr', 'Prof'];
const GENDERS = ['Male', 'Female', 'Other', 'Prefer not to say'];
const DEFAULT_LEAD_TYPES = ['Organizational', 'Individual'];

/** Only apply optional guesses at or above this confidence. */
const MIN_GUESS_CONFIDENCE = 0.78;

function stripCodeFences(text) {
  const raw = String(text || '').trim();
  if (!raw) return '';
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) return String(fenced[1] || '').trim();
  return raw;
}

function safeParseJson(text) {
  const cleaned = stripCodeFences(text);
  if (!cleaned) return null;
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(cleaned.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

function asCleanString(value) {
  if (value == null) return '';
  return String(value).replace(/\s+/g, ' ').trim();
}

function asConfidence(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  if (n > 1 && n <= 100) return Math.min(1, n / 100);
  return Math.max(0, Math.min(1, n));
}

function pickAllowed(value, allowed, { caseInsensitive = true } = {}) {
  const raw = asCleanString(value);
  if (!raw) return '';
  const list = Array.isArray(allowed) ? allowed : [];
  const hit = list.find((item) => {
    const a = String(item || '').trim();
    if (!a) return false;
    return caseInsensitive ? a.toLowerCase() === raw.toLowerCase() : a === raw;
  });
  return hit ? String(hit).trim() : '';
}

function matchRequestType(guessName, requestTypes) {
  const raw = asCleanString(guessName);
  if (!raw || !Array.isArray(requestTypes) || !requestTypes.length) {
    return { requestType: '', requestTypeId: '' };
  }
  const lower = raw.toLowerCase();
  const exact = requestTypes.find(
    (rt) =>
      String(rt.name || '').trim().toLowerCase() === lower ||
      String(rt.key || '').trim().toLowerCase() === lower
  );
  if (exact) {
    return {
      requestType: String(exact.name || '').trim(),
      requestTypeId: String(exact._id || exact.id || '').trim()
    };
  }
  // Soft contains match only when unique
  const partial = requestTypes.filter((rt) => {
    const name = String(rt.name || '').trim().toLowerCase();
    return name && (name.includes(lower) || lower.includes(name));
  });
  if (partial.length === 1) {
    return {
      requestType: String(partial[0].name || '').trim(),
      requestTypeId: String(partial[0]._id || partial[0].id || '').trim()
    };
  }
  return { requestType: '', requestTypeId: '' };
}

/**
 * High-confidence cues printed on the card (Mr/Mrs/Ms…) — safer than pure name guess.
 */
function inferSalutationGenderFromText(ocrText, contactName) {
  const hay = `${ocrText || ''}\n${contactName || ''}`;
  const patterns = [
    { re: /\b(Mrs|Mrs\.)\b/i, salutation: 'Mrs', gender: 'Female', confidence: 0.95 },
    { re: /\b(Miss|Miss\.)\b/i, salutation: 'Miss', gender: 'Female', confidence: 0.92 },
    { re: /\b(Ms|Ms\.)\b/i, salutation: 'Ms', gender: 'Female', confidence: 0.88 },
    { re: /\b(Mr|Mr\.)\b/i, salutation: 'Mr', gender: 'Male', confidence: 0.95 },
    { re: /\b(Dr|Dr\.)\b/i, salutation: 'Dr', gender: '', confidence: 0.9 },
    { re: /\b(Prof|Prof\.)\b/i, salutation: 'Prof', gender: '', confidence: 0.9 }
  ];
  for (const p of patterns) {
    if (p.re.test(hay)) {
      return {
        salutation: p.salutation,
        gender: p.gender,
        salutationConfidence: p.confidence,
        genderConfidence: p.gender ? p.confidence : 0
      };
    }
  }
  return {
    salutation: '',
    gender: '',
    salutationConfidence: 0,
    genderConfidence: 0
  };
}

function normalizeExtracted(raw, catalogs = {}) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const contact =
    source.contact && typeof source.contact === 'object' && !Array.isArray(source.contact)
      ? source.contact
      : source;
  const guesses =
    source.guesses && typeof source.guesses === 'object' && !Array.isArray(source.guesses)
      ? source.guesses
      : source;

  const leadTypes = Array.isArray(catalogs.leadTypes) && catalogs.leadTypes.length
    ? catalogs.leadTypes
    : DEFAULT_LEAD_TYPES;
  const requestTypes = Array.isArray(catalogs.requestTypes) ? catalogs.requestTypes : [];

  const base = {
    companyName: asCleanString(source.companyName || source.company || source.company_name),
    address: asCleanString(source.address || source.street || source.addressLine),
    city: asCleanString(source.city),
    state: asCleanString(source.state || source.province || source.region),
    contactName: asCleanString(
      contact.contactName || contact.name || source.contactName || source.name || source.fullName
    ),
    email: asCleanString(contact.email || source.email).toLowerCase(),
    phone: asCleanString(contact.phone || contact.mobile || source.phone || source.mobile).replace(
      /[^\d+]/g,
      ''
    ),
    jobRole: asCleanString(
      contact.jobRole ||
        contact.jobTitle ||
        contact.title ||
        source.jobRole ||
        source.jobTitle ||
        source.designation
    ),
    salutation: '',
    gender: '',
    leadType: '',
    requestType: '',
    requestTypeId: '',
    guessMeta: {
      salutationConfidence: 0,
      genderConfidence: 0,
      leadTypeConfidence: 0,
      requestTypeConfidence: 0
    },
    rawOcrText: asCleanString(source.rawOcrText || '')
  };

  const cue = inferSalutationGenderFromText(catalogs.ocrText || '', base.contactName);

  const aiSalutation = pickAllowed(
    guesses.salutation || contact.salutation || source.salutation,
    SALUTATIONS
  );
  const aiSalutationConf = asConfidence(
    guesses.salutationConfidence ?? source.salutationConfidence,
    aiSalutation ? 0.7 : 0
  );
  if (cue.salutation && cue.salutationConfidence >= MIN_GUESS_CONFIDENCE) {
    base.salutation = cue.salutation;
    base.guessMeta.salutationConfidence = cue.salutationConfidence;
  } else if (aiSalutation && aiSalutationConf >= MIN_GUESS_CONFIDENCE) {
    base.salutation = aiSalutation;
    base.guessMeta.salutationConfidence = aiSalutationConf;
  }

  const aiGender = pickAllowed(guesses.gender || contact.gender || source.gender, GENDERS);
  const aiGenderConf = asConfidence(
    guesses.genderConfidence ?? source.genderConfidence,
    aiGender ? 0.65 : 0
  );
  if (cue.gender && cue.genderConfidence >= MIN_GUESS_CONFIDENCE) {
    base.gender = cue.gender;
    base.guessMeta.genderConfidence = cue.genderConfidence;
  } else if (aiGender && aiGenderConf >= MIN_GUESS_CONFIDENCE) {
    base.gender = aiGender;
    base.guessMeta.genderConfidence = aiGenderConf;
  }

  const aiLeadType = pickAllowed(
    guesses.leadType || source.leadType || source.lead_type,
    leadTypes
  );
  const aiLeadTypeConf = asConfidence(
    guesses.leadTypeConfidence ?? source.leadTypeConfidence,
    aiLeadType ? 0.7 : 0
  );
  // Strong company/legal cues → Organizational without needing high AI confidence
  const company = base.companyName;
  const orgCue =
    /\b(pvt\.?\s*ltd\.?|private\s+limited|ltd\.?|llp|inc\.?|corp\.?|corporation|llc|gmbh|technologies|solutions|systems|industries|enterprises|hospital|clinic|school|university|college)\b/i.test(
      company
    );
  const individualCue =
    !company &&
    Boolean(base.contactName) &&
    !/\b(pvt|ltd|llp|inc|corp|llc|gmbh|technologies|solutions)\b/i.test(
      `${base.jobRole} ${base.contactName}`
    );
  if (orgCue) {
    const orgType = pickAllowed('Organizational', leadTypes) || 'Organizational';
    if (leadTypes.map((t) => t.toLowerCase()).includes(orgType.toLowerCase())) {
      base.leadType = pickAllowed(orgType, leadTypes);
      base.guessMeta.leadTypeConfidence = 0.9;
    }
  } else if (individualCue) {
    const indType = pickAllowed('Individual', leadTypes) || 'Individual';
    if (leadTypes.map((t) => t.toLowerCase()).includes(indType.toLowerCase())) {
      base.leadType = pickAllowed(indType, leadTypes);
      base.guessMeta.leadTypeConfidence = 0.82;
    }
  } else if (aiLeadType && aiLeadTypeConf >= MIN_GUESS_CONFIDENCE) {
    base.leadType = aiLeadType;
    base.guessMeta.leadTypeConfidence = aiLeadTypeConf;
  }

  const aiRequestName = asCleanString(
    guesses.requestType || source.requestType || source.request_type
  );
  const aiRequestConf = asConfidence(
    guesses.requestTypeConfidence ?? source.requestTypeConfidence,
    aiRequestName ? 0.65 : 0
  );
  if (aiRequestName && aiRequestConf >= MIN_GUESS_CONFIDENCE) {
    const matched = matchRequestType(aiRequestName, requestTypes);
    if (matched.requestType && matched.requestTypeId) {
      base.requestType = matched.requestType;
      base.requestTypeId = matched.requestTypeId;
      base.guessMeta.requestTypeConfidence = aiRequestConf;
    }
  }

  return base;
}

function isModelAccessError(message) {
  const msg = String(message || '').toLowerCase();
  return (
    msg.includes('does not exist') ||
    msg.includes('do not have access') ||
    msg.includes('model_not_found') ||
    msg.includes('invalid_model') ||
    msg.includes('decommissioned') ||
    msg.includes('not available') ||
    msg.includes('forbidden')
  );
}

function isLlamaModelId(id) {
  const s = String(id || '').toLowerCase();
  return s.includes('llama') && !s.includes('prompt-guard');
}

async function listAccessibleModelIds(apiKey) {
  try {
    const response = await fetch(GROQ_MODELS_URL, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      }
    });
    if (!response.ok) return new Set();
    const payload = await response.json().catch(() => ({}));
    const rows = Array.isArray(payload?.data) ? payload.data : [];
    return new Set(
      rows
        .map((row) => String(row?.id || '').trim())
        .filter((id) => id && !PROMPT_GUARD_MODELS.has(id))
    );
  } catch {
    return new Set();
  }
}

function buildModelTryList(preferred, accessible, { visionOnly = true } = {}) {
  const ordered = [];
  const pushUnique = (id) => {
    const model = String(id || '').trim();
    if (!model || PROMPT_GUARD_MODELS.has(model)) return;
    if (ordered.includes(model)) return;
    ordered.push(model);
  };

  const candidates = visionOnly ? GROQ_VISION_MODEL_CANDIDATES : GROQ_OCR_MODEL_CANDIDATES;
  const pref = String(preferred || '').trim().toLowerCase();
  if (pref && pref !== 'auto') {
    pushUnique(preferred);
  }

  for (const id of candidates) {
    if (accessible.size > 0 && !accessible.has(id)) continue;
    if (isLlamaModelId(id)) pushUnique(id);
  }

  for (const id of candidates) {
    if (accessible.size > 0 && !accessible.has(id)) continue;
    pushUnique(id);
  }

  if (accessible.size > 0 && ordered.length === 0) {
    const ids = [...accessible].filter((id) =>
      visionOnly
        ? /llama-4|qwen3\.8|vision|scout|maverick/i.test(id)
        : true
    );
    ids.filter(isLlamaModelId).forEach(pushUnique);
    ids.forEach(pushUnique);
  }

  if (ordered.length === 0) {
    candidates.forEach(pushUnique);
  }

  return ordered;
}

function buildSystemPrompt(catalogs) {
  const leadTypes = (catalogs.leadTypes || DEFAULT_LEAD_TYPES).join(' | ');
  const requestTypes = (catalogs.requestTypes || [])
    .map((rt) => String(rt.name || '').trim())
    .filter(Boolean)
    .slice(0, 40)
    .join(' | ');

  return `You are reading a photograph of a business / visiting card.
Return ONLY valid JSON (no markdown, no commentary) with this exact shape:
{
  "companyName": "string",
  "address": "string",
  "city": "string",
  "state": "string",
  "contactName": "string",
  "email": "string",
  "phone": "string",
  "jobRole": "string",
  "salutation": "Mr|Mrs|Ms|Miss|Dr|Prof|",
  "salutationConfidence": 0.0,
  "gender": "Male|Female|Other|Prefer not to say|",
  "genderConfidence": 0.0,
  "leadType": "string",
  "leadTypeConfidence": 0.0,
  "requestType": "string",
  "requestTypeConfidence": 0.0
}
Rules:
- Read text printed on the card image carefully (name, company, email, phone, address, title).
- Use empty string "" when a field is missing or uncertain.
- companyName is the organization / business name (required when present on the card).
- contactName is the person's full name (not the company).
- phone should be digits with optional leading +.
- Prefer Indian address parsing when cues suggest India (city/state).
- Do not invent values that are not visible on the card.

OPTIONAL GUESSES (only when you are reasonably sure):
- salutation: from printed title (Mr/Mrs/Ms/Dr…) or strong name cues. Allowed: ${SALUTATIONS.join(', ')}.
- gender: infer from salutation / clearly gendered given name. Allowed: ${GENDERS.join(', ')}.
- leadType: must be one of: ${leadTypes}. Use Organizational for companies (Pvt Ltd, Inc, LLP, hospital, school…). Use Individual for a person without a company.
- requestType: must be one of the catalog names exactly (or ""): ${requestTypes || '(none configured)'}. Infer from company industry / job role when clear.
- Each *Confidence is 0–1. If unsure, set the field to "" and confidence to 0. Never guess randomly.`;
}

function normalizeImageDataUrl(raw) {
  const value = String(raw || '').trim();
  if (!value) return '';
  if (/^data:image\/(jpeg|jpg|png|webp|gif);base64,/i.test(value)) {
    return value;
  }
  // Bare base64 → assume JPEG
  if (/^[A-Za-z0-9+/=\s]+$/.test(value) && value.replace(/\s/g, '').length > 100) {
    return `data:image/jpeg;base64,${value.replace(/\s/g, '')}`;
  }
  return '';
}

async function loadOcrCatalogs(req) {
  let leadTypes = [...DEFAULT_LEAD_TYPES];
  let requestTypes = [];
  try {
    leadTypes = await SettingService.getLeadTypes(req);
  } catch {
    // keep defaults
  }
  try {
    const RequestTypeService = require('./request-type.service');
    requestTypes = await RequestTypeService.listEnabled(req);
  } catch {
    requestTypes = [];
  }
  return {
    leadTypes: Array.isArray(leadTypes) && leadTypes.length ? leadTypes : DEFAULT_LEAD_TYPES,
    requestTypes: Array.isArray(requestTypes) ? requestTypes : []
  };
}

async function callGroqVisionExtract(apiKey, model, imageDataUrl, catalogs) {
  const response = await fetch(GROQ_CHAT_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      max_tokens: 1200,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: buildSystemPrompt(catalogs) },
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text:
                'Extract lead and contact fields from this visiting card photo. ' +
                'Also provide optional high-confidence guesses for salutation, gender, leadType, and requestType.'
            },
            {
              type: 'image_url',
              image_url: { url: imageDataUrl }
            }
          ]
        }
      ]
    })
  });

  const payload = await response.json().catch(() => ({}));
  return { response, payload };
}

/**
 * @param {object} req
 * @param {{ imageDataUrl?: string, ocrText?: string }} input
 */
async function extractFromCard(req, input = {}) {
  const imageDataUrl = normalizeImageDataUrl(input.imageDataUrl || input.image || input.dataUrl);
  const text = String(input.ocrText || '').trim();

  if (!imageDataUrl && !text) {
    const err = new Error('Visiting card image is required (imageDataUrl)');
    err.status = 400;
    throw err;
  }
  if (imageDataUrl && imageDataUrl.length > 8_000_000) {
    const err = new Error('Image payload is too large. Use a smaller photo.');
    err.status = 400;
    throw err;
  }

  const { apiKey, source } = await SettingService.resolveGroqApiKey(req);
  if (!apiKey) {
    const status = await SettingService.getGroqIntegration(req).catch(() => null);
    const hint = status?.hint ? ` (saved hint: ${status.hint})` : '';
    const err = new Error(
      `Groq API key is not configured${hint}. Open Settings → Integrations, paste your gsk_ key again, click Save Groq settings, then retry. Source checked: ${source || 'none'}.`
    );
    err.status = 503;
    throw err;
  }

  if (!imageDataUrl) {
    const err = new Error(
      'Image is required. Visiting card scan sends the photo directly to Groq vision (OCR text-only is disabled).'
    );
    err.status = 400;
    throw err;
  }

  const catalogs = await loadOcrCatalogs(req);
  const preferred = await SettingService.resolveGroqOcrModel(req);
  const accessible = await listAccessibleModelIds(apiKey);
  const tryList = buildModelTryList(preferred, accessible, { visionOnly: true });
  const tried = [];
  let lastErrorMessage = '';

  for (const model of tryList) {
    tried.push(model);
    let response;
    let payload;
    try {
      ({ response, payload } = await callGroqVisionExtract(apiKey, model, imageDataUrl, catalogs));
    } catch (networkError) {
      lastErrorMessage = networkError?.message || 'network error';
      continue;
    }

    if (!response.ok) {
      lastErrorMessage =
        payload?.error?.message ||
        payload?.message ||
        `Groq API error (HTTP ${response.status})`;
      if (isModelAccessError(lastErrorMessage)) {
        continue;
      }
      const err = new Error(lastErrorMessage);
      err.status = response.status >= 400 && response.status < 500 ? 400 : 502;
      throw err;
    }

    const content = payload?.choices?.[0]?.message?.content;
    const parsed = safeParseJson(content);
    if (!parsed) {
      lastErrorMessage = `Groq vision model ${model} returned unreadable JSON`;
      continue;
    }

    const normalized = normalizeExtracted(parsed, {
      ...catalogs,
      ocrText: [
        parsed.contactName,
        parsed.companyName,
        parsed.email,
        parsed.phone,
        parsed.jobRole,
        parsed.address
      ]
        .filter(Boolean)
        .join('\n')
    });
    normalized.rawOcrText = '';
    return {
      ...normalized,
      model,
      triedModels: tried,
      extractionMode: 'vision'
    };
  }

  const err = new Error(
    lastErrorMessage ||
      `No accessible Groq vision model found. Tried: ${tried.join(', ') || '(none)'}. ` +
        'In Settings → Integrations set model to Auto or Llama 4 Scout / Qwen 3.8 27B (vision).'
  );
  err.status = 502;
  throw err;
}

/** @deprecated Use extractFromCard with imageDataUrl */
async function extractFromOcrText(req, ocrText) {
  return extractFromCard(req, { ocrText });
}

module.exports = {
  extractFromCard,
  extractFromOcrText,
  normalizeExtracted,
  listAccessibleModelIds,
  buildModelTryList,
  GROQ_VISION_MODEL_CANDIDATES,
  GROQ_OCR_MODEL_CANDIDATES,
  DEFAULT_CHAT_MODEL,
  MIN_GUESS_CONFIDENCE
};
