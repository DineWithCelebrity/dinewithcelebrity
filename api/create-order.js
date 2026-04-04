// POST /api/create-order
// Validates redemption token, RE-COMPUTES discount (never trusts token amount),
// marks token used, locks seat, creates Razorpay order.

import { createClient } from '@supabase/supabase-js';
import Razorpay from 'razorpay';
import crypto from 'crypto';

const sbAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const razorpay = new Razorpay({
  key_id:     process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// ── Token verification ────────────────────────────────────────────
function verifyToken(token) {
  try {
    const [b64, sig] = token.split('.');
    if (!b64 || !sig) return null;

    const expectedSig = crypto
      .createHmac('sha256', process.env.REDEMPTION_SECRET)
      .update(b64)
      .digest('hex');

    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig))) return null;

    const payload = JSON.parse(Buffer.from(b64, 'base64').toString());
    if (Date.now() > payload.expires_at) return null;

    return payload;
  } catch {
    return null;
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // ── Auth ──────────────────────────────────────────────────────
  const jwt = (req.headers.authorization || '').replace('Bearer ', '').trim();
  if (!jwt) return res.status(401).json({ error: 'Unauthorized' });

  const { data: { user }, error: authErr } = await sbAdmin.auth.getUser(jwt);
  if (authErr || !user) return res.status(401).json({ error: 'Invalid token' });

  const { event_id, redemption_token } = req.body || {};
  if (!event_id) return res.status(400).json({ error: 'event_id required' });

  // ── Verify redemption token if provided ───────────────────────
  let tokenPayload = null;
  if (redemption_token) {
    tokenPayload = verifyToken(redemption_token);
    if (!tokenPayload) return res.status(400).json({ error: 'Invalid or expired redemption token' });
    if (tokenPayload.user_id !== user.id) return res.status(403).json({ error: 'Token user mismatch' });
    if (tokenPayload.event_id !== event_id) return res.status(400).json({ error: 'Token event mismatch' });
  }

  try {
    // ── Token replay check ────────────────────────────────────
    if (redemption_token) {
      const tokenHash = crypto.createHash('sha256').update(redemption_token).digest('hex');
      const { data: usedToken } = await sbAdmin
        .from('used_tokens')
        .select('token_hash')
        .eq('token_hash', tokenHash)
        .maybeSingle();

      if (usedToken) return res.status(400).json({ error: 'Redemption token already used' });

      // Mark token as used immediately
      await sbAdmin.from('used_tokens').insert({
        token_hash: tokenHash,
        member_id:  tokenPayload.member_id,
        event_id:   event_id,
        expires_at: new Date(tokenPayload.expires_at).toISOString(),
      });
    }

    // ── Fetch event ────────────────────────────────────────────
    const { data: event, error: evErr } = await sbAdmin
      .from('celebrity_events')
      .select('*')
      .eq('id', event_id)
      .eq('status', 'live')
      .single();

    if (evErr || !event) return res.status(404).json({ error: 'Event not found' });

    // ── Seat availability check ────────────────────────────────
    const seatsAvail = event.available_seats - event.reserved_seats;
    if (seatsAvail <= 0) return res.status(400).json({ error: 'No seats available' });

    // ── Fetch member ───────────────────────────────────────────
    const { data: member } = await sbAdmin
      .from('members')
      .select('id, points, tier')
      .eq('auth_user_id', user.id)
      .single();

    if (!member) return res.status(404).json({ error: 'Member not found' });

    // ── RE-COMPUTE discount server-side (never trust token amount) ──
    const { data: redeemableRows } = await sbAdmin
      .from('points_transactions')
      .select('points')
      .eq('member_id', member.id)
      .eq('type', 'earn')
      .lte('redeemable_after', new Date().toISOString())
      .gt('expires_at', new Date().toISOString())
      .gt('points', 0);

    const redeemablePts = (redeemableRows || []).reduce((s, r) => s + r.points, 0);
    const ptsPerRupee   = 100 / event.points_value_per_100;
    const maxDiscount   = Math.min(
      Math.floor(event.ticket_price * event.max_discount_pct / 100),
      event.max_discount_abs
    );
    const ptsForMax   = Math.ceil(maxDiscount * ptsPerRupee);
    const usablePts   = Math.min(redeemablePts, ptsForMax);
    const rawDiscount = usablePts / ptsPerRupee;
    const discount    = Math.floor(rawDiscount / 50) * 50;
    const pointsUsed  = Math.ceil(discount * ptsPerRupee);
    const finalPrice  = event.ticket_price - discount;

    // ── Lock seat (reserved_seats++) ──────────────────────────
    const { error: lockErr } = await sbAdmin.rpc('lock_event_seat', { p_event_id: event_id });
    if (lockErr) {
      console.error('[create-order] seat lock failed:', lockErr);
      return res.status(400).json({ error: 'Could not reserve seat. Try again.' });
    }

    // ── Create Razorpay order ─────────────────────────────────
    const rpOrder = await razorpay.orders.create({
      amount:   finalPrice * 100,   // paise
      currency: 'INR',
      notes: {
        member_id:   member.id,
        event_id:    event_id,
        points_used: pointsUsed,
        discount:    discount,
      },
    });

    // ── Store pending booking ─────────────────────────────────
    const idempKey = `booking_${member.id}_${event_id}_${rpOrder.id}`;
    await sbAdmin.from('event_bookings').insert({
      member_id:        member.id,
      event_id:         event_id,
      seats:            1,
      base_price:       event.ticket_price,
      points_used:      pointsUsed,
      discount_given:   discount,
      final_price:      finalPrice,
      payment_order_id: rpOrder.id,
      status:           'pending',
      idempotency_key:  idempKey,
    });

    return res.status(200).json({
      order_id:      rpOrder.id,
      amount:        rpOrder.amount,
      currency:      rpOrder.currency,
      final_price:   finalPrice,
      discount:      discount,
      points_used:   pointsUsed,
      key_id:        process.env.RAZORPAY_KEY_ID,
    });

  } catch (err) {
    console.error('[create-order]', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
