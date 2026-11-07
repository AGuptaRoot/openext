'use strict';

const { resolveTenantId, resolveUserId } = require('../utils/tenant.util');
const AuditService = require('./audit.service');
const {
  DEFAULT_STAGE_CATALOG,
  normalizeStageType,
  validateStages
} = require('../validation/opportunity-pipeline.schema');

function getModel(req) {
  const OpportunityPipeline = req.cms?.models.get('OpportunityPipeline');
  if (!OpportunityPipeline) throw new Error('OpportunityPipeline model is not registered');
  return OpportunityPipeline;
}

function getOpportunityModel(req) {
  return req.cms?.models.get('Opportunity') || null;
}

function appError(message, status = 400, extras = {}) {
  const error = new Error(message);
  error.status = status;
  Object.assign(error, extras);
  return error;
}

function baseFilter(req) {
  return { tenantId: resolveTenantId(req), isDeleted: false };
}

function makeStageId(index = 0) {
  return `stage_${Date.now()}_${index}_${Math.random().toString(36).slice(2, 7)}`;
}

function defaultPipelineStages() {
  return [
    { id: makeStageId(0), label: 'Discovery', type: 'OPEN', probability: 10 },
    { id: makeStageId(1), label: 'Requirement Confirmed', type: 'OPEN', probability: 25 },
    { id: makeStageId(2), label: 'Product Validated', type: 'OPEN', probability: 40 },
    { id: makeStageId(3), label: 'Sample Approved', type: 'SAMPLE_APPROVED', probability: 55 },
    { id: makeStageId(4), label: 'Quotation Sent', type: 'QUOTATION_SENT', probability: 95 },
    { id: makeStageId(5), label: 'Won', type: 'WON', probability: 100 },
    { id: makeStageId(6), label: 'Negotiation', type: 'NEGOTIATION', probability: 85 },
    { id: makeStageId(7), label: 'Lost', type: 'LOST', probability: 0 }
  ];
}

/**
 * CRM rule: Negotiation stage must sit immediately after Won (before Lost).
 * Returns { stages, changed }.
 */
function placeNegotiationAfterWon(stages) {
  if (!Array.isArray(stages) || stages.length < 2) {
    return { stages: Array.isArray(stages) ? stages : [], changed: false };
  }
  const list = stages.map((s) => ({ ...s }));
  const isWon = (s) =>
    normalizeStageType(s.type) === 'WON' ||
    String(s.label || '')
      .trim()
      .toLowerCase() === 'won';
  const isNegotiation = (s) =>
    normalizeStageType(s.type) === 'NEGOTIATION' ||
    /negotiat/i.test(String(s.label || ''));

  const negIdx = list.findIndex(isNegotiation);
  const wonIdx = list.findIndex(isWon);
  if (negIdx < 0 || wonIdx < 0) return { stages: list, changed: false };
  if (negIdx === wonIdx + 1) return { stages: list, changed: false };

  const [negotiation] = list.splice(negIdx, 1);
  const newWonIdx = list.findIndex(isWon);
  const insertAt = newWonIdx >= 0 ? newWonIdx + 1 : list.length;
  list.splice(insertAt, 0, negotiation);
  return { stages: list, changed: true };
}

/** Persist Negotiation-after-Won order on a pipeline document when needed. */
async function ensureNegotiationAfterWon(req, pipeline) {
  if (!pipeline) return pipeline;
  const { stages, changed } = placeNegotiationAfterWon(pipeline.stages || []);
  if (!changed) return { ...pipeline, stages };

  const OpportunityPipeline = getModel(req);
  await OpportunityPipeline.updateOne(
    { _id: pipeline._id },
    { $set: { stages, updatedBy: resolveUserId(req) || 'system' } }
  );
  const next = { ...pipeline, stages };
  if (pipeline.isActive) {
    await syncSettingsFromPipeline(req, next);
  }
  return next;
}

function serialize(doc, opportunityCount = 0) {
  if (!doc) return null;
  const item = typeof doc.toObject === 'function' ? doc.toObject() : { ...doc };
  item.opportunityCount = Number(opportunityCount) || 0;
  item.canDelete = !item.isDefault && item.opportunityCount === 0;
  item.stageCount = Array.isArray(item.stages) ? item.stages.length : 0;
  return item;
}

