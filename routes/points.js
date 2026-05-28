const { Router } = require('express');
const supabase    = require('../supabase');

const router = Router();

// ─── Constants ────────────────────────────────────────────────────────────────
const DAILY_CAP        = 1000;
const WL_THRESHOLD     = 10000;
const REFERRAL_BONUS   = 50;
const STREAK_7_BONUS   = 100;
const STREAK_30_BONUS  = 500;
const EVM_ADDRESS_RE   = /^0x[0-9a-fA-F]{40}$/;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function calcPoints(amountUsd) {
  const n = parseFloat(amountUsd) || 0;
  if (n >= 1000) return 20;
  if (n >= 100)  return 5;
  if (n >= 10)   return 2;
  return 1;
}

function todayUTC() {
  return new Date().toISOString().slice(0, 10); // 'YYYY-MM-DD'
}

function yesterdayUTC() {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

function generateCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let c = '';
  for (let i = 0; i < 6; i++) c += chars[Math.floor(Math.random() * 36)];
  return c;
}

async function uniqueCode() {
  let code, exists;
  do {
    code = generateCode();
    const { data } = await supabase
      .from('users').select('id').eq('referral_code', code).maybeSingle();
    exists = !!data;
  } while (exists);
  return code;
}

// ─── getOrCreateUser ─────────────────────────────────────────────────────────
async function getOrCreateUser(wallet, referralCode = null) {
  const addr = wallet.toLowerCase();

  // Try fetch existing
  const { data: existing } = await supabase
    .from('users').select('*').eq('wallet_address', addr).maybeSingle();
  if (existing) return existing;

  // Generate unique referral code
  const code = await uniqueCode();

  // Validate referredBy code
  let referredBy = null;
  let referrerId = null;
  if (referralCode) {
    const { data: referrer } = await supabase
      .from('users').select('id, referral_code')
      .eq('referral_code', referralCode.toUpperCase())
      .maybeSingle();
    if (referrer) {
      referredBy  = referrer.referral_code;
      referrerId  = referrer.id;
    }
  }

  // Create user
  const { data: newUser, error } = await supabase
    .from('users')
    .insert({
      wallet_address: addr,
      referral_code:  code,
      referred_by:    referredBy,
    })
    .select()
    .single();

  if (error) throw new Error(`User create failed: ${error.message}`);

  // Create streak row
  await supabase.from('streaks').insert({ user_id: newUser.id });

  // Handle referral bonus
  if (referrerId) {
    await supabase.from('referrals').insert({
      referrer_user_id: referrerId,
      referred_user_id: newUser.id,
      points_awarded:   REFERRAL_BONUS,
    });
    // Award points to referrer
    await awardPointsDirect(referrerId, REFERRAL_BONUS, 'referral_bonus');
    // Increment referrer's total_referrals count
    const { data: ref } = await supabase
      .from('users').select('total_referrals').eq('id', referrerId).single();
    if (ref) {
      await supabase.from('users')
        .update({ total_referrals: ref.total_referrals + 1 })
        .eq('id', referrerId);
    }
  }

  return newUser;
}

// ─── awardPointsDirect (no daily cap — for bonuses/referrals) ─────────────────
async function awardPointsDirect(userId, points, _reason) {
  const { data: u } = await supabase
    .from('users').select('points_total, wl_status').eq('id', userId).single();
  if (!u) return;

  const newTotal = u.points_total + points;
  const updates  = { points_total: newTotal };

  // Auto-qualify for WL at threshold
  if (!u.wl_status && newTotal >= WL_THRESHOLD) {
    updates.wl_status = true;
  }

  await supabase.from('users').update(updates).eq('id', userId);
  await refreshTop50();
}

