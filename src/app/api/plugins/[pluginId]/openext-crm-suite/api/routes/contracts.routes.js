'use strict';

const ContractService = require('../services/contract.service');
const { requireAnyPermission } = require('../middleware/permission.middleware');

function sendError(res, error) {
  const status = error.status || 500;
  res.status(status).json({ success: false, error: error.message });
}

module.exports = function (app) {
  /**
   * Contracts & Agreements Routes
   */
  app.get('/contracts', requireAnyPermission('crm.leads.read', 'crm.clients.read'), async (req, res) => {
    try {
      const result = await ContractService.list(req);
      res.json({ success: true, data: result.items, pagination: result.pagination, message: 'Contracts loaded' });
    } catch (err) {
      sendError(res, err);
    }
  });

  app.get('/contracts/:id', requireAnyPermission('crm.leads.read', 'crm.clients.read'), async (req, res) => {
    try {
      const data = await ContractService.getById(req, req.params.id);
      res.json({ success: true, data, message: 'Contract loaded' });
    } catch (err) {
      sendError(res, err);
    }
  });

  app.post('/contracts', requireAnyPermission('crm.leads.write', 'crm.clients.write'), async (req, res) => {
    try {
      const data = await ContractService.create(req, req.body);
      res.status(201).json({ success: true, data, message: 'Contract created' });
    } catch (err) {
      sendError(res, err);
    }
  });

  app.post('/contracts/from-lead/:leadId', requireAnyPermission('crm.leads.write', 'crm.clients.write'), async (req, res) => {
    try {
      const data = await ContractService.createFromLead(req, req.params.leadId, req.body);
      res.status(201).json({ success: true, data, message: 'Contract drafted from lead' });
    } catch (err) {
      sendError(res, err);
    }
  });

  app.put('/contracts/:id', requireAnyPermission('crm.leads.write', 'crm.clients.write'), async (req, res) => {
    try {
      const data = await ContractService.update(req, req.params.id, req.body);
      res.json({ success: true, data, message: 'Contract updated' });
    } catch (err) {
      sendError(res, err);
    }
  });

  app.post('/contracts/:id/status', requireAnyPermission('crm.leads.write', 'crm.clients.write'), async (req, res) => {
    try {
      const data = await ContractService.changeStatus(req, req.params.id, req.body.status, req.body.notes);
      res.json({ success: true, data, message: 'Contract status updated' });
    } catch (err) {
      sendError(res, err);
    }
  });

  app.post('/contracts/:id/sign', requireAnyPermission('crm.leads.write', 'crm.clients.write'), async (req, res) => {
    try {
      const data = await ContractService.sign(req, req.params.id, req.body);
      res.json({ success: true, data, message: 'Contract signed electronically' });
    } catch (err) {
      sendError(res, err);
    }
  });

  app.delete('/contracts/:id', requireAnyPermission('crm.leads.delete', 'crm.clients.delete'), async (req, res) => {
    try {
      const result = await ContractService.remove(req, req.params.id);
      res.json({ success: true, data: result, message: 'Contract deleted' });
    } catch (err) {
      sendError(res, err);
    }
  });
};