async function countOpportunitiesByPipeline(req, pipelineId) {
  const Opportunity = getOpportunityModel(req);
  if (!Opportunity || !pipelineId) return 0;
  return Opportunity.countDocuments({
    tenantId: resolveTenantId(req),
    isDeleted: false,
    pipelineId: String(pipelineId)
  });
}

async function syncSettingsFromPipeline(req, pipeline) {
  if (!pipeline || !pipeline.isActive) return;
  const SettingService = require('./setting.service');
  const stages = (pipeline.stages || []).map((s) => String(s.label || '').trim()).filter(Boolean);
  const probabilities = {};
  for (const stage of pipeline.stages || []) {
    probabilities[stage.label] = Number(stage.probability) || 0;
  }
  await SettingService.updateOpportunityStages(req, stages, probabilities);
}

/**
 * Ensure tenant has a default active pipeline (seeded from settings or built-in defaults).
 */
async function ensureDefaultPipeline(req) {
  const OpportunityPipeline = getModel(req);
  const tenantId = resolveTenantId(req);
  const existing = await OpportunityPipeline.findOne({
    tenantId,
    isDeleted: false,
    isDefault: true
  })
    .sort({ isDefault: -1, isActive: -1, createdAt: 1 })
    .lean();

  if (existing) {
    // Guarantee exactly one active among enabled pipelines when possible.
    const active = await OpportunityPipeline.findOne({
      tenantId,
      isDeleted: false,
      isActive: true
    }).lean();
    if (!active) {
      const fallback =
        (await OpportunityPipeline.findOne({
          tenantId,
          isDeleted: false,
          isEnabled: true
        })
          .sort({ isDefault: -1, createdAt: 1 })
          .lean()) || existing;
      await OpportunityPipeline.updateOne(
        { _id: fallback._id },
        { $set: { isActive: true, isEnabled: true } }
      );
      const refreshed = await OpportunityPipeline.findById(fallback._id).lean();
      const ordered = await ensureNegotiationAfterWon(req, refreshed);
      await syncSettingsFromPipeline(req, ordered);
      await ensureContributedPipelines(req);
      return ordered;
    }
    await ensureContributedPipelines(req);
    return ensureNegotiationAfterWon(req, active);
  }

  let stages = defaultPipelineStages();
  try {
    const SettingService = require('./setting.service');
    const [stageNames, probs] = await Promise.all([
      SettingService.getOpportunityStages(req),
      SettingService.getOpportunityStageProbabilities(req)
    ]);
    if (Array.isArray(stageNames) && stageNames.length >= 5) {
      stages = stageNames.map((label, index) => {
        const known = DEFAULT_STAGE_CATALOG.find(
          (item) => item.label.toLowerCase() === String(label).trim().toLowerCase()
        );
        let type = known?.type || 'OPEN';
        const lower = String(label).trim().toLowerCase();
        if (lower === 'won') type = 'WON';
        else if (lower === 'lost') type = 'LOST';
        else if (lower.includes('quotation sent')) type = 'QUOTATION_SENT';
        else if (lower.includes('negotiat') || lower.includes('commercial')) type = 'NEGOTIATION';
        else if (lower.includes('sample approved')) type = 'SAMPLE_APPROVED';
        else if (lower.includes('sample sent')) type = 'SAMPLE_SENT';
        else if (lower.includes('quotation accepted')) type = 'QUOTATION_ACCEPTED';
        return {
          id: makeStageId(index),
          label: String(label).trim(),
          type,
          probability: Number.isFinite(Number(probs[label]))
            ? Number(probs[label])
            : known?.probability ?? (type === 'WON' ? 100 : type === 'LOST' ? 0 : 50)
        };
      });
      // Ensure required types exist for quotation workflow.
      const types = new Set(stages.map((s) => s.type));
      if (!types.has('WON')) {
        stages.push({ id: makeStageId(90), label: 'Won', type: 'WON', probability: 100 });
      }
      if (!types.has('LOST')) {
        stages.push({ id: makeStageId(91), label: 'Lost', type: 'LOST', probability: 0 });
      }
      if (!types.has('QUOTATION_SENT')) {
        const wonIdx = stages.findIndex((s) => s.type === 'WON');
        const insertAt = wonIdx >= 0 ? wonIdx : Math.max(0, stages.length - 1);
        stages.splice(insertAt, 0, {
          id: makeStageId(92),
          label: 'Quotation Sent',
          type: 'QUOTATION_SENT',
          probability: 95
        });
      }
      if (!types.has('NEGOTIATION')) {
        // Place Negotiation after Won (before Lost).
        const wonIdx = stages.findIndex((s) => s.type === 'WON');
        const lostIdx = stages.findIndex((s) => s.type === 'LOST');
        const insertAt =
          wonIdx >= 0 ? wonIdx + 1 : lostIdx >= 0 ? lostIdx : stages.length;
        stages.splice(insertAt, 0, {
          id: makeStageId(93),
          label: 'Negotiation',
          type: 'NEGOTIATION',
          probability: 85
        });
      }
    }
  } catch {
    /* use built-in defaults */
  }

  const created = await OpportunityPipeline.create({
    tenantId,
    name: 'Default Pipeline',
    description: 'Standard CRM opportunity pipeline',
    isDefault: true,
    isActive: true,
    isEnabled: true,
    quotationWorkflowEnabled: true,
    stages,
    createdBy: resolveUserId(req) || 'system',
    updatedBy: resolveUserId(req) || 'system'
  });

  const doc = created.toObject();
  await syncSettingsFromPipeline(req, doc);
  await ensureContributedPipelines(req);
  return doc;
}

