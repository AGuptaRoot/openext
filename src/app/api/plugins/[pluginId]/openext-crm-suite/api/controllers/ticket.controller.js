'use strict';

const TicketService = require('../services/ticket.service');
const CustomerFeedbackService = require('../services/customer-feedback.service');

/**
 * Endpoint: GET /tickets
 */
async function list(req, res, next) {
  try {
    const data = await TicketService.list(req);
    res.json({ success: true, ...data });
  } catch (error) {
    next(error);
  }
}

/**
 * Endpoint: GET /tickets/:id
 */
async function getById(req, res, next) {
  try {
    const data = await TicketService.getById(req, req.params.id);
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
}

/**
 * Endpoint: POST /tickets
 */
async function create(req, res, next) {
  try {
    const data = await TicketService.create(req, req.body);
    res.status(201).json({ success: true, data, message: 'Ticket created successfully' });
  } catch (error) {
    next(error);
  }
}

/**
 * Endpoint: POST /tickets/:id/status
 */
async function updateStatus(req, res, next) {
  try {
    const data = await TicketService.updateStatus(req, req.params.id, req.body);
    res.json({ success: true, data, message: 'Ticket status updated' });
  } catch (error) {
    next(error);
  }
}

/**
 * Endpoint: POST /tickets/:id/resolve
 */
async function resolveTicket(req, res, next) {
  try {
    const data = await TicketService.resolveTicket(req, req.params.id, req.body);
    res.json({ success: true, data, message: 'Ticket resolved successfully' });
  } catch (error) {
    next(error);
  }
}

/**
 * Endpoint: DELETE /tickets/:id
 */
async function remove(req, res, next) {
  try {
    const data = await TicketService.remove(req, req.params.id);
    res.json({ success: true, ...data });
  } catch (error) {
    next(error);
  }
}

/**
 * Endpoint: GET /tickets/feedback/reviews
 */
async function listFeedback(req, res, next) {
  try {
    const data = await CustomerFeedbackService.list(req);
    res.json({ success: true, ...data });
  } catch (error) {
    next(error);
  }
}

/**
 * Endpoint: POST /tickets/feedback/reviews
 */
async function createFeedback(req, res, next) {
  try {
    const data = await CustomerFeedbackService.create(req, req.body);
    res.status(201).json({ success: true, data, message: 'Feedback submitted successfully' });
  } catch (error) {
    next(error);
  }
}

/**
 * Endpoint: GET /tickets/feedback/summary
 */
async function getFeedbackSummary(req, res, next) {
  try {
    const data = await CustomerFeedbackService.getSummary(req);
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
}

async function exportTickets(req, res, next) {
  try {
    const result = await TicketService.exportTickets(req, req.query || {});
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
    res.setHeader('Content-Type', result.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
    if (result.contentType.includes('json')) {
      res.status(200).send(result.content);
    } else {
      res.status(200).send(result.content);
    }
  } catch (error) {
    next(error);
  }
}

async function addMessage(req, res, next) {
  try {
    const data = await TicketService.addMessage(req, req.params.id, req.body);
    res.status(201).json({ success: true, data, message: 'Message posted successfully' });
  } catch (error) {
    next(error);
  }
}

async function listMessages(req, res, next) {
  try {
    const data = await TicketService.listMessages(req, req.params.id);
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
}

async function getCannedResponses(req, res, next) {
  try {
    const data = await TicketService.getCannedResponses(req);
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
}

async function createCannedResponse(req, res, next) {
  try {
    const data = await TicketService.createCannedResponse(req, req.body);
    res.status(201).json({ success: true, data, message: 'Canned response created' });
  } catch (error) {
    next(error);
  }
}

async function deleteCannedResponse(req, res, next) {
  try {
    const data = await TicketService.deleteCannedResponse(req, req.params.id);
    res.json({ success: true, ...data });
  } catch (error) {
    next(error);
  }
}

async function addWatcher(req, res, next) {
  try {
    const data = await TicketService.addWatcher(req, req.params.id, req.body);
    res.json({ success: true, data, message: 'Watcher added' });
  } catch (error) {
    next(error);
  }
}

async function removeWatcher(req, res, next) {
  try {
    const data = await TicketService.removeWatcher(req, req.params.id, req.body);
    res.json({ success: true, data, message: 'Watcher removed' });
  } catch (error) {
    next(error);
  }
}

async function reassign(req, res, next) {
  try {
    const data = await TicketService.reassign(req, req.params.id, req.body);
    res.json({ success: true, data, message: 'Ticket reassigned successfully' });
  } catch (error) {
    next(error);
  }
}

async function escalate(req, res, next) {
  try {
    const data = await TicketService.escalate(req, req.params.id, req.body);
    res.json({ success: true, data, message: 'Ticket escalated successfully' });
  } catch (error) {
    next(error);
  }
}

async function archiveTicket(req, res, next) {
  try {
    const data = await TicketService.archiveTicket(req, req.params.id, req.body);
    res.json({ success: true, ...data });
  } catch (error) {
    next(error);
  }
}

async function restoreTicket(req, res, next) {
  try {
    const data = await TicketService.restoreTicket(req, req.params.id);
    res.json({ success: true, ...data });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  list,
  exportTickets,
  getById,
  create,
  updateStatus,
  resolveTicket,
  remove,
  listFeedback,
  createFeedback,
  getFeedbackSummary,
  addMessage,
  listMessages,
  getCannedResponses,
  createCannedResponse,
  deleteCannedResponse,
  addWatcher,
  removeWatcher,
  reassign,
  escalate,
  archiveTicket,
  restoreTicket
};
