// ============================================================
// /api/razorpay-webhook.js — DWC Webhook Handler
// Backup safety net — expiry preserved on upgrade
// ============================================================

import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';
import { buffer } from 'micro';

export const config = { api: { bodyParser: false } };

const TIER_PRICES = { gold: 249900, platinum: 699900, dwcpurple: 1499900 };
const TIER_RANK   = { free: 0, gold: 1, platinum: 2, dwcpurple: 3 };

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let rawBody;
  try { rawBody = (await buffer(req)).toString('utf8'); }
  catch { return res.status(400).json({ error: 'Failed to read body' }); }

  const sig = req.headers['x-razorpay-signature'];
  if (!sig) return res.status(400).json({ error: 'Missing signature' });

  const expected = crypto
    .createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET)
    .update(rawBody).digest('hex');

  if (expected !== sig) return res.status(400).json({ error: 'Invalid signature' });

  let event;
  try { event = JSON.parse(rawBody); }
  catch { return res.status(400).json({ error: 'Invalid JSON' }); }

  if (event.event !== 'payment.captured') {
    return res.status(200).json({ received: true, action: 'ignored' });
  }

  const payment   = event.payload?.payment?.entity;
  const notes     = payment?.notes || {};
  const paymentId = payment?.id;
  const orderId   = payment?.order_id;
  const tier      = notes.tier;
  const userId    = notes.user_id;
  const keepExpiry = notes.keep_expiry === 'true';
  const originalExpiry = notes.original_expiry || null;

  if (!paymentId || !orderId || !tier || !userId || !TIER_PRICES[tier]) {
    return res.status(400).json({ error: 'Missing fields' });
  }

  const sbAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  // ── Idempotency ──
  const { data: existing } = await sbAdmin
    .from('payment_logs').select('id').eq('payment_id', paymentId).single();
  if (existing) return res.status(200).json({ received: true, action: 'already_processed' });

  // ── Get current member ──
  const { data: member } = await sbAdmin
    .from('members').select('tier, expires_at, member_id, city').eq('id', userId).single();

  const currentTier   = (member?.tier || 'free').toLowerCase();
  const currentRank   = TIER_RANK[currentTier] || 0;
  const now           = new Date();
  const currentExpiry = member?.expires_at ? new Date(member.expires_at) : null;

  // ── Expiry logic (same as verify-payment) ──
  let newExpiry;
  if (keepExpiry && originalExpiry) {
    newExpiry = originalExpiry;
  } else if (currentRank > 0 && currentExpiry && currentExpiry > now) {
    newExpiry = currentExpiry.toISOString();
  } else {
    const e = new Date();
    e.setFullYear(e.getFullYear() + 1);
    newExpiry = e.toISOString();
  }

  // ── Update tier ──
  const { error: updateError } = await sbAdmin
    .from('members')
    .update({
      tier,
      upgraded_at:      now.toISOString(),
      expires_at:       newExpiry,
      payment_id:       paymentId,
      payment_order_id: orderId,
    })
    .eq('id', userId);

  if (updateError) return res.status(500).json({ error: 'Tier update failed' });

  // ── Audit log ──
  await sbAdmin.from('payment_logs').insert({
    member_id:  userId,
    payment_id: paymentId,
    order_id:   orderId,
    tier,
    amount:     TIER_PRICES[tier],
    status:     'success',
    source:     'webhook',
    created_at: now.toISOString(),
  });

  // ── Activity log ──
  if (member?.member_id) {
    await sbAdmin.from('member_activity').insert({
      member_id:     member.member_id,
      member_uuid:   userId,
      activity_type: 'upgrade',
      activity_data: {
        from_tier:  currentTier,
        to_tier:    tier,
        payment_id: paymentId,
        expiry:     newExpiry,
        source:     'webhook',
      },
      city: member.city || null,
    });
  }

  return res.status(200).json({ received: true, action: 'tier_updated', tier });
}
