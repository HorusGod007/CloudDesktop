const express = require('express');
const authenticate = require('../middleware/authenticate');
const { generateWsTicket } = require('../auth');

const router = express.Router();
router.use(authenticate);

// POST /api/terminal/ticket — get a short-lived WebSocket ticket for terminal
router.post('/ticket', (req, res) => {
  const ticket = generateWsTicket(req.user.sub);
  res.json({ ticket });
});

module.exports = router;
