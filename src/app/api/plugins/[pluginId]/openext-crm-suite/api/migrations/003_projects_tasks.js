'use strict';

const COLLECTIONS = {
  projects: 'plugin_openext_crm_suite_projects',
  projectMembers: 'plugin_openext_crm_suite_project_members',
  tasks: 'plugin_openext_crm_suite_tasks',
  taskComments: 'plugin_openext_crm_suite_task_comments'
};

async function ensureCollection(db, name) {
  const existing = await db.listCollections({ name }).toArray();
  if (existing.length === 0) {
    await db.createCollection(name);
  }
  return db.collection(name);
}

module.exports = {
  name: '003_projects_tasks',

  async up(cms) {
    const connection = await cms.database.user();
    if (!connection.db) {
      throw new Error('userDB connection is unavailable');
    }

    const db = connection.db;

    const projects = await ensureCollection(db, COLLECTIONS.projects);
    await projects.createIndex({ tenantId: 1, clientId: 1 }, { name: 'projects_tenant_client' });
    await projects.createIndex({ tenantId: 1, status: 1 }, { name: 'projects_tenant_status' });
    await projects.createIndex({ tenantId: 1, assignedTo: 1 }, { name: 'projects_tenant_assigned' });
    await projects.createIndex({ tenantId: 1, createdAt: -1 }, { name: 'projects_tenant_created' });

    const members = await ensureCollection(db, COLLECTIONS.projectMembers);
    await members.createIndex(
      { tenantId: 1, projectId: 1, userId: 1 },
      { unique: true, name: 'project_members_unique' }
    );

    const tasks = await ensureCollection(db, COLLECTIONS.tasks);
    await tasks.createIndex({ tenantId: 1, projectId: 1 }, { name: 'tasks_tenant_project' });
    await tasks.createIndex({ tenantId: 1, assignedTo: 1 }, { name: 'tasks_tenant_assigned' });
    await tasks.createIndex({ tenantId: 1, dueDate: 1 }, { name: 'tasks_tenant_due' });
    await tasks.createIndex({ tenantId: 1, status: 1 }, { name: 'tasks_tenant_status' });

    const comments = await ensureCollection(db, COLLECTIONS.taskComments);
    await comments.createIndex(
      { tenantId: 1, taskId: 1, createdAt: -1 },
      { name: 'task_comments_task' }
    );

    cms.logger.info('Migration 003: projects and tasks collections ready');
  },

  async down(cms) {
    const connection = await cms.database.user();
    if (!connection.db) return;

    for (const name of Object.values(COLLECTIONS)) {
      const existing = await connection.db.listCollections({ name }).toArray();
      if (existing.length > 0) {
        await connection.db.dropCollection(name);
      }
    }
  }
};