// ─── Streak update ────────────────────────────────────────────────────────────
async function updateStreak(user) {
  const today     = todayUTC();
  const yesterday = yesterdayUTC();
  const last      = user.last_active_date;

  let newStreak   = user.current_streak;
  let streakBonus = 0;

  if (last === today) {
    // Already active today — no change
    return { newStreak, streakBonus };
  }

  if (last === yesterday) {
    // Consecutive day — increment
    newStreak++;
  } else {
    // Missed a day (or first ever tx) — reset
    newStreak = 1;
  }

  const newLongest = Math.max(newStreak, user.longest_streak);

  // Update user record
  await supabase.from('users').update({
    current_streak:   newStreak,
    longest_streak:   newLongest,
    last_active_date: today,
    daily_points:     last === today ? user.daily_points : 0, // reset daily if new day
  }).eq('id', user.id);

  // Update streaks table
  await supabase.from('streaks').upsert({
    user_id:              user.id,
    current_streak_count: newStreak,
    longest_streak_count: newLongest,
    streak_start_date:    newStreak === 1 ? today : undefined,
  }, { onConflict: 'user_id', ignoreDuplicates: false });

  // Check streak milestones (only award once per milestone)
  const milestones = [
    { count: 7,  bonus: STREAK_7_BONUS  },
    { count: 30, bonus: STREAK_30_BONUS },
  ];
  for (const m of milestones) {
    if (newStreak === m.count) {
      // Avoid double-awarding the same milestone
      const { data: prev } = await supabase
        .from('streak_bonus_events')
        .select('id')
        .eq('user_id', user.id)
        .eq('streak_count', m.count)
        .maybeSingle();
      if (!prev) {
        await supabase.from('streak_bonus_events').insert({
          user_id:        user.id,
          streak_count:   m.count,
          points_awarded: m.bonus,
        });
        streakBonus += m.bonus;
      }
    }
  }

  return { newStreak, streakBonus };
}

// ─── Top-50 refresh ───────────────────────────────────────────────────────────
async function refreshTop50() {
  // Use the Postgres function defined in schema.sql
  await supabase.rpc('refresh_top_50').catch(() => {
    // Fallback: manual approach if rpc not yet deployed
  });
}

