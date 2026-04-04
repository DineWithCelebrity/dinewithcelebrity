// GET /api/contract-renewal-check
// Cron: runs daily 9am IST (3:30am UTC)
// Does:
//   1. Partner contract renewals
//   2. Points expiry — deduct expired points
//   3. Seat release — cancel abandoned pending bookings (>15 min)
//   4. Ledger audit — log drift where cached balance ≠ SUM(ledger)
//   5. Token cleanup — delete expired used_tokens

import { createClient } from '@supabase/supabase-js';
import { Resend } from 'resend';

const sbAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const resend  = new Resend(process.env.RESEND_API_KEY);

export default async function handler(req, res) {
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`)
    return res.status(401).json({ error: 'Unauthorized' });

  const results = { renewals_sent:0, points_expired:0, members_affected:0, seats_released:0, ledger_drifts:0, tokens_cleaned:0, errors:[] };

  // ── 1. Partner Contract Renewals ─────────────────────────────
  try {
    const in30 = new Date(Date.now() + 30*24*60*60*1000).toISOString();
    const { data: partners } = await sbAdmin.from('partners')
      .select('id,name,contact_email,contract_expires_at')
      .eq('is_active',true).lte('contract_expires_at',in30).gte('contract_expires_at',new Date().toISOString());

    for (const p of partners||[]) {
      const d = Math.ceil((new Date(p.contract_expires_at)-new Date())/86400000);
      if ([30,14,7,3,1].includes(d)) {
        await resend.emails.send({
          from:'partners@dinewithcelebrity.com', to:p.contact_email,
          subject:`DWC Partnership Renewal — ${d} day${d===1?'':'s'} left`,
          html:`<p>Hi ${p.name},</p><p>Your DWC partnership expires in <strong>${d} day${d===1?'':'s'}</strong>. Contact <a href="mailto:partners@dinewithcelebrity.com">partners@dinewithcelebrity.com</a> to renew.</p>`,
        });
        results.renewals_sent++;
      }
    }
  } catch(e){ results.errors.push('renewals:'+e.message); }

  // ── 2. Points Expiry ─────────────────────────────────────────
  try {
    const { data: expiredRows } = await sbAdmin.from('points_transactions')
      .select('member_id,id,points').eq('type','earn').lt('expires_at',new Date().toISOString()).gt('points',0);

    if (expiredRows?.length) {
      const byMember = {};
      expiredRows.forEach(r => {
        if (!byMember[r.member_id]) byMember[r.member_id]={pts:0,ids:[]};
        byMember[r.member_id].pts += r.points;
        byMember[r.member_id].ids.push(r.id);
      });

      for (const [mid, data] of Object.entries(byMember)) {
        try {
          await sbAdmin.from('points_transactions').update({points:0}).in('id',data.ids);
          await sbAdmin.from('points_transactions').insert({
            member_id:mid, type:'expire', reason:'expiry', points:-data.pts,
            redeemable_after:new Date().toISOString(), expires_at:null,
          });
          const { data: m } = await sbAdmin.from('members').select('points').eq('id',mid).single();
          if (m) await sbAdmin.from('members').update({points:Math.max(0,m.points-data.pts)}).eq('id',mid);
          results.points_expired += data.pts;
          results.members_affected++;
        } catch(e){ results.errors.push(`expiry_${mid}:${e.message}`); }
      }
    }

    // 30-day expiry warning emails
    const in30d = new Date(Date.now()+30*24*60*60*1000).toISOString();
    const { data: expiring } = await sbAdmin.from('points_transactions')
      .select('member_id,points,expires_at,members(email,first_name)')
      .eq('type','earn').gt('points',0).lt('expires_at',in30d).gt('expires_at',new Date().toISOString());
    const warned = new Set();
    for (const r of expiring||[]) {
      if (warned.has(r.member_id)) continue; warned.add(r.member_id);
      if (r.members?.email) {
        await resend.emails.send({
          from:'hello@dinewithcelebrity.com', to:r.members.email,
          subject:'⚠️ Your DWC points expire in 30 days',
          html:`<p>Hi ${r.members.first_name||'Member'},</p><p>Some of your DWC points expire in 30 days. <a href="https://www.dinewithcelebrity.com/dashboard">Log in to use them</a>.</p>`,
        });
      }
    }
  } catch(e){ results.errors.push('points_expiry:'+e.message); }

  // ── 3. Release Abandoned Seats (> 15 min old pending bookings) ──
  try {
    const ago15 = new Date(Date.now()-15*60*1000).toISOString();
    const { data: stale } = await sbAdmin.from('event_bookings')
      .select('id,event_id,seats').eq('status','pending').lt('created_at',ago15);

    for (const b of stale||[]) {
      try {
        await sbAdmin.rpc('release_event_seat',{p_event_id:b.event_id,p_seats:b.seats});
        await sbAdmin.from('event_bookings').update({status:'cancelled'}).eq('id',b.id);
        results.seats_released += b.seats;
      } catch(e){ results.errors.push(`seat_${b.id}:${e.message}`); }
    }
  } catch(e){ results.errors.push('seat_release:'+e.message); }

  // ── 4. Ledger Audit ──────────────────────────────────────────
  try {
    const { data: drifts } = await sbAdmin.from('member_points_audit').select('*').neq('drift',0);
    if (drifts?.length) {
      results.ledger_drifts = drifts.length;
      console.error('[LEDGER AUDIT DRIFT]', JSON.stringify(drifts));
    }
  } catch(e){ results.errors.push('ledger_audit:'+e.message); }

  // ── 5. Clean Expired Tokens ───────────────────────────────────
  try {
    const { data: deleted } = await sbAdmin.from('used_tokens')
      .delete().lt('expires_at',new Date().toISOString()).select('token_hash');
    results.tokens_cleaned = deleted?.length || 0;
  } catch(e){ results.errors.push('token_cleanup:'+e.message); }

  return res.status(200).json({
    message:   results.errors.length?'Completed with errors':'OK',
    timestamp: new Date().toISOString(),
    ...results,
  });
}
