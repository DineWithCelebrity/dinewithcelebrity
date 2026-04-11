// api/verify-event-payment.js
// DWC — Event Payment Verification
// Flow: Razorpay signature check → seat confirm RPC → booking record → confirmation email

import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';

const sbAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // ─── 1. PARSE BODY ───
  const {
    razorpay_order_id,
    razorpay_payment_id,
    razorpay_signature,
    event_id,
    amount,
    tier,
    points_used = 0,
    points_discount = 0
  } = req.body;

  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature || !event_id) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  // ─── 2. VERIFY JWT — get user from auth header ───
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const token = authHeader.split(' ')[1];
  const { data: { user }, error: authErr } = await sbAdmin.auth.getUser(token);
  if (authErr || !user) {
    return res.status(401).json({ error: 'Invalid session' });
  }

  // ─── 3. IDEMPOTENCY CHECK — prevent double confirmation ───
  const { data: existingBooking } = await sbAdmin
    .from('event_bookings')
    .select('id')
    .eq('razorpay_order_id', razorpay_order_id)
    .single();

  if (existingBooking) {
    return res.status(200).json({
      success: true,
      booking_id: existingBooking.id,
      message: 'Already confirmed'
    });
  }

  // ─── 4. VERIFY RAZORPAY SIGNATURE ───
  const body = razorpay_order_id + '|' + razorpay_payment_id;
  const expectedSig = crypto
    .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
    .update(body)
    .digest('hex');

  if (expectedSig !== razorpay_signature) {
    console.error('Signature mismatch', { razorpay_order_id, user_id: user.id });
    return res.status(400).json({ error: 'Payment verification failed' });
  }

  // ─── 5. VERIFY AMOUNT WITH RAZORPAY API ───
  try {
    const rzpAuth = Buffer.from(
      `${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`
    ).toString('base64');

    const rzpRes = await fetch(
      `https://api.razorpay.com/v1/payments/${razorpay_payment_id}`,
      { headers: { Authorization: `Basic ${rzpAuth}` } }
    );
    const rzpData = await rzpRes.json();

    if (rzpData.error) {
      return res.status(400).json({ error: 'Could not verify payment with Razorpay' });
    }

    // Amount in paise — verify it matches expected
    const expectedPaise = Math.round(amount * 100);
    if (rzpData.amount < expectedPaise) {
      console.error('Amount mismatch', {
        expected: expectedPaise,
        received: rzpData.amount,
        user_id: user.id
      });
      return res.status(400).json({ error: 'Payment amount mismatch' });
    }

    if (rzpData.status !== 'captured') {
      return res.status(400).json({ error: 'Payment not captured' });
    }
  } catch (e) {
    console.error('Razorpay API error', e.message);
    return res.status(500).json({ error: 'Could not verify with Razorpay API' });
  }

  // ─── 6. DEDUCT POINTS IF USED ───
  if (points_used > 0) {
    const { error: pointsErr } = await sbAdmin.rpc('deduct_points_fifo', {
      p_user_id: user.id,
      p_points: points_used,
      p_reason: 'event_ticket',
      p_reference_id: razorpay_order_id
    });

    if (pointsErr) {
      // Log but don't block — points failure shouldn't block ticket
      console.error('Points deduction failed', pointsErr.message);
    }
  }

  // ─── 7. CONFIRM SEAT — atomic RPC ───
  const { data: confirmData, error: confirmErr } = await sbAdmin.rpc('confirm_event_seat', {
    p_event_id: event_id,
    p_user_id: user.id,
    p_razorpay_order_id: razorpay_order_id,
    p_razorpay_payment_id: razorpay_payment_id,
    p_amount_paid: amount,
    p_tier: tier,
    p_seats: 1,
    p_points_used: points_used,
    p_points_discount: points_discount
  });

  if (confirmErr || !confirmData?.success) {
    console.error('confirm_event_seat failed', confirmErr?.message || confirmData?.error);
    return res.status(500).json({ error: 'Booking confirmation failed. Contact support.' });
  }

  // ─── 8. FETCH EVENT + USER DETAILS FOR EMAIL ───
  const [{ data: event }, { data: profile }] = await Promise.all([
    sbAdmin.from('celebrity_events')
      .select('event_title, celebrity_name, event_date, location, city')
      .eq('id', event_id)
      .single(),
    sbAdmin.from('profiles')
      .select('full_name, email')
      .eq('id', user.id)
      .single()
  ]);

  // ─── 9. SEND CONFIRMATION EMAIL VIA RESEND ───
  const memberName = profile?.full_name || user.email.split('@')[0];
  const memberEmail = profile?.email || user.email;
  const eventDate = event?.event_date
    ? new Date(event.event_date).toLocaleDateString('en-IN', {
        weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
        hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata'
      })
    : 'Date TBA';

  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`
      },
      body: JSON.stringify({
        from: 'DWC Events <hello@dinewithcelebrity.com>',
        to: memberEmail,
        subject: `Your seat is confirmed — ${event?.event_title || 'DWC Event'}`,
        html: buildConfirmationEmail({
          memberName,
          eventTitle: event?.event_title || 'DWC Celebrity Event',
          castName: event?.celebrity_name || '',
          eventDate,
          venue: event?.location || 'TBA',
          city: event?.city || 'Hyderabad',
          tier,
          amountPaid: amount,
          bookingId: confirmData.booking_id,
          pointsUsed: points_used,
          pointsDiscount: points_discount
        })
      })
    });
  } catch (emailErr) {
    // Email failure doesn't block booking — already confirmed
    console.error('Email send failed', emailErr.message);
  }

  // ─── 10. NOTIFY ADMIN ───
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`
      },
      body: JSON.stringify({
        from: 'DWC Events <hello@dinewithcelebrity.com>',
        to: 'hello@dinewithcelebrity.com',
        subject: `New Event Booking — ${event?.event_title} [${tier.toUpperCase()}]`,
        html: `<p><strong>${memberName}</strong> (${memberEmail}) booked a seat for <strong>${event?.event_title}</strong>.</p>
               <p>Tier: ${tier} | Amount: ₹${Number(amount).toLocaleString('en-IN')} | Booking ID: ${confirmData.booking_id}</p>
               <p>Points used: ${points_used} (discount: ₹${points_discount})</p>`
      })
    });
  } catch (e) {
    console.error('Admin notify failed', e.message);
  }

  // ─── 11. LOG TO payment_logs ───
  await sbAdmin.from('payment_logs').insert({
    user_id: user.id,
    order_id: razorpay_order_id,
    payment_id: razorpay_payment_id,
    amount,
    status: 'captured',
    tier,
    event_type: 'event_booking',
    event_id
  }).catch(e => console.error('payment_logs insert failed', e.message));

  // ─── 12. RETURN SUCCESS ───
  return res.status(200).json({
    success: true,
    booking_id: confirmData.booking_id,
    message: 'Booking confirmed'
  });
}

