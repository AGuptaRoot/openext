const S3Service = require('../services/S3Service');
const { canAccess } = require('../utils/permissions');

module.exports = (app) => {
  app.get('/media', async (req, res) => {
    if (!canAccess(req, 's3.read')) {
      return res.status(403).json({ message: 'Missing permission: s3.read' });
    }

    try {
      const imagesOnly = String(req.query.imagesOnly || 'true') !== 'false';
      const media = imagesOnly
        ? await S3Service.listImages(req.cms, req.query.limit)
        : await S3Service.listObjects(req.cms, req.query.limit, { imagesOnly: false });
      res.json({ media, storage: 's3' });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to list objects from S3';
      res.status(500).json({ message });
    }
  });

  app.get('/media/:encodedKey/file', async (req, res) => {
    if (!canAccess(req, 's3.read')) {
      return res.status(403).json({ message: 'Missing permission: s3.read' });
    }

    let s3Key;
    try {
      s3Key = S3Service.decodeObjectKey(req.params.encodedKey);
    } catch {
      return res.status(400).json({ message: 'Invalid object key' });
    }

    try {
      const object = await S3Service.fetchObject(req.cms, s3Key);
      res.setHeader('content-type', object.contentType);
      res.setHeader('cache-control', 'private, max-age=300');
      res.send(object.buffer);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to fetch object from S3';
      res.status(500).json({ message });
    }
  });

  /**
   * Upload any file to Amazon S3.
   * Requires configured credentials — never writes to local disk.
   */
  app.post('/media/upload', async (req, res) => {
    if (!canAccess(req, 's3.write')) {
      return res.status(403).json({ message: 'Missing permission: s3.write' });
    }

    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const file = body.file;
    const folder = typeof body.folder === 'string' ? body.folder : undefined;
    const imagesOnly = String(body.imagesOnly || '') === 'true';

    const validationError = imagesOnly
      ? S3Service.validateImageFile(file)
      : S3Service.validateUploadFile(file);

    if (validationError) {
      return res.status(400).json({ message: validationError });
    }

    try {
      const uploaded = imagesOnly
        ? await S3Service.uploadImage(req.cms, file, { folder })
        : await S3Service.uploadFile(req.cms, file, { folder });

      res.status(201).json({
        success: true,
        asset: uploaded,
        url: uploaded.url,
        filePath: uploaded.filePath || uploaded.url,
        viewUrl: uploaded.viewUrl,
        storage: 's3',
        s3Key: uploaded.key,
        message: 'File stored in Amazon S3',
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Upload to S3 failed';
      res.status(500).json({ message });
    }
  });

  /**
   * Upload raw buffer / base64 payload to S3 (JSON body).
   * Body: { dataBase64, contentType?, fileName?, folder? }
   */
  app.post('/media/upload-buffer', async (req, res) => {
    if (!canAccess(req, 's3.write')) {
      return res.status(403).json({ message: 'Missing permission: s3.write' });
    }

    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const dataBase64 = typeof body.dataBase64 === 'string' ? body.dataBase64 : '';

    if (!dataBase64) {
      return res.status(400).json({ message: 'dataBase64 is required' });
    }

    try {
      const buffer = Buffer.from(dataBase64, 'base64');
      const uploaded = await S3Service.uploadBuffer(req.cms, {
        buffer,
        contentType: body.contentType,
        fileName: body.fileName,
        folder: body.folder,
      });

      res.status(201).json({
        success: true,
        asset: uploaded,
        url: uploaded.url,
        filePath: uploaded.filePath || uploaded.url,
        viewUrl: uploaded.viewUrl,
        storage: 's3',
        s3Key: uploaded.key,
        message: 'Data stored in Amazon S3',
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Upload to S3 failed';
      res.status(500).json({ message });
    }
  });

  app.delete('/media/:encodedKey', async (req, res) => {
    if (!canAccess(req, 's3.write')) {
      return res.status(403).json({ message: 'Missing permission: s3.write' });
    }

    let s3Key;
    try {
      s3Key = S3Service.decodeObjectKey(req.params.encodedKey);
    } catch {
      return res.status(400).json({ message: 'Invalid object key' });
    }

    try {
      await S3Service.deleteObject(req.cms, s3Key);
      res.json({ message: 'Object deleted from S3', key: s3Key, storage: 's3' });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to delete from S3';
      res.status(500).json({ message });
    }
  });
};
