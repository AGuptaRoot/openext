'use strict';

const {
  validateLeadEventCreate,
  validateLeadEventUpdate,
  validateLeadEventAccept,
  validateLeadEventComplete,
  validateGoalLocationUpdate,
  validateLeadEventConvert,
  normalizeLocationInput
} = require('./lead.schema');

module.exports = {
  validateLeadEventCreate,
  validateLeadEventUpdate,
  validateLeadEventAccept,
  validateLeadEventComplete,
  validateGoalLocationUpdate,
  validateLeadEventConvert,
  normalizeLocationInput
};