// ─── EMAIL TEMPLATE ───
function buildConfirmationEmail({
  memberName, eventTitle, castName, eventDate, venue, city,
  tier, amountPaid, bookingId, pointsUsed, pointsDiscount
}) {
  const tierLabel = tier.charAt(0).toUpperCase() + tier.slice(1);
  const isFree = amountPaid === 0;

  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/></head>
<body style="margin:0;padding:0;background:#06040A;font-family:'Poppins',Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0">
  <tr><td align="center" style="padding:40px 20px">
    <table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%">

      <!-- Header -->
      <tr><td style="text-align:center;padding-bottom:32px">
        <div style="font-family:Georgia,serif;font-size:28px;font-weight:700;color:#F2B705;letter-spacing:4px">DINE WITH CELEBRITY</div>
        <div style="font-size:12px;color:rgba(255,255,255,0.4);letter-spacing:2px;margin-top:4px">DINEWITHCELEBRITY.COM</div>
      </td></tr>

      <!-- Confirmation card -->
      <tr><td style="background:rgba(255,255,255,0.04);border:1px solid rgba(242,183,5,0.25);border-radius:16px;padding:36px">

        <div style="text-align:center;margin-bottom:28px">
          <div style="font-size:36px;margin-bottom:12px">🎉</div>
          <div style="font-size:22px;font-weight:700;color:#ffffff;letter-spacing:1px">Your Seat Is Confirmed</div>
          <div style="font-size:14px;color:rgba(255,255,255,0.6);margin-top:6px">Get ready for an unforgettable evening</div>
        </div>

        <!-- Event Details -->
        <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px">
          <tr><td style="padding:10px 0;border-bottom:1px solid rgba(255,255,255,0.06)">
            <span style="font-size:11px;letter-spacing:2px;text-transform:uppercase;color:rgba(255,255,255,0.4)">Event</span>
            <div style="font-size:15px;font-weight:600;color:#F2B705;margin-top:4px">${eventTitle}</div>
          </td></tr>
          <tr><td style="padding:10px 0;border-bottom:1px solid rgba(255,255,255,0.06)">
            <span style="font-size:11px;letter-spacing:2px;text-transform:uppercase;color:rgba(255,255,255,0.4)">Featuring</span>
            <div style="font-size:14px;color:#ffffff;margin-top:4px">${castName}</div>
          </td></tr>
          <tr><td style="padding:10px 0;border-bottom:1px solid rgba(255,255,255,0.06)">
            <span style="font-size:11px;letter-spacing:2px;text-transform:uppercase;color:rgba(255,255,255,0.4)">Date & Time</span>
            <div style="font-size:14px;color:#ffffff;margin-top:4px">${eventDate}</div>
          </td></tr>
          <tr><td style="padding:10px 0;border-bottom:1px solid rgba(255,255,255,0.06)">
            <span style="font-size:11px;letter-spacing:2px;text-transform:uppercase;color:rgba(255,255,255,0.4)">Venue</span>
            <div style="font-size:14px;color:#ffffff;margin-top:4px">${venue}, ${city}</div>
          </td></tr>
          <tr><td style="padding:10px 0;border-bottom:1px solid rgba(255,255,255,0.06)">
            <span style="font-size:11px;letter-spacing:2px;text-transform:uppercase;color:rgba(255,255,255,0.4)">Your Membership</span>
            <div style="font-size:14px;color:#ffffff;margin-top:4px">${tierLabel}</div>
          </td></tr>
          <tr><td style="padding:10px 0;border-bottom:1px solid rgba(255,255,255,0.06)">
            <span style="font-size:11px;letter-spacing:2px;text-transform:uppercase;color:rgba(255,255,255,0.4)">Amount Paid</span>
            <div style="font-size:16px;font-weight:700;color:#00C853;margin-top:4px">${isFree ? 'Complimentary' : '₹' + Number(amountPaid).toLocaleString('en-IN')}</div>
          </td></tr>
          ${pointsUsed > 0 ? `
          <tr><td style="padding:10px 0;border-bottom:1px solid rgba(255,255,255,0.06)">
            <span style="font-size:11px;letter-spacing:2px;text-transform:uppercase;color:rgba(255,255,255,0.4)">Points Redeemed</span>
            <div style="font-size:14px;color:#FFD166;margin-top:4px">${pointsUsed} pts (saved ₹${Number(pointsDiscount).toLocaleString('en-IN')})</div>
          </td></tr>` : ''}
          <tr><td style="padding:10px 0">
            <span style="font-size:11px;letter-spacing:2px;text-transform:uppercase;color:rgba(255,255,255,0.4)">Booking ID</span>
            <div style="font-size:12px;color:rgba(255,255,255,0.5);font-family:monospace;margin-top:4px">${bookingId}</div>
          </td></tr>
        </table>

        <!-- What to bring -->
        <div style="background:rgba(242,183,5,0.07);border:1px solid rgba(242,183,5,0.15);border-radius:10px;padding:16px;margin-bottom:24px">
          <div style="font-size:12px;font-weight:600;color:#F2B705;letter-spacing:1px;margin-bottom:8px">WHAT TO EXPECT</div>
          <div style="font-size:13px;color:rgba(255,255,255,0.75);line-height:1.7">
            ✦ Arrive 15 minutes early for welcome drinks<br/>
            ✦ Your co-branded event T-shirt will be at the door<br/>
            ✦ Bring this email as your entry confirmation<br/>
            ✦ Professional photography — tag @dinewithcelebrity
          </div>
        </div>

        <!-- CTA -->
        <div style="text-align:center">
          <a href="https://dinewithcelebrity.com/dashboard.html"
             style="display:inline-block;background:#F2B705;color:#06040A;font-weight:700;font-size:14px;padding:14px 32px;border-radius:50px;text-decoration:none;letter-spacing:0.5px">
            View My Booking →
          </a>
        </div>

      </td></tr>

      <!-- Footer -->
      <tr><td style="text-align:center;padding:28px 0">
        <div style="font-size:12px;color:rgba(255,255,255,0.3);line-height:1.7">
          Questions? Email us at <a href="mailto:hello@dinewithcelebrity.com" style="color:#F2B705">hello@dinewithcelebrity.com</a><br/>
          Dine With Celebrity Pvt Ltd · Hyderabad, India
        </div>
      </td></tr>

    </table>
  </td></tr>
</table>
</body>
</html>`;
}
