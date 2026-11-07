let mongoose = null;
try {
  mongoose = require('mongoose');
} catch {
  mongoose = {
    Schema: class {
      static Types = { ObjectId: String, Mixed: Object };
    },
    Types: {
      ObjectId: {
        isValid: (v) => typeof v === 'string' && /^[0-9a-fA-F]{24}$/.test(v)
      }
    }
  };
}
const { toLiteralSearchTerm } = require('./search.util');

const USER_COLLECTION = 'users';

/**
 * Resolve CMS User records for audit display.
 * Uses the shared user DB connection (core User collection).
 */
async function getUserDb(req) {
  return req.cms?.database?.user?.() || null;
}

function getUserModel(conn) {
  if (!conn) return null;
  if (conn.models?.User) return conn.models.User;

  const UserSchema = new mongoose.Schema(
    {
      username: { type: String },
      displayName: { type: String },
      email: { type: String },
      tenantId: { type: String },
      active: { type: Boolean },
      // OpenNext CMS role codes (e.g. 102 = Sales Representative plugin role)
      role: { type: mongoose.Schema.Types.Mixed },
      roles: { type: [mongoose.Schema.Types.Mixed], default: undefined },
      userType: { type: mongoose.Schema.Types.Mixed }
    },
    { collection: USER_COLLECTION, strict: false }
  );

  return conn.model('User', UserSchema);
}

function formatUserLabel(user) {
  if (!user) return null;
  return user.username || user.displayName || user.email || null;
}

async function findCmsUserById(req, userId) {
  const id = String(userId || '').trim();
  if (!id) return null;

  try {
    const conn = await getUserDb(req);
    if (!conn) return null;
    const candidates = [id];
    if (mongoose.Types.ObjectId.isValid(id)) candidates.push(new mongoose.Types.ObjectId(id));

    if (conn.db) {
      return conn.db.collection(USER_COLLECTION).findOne(
        { _id: { $in: candidates } },
        { projection: { username: 1, displayName: 1, email: 1, tenantId: 1, active: 1 } }
      );
    }

    const User = getUserModel(conn);
    return User.findOne({ _id: { $in: candidates } })
      .select('username displayName email tenantId active')
      .lean();
  } catch {
    return null;
  }
}

function toObjectIds(ids) {
  const objectIds = [];
  const strings = [];

  for (const id of ids || []) {
    const value = String(id || '').trim();
    if (!value || value === 'system') continue;

    if (mongoose?.Types?.ObjectId?.isValid?.(value)) {
      try {
        if (typeof mongoose.Types.ObjectId === 'function') {
          objectIds.push(new mongoose.Types.ObjectId(value));
        } else {
          objectIds.push(value);
        }
      } catch {
        objectIds.push(value);
      }
    }
    strings.push(value);
  }

  return { objectIds, strings: [...new Set(strings)] };
}

function applyJwtUserHint(req, labels) {
  const user = req?.user;
  if (!user) return labels;

  const { resolveUserId } = require('./tenant.util');
  const userId = resolveUserId(req);
  if (!userId || userId === 'system') return labels;

  const jwtUsername = user.username || user.name || user.email || null;
  if (jwtUsername) {
    labels[userId] = String(jwtUsername);
  }

  return labels;
}

/**
 * Batch-resolve userId → username for audit lists.
 * @returns {Promise<Record<string, string>>}
 */