/**
 * Automatically inspects registered extensions for contributed opportunity pipelines
 * (declared in the extension's JSON) and seeds them if missing.
 */
async function ensureContributedPipelines(req) {
  const OpportunityPipeline = getModel(req);
  const tenantId = resolveTenantId(req);
  if (!tenantId) return;

  let contributed = [];
  try {
    const extensionHost = require('../extension-host');
    contributed = extensionHost.listContributedOpportunityPipelines();
  } catch {
    /* ignore */
  }
  if (!Array.isArray(contributed) || !contributed.length) return;

  for (const item of contributed) {
    if (!item.name || !Array.isArray(item.stages) || !item.stages.length) continue;

    // Check if pipeline with this key or name or extensionId already exists for this tenant
    const query = OpportunityPipeline.findOne({
      tenantId,
      isDeleted: false,
      $or: [
        { pipelineKey: item.key },
        { extensionId: item.extensionId },
        { name: item.name }
      ]
    });
    const existing = typeof query?.lean === 'function' ? await query.lean() : await query;

    if (!existing) {
      // Validate and ensure required workflow stages (WON, LOST, QUOTATION_SENT, NEGOTIATION)
      let stages = item.stages.map((s, idx) => ({
        id: s.id || makeStageId(idx),
        label: String(s.label || s.name || `Stage ${idx + 1}`).trim(),
        type: normalizeStageType(s.type || 'OPEN'),
        probability: Number.isFinite(Number(s.probability)) ? Number(s.probability) : 50
      }));

      // Ensure WON
      if (!stages.some((s) => s.type === 'WON')) {
        stages.push({ id: makeStageId(80), label: 'Won', type: 'WON', probability: 100 });
      }
      // Ensure LOST
      if (!stages.some((s) => s.type === 'LOST')) {
        stages.push({ id: makeStageId(81), label: 'Lost', type: 'LOST', probability: 0 });
      }
      // Ensure QUOTATION_SENT
      if (!stages.some((s) => s.type === 'QUOTATION_SENT')) {
        const wonIdx = stages.findIndex((s) => s.type === 'WON');
        const insertAt = wonIdx >= 0 ? wonIdx : Math.max(0, stages.length - 1);
        stages.splice(insertAt, 0, {
          id: makeStageId(82),
          label: 'Quotation Sent',
          type: 'QUOTATION_SENT',
          probability: 95
        });
      }
      // Ensure NEGOTIATION (placed after Won before Lost)
      if (!stages.some((s) => s.type === 'NEGOTIATION')) {
        const wonIdx = stages.findIndex((s) => s.type === 'WON');
        const insertAt = wonIdx >= 0 ? wonIdx + 1 : stages.length;
        stages.splice(insertAt, 0, {
          id: makeStageId(83),
          label: 'Negotiation',
          type: 'NEGOTIATION',
          probability: 85
        });
      }

      const { stages: orderedStages } = placeNegotiationAfterWon(stages);

      await OpportunityPipeline.create({
        tenantId,
        name: item.name,
        description: item.description || '',
        pipelineKey: item.key,
        extensionId: item.extensionId,
        isDefault: false,
        isActive: false,
        isEnabled: true,
        quotationWorkflowEnabled: item.quotationWorkflowEnabled !== false,
        stages: orderedStages,
        createdBy: resolveUserId(req) || 'system',
        updatedBy: resolveUserId(req) || 'system'
      });
    }
  }
}

