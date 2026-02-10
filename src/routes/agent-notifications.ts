import { Router, Request, Response } from 'express';

const router = Router();

interface Notification {
  id: string;
  agentId: string;
  type: 'alert' | 'info' | 'warning' | 'billing' | 'system';
  title: string;
  message: string;
  read: boolean;
  createdAt: string;
}

const notifications: Map<string, Notification[]> = new Map();

// POST /api/notifications - Create notification for an agent
router.post('/', (req: Request, res: Response) => {
  const { agentId, type, title, message } = req.body;
  if (!agentId || !title || !message) {
    return res.status(400).json({ error: 'agentId, title, and message required' });
  }
  const notif: Notification = {
    id: `notif_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    agentId,
    type: type || 'info',
    title,
    message,
    read: false,
    createdAt: new Date().toISOString()
  };
  const existing = notifications.get(agentId) || [];
  existing.push(notif);
  notifications.set(agentId, existing);
  res.status(201).json({ notification: notif });
});

// GET /api/notifications/:agentId - Get notifications for an agent
router.get('/:agentId', (req: Request, res: Response) => {
  const agentId = String(req.params.agentId);
  const unreadOnly = String(req.query.unread) === 'true';
  const all = notifications.get(agentId) || [];
  const filtered = unreadOnly ? all.filter(n => !n.read) : all;
  res.json({
    agentId,
    total: all.length,
    unread: all.filter(n => !n.read).length,
    notifications: filtered.slice(-50)
  });
});

// PATCH /api/notifications/:id/read - Mark notification as read
router.patch('/:id/read', (req: Request, res: Response) => {
  for (const [, notifs] of notifications) {
    const notif = notifs.find(n => n.id === String(req.params.id));
    if (notif) {
      notif.read = true;
      return res.json({ notification: notif });
    }
  }
  res.status(404).json({ error: 'Notification not found' });
});

// POST /api/notifications/:agentId/broadcast - Send to multiple agents
router.post('/:agentId/broadcast', (req: Request, res: Response) => {
  const { agentIds, type, title, message } = req.body;
  if (!agentIds?.length || !title || !message) {
    return res.status(400).json({ error: 'agentIds array, title, and message required' });
  }
  const sent: Notification[] = [];
  for (const aid of agentIds) {
    const notif: Notification = {
      id: `notif_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      agentId: aid,
      type: type || 'info',
      title,
      message,
      read: false,
      createdAt: new Date().toISOString()
    };
    const existing = notifications.get(aid) || [];
    existing.push(notif);
    notifications.set(aid, existing);
    sent.push(notif);
  }
  res.status(201).json({ sent: sent.length, notifications: sent });
});

export default router;
