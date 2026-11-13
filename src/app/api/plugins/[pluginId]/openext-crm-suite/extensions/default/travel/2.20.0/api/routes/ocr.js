'use strict';

/**
 * POST /ocr/:kind   kind = passport | aadhaar   body { image: "<data URL>" }
 *
 * Reads the photo with the CRM's OCR engine (sdk.ai.readImage — the same
 * engine and Groq key as the lead visiting-card scan) and returns the values
 * for the Traveller form to review. Nothing is saved, the photo is not kept,
 * and the values are not logged. See services/document-ocr.js for the rules.
 */

const ocr = require('../services/document-ocr.js');

const KINDS = {
  passport: { instructions: ocr.PASSPORT_INSTRUCTIONS, prompt: 'Read this passport photo page.', toResult: ocr.passportResult },
  aadhaar: { instructions: ocr.AADHAAR_INSTRUCTIONS, prompt: 'Read this Aadhaar card.', toResult: ocr.aadhaarResult }
};

exports.extract = async (req, sdk) => {
  const kind = String((req.params && req.params.kind) || '');
  const spec = KINDS[kind];
  if (!spec) throw sdk.error(404, 'Document type must be passport or aadhaar', 'NOT_FOUND');
  const image = req.body && req.body.image;
  if (typeof image !== 'string' || !image) throw sdk.error(400, 'image is required (a JPG, PNG or WEBP data URL)', 'INVALID_IMAGE');

  const { data } = await sdk.ai.readImage({ image, instructions: spec.instructions, prompt: spec.prompt });
  const nationalities = await sdk.settings.get('nationalities');
  const result = ocr.resolveNationality(spec.toResult(data), nationalities);
  await sdk.audit('viewed', `${kind === 'passport' ? 'Passport' : 'Aadhaar'} read with OCR`, {
    document: kind,
    fieldsRead: Object.keys(result.fields).length
  });
  return result;
};