async function list(req) {
  await ensureDefaultPipeline(req);
  await ensureContributedPipelines(req);
  const OpportunityPipeline = getModel(req);
  const items = await OpportunityPipeline.find(baseFilter(req))
    .sort({ isActive: -1, isDefault: -1, name: 1 })
    .lean();

  const withCounts = await Promise.all(
    items.map(async (item) => {
      const ordered = await ensureNegotiationAfterWon(req, item);
      const count = await countOpportunitiesByPipeline(req, ordered._id);
      return serialize(ordered, count);
    })
  );
  return withCounts;
}

async function getById(req, id) {
  await ensureDefaultPipeline(req);
  const OpportunityPipeline = getModel(req);
  const doc = await OpportunityPipeline.findOne({ ...baseFilter(req), _id: id }).lean();
  if (!doc) throw appError('Pipeline not found', 404);
  const ordered = await ensureNegotiationAfterWon(req, doc);
  const count = await countOpportunitiesByPipeline(req, ordered._id);
  return serialize(ordered, count);
}

async function getActive(req) {
  const active = await ensureDefaultPipeline(req);
  const ordered = await ensureNegotiationAfterWon(req, active);
  const count = await countOpportunitiesByPipeline(req, ordered._id);
  return serialize(ordered, count);
}

/**
 * Resolve stage type for a label within a pipeline (or the active pipeline).
 */
/**
 * The pipeline identified by `pipelineId`, falling back to the tenant default
 * when the id is missing or no longer resolves.
 */
async function loadPipelineOrDefault(req, pipelineId) {
  if (pipelineId) {
    const OpportunityPipeline = getModel(req);
    const pipeline = await OpportunityPipeline.findOne({
      ...baseFilter(req),
      _id: pipelineId
    }).lean();
    if (pipeline) return pipeline;
  }
  return ensureDefaultPipeline(req);
}

/**
 * The stage a deal opens in when it is converted from a lead whose commercial
 * requirement is confirmed.
 *
 * Matched against the pipeline's own labels rather than a fixed name, so a
 * tenant that renamed the stage still lands inside its own pipeline (an
 * extension pipeline may call it "Requirements Gathered"). Returns null
 * when no stage carries that meaning, which leaves the caller on the pipeline's
 * entry stage instead of inventing a stage the board has no column for.
 */
async function resolveRequirementConfirmedStage(req, pipelineId) {
  const pipeline = await loadPipelineOrDefault(req, pipelineId);
  const openStages = (Array.isArray(pipeline?.stages) ? pipeline.stages : []).filter(
    (stage) => normalizeStageType(stage.type) === 'OPEN'
  );
  const labelOf = (stage) => String(stage?.label || '').trim();
  const hit =
    openStages.find((stage) => labelOf(stage).toLowerCase() === 'requirement confirmed') ||
    openStages.find((stage) => /requirement/i.test(labelOf(stage)));
  if (!hit) return null;
  return {
    label: hit.label,
    probability: Number(hit.probability) || 25,
    pipelineId: String(pipeline._id)
  };
}

/**
 * Whether a deal has reached Requirement Confirmed — at that stage or past it.
 *
 * Used to decide when the client portal may be offered from the lead. Compared
 * by position in the pipeline rather than by name, so Negotiation and
 * Quotation Sent count as "past it" too. A pipeline with no such stage answers
 * false, which keeps the portal button hidden rather than offering it on a
 * board that has no notion of a confirmed requirement.
 */
