import { createClient } from '@supabase/supabase-js';

const sbAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  const authHeader = req.headers.authorization;
  if (
    authHeader !== `Bearer ${process.env.CRON_SECRET}` &&
    process.env.NODE_ENV !== 'development'
  ) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const today = new Date();
  const in25  = new Date(today); in25.setDate(today.getDate() + 25);
  const in35  = new Date(today); in35.setDate(today.getDate() + 35);

  const { data: partners, error } = await sbAdmin
    .from('partners')
    .select('id, name, contact_email, contract_expires_at, approved_at, city')
    .eq('is_active', true)
    .eq('suspended', false)
    .gte('contract_expires_at', in25.toISOString())
    .lte('contract_expires_at', in35.toISOString());

  if (error) return res.status(500).json({ error: error.message });
  if (!partners || partners.length === 0) {
    return res.status(200).json({ sent: 0, message: 'No renewals due' });
  }

  const results = [];

  for (const partner of partners) {
    try {
      const { data: redemptions } = await sbAdmin
        .from('partner_redemptions')
        .select('id, discount_given')
        .eq('partner_id', partner.id)
        .eq('status', 'success');

      const totalRedemptions = redemptions?.length || 0;
      const totalRevenue     = redemptions?.reduce((s, r) => s + (r.discount_given || 0), 0) || 0;
      const formattedRevenue = totalRevenue > 0 ? `₹${totalRevenue.toLocaleString('en-IN')}` : '₹0';
      const expiryDate       = new Date(partner.contract_expires_at).toLocaleDateString('en-IN', {
        day: 'numeric', month: 'long', year: 'numeric',
      });

      await fetch(
        `${process.env.NEXT_PUBLIC_SITE_URL || 'https://www.dinewithcelebrity.com'}/api/send-partner-email`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'contract_renewal',
            partnerEmail: partner.contact_email,
            partnerName: partner.name,
            expiryDate,
            redemptions: totalRedemptions,
            revenue: formattedRevenue,
          }),
        }
      );

      await sbAdmin.from('admin_logs').insert({
        admin_email: 'system',
        action: 'renewal_email_sent',
        target_type: 'partner',
        target_id: partner.id,
        target_label: partner.name,
        metadata: {
          redemptions: totalRedemptions,
          revenue: formattedRevenue,
          expires: partner.contract_expires_at,
        },
      });

      results.push({ partner: partner.name, status: 'sent' });
    } catch (e) {
      results.push({ partner: partner.name, status: 'failed', error: e.message });
    }
  }

  return res.status(200).json({
    sent: results.filter(r => r.status === 'sent').length,
    results,
  });
}
