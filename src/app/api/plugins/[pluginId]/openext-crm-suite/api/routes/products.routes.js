'use strict';

const ProductService = require('../services/product.service');
const { requirePermission } = require('../middleware/permission.middleware');

function sendError(res, error) {
  const status = error.status || 500;
  res.status(status).json({ success: false, error: error.message });
}

module.exports = function (app) {
  /**
   * Product Catalogue Routes
   */
  app.get('/products', requirePermission('crm.leads.read'), async (req, res) => {
    try {
      const result = await ProductService.list(req);
      res.json({ success: true, data: result.items, pagination: result.pagination, message: 'Products loaded' });
    } catch (err) {
      sendError(res, err);
    }
  });

  app.get('/products/categories', requirePermission('crm.leads.read'), async (req, res) => {
    try {
      const data = await ProductService.getCategories(req);
      res.json({ success: true, data, message: 'Categories loaded' });
    } catch (err) {
      sendError(res, err);
    }
  });

  app.get('/products/:id', requirePermission('crm.leads.read'), async (req, res) => {
    try {
      const data = await ProductService.getById(req, req.params.id);
      res.json({ success: true, data, message: 'Product loaded' });
    } catch (err) {
      sendError(res, err);
    }
  });

  app.post('/products', requirePermission('crm.leads.write'), async (req, res) => {
    try {
      const data = await ProductService.create(req, req.body);
      res.status(201).json({ success: true, data, message: 'Product created' });
    } catch (err) {
      sendError(res, err);
    }
  });

  app.put('/products/:id', requirePermission('crm.leads.write'), async (req, res) => {
    try {
      const data = await ProductService.update(req, req.params.id, req.body);
      res.json({ success: true, data, message: 'Product updated' });
    } catch (err) {
      sendError(res, err);
    }
  });

  app.delete('/products/:id', requirePermission('crm.leads.delete'), async (req, res) => {
    try {
      const result = await ProductService.remove(req, req.params.id);
      res.json({ success: true, data: result, message: 'Product deleted' });
    } catch (err) {
      sendError(res, err);
    }
  });
};
