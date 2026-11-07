'use strict';

const { asObject, trimString, ok, fail } = require('./common.util');
const { isTenantRole, normalizeTenantRoleKey } = require('../utils/tenant-role.util');
const USER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/;

function validateMemberCreate(body) {
  const source = asObject(body);
  const errors = [];
  const userId = trimString(source.userId) || '';
  let role = trimString(source.role) || '';
  const designation = trimString(source.designation) || '';

  if (!userId) errors.push('User is required');
  if (userId.length > 128) errors.push('User ID must be 128 characters or fewer');
  if (userId && !USER_ID_PATTERN.test(userId)) errors.push('User ID format is invalid');
  if (!role || !isTenantRole(role)) {
    errors.push('A valid tenant role is required');
  } else {
    role = normalizeTenantRoleKey(role);
  }
  if (designation.length > 120) {
    errors.push('Designation must be 120 characters or fewer');
  }

  return errors.length ? fail(errors) : ok({ userId, role, designation });
}

function validateMemberUpdate(body) {
  const source = asObject(body);
  const errors = [];
  const value = {};

  if (source.role !== undefined) {
    let role = trimString(source.role) || '';
    if (!role || !isTenantRole(role)) {
      errors.push('Role is invalid');
    } else {
      value.role = normalizeTenantRoleKey(role);
    }
  }
  if (source.designation !== undefined) {
    const designation = trimString(source.designation) || '';
    if (designation.length > 120) errors.push('Designation must be 120 characters or fewer');
    else value.designation = designation;
  }
  if (source.status !== undefined) {
    const status = trimString(source.status) || '';
    if (!['active', 'inactive'].includes(status)) errors.push('Status must be active or inactive');
    else value.status = status;
  }
  if (!Object.keys(value).length) errors.push('Role, designation, or status is required');

  return errors.length ? fail(errors) : ok(value);
}

module.exports = {
  USER_ID_PATTERN,
  validateMemberCreate,
  validateMemberUpdate
};
