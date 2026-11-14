'use strict';

const { randomUUID } = require('crypto');
const AuditService = require('./audit.service');
const { resolveUserId } = require('../utils/tenant.util');
const { parsePagination } = require('../utils/pagination.util');
const {
  deriveTenantRole,
  isTenantRole,
  normalizeTenantRoleKey,
  listTenantRoles,
  PERMISSION_GROUPS,
  ROLE_DEFINITIONS,
  getRoleDefinition,
  TENANT_ROLES,
  ALL_PERMISSIONS: CRM_MANIFEST_PERMISSIONS,
  getDefaultRolePermissionsMap,
  resolveTenantRolePermissions
} = require('../utils/tenant-role.util');
const {
  resolveUsernames,
  findCmsUserById,
  listAssignableUsers: listCmsUsers
} = require('../utils/user.util');

const DEFAULT_TENANT_ID = 'default';
const TENANT_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const ADMIN_MUTATION_LOCK_MS = 30000;

function appError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function getMembershipModel(req) {
  const Membership = req.cms?.models?.get?.('TenantMembership') || req.cms?.models?.TenantMembership || req.models?.TenantMembership;
  if (!Membership) throw appError('Tenant membership model is not registered', 500);
  return Membership;
}

function getTenantModel(req) {
  const Tenant = req.cms?.models?.get?.('Tenant') || req.cms?.models?.Tenant || req.models?.Tenant;
  if (!Tenant) throw appError('Tenant model is not registered', 500);
  return Tenant;
}

function getSettingModel(req) {
  const Setting = req.cms?.models?.get?.('Setting') || req.cms?.models?.Setting || req.models?.Setting;
  if (!Setting) throw appError('Setting model is not registered', 500);
  return Setting;
}

function normalizeTenantId(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return DEFAULT_TENANT_ID;
  if (!TENANT_ID_PATTERN.test(raw)) {
    throw appError('Tenant ID format is invalid', 400);
  }
  return raw;
}

function trustedTenantHint(req) {
  const hint = req.get ? req.get('x-tenant-id') : req.headers?.['x-tenant-id'];
  return hint ? normalizeTenantId(hint) : null;
}

/**
 * Performance: the tenant row is read once per 10 s per process and written only when it is
 * missing (it used to be upserted on every request). CMS roles are cached for 5 s.
 */
const TENANT_TTL_MS = 10_000;
const ROLES_TTL_MS = 5_000;
const tenantCache = new Map();
let rolesCache = null;

