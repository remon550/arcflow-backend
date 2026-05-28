const { createClient } = require('@supabase/supabase-js');

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_KEY; // service_role key — never expose to frontend

if (!url || !key) {
  throw new Error(
    '[supabase] SUPABASE_URL and SUPABASE_SERVICE_KEY must be set in .env\n' +
    'Get them from: Supabase Dashboard → Settings → API'
  );
}

const supabase = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false },
});

module.exports = supabase;