// ─── POST /api/points/transaction ─────────────────────────────────────────────
// Called by dashboard.html after every successful USDC send.
router.post('/transaction', async (req, res) => {
  try {
    const { wallet, txHash, amountUsd } = req.body;
    console.log(`[points/transaction] wallet=${wallet} txHash=${txHash} amountUsd=${amountUsd}`);
    if (!wallet || !txHash || amountUsd == null) {
      return res.status(400).json({ success: false, error: 'wallet, txHash, amountUsd required' });
    }

    const user  = await getOrCreateUser(wallet);
    const today = todayUTC();

    // Reset daily counter if it's a new day
    const isNewDay = user.last_active_date !== today;
    const currentDaily = isNewDay ? 0 : (user.daily_points || 0);

    // Calculate points for this tx, respecting daily cap
    const basePoints    = calcPoints(amountUsd);
    const remaining     = Math.max(0, DAILY_CAP - currentDaily);
    const pointsAwarded = Math.min(basePoints, remaining);

    // Update streak
    const { newStreak, streakBonus } = await updateStreak(
      isNewDay ? { ...user, daily_points: 0 } : user
    );

    const totalPoints = pointsAwarded + streakBonus;

    if (totalPoints > 0) {
      // Fetch fresh user after streak update
      const { data: freshUser } = await supabase
        .from('users').select('points_total, daily_points, wl_status').eq('id', user.id).single();

      const newTotal = (freshUser?.points_total || 0) + totalPoints;
      const newDaily = (isNewDay ? 0 : (freshUser?.daily_points || 0)) + pointsAwarded;

      const updates = {
        points_total:     newTotal,
        daily_points:     newDaily,
        last_active_date: today,
      };

      // Auto WL at 10 000 points
      if (!freshUser?.wl_status && newTotal >= WL_THRESHOLD) {
        updates.wl_status = true;
        // Add to whitelist table (evm_address may still be pending)
        const { data: uEvm } = await supabase
          .from('users').select('evm_address').eq('id', user.id).single();
        if (uEvm?.evm_address) {
          await supabase.from('whitelist').upsert({
            user_id:            user.id,
            evm_address:        uEvm.evm_address,
            qualification_type: 'points',
            added_by:           'system',
          }, { onConflict: 'user_id' });
        }
      }

      await supabase.from('users').update(updates).eq('id', user.id);

      // Record point transaction
      await supabase.from('point_transactions').insert({
        user_id:        user.id,
        tx_hash:        txHash,
        amount_usd:     amountUsd,
        points_awarded: totalPoints,
      });

      // Upsert daily_activity
      await supabase.from('daily_activity').upsert({
        user_id:       user.id,
        date:          today,
        points_earned: newDaily,
        tx_count:      1,
      }, {
        onConflict: 'user_id,date',
        ignoreDuplicates: false,
      });

      await refreshTop50();
    }

    // Return fresh stats
    const { data: updated } = await supabase
      .from('users')
      .select('points_total,daily_points,current_streak,longest_streak,wl_status,is_top_50,total_referrals,referral_code')
      .eq('id', user.id)
      .single();

    res.json({
      success:        true,
      pointsAwarded:  totalPoints,
      streakBonus,
      newStreak,
      user:           updated,
    });
  } catch (err) {
    console.error('[points/transaction]', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── POST /api/points/signup ──────────────────────────────────────────────────
// Called when a user first lands on the points page. Creates account if needed.
router.post('/signup', async (req, res) => {
  try {
    const { wallet, referralCode } = req.body;
    if (!wallet) return res.status(400).json({ success: false, error: 'wallet required' });

    const user = await getOrCreateUser(wallet, referralCode);
    res.json({ success: true, user });
  } catch (err) {
    console.error('[points/signup]', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── GET /api/points/user/:wallet ─────────────────────────────────────────────
router.get('/user/:wallet', async (req, res) => {
  try {
    const addr = req.params.wallet.toLowerCase();
    if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) {
      return res.status(400).json({ success: false, error: 'Invalid address' });
    }

    const { data: user } = await supabase
      .from('users')
      .select('*')
      .eq('wallet_address', addr)
      .maybeSingle();

    if (!user) return res.status(404).json({ success: false, error: 'User not found' });

    // Rank
    const { count } = await supabase
      .from('users')
      .select('id', { count: 'exact', head: true })
      .gt('points_total', user.points_total);
    const rank = (count || 0) + 1;

    // Recent point transactions
    const { data: txs } = await supabase
      .from('point_transactions')
      .select('tx_hash, amount_usd, points_awarded, created_at')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .limit(20);

    // Streak bonus history
    const { data: bonuses } = await supabase
      .from('streak_bonus_events')
      .select('streak_count, points_awarded, created_at')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false });

    res.json({ success: true, user, rank, transactions: txs || [], bonuses: bonuses || [] });
  } catch (err) {
    console.error('[points/user]', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── GET /api/points/leaderboard ─────────────────────────────────────────────
router.get('/leaderboard', async (req, res) => {
  try {
    const limit  = Math.min(parseInt(req.query.limit)  || 100, 200);
    const offset = parseInt(req.query.offset) || 0;

    const { data, error } = await supabase
      .from('users')
      .select('wallet_address, username, points_total, current_streak, wl_status, is_top_50, total_referrals, created_at')
      .order('points_total', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) throw error;

    const rows = (data || []).map((u, i) => ({
      rank:         offset + i + 1,
      display_name: u.username || `${u.wallet_address.slice(0,6)}…${u.wallet_address.slice(-4)}`,
      wallet:       u.wallet_address,
      points:       u.points_total,
      streak:       u.current_streak,
      wl_status:    u.wl_status,
      is_top_50:    u.is_top_50,
      referrals:    u.total_referrals,
      joined:       u.created_at,
    }));

    res.json({ success: true, rows, total: rows.length });
  } catch (err) {
    console.error('[points/leaderboard]', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── GET /api/points/referral/:code ──────────────────────────────────────────
router.get('/referral/:code', async (req, res) => {
  try {
    const code = req.params.code.toUpperCase();
    const { data: referrer } = await supabase
      .from('users')
      .select('wallet_address, username, points_total, total_referrals')
      .eq('referral_code', code)
      .maybeSingle();

    if (!referrer) return res.status(404).json({ success: false, error: 'Referral code not found' });

    res.json({
      success: true,
      display: referrer.username || `${referrer.wallet_address.slice(0,6)}…${referrer.wallet_address.slice(-4)}`,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── GET /api/points/referrals/:wallet ────────────────────────────────────────
// Returns the list of users referred by this wallet.
router.get('/referrals/:wallet', async (req, res) => {
  try {
    const addr = req.params.wallet.toLowerCase();

    const { data: me } = await supabase
      .from('users')
      .select('id, total_referrals, referral_code')
      .eq('wallet_address', addr)
      .maybeSingle();

    if (!me) return res.status(404).json({ success: false, error: 'User not found' });

    const { data: refs } = await supabase
      .from('referrals')
      .select(`
        points_awarded, created_at,
        referred:referred_user_id (wallet_address, username, points_total, created_at)
      `)
      .eq('referrer_user_id', me.id)
      .order('created_at', { ascending: false });

    const pointsFromReferrals = (refs || []).reduce((s, r) => s + r.points_awarded, 0);

    res.json({
      success: true,
      referralCode:      me.referral_code,
      totalReferrals:    me.total_referrals,
      pointsFromReferrals,
      referrals: (refs || []).map(r => ({
        wallet:    r.referred.wallet_address,
        username:  r.referred.username,
        points:    r.referred.points_total,
        joinDate:  r.referred.created_at,
        bonusAwarded: r.points_awarded,
      })),
    });
  } catch (err) {
    console.error('[points/referrals]', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── POST /api/points/evm ─────────────────────────────────────────────────────
// Save user's EVM address for WL.
router.post('/evm', async (req, res) => {
  try {
    const { wallet, evmAddress } = req.body;
    if (!wallet || !evmAddress) {
      return res.status(400).json({ success: false, error: 'wallet and evmAddress required' });
    }
    if (!EVM_ADDRESS_RE.test(evmAddress)) {
      return res.status(400).json({ success: false, error: 'Invalid EVM address format' });
    }

    const addr = wallet.toLowerCase();
    const { data: user } = await supabase
      .from('users').select('id, wl_status, is_top_50').eq('wallet_address', addr).maybeSingle();

    if (!user) return res.status(404).json({ success: false, error: 'User not found' });

    await supabase.from('users').update({ evm_address: evmAddress }).eq('id', user.id);

    // If already WL-qualified, ensure they're in whitelist table
    if (user.wl_status || user.is_top_50) {
      const qualType = user.is_top_50 ? 'top50' : 'points';
      await supabase.from('whitelist').upsert({
        user_id:            user.id,
        evm_address:        evmAddress,
        qualification_type: qualType,
        added_by:           'system',
      }, { onConflict: 'user_id' });
    }

    res.json({ success: true, evmAddress });
  } catch (err) {
    console.error('[points/evm]', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── GET /api/points/stats ────────────────────────────────────────────────────
// Platform-wide stats for the points page header.
router.get('/stats', async (req, res) => {
  try {
    const { count: totalUsers } = await supabase
      .from('users').select('id', { count: 'exact', head: true });

    const { count: wlCount } = await supabase
      .from('users').select('id', { count: 'exact', head: true }).eq('wl_status', true);

    const { count: evmCount } = await supabase
      .from('users').select('id', { count: 'exact', head: true }).not('evm_address', 'is', null);

    const { data: top } = await supabase
      .from('users').select('points_total').order('points_total', { ascending: false }).limit(1).single();

    res.json({
      success:    true,
      totalUsers: totalUsers || 0,
      wlCount:    wlCount    || 0,
      evmCount:   evmCount   || 0,
      maxPoints:  top?.points_total || 0,
      wlTotal:    1000,
      fcfsSpots:  100,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