async function resolveUsernames(req, userIds) {
  const labels = applyJwtUserHint(req, { system: 'System' });
  const { objectIds, strings } = toObjectIds(userIds);

  if (!strings.length) return labels;

  try {
    const conn = await getUserDb(req);
    if (!conn) {
      strings.forEach((id) => {
        if (!labels[id]) labels[id] = id;
      });
      return labels;
    }

    let users = [];

    if (objectIds.length) {
      const User = getUserModel(conn);
      users = await User.find({ _id: { $in: objectIds } })
        .select('username displayName email')
        .lean();
    }

    if (!users.length && objectIds.length) {
      const col = conn.db?.collection(USER_COLLECTION) || (typeof conn.collection === 'function' ? conn.collection(USER_COLLECTION) : null);
      if (col && typeof col.find === 'function') {
        users = await col
          .find({ _id: { $in: objectIds } })
          .project({ username: 1, displayName: 1, email: 1 })
          .toArray();
      }
    }

    for (const user of users) {
      const id = String(user._id);
      labels[id] = formatUserLabel(user) || id;
    }

    for (const id of strings) {
      if (!labels[id]) labels[id] = id;
    }
  } catch (error) {
    req?.cms?.logger?.warn?.('Failed to resolve audit usernames:', error?.message || error);
    strings.forEach((id) => {
      if (!labels[id]) labels[id] = id;
    });
  }

  return labels;
}

async function resolveUsername(req, userId) {
  const id = String(userId || '').trim();
  if (!id) return 'Unknown';
  if (id === 'system') return 'System';

  const map = await resolveUsernames(req, [id]);
  return map[id] || id;
}

/** Attach username to each audit row for API responses */
async function enrichAuditUsers(req, items) {
  if (!Array.isArray(items) || !items.length) return items || [];

  const nameMap = await resolveUsernames(
    req,
    items.map((item) => item.userId)
  );

  return items.map((item) => {
    const userId = String(item.userId || '');
    const storedUsername = item.metadata?.username ? String(item.metadata.username) : null;

    return {
      ...item,
      username: storedUsername || nameMap[userId] || userId || 'Unknown'
    };
  });
}

/** Find CMS user IDs matching a search term (username, display name, email) */
async function findUserIdsBySearchTerm(req, term) {
  const value = toLiteralSearchTerm(term);
  if (!value) return [];

  try {
    const conn = await getUserDb(req);
    if (!conn) return [];

    const User = getUserModel(conn);
    const filter = {
      $or: [
        { username: { $regex: value, $options: 'i' } },
        { displayName: { $regex: value, $options: 'i' } },
        { email: { $regex: value, $options: 'i' } }
      ]
    };

    let users = [];
    if (User && typeof User.find === 'function') {
      users = await User.find(filter).select('_id').limit(50).lean();
    }

    if (!users.length) {
      const col = conn.db?.collection(USER_COLLECTION) || (typeof conn.collection === 'function' ? conn.collection(USER_COLLECTION) : null);
      if (col && typeof col.find === 'function') {
        users = await col
          .find(filter)
          .project({ _id: 1 })
          .limit(50)
          .toArray();
      }
    }

    return users.map((user) => String(user._id));
  } catch {
    return [];
  }
}