async function isStageAtOrAfterRequirementConfirmed(req, stageLabel, pipelineId) {
  const label = String(stageLabel || '').trim().toLowerCase();
  if (!label) return false;

  const pipeline = await loadPipelineOrDefault(req, pipelineId);
  const stages = Array.isArray(pipeline?.stages) ? pipeline.stages : [];
  const labelOf = (stage) => String(stage?.label || '').trim().toLowerCase();

  // A closed-won deal is past every open stage by definition.
  const current = stages.find((stage) => labelOf(stage) === label);
  if (current && normalizeStageType(current.type) === 'WON') return true;

  const target = await resolveRequirementConfirmedStage(req, pipeline._id);
  if (!target) return false;

  const targetIndex = stages.findIndex(
    (stage) => labelOf(stage) === String(target.label || '').trim().toLowerCase()
  );
  const currentIndex = stages.findIndex((stage) => labelOf(stage) === label);
  if (targetIndex < 0 || currentIndex < 0) return false;
  return currentIndex >= targetIndex;
}

async function resolveStageMeta(req, stageLabel, pipelineId) {
  const label = String(stageLabel || '').trim();
  if (!label) return { label: '', type: 'OPEN', probability: 50 };

  const pipeline = await loadPipelineOrDefault(req, pipelineId);

  const hit = (pipeline.stages || []).find(
    (s) => String(s.label || '').trim().toLowerCase() === label.toLowerCase()
  );
  if (hit) {
    return {
      label: hit.label,
      type: normalizeStageType(hit.type),
      probability: Number(hit.probability) || 50,
      pipelineId: String(pipeline._id)
    };
  }

  const lower = label.toLowerCase();
  if (lower === 'won') return { label, type: 'WON', probability: 100, pipelineId: String(pipeline._id) };
  if (lower === 'lost') return { label, type: 'LOST', probability: 0, pipelineId: String(pipeline._id) };
  return { label, type: 'OPEN', probability: 50, pipelineId: String(pipeline._id) };
}

async function findStageLabelByType(req, type, pipelineId) {
  const target = normalizeStageType(type);
  const pipeline = await loadPipelineOrDefault(req, pipelineId);
  const hit = (pipeline.stages || []).find((s) => normalizeStageType(s.type) === target);
  return hit ? hit.label : null;
}

async function create(req, input) {
  await ensureDefaultPipeline(req);
  const OpportunityPipeline = getModel(req);
  const tenantId = resolveTenantId(req);
  const userId = resolveUserId(req);

  const quotationWorkflowEnabled = input.quotationWorkflowEnabled !== false;
  const { errors, stages: validatedStages } = validateStages(input.stages, {
    quotationWorkflowEnabled
  });
  if (errors.length) throw appError(errors[0], 400, { details: errors });
  const stages = placeNegotiationAfterWon(validatedStages).stages;

  const name = String(input.name || '').trim();
  if (!name) throw appError('Pipeline name is required');

  const duplicate = await OpportunityPipeline.findOne({
    tenantId,
    isDeleted: false,
    name: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i')
  }).lean();
  if (duplicate) throw appError('A pipeline with this name already exists', 409);

  const created = await OpportunityPipeline.create({
    tenantId,
    name,
    description: String(input.description || '').trim(),
    isDefault: false,
    isActive: false,
    isEnabled: input.isEnabled !== false,
    quotationWorkflowEnabled,
    stages,
    createdBy: userId,
    updatedBy: userId
  });

  const doc = created.toObject();
  await AuditService.log(req, {
    action: 'created',
    module: 'opportunity_pipeline',
    recordId: String(doc._id),
    description: `Opportunity pipeline created: ${doc.name}`
  });

  return serialize(doc, 0);
}

