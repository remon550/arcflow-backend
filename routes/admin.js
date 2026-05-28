const { Router } = require('express');
const supabase    = require('../supabase');

const router = Router();

const EVM_RE = /^0x[0-9a-fA-F]{40}$/;

// ─── Auth middleware ──────────────────────────────────────────────────────────
// All admin routes require x-wallet-address header pointing to an admin user.
// NOTE: For production, replace this with wallet-signature verification.
async function requireAdmin(req, res, next) {
  const wallet = (req.headers['x-wallet-address'] || '').toLowerCase();
  if (!wallet) return res.status(401).json({ success: false, error: 'No wallet header' });

  const { data } = await supabase
    .from('users')
    .select('id, is_admin')
    .eq('wallet_address', wallet)
    .maybeSingle();

  if (!data?.is_admin) {
    return res.status(403).json({ success: false, error: 'Not authorised' });
  }

  req.adminWallet = wallet;
  req.adminId     = data.id;
  next();
}

// ─── GET /api/admin/check ─────────────────────────────────────────────────────
router.get('/check', async (req, res) => {
  const wallet = (req.headers['x-wallet-address'] || '').toLowerCase();
  if (!wallet) return res.json({ isAdmin: false });

  const { data } = await supabase
    .from('users').select('is_admin').eq('wallet_address', wallet).maybeSingle();
  res.json({ isAdmin: data?.is_admin === true });
});

