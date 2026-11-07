'use strict';

const path = require('path');
const fs = require('fs');

/**
 * Resolves a controller file safely on physical disk or via Node require.
 * Handles Next.js Webpack bundle environment where __dirname is overridden to .next/server/chunks.
 */
function requireController(controllerName) {
  const nameClean = controllerName.replace(/\.js$/, '');
  const filename = `${nameClean}.js`;

  // 1. Try standard relative require
  try {
    return require(`../controllers/${nameClean}`);
  } catch (err1) {
    // 2. Fall back to native Node require on physical disk bypassing Webpack
    const candidatePaths = [
      path.resolve(__dirname, '../controllers', filename),
      path.resolve(process.cwd(), 'api/controllers', filename),
      path.resolve(process.cwd(), 'plugin-packages/crm-plugin/api/controllers', filename),
      `C:/Users/AdarshGupta/Documents/plugin-packages/OpenNext crm/openext-crm-suite/api/controllers/${filename}`
    ];

    for (const fullPath of candidatePaths) {
      if (fs.existsSync(fullPath)) {
        try {
          return eval('require')(fullPath);
        } catch (e) {
          // Continue trying next path
        }
      }
    }
    throw err1;
  }
}

module.exports = {
  requireController
};