async function update(req, id, input) {
  const OpportunityPipeline = getModel(req);
  const userId = resolveUserId(req);
  const existing = await OpportunityPipeline.findOne({ ...baseFilter(req), _id: id }).lean();
  if (!existing) throw appError('Pipeline not found', 404);

  const updates = { updatedBy: userId };

  if (input.name !== undefined) {
    const name = String(input.name || '').trim();
    if (!name) throw appError('Pipeline name is required');
    const duplicate = await OpportunityPipeline.findOne({
      tenantId: existing.tenantId,
      isDeleted: false,
      _id: { $ne: id },
      name: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i')
    }).lean();
    if (duplicate) throw appError('A pipeline with this name already exists', 409);
    updates.name = name;
  }

  if (input.description !== undefined) {
    updates.description = String(input.description || '').trim();
  }

  if (input.quotationWorkflowEnabled !== undefined) {
    updates.quotationWorkflowEnabled = Boolean(input.quotationWorkflowEnabled);
  }

  if (input.isEnabled !== undefined) {
    const nextEnabled = Boolean(input.isEnabled);
    if (!nextEnabled && existing.isActive) {
      const otherActiveCandidate = await OpportunityPipeline.findOne({
        ...baseFilter(req),
        _id: { $ne: id },
        isEnabled: true
      }).lean();
      if (!otherActiveCandidate) {
        throw appError(
          'Cannot disable the only enabled pipeline. Enable or create another pipeline first.',
          409
        );
      }
      // Disabling the active pipeline — activate another enabled one.
      await OpportunityPipeline.updateMany(baseFilter(req), { $set: { isActive: false } });
      await OpportunityPipeline.updateOne(
        { _id: otherActiveCandidate._id },
        { $set: { isActive: true, isEnabled: true, updatedBy: userId } }
      );
      const activated = await OpportunityPipeline.findById(otherActiveCandidate._id).lean();
      await syncSettingsFromPipeline(req, activated);
      updates.isActive = false;
    }
    updates.isEnabled = nextEnabled;
  }

  if (input.stages !== undefined) {
    const quotationWorkflowEnabled =
      input.quotationWorkflowEnabled !== undefined
        ? Boolean(input.quotationWorkflowEnabled)
        : existing.quotationWorkflowEnabled !== false;
    const { errors, stages: validatedStages } = validateStages(input.stages, {
      quotationWorkflowEnabled
    });
    if (errors.length) throw appError(errors[0], 400, { details: errors });
    const stages = placeNegotiationAfterWon(validatedStages).stages;

    // Won / Lost types cannot be removed.
    const nextTypes = new Set(stages.map((s) => s.type));
    if (!nextTypes.has('WON') || !nextTypes.has('LOST')) {
      throw appError('Won and Lost stages cannot be removed from a pipeline', 400);
    }
    updates.stages = stages;
  }

  const updated = await OpportunityPipeline.findOneAndUpdate(
    { ...baseFilter(req), _id: id },
    { $set: updates },
    { new: true }
  ).lean();

  if (updated.isActive) {
    await syncSettingsFromPipeline(req, updated);
  }

  await AuditService.log(req, {
    action: 'updated',
    module: 'opportunity_pipeline',
    recordId: String(id),
    description: `Opportunity pipeline updated: ${updated.name}`
  });

  const count = await countOpportunitiesByPipeline(req, updated._id);
  return serialize(updated, count);
}

async function activate(req, id) {
  const OpportunityPipeline = getModel(req);
  const userId = resolveUserId(req);
  const existing = await OpportunityPipeline.findOne({ ...baseFilter(req), _id: id }).lean();
  if (!existing) throw appError('Pipeline not found', 404);
  if (!existing.isEnabled) {
    throw appError('Enable the pipeline before activating it', 409);
  }

  await OpportunityPipeline.updateMany(baseFilter(req), {
    $set: { isActive: false, updatedBy: userId }
  });

  const updated = await OpportunityPipeline.findOneAndUpdate(
    { ...baseFilter(req), _id: id },
    { $set: { isActive: true, isEnabled: true, updatedBy: userId } },
    { new: true }
  ).lean();

  await syncSettingsFromPipeline(req, updated);

  await AuditService.log(req, {
    action: 'activated',
    module: 'opportunity_pipeline',
    recordId: String(id),
    description: `Opportunity pipeline activated: ${updated.name}`
  });

  const count = await countOpportunitiesByPipeline(req, updated._id);
  return serialize(updated, count);
}

