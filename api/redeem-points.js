// POST /api/redeem-points
// Quote only — computes discount, signs HMAC token. No DB write.
// Client uses token in /api/create-order

import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';

const sbAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // ── Auth ──────────────────────────────────────────────────────
  const authHeader = req.headers.authorization || '';
  const jwt = authHeader.replace('Bearer ', '').trim();
  if (!jwt) return res.status(401).json({ error: 'Unauthorized' });

  const { data: { user }, error: authErr } = await sbAdmin.auth.getUser(jwt);
  if (authErr || !user) return res.status(401).json({ error: 'Invalid token' });

  const { event_id } = req.body || {};
  if (!event_id) return res.status(400).json({ error: 'event_id required' });

  try {
    // ── Fetch event ────────────────────────────────────────────
    const { data: event, error: evErr } = await sbAdmin
      .from('celebrity_events')
      .select('*')
      .eq('id', event_id)
      .eq('status', 'live')
      .single();

    if (evErr || !event) return res.status(404).json({ error: 'Event not found or not live' });

    // ── Check seats ────────────────────────────────────────────
    const seatsAvail = event.available_seats - event.reserved_seats;
    if (seatsAvail <= 0) return res.status(400).json({ error: 'Event sold out' });

    // ── Fetch member ───────────────────────────────────────────
    const { data: member, error: memErr } = await sbAdmin
      .from('members')
      .select('id, points, tier, expires_at')
      .eq('id', user.id)
      .single();

    if (memErr || !member) return res.status(404).json({ error: 'Member not found' });

    // ── Fetch redeemable points (past cooldown, not expired) ───
    const { data: redeemableRows } = await sbAdmin
      .from('points_transactions')
      .select('points')
      .eq('member_id', member.id)
      .eq('type', 'earn')
      .lte('redeemable_after', new Date().toISOString())
      .gt('expires_at', new Date().toISOString())
      .gt('points', 0);

    const redeemablePts = (redeemableRows || []).reduce((s, r) => s + r.points, 0);

    // ── Compute discount ───────────────────────────────────────
    const ptsPerRupee  = 100 / event.points_value_per_100;          // e.g. 100/500 = 0.2 pts per ₹
    const maxDiscount  = Math.min(
      Math.floor(event.ticket_price * event.max_discount_pct / 100),
      event.max_discount_abs
    );
    const ptsForMax    = Math.ceil(maxDiscount * ptsPerRupee);
    const usablePts    = Math.min(redeemablePts, ptsForMax);
    const rawDiscount  = usablePts / ptsPerRupee;

    // Round to nearest ₹50
    const discount     = Math.floor(rawDiscount / 50) * 50;
    const pointsUsed   = Math.ceil(discount * ptsPerRupee);
    const finalPrice   = event.ticket_price - discount;

    // ── Sign token (expires 10 min) ────────────────────────────
    const tokenPayload = {
      user_id:     user.id,
      member_id:   member.id,
      event_id:    event.id,
      discount:    discount,
      points_used: pointsUsed,
      final_price: finalPrice,
      expires_at:  Date.now() + 10 * 60 * 1000,
    };
    const tokenString = JSON.stringify(tokenPayload);
    const tokenB64    = Buffer.from(tokenString).toString('base64');
    const sig         = crypto
      .createHmac('sha256', process.env.REDEMPTION_SECRET)
      .update(tokenB64)
      .digest('hex');
    const token       = `${tokenB64}.${sig}`;

    return res.status(200).json({
      ticket_price:   event.ticket_price,
      max_discount:   maxDiscount,
      member_pts:     member.points,
      redeemable_pts: redeemablePts,
      points_used:    pointsUsed,
      discount:       discount,
      final_price:    finalPrice,
      seats_available: seatsAvail,
      token:          token,
      token_expires_at: tokenPayload.expires_at,
    });

  } catch (err) {
    console.error('[redeem-points]', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
