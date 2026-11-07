/**
 * Plugin roles for S3 Media (single-page plugin).
 */
module.exports = {
  pages: [
    {
      id: 'media',
      label: 'Media',
      features: ['browse', 'upload', 'delete', 'configure'],
    },
  ],
  roles: [
    {
      id: 's3-viewer',
      name: 'S3 Viewer',
      baseRole: 3,
      permissions: ['s3.read'],
      pages: [{ id: 'media', features: ['browse'] }],
    },
    {
      id: 's3-uploader',
      name: 'S3 Uploader',
      baseRole: 3,
      permissions: ['s3.read', 's3.write'],
      pages: [{ id: 'media', features: ['browse', 'upload'] }],
    },
  ],
};