async function remove(req, id) {
  const OpportunityPipeline = getModel(req);
  const userId = resolveUserId(req);
  const existing = await OpportunityPipeline.findOne({ ...baseFilter(req), _id: id }).lean();
  if (!existing) throw appError('Pipeline not found', 404);
  if (existing.isDefault) {
    throw appError('The default pipeline cannot be deleted', 409);
  }

  const count = await countOpportunitiesByPipeline(req, id);
  if (count > 0) {
    throw appError(
      `Cannot delete this pipeline because ${count} opportunit${count === 1 ? 'y is' : 'ies are'} linked to it. Move those opportunities to another pipeline first.`,
      409,
      { code: 'PIPELINE_HAS_OPPORTUNITIES', opportunityCount: count }
    );
  }

  if (existing.isActive) {
    const fallback = await OpportunityPipeline.findOne({
      ...baseFilter(req),
      _id: { $ne: id },
      isEnabled: true
    })
      .sort({ isDefault: -1, createdAt: 1 })
      .lean();
    if (!fallback) {
      throw appError('Cannot delete the only active pipeline', 409);
    }
    await OpportunityPipeline.updateOne(
      { _id: fallback._id },
      { $set: { isActive: true, updatedBy: userId } }
    );
    const activated = await OpportunityPipeline.findById(fallback._id).lean();
    await syncSettingsFromPipeline(req, activated);
  }

  await OpportunityPipeline.findOneAndUpdate(
    { ...baseFilter(req), _id: id },
    {
      $set: {
        isDeleted: true,
        isActive: false,
        deletedAt: new Date(),
        deletedBy: userId,
        updatedBy: userId
      }
    }
  );

  await AuditService.log(req, {
    action: 'deleted',
    module: 'opportunity_pipeline',
    recordId: String(id),
    description: `Opportunity pipeline deleted: ${existing.name}`
  });

  return { deleted: true, id: String(id) };
}

/**
 * An extension update dropped some of the stages it contributed. Removes them from the tenant's
 * pipeline(s) that extension created and moves their opportunities to the stage before (never
 * deleting anything). Won / Lost stages and stages an admin added are never touched.
 * @returns {Promise<Array<{ pipelineId: string, removed: string, movedTo: string, moved: number }>>}
 */
/**
 * Stages a new extension version contributes that the tenant's pipeline does not have yet (by id or label)
 * are added, each right after the stage that comes before it in the manifest (else before the Won stage).
 * Existing stages, their order and opportunities are untouched. Best-effort, audited by the caller.
 * @returns {Promise<Array<{ pipelineId: string, added: string[] }>>}
 */
async function addExtensionStages(req, { extensionId, pipelineKey, stages }) {
  const wanted = (Array.isArray(stages) ? stages : []).filter((s) => s && s.id && s.label);
  if (!wanted.length) return [];
  const OpportunityPipeline = getModel(req);
  const tenantId = resolveTenantId(req);
  const or = [{ extensionId: `crm:${extensionId}` }, { extensionId }];
  if (pipelineKey) or.push({ pipelineKey });
  const pipelines = await OpportunityPipeline.find({ tenantId, isDeleted: false, $or: or }).lean();
  const report = [];
  const same = (a, b) => String(a.id) === String(b.id) || String(a.label || '').trim().toLowerCase() === String(b.label || '').trim().toLowerCase();

  for (const pipeline of pipelines) {
    const current = Array.isArray(pipeline.stages) ? pipeline.stages.map((s) => ({ ...s })) : [];
    if (!current.length) continue;
    const added = [];
    wanted.forEach((stage, index) => {
      if (current.some((s) => same(s, stage))) return;
      const type = normalizeStageType(stage.type || 'OPEN');
      if (type === 'WON' || type === 'LOST') return;
      const before = wanted.slice(0, index).reverse().find((w) => current.some((s) => same(s, w)));
      let at = before ? current.findIndex((s) => same(s, before)) + 1 : current.findIndex((s) => s.type === 'WON');
      if (at < 0) at = current.length;
      current.splice(at, 0, {
        id: String(stage.id),
        label: String(stage.label).trim(),
        type,
        probability: Number.isFinite(Number(stage.probability)) ? Number(stage.probability) : 50
      });
      added.push(String(stage.label).trim());
    });
    if (!added.length) continue;
    await OpportunityPipeline.findOneAndUpdate(
      { tenantId, _id: pipeline._id },
      { $set: { stages: current, updatedBy: resolveUserId(req) || 'system' } }
    );
    if (pipeline.isActive) {
      try {
        await syncSettingsFromPipeline(req, { ...pipeline, stages: current });
      } catch {
        /* the pipeline page re-syncs */
      }
    }
    report.push({ pipelineId: String(pipeline._id), added });
  }
  return report;
}

