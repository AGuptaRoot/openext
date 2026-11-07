'use strict';

/**
 * Applies the declarative part (json/) of a CRM workspace extension to a tenant.
 *
 * OWNER: Step 2 (see documentation/crm-upload-plan/AGY-STEP-2-declarations.md).
 *
 * Contract (documentation/crm-upload-plan/00-CONTRACTS.md §2 & §4):
 *   applyOnEnable(req, def, previousDef)
 *     Called by CrmExtensionService.enable() after the request type and
 *     pipeline are synced, every time an extension becomes active (built-in
 *     or uploaded). `def` is the full definition; `def.declarations` may be
 *     null/empty for built-ins and manifestVersion 1 packages.
 *     Must be idempotent and must never throw: enable() already succeeded.
 *     Returns a short summary object for the audit log.
 */

const SettingService = require('./setting.service');

const CATALOG_LISTS = {
  leadStatuses: 'lead_statuses',
  leadSources: 'lead_sources',
  leadTypes: 'lead_types',
  leadPriorities: 'lead_priorities',
  leadTags: 'lead_tags',
  activityTypes: 'activity_types',
  clientCategories: 'client_categories',
  clientStatuses: 'client_statuses',
  projectStatuses: 'project_statuses',
  projectPriorities: 'project_priorities',
  projectCategories: 'project_categories',
  projectTags: 'project_tags',
  projectLabels: 'project_labels',
  taskStatuses: 'task_statuses',
  taskPriorities: 'task_priorities',
  expenseCategories: 'expense_categories'
};

function getItemKey(item) {
  if (item === null || item === undefined) return '';
  if (typeof item === 'string') return item.trim().toLowerCase();
  if (typeof item === 'object') {
    return String(item.value ?? item.name ?? item.label ?? item.id ?? '').trim().toLowerCase();
  }
  return String(item).trim().toLowerCase();
}

/**
 * Merges def.declarations.catalog into the tenant settings.
 *
 * Idempotent, case-insensitive deduplication, never removes existing values.
 * Returns { applied: true, catalog: { [settingKey]: addedCount } }.
 * Never throws!
 */
// eslint-disable-next-line no-unused-vars
async function applyOnEnable(req, def, previousDef) {
  try {
    const catalogReport = {};
    const catalog = def?.declarations?.catalog;

    if (!catalog || typeof catalog !== 'object') {
      return { applied: true, catalog: catalogReport };
    }

    const allSettings = await SettingService.getAll(req);

    for (const [listName, entry] of Object.entries(catalog)) {
      if (!entry) continue;

      let settingKey = null;
      let valuesToMerge = [];

      if (entry && typeof entry === 'object' && Array.isArray(entry.values)) {
        settingKey = entry.settingKey || CATALOG_LISTS[listName] || listName;
        valuesToMerge = entry.values;
      } else if (Array.isArray(entry)) {
        settingKey = CATALOG_LISTS[listName] || listName;
        valuesToMerge = entry;
      } else if (typeof entry === 'object') {
        settingKey = entry.settingKey || CATALOG_LISTS[listName] || listName;
        valuesToMerge = Array.isArray(entry.values) ? entry.values : [];
      }

      if (!settingKey) continue;

      let currentList = null;
      if (Array.isArray(allSettings[settingKey])) {
        currentList = [...allSettings[settingKey]];
      } else {
        const defaultSetting = (SettingService.DEFAULT_SETTINGS || []).find((s) => s.key === settingKey);
        currentList = Array.isArray(defaultSetting?.value) ? [...defaultSetting.value] : [];
      }

      const seen = new Set(currentList.map(getItemKey).filter(Boolean));
      const isObjectShape = currentList.length > 0 && typeof currentList[0] === 'object' && currentList[0] !== null;

      let addedCount = 0;
      for (const rawVal of valuesToMerge) {
        const strVal = typeof rawVal === 'object' && rawVal !== null
          ? String(rawVal.value ?? rawVal.name ?? rawVal.label ?? '').trim()
          : String(rawVal || '').trim();

        if (!strVal) continue;
        const dedupe = strVal.toLowerCase();
        if (seen.has(dedupe)) continue;

        seen.add(dedupe);
        if (isObjectShape) {
          const sample = currentList[0];
          const newObj = {};
          if ('label' in sample) newObj.label = strVal;
          if ('value' in sample) newObj.value = strVal;
          if ('name' in sample) newObj.name = strVal;
          if (!Object.keys(newObj).length) {
            newObj.label = strVal;
            newObj.value = strVal;
          }
          currentList.push(newObj);
        } else {
          currentList.push(strVal);
        }
        addedCount += 1;
      }

      if (addedCount > 0) {
        await SettingService.upsertSettingValue(req, settingKey, currentList);
        allSettings[settingKey] = currentList;
      }
      catalogReport[settingKey] = addedCount;
    }

    return { applied: true, catalog: catalogReport };
  } catch (err) {
    return { applied: false, error: err?.message || String(err), catalog: {} };
  }
}

module.exports = { applyOnEnable, CATALOG_LISTS };
