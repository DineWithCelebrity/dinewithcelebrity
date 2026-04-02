// api/contract-renewal-check.js
// Vercel Cron Job — runs daily at 9am IST (3:30 UTC)
// Finds partners entering month 5 (30 days before contract_expires)
// Sends renewal alert email with their performance data

import { createClient } from '@supabase/supabase-js';

const sbClient = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

export default async function handler(req, res) {
  // Protect endpoint — only Vercel cron or admin can call
  const authHeader = req.headers.authorization;
  if(authHeader !== `Bearer ${process.env.CRON_SECRET}` && process.env.NODE_ENV !== 'development') {
    return res.status(401).json({error: 'Unauthorized'});
  }

  const today = new Date();
  // Find partners whose contract expires in 25–35 days (month 5 window)
  const in25Days = new Date(today); in25Days.setDate(today.getDate() + 25);
  const in35Days = new Date(today); in35Days.setDate(today.getDate() + 35);

  const { data: partners, error } = await sbClient
    .from('partners')
    .select('id, business_name, email, contract_expires, approved_at, city')
    .eq('is_active', true)
    .eq('suspended', false)
    .gte('contract_expires', in25Days.toISOString())
    .lte('contract_expires', in35Days.toISOString());

  if(error) return res.status(500).json({error: error.message});
  if(!partners || partners.length === 0) {
    return res.status(200).json({sent: 0, message: 'No renewals due'});
  }

  const results = [];

  for(const partner of partners) {
    try {
      // Get their redemption stats
      const { data: redemptions } = await sbClient
        .from('partner_redemptions')
        .select('id, discount_given')
        .eq('partner_id', partner.id)
        .eq('status', 'success');

      const totalRedemptions = redemptions?.length || 0;
      const totalRevenue = redemptions?.reduce((sum, r) => sum + (r.discount_given || 0), 0) || 0;
      const formattedRevenue = totalRevenue > 0 ? `₹${totalRevenue.toLocaleString('en-IN')}` : '₹0';
      const expiryDate = new Date(partner.contract_expires).toLocaleDateString('en-IN', {
        day: 'numeric', month: 'long', year: 'numeric'
      });

      // Send renewal email
      const emailRes = await fetch(`${process.env.NEXT_PUBLIC_SITE_URL || 'https://www.dinewithcelebrity.com'}/api/send-partner-email`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          type: 'contract_renewal',
          partnerEmail: partner.email,
          partnerName: partner.business_name,
          expiryDate,
          redemptions: totalRedemptions,
          revenue: formattedRevenue
        })
      });

      // Log in admin_logs
      await sbClient.from('admin_logs').insert({
        admin_email: 'system',
        action: 'renewal_email_sent',
        target_type: 'partner',
        target_id: partner.id,
        target_label: partner.business_name,
        metadata: {redemptions: totalRedemptions, revenue: formattedRevenue, expires: partner.contract_expires}
      });

      results.push({partner: partner.business_name, status: 'sent'});
    } catch(e) {
      results.push({partner: partner.business_name, status: 'failed', error: e.message});
    }
  }

  return res.status(200).json({sent: results.filter(r=>r.status==='sent').length, results});
}