// ─── GET /api/admin/dashboard ─────────────────────────────────────────────────
router.get('/dashboard', requireAdmin, async (req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 10);

    const [
      { count: totalUsers },
      { count: wlCount },
      { count: evmCount },
      { count: top50Count },
    ] = await Promise.all([
      supabase.from('users').select('id', { count: 'exact', head: true }),
      supabase.from('users').select('id', { count: 'exact', head: true }).eq('wl_status', true),
      supabase.from('users').select('id', { count: 'exact', head: true }).not('evm_address','is',null),
      supabase.from('users').select('id', { count: 'exact', head: true }).eq('is_top_50', true),
    ]);

    // Total txs today
    const { count: txsToday } = await supabase
      .from('daily_activity')
      .select('tx_count', { count: 'exact', head: true })
      .eq('date', today);

    // Total points distributed
    const { data: ptRow } = await supabase
      .from('users').select('points_total').order('points_total', { ascending: false });
    const totalPoints = (ptRow || []).reduce((s, r) => s + r.points_total, 0);

    res.json({
      success:     true,
      totalUsers:  totalUsers  || 0,
      wlCount:     wlCount     || 0,
      evmCount:    evmCount    || 0,
      top50Count:  top50Count  || 0,
      txsToday:    txsToday    || 0,
      totalPoints,
    });
  } catch (err) {
    console.error('[admin/dashboard]', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── GET /api/admin/users ─────────────────────────────────────────────────────
router.get('/users', requireAdmin, async (req, res) => {
  try {
    const { search, filter, limit = 200, offset = 0 } = req.query;

    let q = supabase
      .from('users')
      .select('id,wallet_address,username,evm_address,points_total,current_streak,total_referrals,wl_status,is_top_50,created_at', { count: 'exact' })
      .order('points_total', { ascending: false })
      .range(Number(offset), Number(offset) + Number(limit) - 1);

    if (search) {
      q = q.or(`wallet_address.ilike.%${search}%,username.ilike.%${search}%`);
    }
    if (filter === 'wl')      q = q.eq('wl_status', true);
    if (filter === 'top50')   q = q.eq('is_top_50', true);
    if (filter === 'no_evm')  q = q.is('evm_address', null);

    const { data, error, count } = await q;
    if (error) throw error;

    const rows = (data || []).map((u, i) => ({
      rank:        Number(offset) + i + 1,
      id:          u.id,
      wallet:      u.wallet_address,
      username:    u.username,
      evm_address: u.evm_address,
      points:      u.points_total,
      streak:      u.current_streak,
      referrals:   u.total_referrals,
      wl_status:   u.wl_status,
      is_top_50:   u.is_top_50,
      joined:      u.created_at,
    }));

    res.json({ success: true, rows, total: count || 0 });
  } catch (err) {
    console.error('[admin/users]', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── POST /api/admin/points/adjust ────────────────────────────────────────────
router.post('/points/adjust', requireAdmin, async (req, res) => {
  try {
    const { userId, delta, reason } = req.body;
    if (!userId || delta == null || !reason) {
      return res.status(400).json({ success: false, error: 'userId, delta, reason required' });
    }

    const { data: user, error } = await supabase
      .from('users').select('id, points_total, wl_status').eq('id', userId).single();
    if (error || !user) return res.status(404).json({ success: false, error: 'User not found' });

    const oldValue  = user.points_total;
    const newValue  = Math.max(0, oldValue + Number(delta));
    const updates   = { points_total: newValue };
    if (!user.wl_status && newValue >= 10000) updates.wl_status = true;

    await supabase.from('users').update(updates).eq('id', userId);

    // Audit log
    await supabase.from('audit_log').insert({
      admin_wallet:     req.adminWallet,
      action:           'points_adjust',
      affected_user_id: userId,
      old_value:        String(oldValue),
      new_value:        String(newValue),
      reason,
    });

    // Refresh top-50 after adjustment
    await supabase.rpc('refresh_top_50').catch(() => {});

    res.json({ success: true, oldValue, newValue, delta: Number(delta) });
  } catch (err) {
    console.error('[admin/points/adjust]', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── POST /api/admin/whitelist/add ────────────────────────────────────────────
router.post('/whitelist/add', requireAdmin, async (req, res) => {
  try {
    const { wallet, evmAddress } = req.body;
    if (!wallet || !evmAddress) {
      return res.status(400).json({ success: false, error: 'wallet and evmAddress required' });
    }
    if (!EVM_RE.test(evmAddress)) {
      return res.status(400).json({ success: false, error: 'Invalid EVM address' });
    }

    // Get or create the user record
    let { data: user } = await supabase
      .from('users').select('id').eq('wallet_address', wallet.toLowerCase()).maybeSingle();

    if (!user) {
      // Allow adding unknown wallets to WL (manual override)
      const code = [...Array(6)].map(() => 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'[Math.floor(Math.random()*36)]).join('');
      const { data: created } = await supabase
        .from('users')
        .insert({ wallet_address: wallet.toLowerCase(), referral_code: code, wl_status: true })
        .select().single();
      user = created;
    }

    await supabase.from('users').update({ wl_status: true, evm_address: evmAddress }).eq('id', user.id);

    await supabase.from('whitelist').upsert({
      user_id:            user.id,
      evm_address:        evmAddress,
      qualification_type: 'manual',
      added_by:           req.adminWallet,
    }, { onConflict: 'user_id' });

    // Audit log
    await supabase.from('audit_log').insert({
      admin_wallet:     req.adminWallet,
      action:           'manual_wl_add',
      affected_user_id: user.id,
      new_value:        evmAddress,
      reason:           'manual admin addition',
    });

    res.json({ success: true });
  } catch (err) {
    console.error('[admin/whitelist/add]', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── GET /api/admin/export/users ─────────────────────────────────────────────
router.get('/export/users', requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('users')
      .select('wallet_address,username,evm_address,points_total,current_streak,total_referrals,wl_status,is_top_50,created_at')
      .order('points_total', { ascending: false });
    if (error) throw error;

    const header = 'rank,wallet,username,evm_address,points,streak,referrals,wl_qualified,top50,joined\n';
    const rows   = (data || []).map((u, i) =>
      [i+1, u.wallet_address, u.username||'', u.evm_address||'', u.points_total,
       u.current_streak, u.total_referrals, u.wl_status?'YES':'NO',
       u.is_top_50?'YES':'NO', u.created_at].join(',')
    ).join('\n');

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="arcflow-users.csv"');
    res.send(header + rows);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── GET /api/admin/export/whitelist ──────────────────────────────────────────
router.get('/export/whitelist', requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('whitelist')
      .select('evm_address, qualification_type, added_at, user:user_id (wallet_address, username, points_total)')
      .order('added_at', { ascending: true });
    if (error) throw error;

    // Also pull top-50 users who haven't submitted EVM yet (mark as pending)
    const { data: top50 } = await supabase
      .from('users')
      .select('wallet_address, username, points_total, evm_address')
      .eq('is_top_50', true);

    // Build a unified sorted list: wl entries first, then top-50 pending
    const wlSet   = new Set((data || []).map(r => r.user?.wallet_address));
    const pending = (top50 || [])
      .filter(u => !wlSet.has(u.wallet_address))
      .map(u => ({
        rank:  '—',
        wallet: u.wallet_address,
        username: u.username || '',
        evm_address: u.evm_address || 'PENDING',
        points: u.points_total,
        qualification_type: 'top50',
        added_at: '',
      }));

    const header = 'rank,wallet,username,evm_address,points,qualification_type,added_at\n';
    const rows   = (data || []).map((r, i) =>
      [i+1, r.user?.wallet_address||'', r.user?.username||'', r.evm_address,
       r.user?.points_total||0, r.qualification_type, r.added_at].join(',')
    ).concat(
      pending.map(p =>
        [p.rank, p.wallet, p.username, p.evm_address, p.points, p.qualification_type, p.added_at].join(',')
      )
    ).join('\n');

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="arcflow-whitelist.csv"');
    res.send(header + rows);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── GET /api/admin/audit ─────────────────────────────────────────────────────
router.get('/audit', requireAdmin, async (req, res) => {
  try {
    const { data } = await supabase
      .from('audit_log')
      .select('admin_wallet, action, old_value, new_value, reason, created_at, user:affected_user_id (wallet_address)')
      .order('created_at', { ascending: false })
      .limit(200);
    res.json({ success: true, log: data || [] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