/** List CMS users for lead/opportunity assignment dropdowns. */
async function listAssignableUsers(req, search = '') {
  const limit = 100;
  const term = toLiteralSearchTerm(search);

  try {
    const conn = await getUserDb(req);
    if (!conn) return [];

    const User = getUserModel(conn);
    const filter = term
      ? {
          $and: [
            { active: { $ne: false } },
            { $or: [
              { username: { $regex: term, $options: 'i' } },
              { displayName: { $regex: term, $options: 'i' } },
              { email: { $regex: term, $options: 'i' } }
            ] }
          ]
        }
      : { active: { $ne: false } };

    const projection = {
      username: 1,
      displayName: 1,
      email: 1,
      role: 1,
      roles: 1,
      userType: 1,
      tenantId: 1,
      active: 1
    };

    let users = [];
    // Prefer raw collection so OpenNext role fields are never stripped by a stale model schema.
    const col = conn.db?.collection(USER_COLLECTION) || (typeof conn.collection === 'function' ? conn.collection(USER_COLLECTION) : null);
    if (col && typeof col.find === 'function') {
      users = await col
        .find(filter)
        .project(projection)
        .sort({ username: 1, displayName: 1 })
        .limit(limit)
        .toArray();
    }

    if (!users.length && User && typeof User.find === 'function') {
      users = await User.find(filter)
        .select('username displayName email role roles userType tenantId active')
        .sort({ username: 1, displayName: 1 })
        .limit(limit)
        .lean();
    }

    const uids = users.map((u) => String(u._id || u.id));
    const designationMap = await resolveUserDesignations(req, uids);
    const { normalizeTenantRoleKey } = require('./tenant-role.util');

    return users
      .filter((u) => {
        const uid = String(u._id || u.id);
        const membershipRole = designationMap[uid]?.role || '';
        const cmsRole = u.role ?? (Array.isArray(u.roles) ? u.roles[0] : '') ?? u.userType ?? '';
        const role = String(membershipRole || cmsRole || '').toLowerCase();
        const isClient = Boolean(
          u.isClient ||
            u.isClientUser ||
            u.clientId ||
            role === 'client' ||
            role.includes('client') ||
            role.includes('customer') ||
            role.includes('portal')
        );
        return !isClient;
      })
      .map((u) => {
        const uid = String(u._id || u.id);
        const username = u.username || u.displayName || u.email || 'User';
        const designation = designationMap[uid]?.designation || '';
        const membershipRole = designationMap[uid]?.role || '';
        const cmsRoleRaw = u.role ?? (Array.isArray(u.roles) ? u.roles[0] : '') ?? u.userType ?? '';
        // Prefer CRM membership role; otherwise normalize OpenNext CMS role (e.g. 102 → sales-representative)
        const role = membershipRole || normalizeTenantRoleKey(cmsRoleRaw) || String(cmsRoleRaw || '');
        const displayName = designation ? `${username} (${designation})` : username;
        return {
          id: uid,
          _id: uid,
          userId: uid,
          username,
          name: username,
          designation,
          role,
          cmsRole: cmsRoleRaw,
          displayName,
          email: u.email || ''
        };
      });
  } catch {
    return [];
  }
}

/**
 * Batch resolve designations & tenant roles from TenantMembership
 */
async function resolveUserDesignations(req, userIds) {
  const map = {};
  if (!Array.isArray(userIds) || !userIds.length) return map;
  const Membership = req.cms?.models?.get?.('TenantMembership');
  if (!Membership) return map;

  try {
    const { resolveTenantId } = require('./tenant.util');
    const tenantId = resolveTenantId(req);
    const validIds = userIds.map(String).filter(Boolean);
    if (!validIds.length) return map;

    const rows = await Membership.find({
      tenantId,
      userId: { $in: validIds },
      status: 'active'
    })
      .select('userId designation role')
      .lean();

    for (const row of rows) {
      map[String(row.userId)] = {
        designation: row.designation || '',
        role: row.role || ''
      };
    }
  } catch (err) {
    req?.cms?.logger?.warn?.('Failed to resolve user designations:', err.message);
  }

  return map;
}

/** Helper to enrich lead assignees with user details */
async function enrichLeadAssignee(req, leads) {
  if (!leads) return leads;
  const isArray = Array.isArray(leads);
  const items = isArray ? leads : [leads];

  const assigneeIds = items.map((l) => l.assignedTo).filter(Boolean);
  if (!assigneeIds.length) return leads;

  const userMap = await resolveUsernames(req, assigneeIds);
  const designationMap = await resolveUserDesignations(req, assigneeIds);
  const enriched = items.map((lead) => {
    const name = lead.assignedTo ? userMap[lead.assignedTo] || lead.assignedTo : '';
    const desig = lead.assignedTo ? designationMap[lead.assignedTo]?.designation || '' : '';
    return {
      ...lead,
      assignedToName: name,
      assignedToDesignation: desig,
      assignedToLabel: desig ? `${name} (${desig})` : name
    };
  });

  return isArray ? enriched : enriched[0];
}

const enrichLeadAssignees = enrichLeadAssignee;

module.exports = {
  findCmsUserById,
  resolveUsernames,
  resolveUsername,
  resolveUserDesignations,
  enrichAuditUsers,
  enrichLeadAssignee,
  enrichLeadAssignees,
  findUserIdsBySearchTerm,
  listAssignableUsers
};
