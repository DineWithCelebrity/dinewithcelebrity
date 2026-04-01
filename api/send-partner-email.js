export default async function handler(req, res) {
  if(req.method !== 'POST') return res.status(405).json({error:'Method not allowed'});
  const { type, partnerEmail, partnerName, tier, contractDays, reason } = req.body;
  const RESEND_KEY = process.env.RESEND_API_KEY;
  if(!RESEND_KEY) return res.status(500).json({error:'Resend API key not configured'});

  const tierNames = {basic:'Basic (Free)',growth:'Growth (₹2,999/mo)',premium:'Premium (₹7,999/mo)'};
  let subject, html;

  if(type === 'approval'){
    subject = 'Your Dine With Celebrity Partnership is Approved 🎉';
    html = `
<!DOCTYPE html><html><head><meta charset="UTF-8">
<style>body{background:#06040A;color:#fff;font-family:Poppins,sans-serif;margin:0;padding:0}
.wrap{max-width:560px;margin:0 auto;padding:40px 20px}
.logo{font-size:1.4rem;font-weight:900;color:#F2B705;letter-spacing:.08em;margin-bottom:32px}
.card{background:#0f0b18;border:1px solid rgba(242,183,5,.2);border-radius:16px;padding:32px}
.title{font-size:2rem;font-weight:900;color:#fff;margin-bottom:8px}
.title em{color:#F2B705;font-style:normal}
.sub{color:rgba(255,255,255,.7);font-size:.9rem;line-height:1.6;margin-bottom:24px}
.highlight{background:rgba(242,183,5,.08);border:1px solid rgba(242,183,5,.2);border-radius:10px;padding:16px;margin-bottom:24px}
.hl-row{display:flex;justify-content:space-between;font-size:.85rem;margin-bottom:8px}
.hl-key{color:rgba(255,255,255,.5)}
.hl-val{color:#F2B705;font-weight:700}
.steps{margin-bottom:24px}
.step{display:flex;gap:12px;align-items:flex-start;margin-bottom:12px}
.step-num{width:28px;height:28px;border-radius:50%;background:#F2B705;color:#06040A;font-weight:800;font-size:.78rem;display:flex;align-items:center;justify-content:center;flex-shrink:0}
.step-text{font-size:.85rem;color:rgba(255,255,255,.75);line-height:1.5}
.step-text strong{color:#fff;display:block}
.btn{display:block;background:#F2B705;color:#06040A;text-decoration:none;text-align:center;padding:14px;border-radius:10px;font-weight:800;font-size:.95rem;text-transform:uppercase;letter-spacing:.06em;margin-bottom:24px}
.footer{font-size:.75rem;color:rgba(255,255,255,.35);text-align:center;margin-top:32px}
</style></head><body>
<div class="wrap">
  <div class="logo">★ DINE WITH CELEBRITY</div>
  <div class="card">
    <div class="title">WELCOME,<br><em>PARTNER!</em></div>
    <p class="sub">Congratulations ${partnerName} — your application has been approved. You are now an official DWC Partner and your vouchers will be visible to our premium members.</p>
    <div class="highlight">
      <div class="hl-row"><span class="hl-key">Partner Tier</span><span class="hl-val">${tierNames[tier]||tier}</span></div>
      <div class="hl-row"><span class="hl-key">Contract Duration</span><span class="hl-val">${contractDays} days</span></div>
      <div class="hl-row"><span class="hl-key">Dashboard</span><span class="hl-val">partner-dashboard.html</span></div>
    </div>
    <div class="steps">
      <div class="step"><div class="step-num">1</div><div class="step-text"><strong>Sign In to Your Dashboard</strong>Use your registered email and password at the link below.</div></div>
      <div class="step"><div class="step-num">2</div><div class="step-text"><strong>Complete Your Profile</strong>Add your outlet address, operating hours, and logo.</div></div>
      <div class="step"><div class="step-num">3</div><div class="step-text"><strong>Create Your First Voucher</strong>Design an offer for DWC members. It goes live after our team reviews it (within 24 hours).</div></div>
      <div class="step"><div class="step-num">4</div><div class="step-text"><strong>Set Your 4-Digit PIN</strong>You'll need this to validate member OTPs at your outlet.</div></div>
    </div>
    <a href="https://www.dinewithcelebrity.com/partner-dashboard.html" class="btn">Open Partner Dashboard →</a>
    <p style="font-size:.8rem;color:rgba(255,255,255,.5);text-align:center">Questions? Reply to this email or reach us at partners@dinewithcelebrity.com</p>
  </div>
  <div class="footer">© 2025 Dine With Celebrity Pvt Ltd · Hyderabad, India<br>Dine For A Cause</div>
</div></body></html>`;
  }
  } else if (type === 'voucher_approved') {
    subject = 'Your Voucher is Live — DWC';
    htmlBody = `<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;background:#06040A;color:#fff;padding:32px;border-radius:16px">
      <div style="text-align:center;margin-bottom:24px">
        <div style="font-size:2rem;font-weight:900;color:#F2B705;letter-spacing:.06em">★ DWC</div>
      </div>
      <h2 style="color:#00C853;font-size:1.4rem;margin-bottom:12px">✅ Your Voucher is Now Live!</h2>
      <p style="color:rgba(255,255,255,.8);font-size:.95rem;line-height:1.6">Great news! Your voucher <strong style="color:#F2B705">${data.voucherTitle || 'your voucher'}</strong> has been approved and is now visible to DWC premium members.</p>
      <div style="background:rgba(0,200,83,.08);border:1px solid rgba(0,200,83,.2);border-radius:12px;padding:16px;margin:20px 0">
        <div style="color:rgba(255,255,255,.6);font-size:.82rem">Members can start redeeming from</div>
        <div style="color:#00C853;font-weight:700;font-size:1.1rem">2 April 2026</div>
      </div>
      <p style="color:rgba(255,255,255,.6);font-size:.85rem">Log in to your partner dashboard to track redemptions in real time.</p>
      <div style="text-align:center;margin-top:24px">
        <a href="https://www.dinewithcelebrity.com/partner-dashboard.html" style="background:#F2B705;color:#06040A;padding:12px 28px;border-radius:10px;font-weight:700;text-decoration:none;font-size:.9rem">View Dashboard →</a>
      </div>
    </div>`;
  } else if (type === 'voucher_rejected') {
    subject = 'Voucher Update — Action Required';
    htmlBody = `<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;background:#06040A;color:#fff;padding:32px;border-radius:16px">
      <div style="text-align:center;margin-bottom:24px">
        <div style="font-size:2rem;font-weight:900;color:#F2B705;letter-spacing:.06em">★ DWC</div>
      </div>
      <h2 style="color:#D4002A;font-size:1.4rem;margin-bottom:12px">Voucher Needs Revision</h2>
      <p style="color:rgba(255,255,255,.8);font-size:.95rem;line-height:1.6">Your voucher <strong style="color:#F2B705">${data.voucherTitle || 'your voucher'}</strong> requires some changes before it can go live.</p>
      ${data.reason ? `<div style="background:rgba(212,0,42,.08);border:1px solid rgba(212,0,42,.2);border-radius:12px;padding:16px;margin:20px 0;color:rgba(255,255,255,.8);font-size:.88rem"><strong>Reason:</strong> ${data.reason}</div>` : ''}
      <p style="color:rgba(255,255,255,.6);font-size:.85rem">Please update your voucher and resubmit. Our team will review it within 24 hours.</p>
      <div style="text-align:center;margin-top:24px">
        <a href="https://www.dinewithcelebrity.com/partner-dashboard.html" style="background:#F2B705;color:#06040A;padding:12px 28px;border-radius:10px;font-weight:700;text-decoration:none;font-size:.9rem">Update Voucher →</a>
      </div>
    </div>`;
  } else if (type === 'contract_renewal') {
    subject = 'Your DWC Partnership — Renewal Coming Up';
    htmlBody = `<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;background:#06040A;color:#fff;padding:32px;border-radius:16px">
      <div style="text-align:center;margin-bottom:24px">
        <div style="font-size:2rem;font-weight:900;color:#F2B705;letter-spacing:.06em">★ DWC</div>
      </div>
      <h2 style="color:#F2B705;font-size:1.4rem;margin-bottom:12px">⏰ Your Partnership Renews in 30 Days</h2>
      <p style="color:rgba(255,255,255,.8);font-size:.95rem;line-height:1.6">Your 6-month free partnership trial ends on <strong style="color:#F2B705">${data.expiryDate || 'soon'}</strong>.</p>
      <div style="background:rgba(242,183,5,.06);border:1px solid rgba(242,183,5,.15);border-radius:12px;padding:16px;margin:20px 0">
        <div style="color:rgba(255,255,255,.6);font-size:.82rem;margin-bottom:8px">Your performance this period</div>
        <div style="display:flex;gap:20px;flex-wrap:wrap">
          <div><div style="color:#F2B705;font-size:1.4rem;font-weight:700">${data.redemptions || 0}</div><div style="color:rgba(255,255,255,.5);font-size:.75rem">Redemptions</div></div>
          <div><div style="color:#00C853;font-size:1.4rem;font-weight:700">${data.revenue || '₹0'}</div><div style="color:rgba(255,255,255,.5);font-size:.75rem">Revenue Driven</div></div>
        </div>
      </div>
      <p style="color:rgba(255,255,255,.6);font-size:.85rem">We will reach out to discuss your renewal plan. Stay connected!</p>
      <div style="text-align:center;margin-top:24px">
        <a href="https://www.dinewithcelebrity.com/partner-dashboard.html" style="background:#F2B705;color:#06040A;padding:12px 28px;border-radius:10px;font-weight:700;text-decoration:none;font-size:.9rem">View Your Dashboard →</a>
      </div>
    </div>`;
 else if(type === 'rejection'){
    subject = 'Update on Your DWC Partner Application';
    html = `
<!DOCTYPE html><html><head><meta charset="UTF-8">
<style>body{background:#06040A;color:#fff;font-family:Poppins,sans-serif;margin:0;padding:0}
.wrap{max-width:560px;margin:0 auto;padding:40px 20px}
.logo{font-size:1.4rem;font-weight:900;color:#F2B705;letter-spacing:.08em;margin-bottom:32px}
.card{background:#0f0b18;border:1px solid rgba(255,255,255,.08);border-radius:16px;padding:32px}
.title{font-size:1.8rem;font-weight:900;color:#fff;margin-bottom:8px}
.sub{color:rgba(255,255,255,.7);font-size:.9rem;line-height:1.6;margin-bottom:20px}
.reason-box{background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.1);border-radius:10px;padding:16px;margin-bottom:24px;font-size:.85rem;color:rgba(255,255,255,.7);line-height:1.6}
.btn{display:block;background:#F2B705;color:#06040A;text-decoration:none;text-align:center;padding:14px;border-radius:10px;font-weight:800;font-size:.95rem;text-transform:uppercase;letter-spacing:.06em;margin-bottom:24px}
.footer{font-size:.75rem;color:rgba(255,255,255,.35);text-align:center;margin-top:32px}
</style></head><body>
<div class="wrap">
  <div class="logo">★ DINE WITH CELEBRITY</div>
  <div class="card">
    <div class="title">Application Update</div>
    <p class="sub">Hi ${partnerName}, thank you for applying to partner with Dine With Celebrity. After reviewing your application, we are unable to proceed at this time.</p>
    <div class="reason-box"><strong style="color:#fff;display:block;margin-bottom:8px">Reason:</strong>${reason||'Your application did not meet our current partner criteria.'}</div>
    <p class="sub">We appreciate your interest and encourage you to reapply in the future as our platform grows. If you have questions, please reach out to us.</p>
    <a href="mailto:partners@dinewithcelebrity.com" class="btn">Contact Us →</a>
  </div>
  <div class="footer">© 2025 Dine With Celebrity Pvt Ltd · Hyderabad, India</div>
</div></body></html>`;
  } else {
    return res.status(400).json({error:'Unknown email type'});
  }

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'Dine With Celebrity <partners@dinewithcelebrity.com>',
        to: [partnerEmail],
        subject,
        html
      })
    });
    const data = await response.json();
    if(!response.ok) return res.status(500).json({error: data.message||'Email send failed'});
    return res.status(200).json({success:true, id: data.id});
  } catch(e) {
    return res.status(500).json({error: e.message});
  }
}