async function removeExtensionStages(req, { extensionId, pipelineKey, stageIds, stageLabels = [] }) {
  const ids = new Set((stageIds || []).map(String).filter(Boolean));
  const labels = new Set((stageLabels || []).map((l) => String(l).trim().toLowerCase()).filter(Boolean));
  if (!ids.size && !labels.size) return [];
  const OpportunityPipeline = getModel(req);
  const Opportunity = getOpportunityModel(req);
  const tenantId = resolveTenantId(req);
  const or = [{ extensionId: `crm:${extensionId}` }];
  if (pipelineKey) or.push({ pipelineKey });
  const pipelines = await OpportunityPipeline.find({ tenantId, isDeleted: false, $or: or }).lean();
  const report = [];

  for (const pipeline of pipelines) {
    const stages = Array.isArray(pipeline.stages) ? pipeline.stages : [];
    const isRemoved = (s) =>
      (ids.has(String(s.id)) || labels.has(String(s.label || '').trim().toLowerCase())) && s.type !== 'WON' && s.type !== 'LOST';
    const kept = stages.filter((s) => !isRemoved(s));
    if (kept.length === stages.length || kept.length < 2) continue;

    const moves = [];
    stages.forEach((stage, index) => {
      if (!isRemoved(stage)) return;
      // The nearest kept stage before it (or the first kept stage when it was the first one).
      const before = stages.slice(0, index).reverse().find((s) => !isRemoved(s));
      moves.push({ from: stage, to: before || kept[0] });
    });

    for (const { from, to } of moves) {
      let moved = 0;
      if (Opportunity) {
        const filter = { tenantId, isDeleted: false, stage: from.label };
        filter.$or = pipeline.isActive
          ? [{ pipelineId: String(pipeline._id) }, { pipelineId: null }, { pipelineId: '' }]
          : [{ pipelineId: String(pipeline._id) }];
        const opportunities = await Opportunity.find(filter).select('_id expectedRevenue').lean();
        const probability = Number(to.probability) || 0;
        for (const opp of opportunities) {
          await Opportunity.updateOne(
            { _id: opp._id, tenantId },
            {
              $set: {
                stage: to.label,
                stageType: to.type || 'OPEN',
                probability,
                weightedRevenue: Math.round((Number(opp.expectedRevenue) || 0) * (probability / 100) * 100) / 100
              }
            }
          );
          moved += 1;
        }
      }
      report.push({ pipelineId: String(pipeline._id), removed: from.label, movedTo: to.label, moved });
    }

    await OpportunityPipeline.updateOne({ _id: pipeline._id }, { $set: { stages: kept } });
    if (pipeline.isActive) await syncSettingsFromPipeline(req, { ...pipeline, stages: kept });
    await AuditService.log(req, {
      action: 'updated',
      module: 'opportunity_pipeline',
      recordId: String(pipeline._id),
      description: `Stages removed by extension update: ${moves.map((m) => `${m.from.label} → opportunities moved to ${m.to.label}`).join('; ')}`
    });
  }
  return report;
}

module.exports = {
  addExtensionStages,
  DEFAULT_STAGE_CATALOG,
  removeExtensionStages,
  list,
  getById,
  getActive,
  create,
  update,
  activate,
  remove,
  ensureDefaultPipeline,
  ensureContributedPipelines,
  resolveStageMeta,
  resolveRequirementConfirmedStage,
  isStageAtOrAfterRequirementConfirmed,
  findStageLabelByType,
  countOpportunitiesByPipeline,
  serialize
};