async function ensureTenant(req, tenantId = DEFAULT_TENANT_ID) {
  const Tenant = getTenantModel(req);
  if (!Tenant) return { tenantId, name: 'Default Tenant', status: 'active' };

  const cached = tenantCache.get(tenantId);
  if (cached && Date.now() - cached.at < TENANT_TTL_MS) return cached.tenant;
  if (typeof Tenant.findOne === 'function') {
    const found = await Tenant.findOne({ tenantId }).lean();
    if (found) {
      tenantCache.set(tenantId, { at: Date.now(), tenant: found });
      return found;
    }
  }

  const actor = resolveUserId(req);
  const tenant = await Tenant.findOneAndUpdate(
    { tenantId },
    {
      $setOnInsert: {
        tenantId,
        name: tenantId === DEFAULT_TENANT_ID ? 'Default Tenant' : `Tenant ${tenantId}`,
        status: 'active',
        createdBy: actor,
        updatedBy: actor
      }
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  ).lean();
  if (tenant) tenantCache.set(tenantId, { at: Date.now(), tenant });
  return tenant;
}

/** Forget cached tenant rows (after a tenant is changed). */
function forgetTenantCache(tenantId) {
  if (tenantId) tenantCache.delete(tenantId);
  else tenantCache.clear();
}

async function fetchCmsRolesMap(req) {
  if (rolesCache && Date.now() - rolesCache.at < ROLES_TTL_MS) return rolesCache.map;
  const map = await readCmsRolesMap(req);
  if (map.size) rolesCache = { at: Date.now(), map };
  return map;
}

async function readCmsRolesMap(req) {
  const map = new Map();
  try {
    const conn = await req.cms?.database?.user?.();
    if (conn) {
      let roleDocs = [];
      if (conn.db && typeof conn.db.collection === 'function') {
        roleDocs = await conn.db.collection('roles').find({}).toArray();
      } else if (typeof conn.collection === 'function') {
        const col = conn.collection('roles');
        if (col && typeof col.find === 'function') {
          roleDocs = await col.find({}).toArray();
        }
      }
      for (const r of roleDocs) {
        if (r.value !== undefined) {
          map.set(Number(r.value), r);
        }
        if (r.name) {
          map.set(String(r.name).toLowerCase(), r);
        }
        if (r.id) {
          map.set(String(r.id).toLowerCase(), r);
        }
      }
    }
  } catch (err) {
    // fallback if CMS userDb is unreachable
  }
  return map;
}

async function bootstrapMembership(req, tenantId, userId) {
  const Membership = getMembershipModel(req);
  const cmsRolesMap = await fetchCmsRolesMap(req);
  const role = deriveTenantRole(req?.user, cmsRolesMap);
  return Membership.findOneAndUpdate(
    { tenantId, userId },
    {
      $setOnInsert: {
        tenantId,
        userId,
        role,
        status: 'active',
        createdBy: userId,
        updatedBy: userId
      }
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  ).lean();
}

/**
 * Derive tenant scope only from authenticated context or server-side membership.
 * Request body/query tenant IDs are intentionally ignored.
 * 
 * Usecase: Attaches tenant context to authenticated requests. Uses resolveUserId(req) to support req.user.id, req.user._id, req.user.userId, or req.user.sub.
 * 
 * @param {Object} req Express request object
 */
async function attachTenantContext(req) {
  if (!req?.user) throw appError('Authentication is required', 401);

  const userId = resolveUserId(req);
  if (!userId || userId === 'system') throw appError('Authentication is required', 401);

  const Membership = getMembershipModel(req);
  const tenantHint = trustedTenantHint(req);
  let membership;

  if (tenantHint) {
    membership = await Membership.findOne({ tenantId: tenantHint, userId }).lean();
  } else {
    const memberships = await Membership.find({ userId, status: 'active' })
      .sort({ createdAt: 1 })
      .limit(2)
      .lean();

    if (memberships.length > 1) {
      membership = memberships[0];
    } else {
      membership = memberships[0] || null;
    }
  }

  const tenantId = tenantHint || membership?.tenantId || DEFAULT_TENANT_ID;
  const tenant = await ensureTenant(req, tenantId);

  if (!membership) {
    // Automatically admit any authenticated OpenNext CMS user and bootstrap their CRM membership based on their role
    membership = await bootstrapMembership(req, tenantId, userId);
  }

  const cmsRolesMap = await fetchCmsRolesMap(req);
  const currentDerivedRole = deriveTenantRole(req?.user, cmsRolesMap);
  if (membership && currentDerivedRole && membership.role !== currentDerivedRole) {
    await Membership.updateOne({ _id: membership._id }, { $set: { role: currentDerivedRole } });
    membership.role = currentDerivedRole;
  }

  if (!membership || membership.status !== 'active') {
    throw appError('Your CRM tenant membership is inactive', 403);
  }
  if (membership.tenantId !== tenantId) {
    throw appError('Tenant membership does not match the authenticated tenant', 403);
  }
  membership.role = normalizeTenantRoleKey(membership.role || deriveTenantRole(req?.user));
  if (!tenant || tenant.status !== 'active') {
    throw appError('This CRM tenant is suspended', 403);
  }

  req.tenantId = tenantId;
  req.tenantMembership = membership;
  req.tenant = {
    tenantId,
    name: tenant.name,
    status: tenant.status,
    role: membership.role
  };

  return req.tenant;
}

function getContext(req) {
  if (!req.tenant || !req.tenantMembership) {
    throw appError('Tenant context is unavailable', 500);
  }
  return {
    tenantId: req.tenantId,
    role: req.tenantMembership.role,
    userId: req.tenantMembership.userId,
    status: req.tenantMembership.status
  };
}

async function listMembers(req) {
  const Membership = getMembershipModel(req);
  const { page, limit, skip } = parsePagination(req.query, { defaultLimit: 25, maxLimit: 100 });
  const filter = { tenantId: req.tenantId };

  const role = String(req.query?.role || '').trim();
  const status = String(req.query?.status || '').trim();
  if (role && isTenantRole(role)) filter.role = role;
  if (status && ['active', 'inactive'].includes(status)) filter.status = status;

  // 1. Fetch CMS Roles & Users from OpenNext user database
  const cmsRolesMap = await fetchCmsRolesMap(req);
  const cmsUsers = await listCmsUsers(req);
  const cmsUserMap = new Map();
  for (const u of cmsUsers) {
    const uid = String(u._id || u.id || u.userId);
    cmsUserMap.set(uid, u);
  }

  // 2. Fetch CRM Tenant Memberships
  const [items, total] = await Promise.all([
    Membership.find(filter).sort({ createdAt: 1 }).skip(skip).limit(limit).lean(),
    Membership.countDocuments(filter)
  ]);

  const existingUserIds = new Set(items.map((item) => String(item.userId)));

  const resultItems = items.map((item) => {
    const uid = String(item.userId);
    const cmsUser = cmsUserMap.get(uid);
    const rawRole = item.role !== undefined ? item.role : cmsUser?.role;
    const resolvedRole = normalizeTenantRoleKey(deriveTenantRole(rawRole, cmsRolesMap));

    let roleLabel = '';
    if (cmsUser?.role !== undefined && cmsRolesMap.has(Number(cmsUser.role))) {
      roleLabel = cmsRolesMap.get(Number(cmsUser.role)).name;
    } else {
      const def = getRoleDefinition(resolvedRole);
      roleLabel = def?.label || resolvedRole;
    }

    return {
      id: String(item._id),
      userId: uid,
      username: cmsUser?.username || cmsUser?.displayName || cmsUser?.email || uid,
      role: resolvedRole,
      roleLabel,
      cmsRole: cmsUser?.role,
      cmsRoleName: roleLabel,
      designation: item.designation || cmsUser?.designation || '',
      status: item.status || (cmsUser?.active === false ? 'inactive' : 'active'),
      createdAt: item.createdAt,
      updatedAt: item.updatedAt
    };
  });

  // Include any CMS sub-users that don't have membership records yet
  for (const [uid, cmsUser] of cmsUserMap.entries()) {
    if (!existingUserIds.has(uid)) {
      const resolvedRole = normalizeTenantRoleKey(deriveTenantRole(cmsUser.role, cmsRolesMap));
      let roleLabel = '';
      if (cmsUser.role !== undefined && cmsRolesMap.has(Number(cmsUser.role))) {
        roleLabel = cmsRolesMap.get(Number(cmsUser.role)).name;
      } else {
        const def = getRoleDefinition(resolvedRole);
        roleLabel = def?.label || resolvedRole;
      }

      resultItems.push({
        id: uid,
        userId: uid,
        username: cmsUser.username || cmsUser.displayName || cmsUser.email || uid,
        role: resolvedRole,
        roleLabel,
        cmsRole: cmsUser.role,
        cmsRoleName: roleLabel,
        designation: cmsUser.designation || '',
        status: cmsUser.active === false ? 'inactive' : 'active',
        createdAt: new Date(),
        updatedAt: new Date()
      });
    }
  }

  return {
    items: resultItems,
    pagination: { page, limit, total: Math.max(total, resultItems.length), totalPages: 1 }
  };
}

async function listCandidates(req, search = '') {
  const Membership = getMembershipModel(req);
  const users = await listCmsUsers(req, search);
  if (!users.length) return [];

  const userIds = users.map((user) => String(user.id || user._id || '')).filter(Boolean);
  const memberships = await Membership.find({ userId: { $in: userIds } })
    .select('tenantId userId status')
    .lean();
  const membershipsByUser = new Map();
  memberships.forEach((item) => {
    const key = String(item.userId);
    const existing = membershipsByUser.get(key) || [];
    existing.push(item);
    membershipsByUser.set(key, existing);
  });

  return users
    .filter((user) => {
      const uid = String(user.id || user._id || '');
      const userMemberships = membershipsByUser.get(uid) || [];
      if (!userMemberships.length) return true;
      const activeElsewhere = userMemberships.some(
        (item) => item.status === 'active' && item.tenantId !== req.tenantId
      );
      if (activeElsewhere) return false;
      return userMemberships.some(
        (item) => item.tenantId === req.tenantId && item.status === 'inactive'
      );
    })
    .map((user) => {
      const uid = String(user.id || user._id || '');
      return {
        id: uid,
        _id: uid,
        userId: uid,
        username: user.username,
        displayName: user.displayName,
        email: user.email
      };
    });
}

/**
 * Assignable users for lead/opportunity ownership.
 * Always includes OpenNext CMS users (source of truth), enriched with CRM
 * TenantMembership role/designation when present. Previously membership-only
 * lists hid CMS Sales Representatives who were not yet CRM members.
 */
async function listAssignableMembers(req, search = '') {
  const { normalizeTenantRoleKey } = require('../utils/tenant-role.util');
  const Membership = getMembershipModel(req);

  const [cmsUsers, memberships] = await Promise.all([
    listCmsUsers(req, search),
    Membership.find({
      tenantId: req.tenantId,
      status: 'active',
      role: { $nin: ['client', 'customer', 'portal'] }
    })
      .select('userId designation role')
      .limit(200)
      .lean()
  ]);

  const designationMap = {};
  const roleMap = {};
  for (const m of memberships || []) {
    const uid = String(m.userId || '').trim();
    if (!uid) continue;
    designationMap[uid] = m.designation || '';
    roleMap[uid] = m.role || '';
  }

  const byId = new Map();

  // 1) CMS users first — these are the OpenNext accounts managers expect to assign
  for (const u of cmsUsers || []) {
    const uid = String(u.id || u._id || u.userId || '').trim();
    if (!uid) continue;
    const cmsRoleRaw = u.cmsRole ?? u.role ?? (Array.isArray(u.roles) ? u.roles[0] : '') ?? '';
    const membershipRole = roleMap[uid] || '';
    const role = membershipRole || normalizeTenantRoleKey(cmsRoleRaw) || String(u.role || cmsRoleRaw || '');
    const roleLower = String(role || '').toLowerCase();
    if (
      roleLower === 'client' ||
      roleLower.includes('client') ||
      roleLower.includes('customer') ||
      roleLower.includes('portal')
    ) {
      continue;
    }
    const username = u.username || u.name || u.displayName || u.email || 'User';
    const designation = designationMap[uid] || u.designation || '';
    byId.set(uid, {
      id: uid,
      _id: uid,
      userId: uid,
      username,
      name: username,
      designation,
      role,
      cmsRole: cmsRoleRaw,
      displayName: designation ? `${username} (${designation})` : username,
      email: u.email || ''
    });
  }

  // 2) Membership-only users (added to CRM but missing from CMS query / inactive-filtered)
  for (const m of memberships || []) {
    const uid = String(m.userId || '').trim();
    if (!uid || byId.has(uid)) continue;
    const role = String(m.role || '');
    const roleLower = role.toLowerCase();
    if (
      roleLower === 'client' ||
      roleLower.includes('client') ||
      roleLower.includes('customer') ||
      roleLower.includes('portal')
    ) {
      continue;
    }
    byId.set(uid, {
      id: uid,
      _id: uid,
      userId: uid,
      username: uid,
      name: uid,
      designation: m.designation || '',
      role,
      displayName: m.designation ? `${uid} (${m.designation})` : uid,
      email: ''
    });
  }

  // Resolve real usernames for any leftover ObjectId labels
  const unresolved = [...byId.values()]
    .filter((u) => /^[a-f0-9]{24}$/i.test(String(u.username || '')))
    .map((u) => u.id);
  if (unresolved.length) {
    const names = await resolveUsernames(req, unresolved);
    for (const uid of unresolved) {
      const entry = byId.get(uid);
      if (!entry) continue;
      const label = names[uid];
      if (label && !/^[a-f0-9]{24}$/i.test(String(label))) {
        entry.username = label;
        entry.name = label;
        entry.displayName = entry.designation ? `${label} (${entry.designation})` : label;
      }
    }
    // CRM 3.50.5: a membership whose OpenNext user cannot be found (e.g. the account was deleted) has no
    // name to show — it was listed as its raw id. It cannot be assigned work, so it is left out (leads
    // already assigned to it are not changed).
    for (const uid of unresolved) {
      const entry = byId.get(uid);
      if (entry && /^[a-f0-9]{24}$/i.test(String(entry.username || ''))) byId.delete(uid);
    }
  }

  const term = String(search || '').trim().toLowerCase().slice(0, 100);
  return [...byId.values()]
    .filter((user) => {
      if (!term) return true;
      return (
        user.username.toLowerCase().includes(term) ||
        user.displayName.toLowerCase().includes(term) ||
        String(user.designation || '').toLowerCase().includes(term) ||
        String(user.email || '').toLowerCase().includes(term) ||
        String(user.role || '').toLowerCase().includes(term)
      );
    })
    .sort((a, b) => String(a.username).localeCompare(String(b.username), undefined, { sensitivity: 'base' }))
    .slice(0, 100);
}

function assertCompatibleCmsTenant(req, cmsUser) {
  const userTenantId = normalizeTenantId(cmsUser?.tenantId);
  if (userTenantId && userTenantId !== req.tenantId) {
    throw appError('The selected user belongs to a different tenant', 409);
  }
}

async function addMember(req, input) {
  const Membership = getMembershipModel(req);
  const userId = String(input.userId || '').trim();
  const cmsUser = await findCmsUserById(req, userId);
  if (!cmsUser) throw appError('CMS user not found', 404);
  if (cmsUser.active === false) throw appError('Inactive OpenNext users cannot be added to CRM', 409);
  assertCompatibleCmsTenant(req, cmsUser);

  const activeMemberships = await Membership.find({ userId, status: 'active' })
    .select('tenantId')
    .limit(2)
    .lean();
  const activeElsewhere = activeMemberships.some((item) => item.tenantId !== req.tenantId);
  if (activeElsewhere && !normalizeTenantId(cmsUser.tenantId)) {
    throw appError(
      'This user already belongs to another tenant and requires trusted tenant selection from OpenNext',
      409
    );
  }

  const existing = await Membership.findOne({ tenantId: req.tenantId, userId }).lean();
  if (existing?.status === 'active') throw appError('User is already an active tenant member', 409);

  const actor = resolveUserId(req);
  const member = await Membership.findOneAndUpdate(
    { tenantId: req.tenantId, userId },
    {
      $set: {
        role: input.role,
        designation: input.designation !== undefined ? String(input.designation).trim() : '',
        status: 'active',
        updatedBy: actor
      },
      $setOnInsert: { tenantId: req.tenantId, userId, createdBy: actor }
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  ).lean();

  await AuditService.log(req, {
    action: existing ? 'reactivated' : 'created',
    module: 'tenant_security',
    recordId: userId,
    description: `Tenant member ${existing ? 'reactivated' : 'added'} with role ${input.role}`,
    metadata: { targetUserId: userId, role: input.role }
  });

  return member;
}

async function assertAdminContinuity(req, member, updates) {
  const removesAdmin =
    member.role === 'tenant_admin' &&
    (updates.role !== undefined && updates.role !== 'tenant_admin' || updates.status === 'inactive');
  if (!removesAdmin) return;

  const Membership = getMembershipModel(req);
  const activeAdmins = await Membership.countDocuments({
    tenantId: req.tenantId,
    role: 'tenant_admin',
    status: 'active'
  });
  if (activeAdmins <= 1) throw appError('A tenant must keep at least one active administrator', 409);
}

/**
 * Serialize tenant-administrator removals across processes using an atomic,
 * expiring lease on the tenant document. This works on standalone MongoDB
 * deployments where multi-document transactions may be unavailable.
 */
async function acquireAdminMutationLock(req) {
  const Tenant = getTenantModel(req);
  const token = randomUUID();
  const now = new Date();
  const lockedUntil = new Date(now.getTime() + ADMIN_MUTATION_LOCK_MS);
  const tenant = await Tenant.findOneAndUpdate(
    {
      tenantId: req.tenantId,
      $or: [
        { adminMutationLockUntil: { $exists: false } },
        { adminMutationLockUntil: null },
        { adminMutationLockUntil: { $lte: now } }
      ]
    },
    {
      $set: {
        adminMutationLockToken: token,
        adminMutationLockUntil: lockedUntil
      }
    },
    { new: true }
  ).lean();

  if (!tenant) {
    throw appError('Another administrator change is in progress. Please retry.', 409);
  }

  return { Tenant, token };
}

async function releaseAdminMutationLock(req, lock) {
  if (!lock) return;
  try {
    await lock.Tenant.updateOne(
      { tenantId: req.tenantId, adminMutationLockToken: lock.token },
      { $unset: { adminMutationLockToken: '', adminMutationLockUntil: '' } }
    );
  } catch (error) {
    req?.cms?.logger?.warn?.(
      'Tenant administrator mutation lock release failed; the lease will expire automatically:',
      error?.message || error
    );
  }
}

async function updateMember(req, targetUserId, input) {
  const Membership = getMembershipModel(req);
  const userId = String(targetUserId || '').trim();
  const actor = resolveUserId(req);
  if (userId === actor && (input.role !== undefined || input.status !== undefined)) {
    throw appError('You cannot change your own tenant role or status', 409);
  }

  let member = await Membership.findOne({ tenantId: req.tenantId, userId }).lean();

  const removesAdmin =
    member?.role === 'tenant_admin' &&
    (input.role !== undefined && input.role !== 'tenant_admin' || input.status === 'inactive');
  let adminLock = null;

  if (removesAdmin) {
    adminLock = await acquireAdminMutationLock(req);
    try {
      member = await Membership.findOne({ tenantId: req.tenantId, userId }).lean();
      if (member) {
        await assertAdminContinuity(req, member, input);
      }
    } catch (error) {
      await releaseAdminMutationLock(req, adminLock);
      throw error;
    }
  }

  const updates = { tenantId: req.tenantId, userId, updatedBy: actor };
  if (input.role !== undefined) updates.role = input.role;
  if (input.designation !== undefined) updates.designation = String(input.designation).trim();
  if (input.status !== undefined) updates.status = input.status;

  let updated;
  try {
    updated = await Membership.findOneAndUpdate(
      { tenantId: req.tenantId, userId },
      { $set: updates },
      { upsert: true, new: true }
    ).lean();

    // Sync role and designation back to OpenNext CMS User record (matching OpenNext CMS sub-users update route)
    const conn = await req.cms?.database?.user?.();
    if (conn) {
      const candidates = [userId];
      const mongoose = require('mongoose');
      if (mongoose.Types.ObjectId.isValid(userId)) candidates.push(new mongoose.Types.ObjectId(userId));

      const cmsUpdates = {};
      if (input.designation !== undefined) cmsUpdates.designation = String(input.designation).trim();
      if (input.status !== undefined) cmsUpdates.active = input.status === 'active';
      if (input.role !== undefined) {
        // Map string role to OpenNext CMS role format
        const roleStr = String(input.role).toLowerCase();
        if (roleStr === 'superadmin' || roleStr === '0') {
          cmsUpdates.role = 0;
        } else if (roleStr === 'admin' || roleStr === '1' || roleStr === 'tenant_admin') {
          cmsUpdates.role = 1;
        } else if (roleStr === 'editor' || roleStr === '2') {
          cmsUpdates.role = 2;
        } else if (roleStr === 'author' || roleStr === '3') {
          cmsUpdates.role = 3;
        } else if (!isNaN(Number(input.role))) {
          cmsUpdates.role = Number(input.role);
        }
      }

      if (Object.keys(cmsUpdates).length > 0) {
        await conn.collection('users').updateOne(
          { _id: { $in: candidates } },
          { $set: cmsUpdates }
        );
      }
    }
  } finally {
    await releaseAdminMutationLock(req, adminLock);
  }

  await AuditService.log(req, {
    action: 'updated',
    module: 'tenant_security',
    recordId: userId,
    description: `Tenant membership updated for ${userId}`,
    metadata: {
      targetUserId: userId,
      previousRole: member?.role,
      role: updated.role,
      previousStatus: member?.status,
      status: updated.status
    }
  });

  return updated;
}

async function getCustomRolePermissionsMap(req) {
  const Setting = getSettingModel(req);
  const setting = await Setting.findOne({
    tenantId: req.tenantId,
    key: 'role_permissions',
    isDeleted: false
  }).lean();
  if (setting && setting.value && typeof setting.value === 'object') {
    return setting.value;
  }
  return null;
}

/**
 * Retrieves user-created custom roles stored in tenant settings.
 */
async function getCustomRoles(req) {
  const Setting = getSettingModel(req);
  const setting = await Setting.findOne({
    tenantId: req.tenantId,
    key: 'custom_created_roles',
    isDeleted: false
  }).lean();
  return Array.isArray(setting?.value) ? setting.value : [];
}

async function getRolePermissionsMatrix(req) {
  const customMap = await getCustomRolePermissionsMap(req);
  const defaultMap = getDefaultRolePermissionsMap();
  const activeMap = customMap ? { ...defaultMap, ...customMap } : defaultMap;
  activeMap['crm-manager'] = [...CRM_MANIFEST_PERMISSIONS];

  const standardRoles = listTenantRoles(CRM_MANIFEST_PERMISSIONS, activeMap);

  return {
    rolePermissions: activeMap,
    groups: PERMISSION_GROUPS,
    roles: standardRoles
  };
}

async function updateRolePermissions(req, input) {
  const Setting = getSettingModel(req);
  const actor = resolveUserId(req);

  const rawMap = input?.rolePermissions || input;
  if (!rawMap || typeof rawMap !== 'object') {
    throw appError('Role permissions data is required', 400);
  }

  const validRoles = TENANT_ROLES.filter((r) => r !== 'crm-manager');
  const validPermissions = new Set(CRM_MANIFEST_PERMISSIONS);
  const updatedMap = {};

  for (const roleKey of validRoles) {
    if (Array.isArray(rawMap[roleKey])) {
      updatedMap[roleKey] = [...new Set(rawMap[roleKey])].filter((p) => validPermissions.has(p));
    } else {
      const def = getDefaultRolePermissionsMap();
      updatedMap[roleKey] = def[roleKey] || [];
    }
  }
  updatedMap['crm-manager'] = [...CRM_MANIFEST_PERMISSIONS];

  require('./setting.service').invalidateSettingsCache(req);
  await Setting.findOneAndUpdate(
    { tenantId: req.tenantId, key: 'role_permissions' },
    {
      $set: {
        value: updatedMap,
        category: 'general',
        status: 'active',
        updatedBy: actor
      },
      $setOnInsert: {
        tenantId: req.tenantId,
        key: 'role_permissions',
        createdBy: actor
      }
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  await AuditService.log(req, {
    action: 'updated',
    module: 'tenant_security',
    recordId: 'role_permissions',
    description: 'Tenant role permissions matrix updated',
    metadata: { updatedRoles: Object.keys(updatedMap) }
  });

  return getRolePermissionsMatrix(req);
}

/**
 * Creates a new custom role in the tenant workspace.
 * 
 * Usecase: Allows Super Admins / Tenant Admins to create new custom roles with custom permissions.
 * 
 * @param {Object} req Express request object
 * @param {Object} input Custom role details containing name, description, permissions
 * @returns {Promise<Object>} Created role object and updated role permissions matrix
 */
async function createCustomRole(req, input) {
  const Setting = getSettingModel(req);
  const actor = resolveUserId(req);

  const name = String(input.name || input.label || '').trim();
  if (!name) throw appError('Role name is required', 400);

  const key = 'custom_' + name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (!key || key === 'custom_') throw appError('Invalid role name', 400);

  const customRoles = await getCustomRoles(req);
  if (customRoles.some((r) => r.key === key) || TENANT_ROLES.includes(key)) {
    throw appError(`Role with key "${key}" already exists`, 409);
  }

  const description = String(input.description || `Custom role: ${name}`).trim();
  const validPermissions = new Set(CRM_MANIFEST_PERMISSIONS);
  const permissions = Array.isArray(input.permissions)
    ? [...new Set(input.permissions)].filter((p) => validPermissions.has(p))
    : [];

  const newRole = { key, label: name, description, isCustom: true, permissions };
  customRoles.push(newRole);

  require('./setting.service').invalidateSettingsCache(req);
  await Setting.findOneAndUpdate(
    { tenantId: req.tenantId, key: 'custom_created_roles' },
    {
      $set: { value: customRoles, category: 'general', status: 'active', updatedBy: actor },
      $setOnInsert: { tenantId: req.tenantId, key: 'custom_created_roles', createdBy: actor }
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  const customMap = (await getCustomRolePermissionsMap(req)) || {};
  customMap[key] = permissions;
  require('./setting.service').invalidateSettingsCache(req);
  await Setting.findOneAndUpdate(
    { tenantId: req.tenantId, key: 'role_permissions' },
    {
      $set: { value: customMap, category: 'general', status: 'active', updatedBy: actor },
      $setOnInsert: { tenantId: req.tenantId, key: 'role_permissions', createdBy: actor }
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  await AuditService.log(req, {
    action: 'created',
    module: 'tenant_security',
    recordId: key,
    description: `Custom role created: ${name}`,
    metadata: { key, label: name, permissionsCount: permissions.length }
  });

  return getRolePermissionsMatrix(req);
}

/**
 * Deletes a custom role from the tenant workspace.
 * 
 * Usecase: Allows Tenant Admins to delete user-created custom roles.
 * 
 * @param {Object} req Express request object
 * @param {string} roleKey Custom role key to delete
 * @returns {Promise<Object>} Updated role permissions matrix
 */
async function deleteCustomRole(req, roleKey) {
  const Setting = getSettingModel(req);
  const actor = resolveUserId(req);
  const key = String(roleKey || '').trim();

  if (TENANT_ROLES.includes(key)) {
    throw appError('System standard roles cannot be deleted', 400);
  }

  const customRoles = await getCustomRoles(req);
  const filtered = customRoles.filter((r) => r.key !== key);
  if (filtered.length === customRoles.length) {
    throw appError('Custom role not found', 404);
  }

  require('./setting.service').invalidateSettingsCache(req);
  await Setting.findOneAndUpdate(
    { tenantId: req.tenantId, key: 'custom_created_roles' },
    { $set: { value: filtered, updatedBy: actor } }
  );

  const customMap = (await getCustomRolePermissionsMap(req)) || {};
  delete customMap[key];
  require('./setting.service').invalidateSettingsCache(req);
  await Setting.findOneAndUpdate(
    { tenantId: req.tenantId, key: 'role_permissions' },
    { $set: { value: customMap, updatedBy: actor } }
  );

  await AuditService.log(req, {
    action: 'deleted',
    module: 'tenant_security',
    recordId: key,
    description: `Custom role deleted: ${key}`
  });

  return getRolePermissionsMatrix(req);
}

async function resolvePermissionsForMembership(req) {
  // 1. OpenNext CMS SuperAdmin (0) & Admin (1) or explicit isAdmin / isSuperAdmin flags
  if (req?.user?.isAdmin || req?.user?.isSuperAdmin) {
    return [...CRM_MANIFEST_PERMISSIONS];
  }
  if (Array.isArray(req?.user?.roles) && (req.user.roles.includes('admin') || req.user.roles.includes('superadmin') || req.user.roles.includes('owner') || req.user.roles.includes('crm-manager'))) {
    return [...CRM_MANIFEST_PERMISSIONS];
  }
  const rawRole = req?.user?.role !== undefined ? req.user.role : req?.tenantMembership?.role;
  if (typeof rawRole === 'number' && rawRole <= 1) {
    return [...CRM_MANIFEST_PERMISSIONS];
  }
  const roleStr = String(rawRole || '').toLowerCase().trim();
  if (['admin', 'superadmin', 'tenant_admin', 'crm-manager', 'owner', '0', '1'].includes(roleStr)) {
    return [...CRM_MANIFEST_PERMISSIONS];
  }

  // 2. Client / Customer Portal User
  const { isClientUser, resolveClientIdAsync, resolveClientId } = require('../utils/tenant.util');
  const userClientId = req.resolvedClientId || resolveClientId(req) || (await resolveClientIdAsync(req));
  if (isClientUser(req) || userClientId) {
    const customMap = await getCustomRolePermissionsMap(req);
    const perms = resolveTenantRolePermissions('client', CRM_MANIFEST_PERMISSIONS, customMap);
    if (perms && perms.length > 0) return perms;
  }

  // 3. OpenNext CMS Custom Role & Plugin Page Access
  const cmsRolesMap = await fetchCmsRolesMap(req);
  if (typeof req?.user?.role === 'number' && cmsRolesMap.has(req.user.role)) {
    const roleDoc = cmsRolesMap.get(req.user.role);
    if (roleDoc?.pluginPageAccess && Array.isArray(roleDoc.pluginPageAccess)) {
      const entry = roleDoc.pluginPageAccess.find((p) => p.pluginId === 'openext-crm-suite' || p.pluginId === 'openext_crm_suite');
      if (entry) {
        let basePerms = Array.isArray(entry.permissions) && entry.permissions.length > 0
          ? entry.permissions.filter((p) => CRM_MANIFEST_PERMISSIONS.includes(p))
          : [...CRM_MANIFEST_PERMISSIONS];

        if (Array.isArray(entry.pages) && !entry.pages.some((p) => (typeof p === 'string' ? p : p?.id) === '*')) {
          const pageMap = new Map();
          for (const p of entry.pages) {
            if (typeof p === 'string' && p.trim()) {
              pageMap.set(p.trim(), '*');
            } else if (p && typeof p === 'object') {
              const pageId = p.id || p.pageId || p.page || p.name;
              if (pageId) {
                if (!p.features || !Array.isArray(p.features) || p.features.length === 0 || p.features.includes('*')) {
                  pageMap.set(pageId, '*');
                } else {
                  pageMap.set(pageId, p.features);
                }
              }
            }
          }

          const PERM_REQ = {
            'crm.dashboard.view': { pages: ['dashboard'], features: ['view-stats', 'view', 'list', '*'] },
            'crm.leads.read': { page: 'leads', features: ['list', 'view', '*'] },
            'crm.leads.write': { page: 'leads', features: ['create', 'edit', '*'] },
            'crm.leads.delete': { page: 'leads', features: ['delete', '*'] },
            'crm.leads.convert': { page: 'leads', features: ['convert', '*'] },
            'crm.leads.export': { page: 'leads', features: ['list', 'view', 'export', '*'] },
            'crm.leads.duplicate.override': { page: 'leads', features: ['qualify', 'create', 'edit', '*'] },
            'crm.contacts.read': { page: 'contacts', features: ['list', 'view', '*'] },
            'crm.contacts.write': { page: 'contacts', features: ['create', 'edit', '*'] },
            'crm.contacts.delete': { page: 'contacts', features: ['delete', '*'] },
            'crm.clients.read': { page: 'clients', features: ['list', 'view', '*'] },
            'crm.clients.write': { page: 'clients', features: ['create', 'edit', '*'] },
            'crm.clients.delete': { page: 'clients', features: ['delete', '*'] },
            'crm.clients.duplicate.override': { page: 'clients', features: ['create', 'edit', '*'] },
            'crm.dataQuality.read': { page: 'data-quality', features: ['view', 'list', 'manage', '*'] },
            'crm.dataQuality.manage': { page: 'data-quality', features: ['manage', '*'] },
            'crm.projects.read': { page: 'projects', features: ['list', 'view', '*'] },
            'crm.projects.write': { page: 'projects', features: ['create', 'edit', 'members', '*'] },
            'crm.projects.delete': { page: 'projects', features: ['delete', '*'] },
            'crm.tasks.read': { page: 'tasks', features: ['list', 'view', '*'] },
            'crm.tasks.write': { page: 'tasks', features: ['create', 'edit', 'comments', 'status', '*'] },
            'crm.tasks.delete': { page: 'tasks', features: ['delete', '*'] },
            'crm.time.read': { page: 'time-logs', features: ['list', 'view', '*'] },
            'crm.time.write': { page: 'time-logs', features: ['create', 'edit', '*'] },
            'crm.time.delete': { page: 'time-logs', features: ['delete', '*'] },
            'crm.expenses.read': { page: 'expenses', features: ['list', 'view', '*'] },
            'crm.expenses.write': { page: 'expenses', features: ['create', 'submit', 'edit', '*'] },
            'crm.expenses.delete': { page: 'expenses', features: ['reject', 'delete', '*'] },
            'crm.expenses.approve': { page: 'expenses', features: ['approve', '*'] },
            'crm.finance.read': { pages: ['quotations', 'invoices', 'payments'], features: ['list', 'view', '*'] },
            'crm.finance.write': { pages: ['quotations', 'invoices', 'payments'], features: ['create', 'edit', 'send', 'cancel', '*'] },
            'crm.finance.delete': { pages: ['quotations', 'payments', 'invoices'], features: ['delete', '*'] },
            'crm.contracts.read': { pages: ['quotations', 'invoices', 'payments'], features: ['list', 'view', '*'] },
            'crm.contracts.write': { pages: ['quotations', 'invoices', 'payments'], features: ['create', 'edit', 'send', '*'] },
            'crm.contracts.delete': { pages: ['quotations', 'invoices', 'payments'], features: ['delete', '*'] },
            'crm.quotes.write': { page: 'quotations', features: ['create', 'edit', 'send', '*'] },
            'crm.quotes.approveDiscount': { page: 'quotations', features: ['approve-discount', '*'] },
            'crm.orders.read': { page: 'sales-orders', features: ['list', 'view', '*'] },
            'crm.orders.write': { page: 'sales-orders', features: ['create', 'edit', 'dispatch', 'confirm-delivery', '*'] },
            'crm.orders.delete': { page: 'sales-orders', features: ['delete', '*'] },
            'crm.samples.read': { page: 'samples', features: ['list', 'view', '*'] },
            'crm.samples.write': { page: 'samples', features: ['create', 'edit', '*'] },
            'crm.samples.approve': { page: 'samples', features: ['approve', '*'] },
            'crm.samples.feedback': { page: 'samples', features: ['feedback', '*'] },
            'crm.samples.export': { page: 'samples', features: ['list', 'view', 'export', '*'] },
            'crm.opportunities.read': { page: 'opportunities', features: ['list', 'view', '*'] },
            'crm.opportunities.write': { page: 'opportunities', features: ['create', 'edit', 'convert', '*'] },
            'crm.opportunities.delete': { page: 'opportunities', features: ['delete', '*'] },
            'crm.opportunities.export': { page: 'opportunities', features: ['list', 'view', 'export', '*'] },
            'crm.tickets.read': { page: 'tickets', features: ['list', 'view', '*'] },
            'crm.tickets.write': { page: 'tickets', features: ['create', 'status', 'edit', '*'] },
            'crm.tickets.delete': { page: 'tickets', features: ['delete', '*'] },
            'crm.tickets.resolve': { page: 'tickets', features: ['resolve', '*'] },
            'crm.customerSuccess.read': { page: 'customer-success', features: ['view-summary', 'view-health', 'view', 'list', '*'] },
            'crm.customerSuccess.manage': { page: 'customer-success', features: ['submit-csat', 'manage', '*'] },
            'crm.marketing.read': { page: 'marketing', features: ['list', 'view', '*'] },
            'crm.marketing.write': { page: 'marketing', features: ['create', 'edit', 'execute', '*'] },
            'crm.marketing.delete': { page: 'marketing', features: ['delete', '*'] },
            'crm.analytics.read': { page: 'analytics-ai', features: ['view-dashboard', 'view-forecasting', 'view-behavior', 'view-demand', 'view', '*'] },
            'crm.ai.read': { page: 'analytics-ai', features: ['view-dashboard', 'view-forecasting', 'view-behavior', 'view-demand', 'view', '*'] },
            'crm.ai.write': { page: 'analytics-ai', features: ['apply-nba', 'execute', '*'] },
            'crm.reports.read': { page: 'reports', features: ['view', 'list', '*'] },
            'crm.reports.export': { page: 'reports', features: ['export', '*'] },
            'crm.audit.read': { page: 'audit', features: ['view', 'list', '*'] },
            'crm.settings.manage': { page: 'settings', features: ['manage', '*'] },
            'crm.users.manage': { page: 'security', features: ['manage', '*'] }
          };

          basePerms = basePerms.filter((perm) => {
            // Dashboard view is granted if dashboard or * is present, or if user has any CRM access
            if (perm === 'crm.dashboard.view') {
              if (pageMap.has('dashboard') || pageMap.has('*') || pageMap.size > 0) return true;
            }
            const reqPerm = PERM_REQ[perm];
            // Keep permissions that are not page-mapped (do not silently strip new keys)
            if (!reqPerm) return true;
            const allowedPages = reqPerm.pages || (reqPerm.page ? [reqPerm.page] : []);
            const matchingPage = allowedPages.find((p) => pageMap.has(p) || pageMap.has('*'));
            if (!matchingPage) return false;
            const pageFeatures = pageMap.get(matchingPage) || pageMap.get('*');
            if (pageFeatures === '*' || !Array.isArray(pageFeatures)) return true;
            const reqFeatures = reqPerm.features || (reqPerm.feature ? [reqPerm.feature] : []);
            if (reqFeatures.length === 0) return true;
            return reqFeatures.some((f) => pageFeatures.includes(f) || pageFeatures.includes('*'));
          });
        }

        // Always ensure crm.dashboard.view is present if the user has any CRM permissions
        if (basePerms.length > 0 && !basePerms.includes('crm.dashboard.view')) {
          basePerms.unshift('crm.dashboard.view');
        }

        return basePerms;
      }
    }
  }

  const role = req?.tenantMembership?.role !== undefined ? req.tenantMembership.role : req?.user?.role;
  const effectiveRole = (role !== null && role !== undefined) ? role : deriveTenantRole(req?.user, cmsRolesMap);
  const normalized = normalizeTenantRoleKey(effectiveRole);
  if (normalized === 'tenant_admin' || normalized === 'crm-manager' || normalized === 'superadmin' || normalized === 'admin') {
    return [...CRM_MANIFEST_PERMISSIONS];
  }
  const customMap = await getCustomRolePermissionsMap(req);
  const perms = resolveTenantRolePermissions(effectiveRole, CRM_MANIFEST_PERMISSIONS, customMap);
  if (perms && perms.length > 0) return perms;
  return [...CRM_MANIFEST_PERMISSIONS];
}

async function listTenantRolesAll(req) {
  const matrix = await getRolePermissionsMatrix(req);
  return matrix.roles.map((r) => ({
    id: r.key || r.id,
    key: r.key || r.id,
    name: r.label || r.name,
    label: r.label || r.name,
    description: r.description || '',
    isCustom: Boolean(r.isCustom),
    permissions: r.permissions || []
  }));
}

async function exportMembers(req, query = {}) {
  const result = await listMembers(req);
  let items = result.items || [];

  if (query.role) {
    const r = String(query.role).trim().toLowerCase();
    items = items.filter((m) => (m.role || '').toLowerCase() === r);
  }
  if (query.status) {
    const s = String(query.status).trim().toLowerCase();
    items = items.filter((m) => (m.status || '').toLowerCase() === s);
  }
  if (query.search) {
    const s = String(query.search).trim().toLowerCase();
    items = items.filter(
      (m) =>
        (m.username || '').toLowerCase().includes(s) ||
        (m.email || '').toLowerCase().includes(s) ||
        (m.role || '').toLowerCase().includes(s)
    );
  }

  const format = String(query.format || 'csv').trim().toLowerCase();
  const nowStr = new Date().toISOString().slice(0, 10);

  await AuditService.log(req, {
    action: 'exported',
    module: 'tenant_security',
    recordId: 'export',
    description: `Exported ${items.length} tenant members in ${format.toUpperCase()} format`
  });

  if (format === 'json') {
    return {
      contentType: 'application/json; charset=utf-8',
      format: 'json',
      filename: `tenant_members_export_${nowStr}.json`,
      content: JSON.stringify(items, null, 2),
      data: items,
      count: items.length
    };
  }

  const escapeCsv = (str) => {
    if (str === null || str === undefined) return '""';
    const s = String(str).replace(/"/g, '""');
    return `"${s}"`;
  };

  const headers = [
    'User ID',
    'Username / Name',
    'Email Address',
    'CRM Role',
    'Status',
    'Created At'
  ];

  const rows = [headers.map(escapeCsv).join(',')];

  for (const m of items) {
    rows.push(
      [
        m.userId || m._id || '',
        m.username || m.name || '',
        m.email || '',
        m.role || m.roleName || '',
        m.status || 'active',
        m.createdAt ? new Date(m.createdAt).toISOString() : ''
      ]
        .map(escapeCsv)
        .join(',')
    );
  }

  const csvContent = rows.join('\r\n');

  return {
    contentType: 'text/csv; charset=utf-8',
    format: 'csv',
    filename: `tenant_members_export_${nowStr}.csv`,
    content: csvContent,
    data: csvContent,
    count: items.length
  };
}

module.exports = {
  DEFAULT_TENANT_ID,
  normalizeTenantId,
  trustedTenantHint,
  attachTenantContext,
  getContext,
  listMembers,
  listCandidates,
  listAssignableMembers,
  listRoles: listTenantRolesAll,
  listTenantRolesAll,
  addMember,
  updateMember,
  getRolePermissionsMatrix,
  updateRolePermissions,
  createCustomRole,
  deleteCustomRole,
  resolvePermissionsForMembership,
  exportMembers
};
