import express from 'express';
import cors from 'cors';
import Stripe from 'stripe';

const app = express();
const port = process.env.PORT || 3000;

const SUPABASE_URL = 'https://ncqrxtczvcpjocurlwzb.supabase.co';
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const TIER_ANALYSIS_LIMIT = { free: 3, pro: 10, premium: 20 };
const TIER_XSENT_LIMIT = { free: 0, pro: 2, premium: 4 };
const TIER_SAVED_LIMIT = { free: 2, pro: 10, premium: Infinity };
const TIER_FABLE_LIMIT = { free: 0, pro: 1, premium: 5 };

app.use(cors({ origin: '*', methods: ['GET', 'POST', 'DELETE', 'OPTIONS'], allowedHeaders: ['Content-Type', 'Authorization'] }));

// ── Stripe Webhook — MUST come before express.json(), needs raw body for signature verification ──
app.post('/api/stripe-webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('[Stripe Webhook] Signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }
  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const userId = session.client_reference_id || session.metadata?.userId;
      const tier = session.metadata?.tier === 'premium' ? 'premium' : 'pro';
      if (userId) {
        await setTier(userId, tier);
        console.log(`[Stripe Webhook] User ${userId} upgraded to ${tier}.`);
      }
    }
    if (event.type === 'customer.subscription.deleted' || event.type === 'customer.subscription.updated') {
      const subscription = event.data.object;
      const isActive = subscription.status === 'active' || subscription.status === 'trialing';
      const userId = subscription.metadata?.userId;
      const tier = isActive ? (subscription.metadata?.tier === 'premium' ? 'premium' : 'pro') : 'free';
      if (userId) {
        await setTier(userId, tier);
        console.log(`[Stripe Webhook] User ${userId} tier set to ${tier} (subscription ${subscription.status}).`);
      }
    }
    res.json({ received: true });
  } catch (err) {
    console.error('[Stripe Webhook] Handler error:', err.message);
    res.status(500).send('Webhook handler failed');
  }
});

app.use(express.json());

app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));

app.get('/api/pro-status', async (req, res) => {
  const tier = await getUserTier(req.headers['authorization']);
  res.json({ tier, isPro: tier !== 'free' });
});

// ── Saved analyses (Watchlist) ───────────────────────────────────────────────
// Reads/writes the existing `saved_analyses` table (unique on user_id,ticker).
// Uses the service-role key (bypasses RLS) but always scopes by user_id manually.
function savedHeaders(extra) {
  return {
    'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
    'apikey': process.env.SUPABASE_SERVICE_ROLE_KEY,
    ...(extra || {})
  };
}

// GET all saved analyses for the logged-in user (newest first)
app.get('/api/saved-analyses', async (req, res) => {
  const userId = await getUserId(req.headers['authorization']);
  if (!userId) return res.status(401).json({ error: 'not_signed_in' });
  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/saved_analyses?user_id=eq.${userId}&select=ticker,analysis_data,created_at,updated_at&order=updated_at.desc`,
      { headers: savedHeaders() }
    );
    if (!r.ok) { console.error('[saved-analyses GET] failed:', await r.text()); return res.status(500).json({ error: 'fetch_failed' }); }
    res.json({ savedAnalyses: await r.json() });
  } catch (e) {
    console.error('[saved-analyses GET] error:', e.message);
    res.status(500).json({ error: 'fetch_failed' });
  }
});

// Save or overwrite the analysis for a ticker. The tier watchlist cap (TIER_SAVED_LIMIT)
// applies only to *new* tickers; overwriting an already-saved ticker is always allowed.
app.post('/api/save-analysis', async (req, res) => {
  const userId = await getUserId(req.headers['authorization']);
  if (!userId) return res.status(401).json({ error: 'not_signed_in' });
  const { ticker, analysis_data } = req.body || {};
  if (!ticker || !analysis_data) return res.status(400).json({ error: 'ticker_and_data_required' });
  const tickerUp = String(ticker).toUpperCase();
  try {
    const tier = await getUserTier(req.headers['authorization']);
    const savedLimit = TIER_SAVED_LIMIT[tier];
    const existRes = await fetch(
      `${SUPABASE_URL}/rest/v1/saved_analyses?user_id=eq.${userId}&select=ticker`,
      { headers: savedHeaders() }
    );
    if (!existRes.ok) { console.error('[save-analysis] existence check failed:', await existRes.text()); return res.status(500).json({ error: 'save_failed' }); }
    const existing = await existRes.json();
    const alreadySaved = existing.some(r => r.ticker === tickerUp);

    if (!alreadySaved && existing.length >= savedLimit) {
      return res.status(403).json({ error: 'free_limit_reached', limit: savedLimit, tier });
    }

    const now = new Date().toISOString();
    const upsertRes = await fetch(
      `${SUPABASE_URL}/rest/v1/saved_analyses?on_conflict=user_id,ticker`,
      {
        method: 'POST',
        headers: savedHeaders({ 'Content-Type': 'application/json', 'Prefer': 'resolution=merge-duplicates,return=representation' }),
        body: JSON.stringify({ user_id: userId, ticker: tickerUp, analysis_data, updated_at: now })
      }
    );
    if (!upsertRes.ok) { console.error('[save-analysis] upsert failed:', await upsertRes.text()); return res.status(500).json({ error: 'save_failed' }); }
    const saved = await upsertRes.json();
    res.json({ saved: Array.isArray(saved) ? saved[0] : saved, overwrote: alreadySaved });
  } catch (e) {
    console.error('[save-analysis] error:', e.message);
    res.status(500).json({ error: 'save_failed' });
  }
});

// Delete a saved analysis (frees a free-tier slot)
app.delete('/api/saved-analysis/:ticker', async (req, res) => {
  const userId = await getUserId(req.headers['authorization']);
  if (!userId) return res.status(401).json({ error: 'not_signed_in' });
  const tickerUp = String(req.params.ticker || '').toUpperCase();
  if (!tickerUp) return res.status(400).json({ error: 'ticker_required' });
  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/saved_analyses?user_id=eq.${userId}&ticker=eq.${encodeURIComponent(tickerUp)}`,
      { method: 'DELETE', headers: savedHeaders({ 'Prefer': 'return=minimal' }) }
    );
    if (!r.ok) { console.error('[saved-analysis DELETE] failed:', await r.text()); return res.status(500).json({ error: 'delete_failed' }); }
    res.json({ deleted: tickerUp });
  } catch (e) {
    console.error('[saved-analysis DELETE] error:', e.message);
    res.status(500).json({ error: 'delete_failed' });
  }
});

// Robust JSON extractor — tracks brace depth and string boundaries
function extractJSON(text) {
  const start = text.indexOf('{');
  if (start === -1) return text;
  let depth = 0, inString = false, escaped = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (escaped) { escaped = false; continue; }
    if (c === '\\' && inString) { escaped = true; continue; }
    if (c === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (c === '{') depth++;
    if (c === '}') { depth--; if (depth === 0) return text.slice(start, i + 1); }
  }
  return text.slice(start);
}

// ── Brave Search — fetch live web results to inject into model prompts ──────
// Returns a compact text block (title / snippet / url) for the top results, or
// throws on HTTP error / timeout / empty results so the caller can fall back.
async function braveSearch(query) {
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=5`;
  const res = await fetch(url, {
    headers: {
      'Accept': 'application/json',
      'Accept-Encoding': 'gzip',
      'X-Subscription-Token': process.env.BRAVE_API_KEY
    },
    signal: AbortSignal.timeout(8000)
  });
  if (!res.ok) {
    throw new Error(`Brave API returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const data = await res.json();
  const results = data?.web?.results || [];
  if (!results.length) throw new Error('Brave returned no web results');
  return results.slice(0, 5).map((r, i) => {
    const title = (r.title || '').trim();
    const snippet = (r.description || '').replace(/<\/?[^>]+>/g, '').trim(); // strip Brave <strong> highlight tags
    const age = (r.age || r.page_age || '').toString().trim();
    return `${i + 1}. ${title}${age ? ` — ${age}` : ''}\n${snippet}\n${r.url || ''}`;
  }).join('\n\n');
}

// Prepend a live-search block to a model prompt (no-op if the search came back empty).
function withLiveSearch(ticker, searchBlock, prompt) {
  if (!searchBlock) return prompt;
  return `Current information from a live web search for ${ticker} (use this for current price, recent news, and dates — it is more up to date than your training data):\n\n${searchBlock}\n\n---\n\n${prompt}`;
}

// ── Single Claude call (Haiku OR Fable 5), with real error surfacing ──────────
// Fable 5 (`claude-fable-5`) is a REASONING model: thinking is always on and draws
// from max_tokens, so a small max_tokens (fine for Haiku) truncates Fable's output
// to nothing and the JSON parse fails. We give Fable a large budget + low effort
// (we only need a short JSON verdict) and NEVER send `thinking`/`temperature`
// (both 400 on Fable). Every failure mode is logged loudly and thrown — nothing is
// swallowed — so a Fable failure surfaces as a real error instead of a fake success.
async function callAnthropicMessages(modelId, systemPrompt, userContent, tier) {
  const isFable = modelId === 'claude-fable-5';
  const body = {
    model: modelId,
    max_tokens: isFable ? 8000 : (tier !== 'free' ? 450 : 250),
    system: systemPrompt,
    messages: [{ role: 'user', content: userContent }]
  };
  // effort is supported on Fable (reasoning) but 400s on Haiku — only send it for Fable.
  if (isFable) body.output_config = { effort: 'low' };

  let response, data;
  try {
    response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(90000) // Fable can think for a while; cap it
    });
  } catch (e) {
    console.error(`[Claude] ${modelId} request failed (network/timeout): ${e.message}`);
    throw new Error(`Claude (${modelId}) request failed: ${e.message}`);
  }

  data = await response.json().catch(() => ({}));

  if (!response.ok || data.error) {
    const detail = JSON.stringify(data.error || data).slice(0, 600);
    console.error(`[Claude] ${modelId} API error — HTTP ${response.status}: ${detail}`);
    throw new Error(`Claude (${modelId}) API error (HTTP ${response.status}): ${data?.error?.message || 'unknown'}`);
  }
  if (data.stop_reason === 'refusal') {
    console.error(`[Claude] ${modelId} REFUSED (category=${data.stop_details?.category ?? 'n/a'}) — returning error, not a result`);
    throw new Error(`Claude (${modelId}) declined this request (${data.stop_details?.category || 'refusal'})`);
  }

  // COST WATCH: log real token usage per call so the Fable 5 caps can be validated
  // against actual $. Fable 5 output (INCLUDES thinking tokens) bills at $50/1M,
  // input at $10/1M; Haiku at $5/$1 per 1M. output_tokens here already covers the
  // reasoning tokens, so this is the true per-call cost.
  if (data.usage) {
    const inTok = data.usage.input_tokens || 0;
    const outTok = data.usage.output_tokens || 0;
    const cost = isFable ? (inTok / 1e6 * 10 + outTok / 1e6 * 50) : (inTok / 1e6 * 1 + outTok / 1e6 * 5);
    console.log(`[Claude][cost] ${modelId} — input=${inTok} output=${outTok} (of ${body.max_tokens} max) → ~$${cost.toFixed(4)} this call`);
  }

  const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  if (!text) {
    console.error(`[Claude] ${modelId} returned NO text — stop_reason=${data.stop_reason}, output_tokens=${data.usage?.output_tokens}. If stop_reason=max_tokens, max_tokens is too low for this model (thinking consumed the budget).`);
    throw new Error(`Claude (${modelId}) returned no text (stop_reason=${data.stop_reason})`);
  }

  const stripped = text.replace(/```json|```/g, '').trim();
  try {
    return JSON.parse(extractJSON(stripped));
  } catch (e) {
    console.error(`[Claude] ${modelId} JSON parse failed: ${e.message}. Raw text (first 600):`, stripped.slice(0, 600));
    throw new Error(`Claude (${modelId}) JSON parse failed: ${e.message}`);
  }
}

// ── Verify Supabase token and look up the user's membership tier ───────────
async function getUserTier(authHeader) {
  if (!authHeader || !authHeader.startsWith('Bearer ')) return 'free';
  const token = authHeader.slice(7);
  try {
    const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { 'Authorization': `Bearer ${token}`, 'apikey': process.env.SUPABASE_SERVICE_ROLE_KEY }
    });
    if (!userRes.ok) return 'free';
    const userData = await userRes.json();
    const userId = userData?.id;
    if (!userId) return 'free';
    const profileRes = await fetch(
      `${SUPABASE_URL}/rest/v1/profiles?id=eq.${userId}&select=tier`,
      { headers: { 'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`, 'apikey': process.env.SUPABASE_SERVICE_ROLE_KEY } }
    );
    if (!profileRes.ok) return 'free';
    const profiles = await profileRes.json();
    const tier = profiles?.[0]?.tier;
    return (tier === 'pro' || tier === 'premium') ? tier : 'free';
  } catch (e) {
    console.warn('Tier check failed:', e.message);
    return 'free';
  }
}

// ── Get the Supabase user ID from an auth header, or null if not signed in ──
async function getUserId(authHeader) {
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7);
  try {
    const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { 'Authorization': `Bearer ${token}`, 'apikey': process.env.SUPABASE_SERVICE_ROLE_KEY }
    });
    if (!userRes.ok) return null;
    const userData = await userRes.json();
    return userData?.id || null;
  } catch (e) {
    return null;
  }
}

// ── Write the membership tier to the Supabase profiles table ──────────────
// IMPORTANT: a plain PATCH updates 0 rows (but still returns 200) when the user
// has no profiles row yet — which silently loses the upgrade and leaves a paying
// user stuck on 'free'. So we PATCH first, and if nothing was updated we INSERT
// the row. `return=representation` lets us detect the 0-rows case.
async function setTier(userId, tier) {
  const authHeaders = {
    'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
    'apikey': process.env.SUPABASE_SERVICE_ROLE_KEY,
    'Content-Type': 'application/json'
  };
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/profiles?id=eq.${userId}`,
      { method: 'PATCH', headers: { ...authHeaders, 'Prefer': 'return=representation' }, body: JSON.stringify({ tier }) }
    );
    if (!res.ok) {
      console.error(`[setTier] PATCH failed for user ${userId}:`, await res.text());
      return;
    }
    const updated = await res.json();
    if (Array.isArray(updated) && updated.length === 0) {
      // No existing profile row — create one so the tier actually persists.
      const insRes = await fetch(
        `${SUPABASE_URL}/rest/v1/profiles`,
        {
          method: 'POST',
          headers: { ...authHeaders, 'Prefer': 'resolution=merge-duplicates,return=minimal' },
          body: JSON.stringify({ id: userId, tier })
        }
      );
      if (!insRes.ok) {
        console.error(`[setTier] INSERT fallback failed for user ${userId}:`, await insRes.text());
      } else {
        console.log(`[setTier] Created profiles row for ${userId} with tier=${tier}.`);
      }
    }
  } catch (e) {
    console.error(`[setTier] Error updating user ${userId}:`, e.message);
  }
}

// ── Get a usable identifier for usage tracking: userId if signed in, else IP ──
function getRequestIdentifier(req, userId) {
  if (userId) return `user:${userId}`;
  // x-forwarded-for can contain a list "client, proxy1, proxy2" — take the first
  const forwarded = req.headers['x-forwarded-for'];
  const ip = forwarded ? forwarded.split(',')[0].trim() : req.socket?.remoteAddress || 'unknown';
  return `ip:${ip}`;
}

// ── Check today's usage count for an identifier and increment if allowed ──
// Returns { allowed: boolean, remaining: number }
async function checkAndIncrementUsage(identifier, limit) {
  const today = new Date().toISOString().slice(0, 10); // "YYYY-MM-DD" in UTC

  try {
    // Read current count for today
    const getRes = await fetch(
      `${SUPABASE_URL}/rest/v1/usage?identifier=eq.${encodeURIComponent(identifier)}&date=eq.${today}&select=count`,
      { headers: { 'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`, 'apikey': process.env.SUPABASE_SERVICE_ROLE_KEY } }
    );
    if (!getRes.ok) {
      console.error('[Usage] Failed to read usage row:', await getRes.text());
      // Fail open — don't block users if our own tracking breaks
      return { allowed: true, remaining: limit };
    }
    const rows = await getRes.json();
    const currentCount = rows?.[0]?.count ?? 0;

    if (currentCount >= limit) {
      return { allowed: false, remaining: 0 };
    }

    const newCount = currentCount + 1;

    // Upsert — insert if no row for today yet, update count if it exists
    const upsertRes = await fetch(
      `${SUPABASE_URL}/rest/v1/usage`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
          'apikey': process.env.SUPABASE_SERVICE_ROLE_KEY,
          'Content-Type': 'application/json',
          'Prefer': 'resolution=merge-duplicates,return=minimal'
        },
        body: JSON.stringify({ identifier, date: today, count: newCount })
      }
    );
    if (!upsertRes.ok) {
      console.error('[Usage] Failed to upsert usage row:', await upsertRes.text());
      // Fail open here too — a tracking write failure shouldn't block a real user
      return { allowed: true, remaining: limit - newCount };
    }

    return { allowed: true, remaining: limit - newCount };
  } catch (e) {
    console.error('[Usage] Unexpected error:', e.message);
    return { allowed: true, remaining: limit };
  }
}

// ── Read today's usage count for an identifier WITHOUT incrementing it ──
// Used to report remaining quota (e.g. Fable 5) when we aren't consuming a use.
// Returns 0 on any error so callers can compute a non-negative remaining.
async function getUsageCount(identifier) {
  const today = new Date().toISOString().slice(0, 10);
  try {
    const getRes = await fetch(
      `${SUPABASE_URL}/rest/v1/usage?identifier=eq.${encodeURIComponent(identifier)}&date=eq.${today}&select=count`,
      { headers: { 'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`, 'apikey': process.env.SUPABASE_SERVICE_ROLE_KEY } }
    );
    if (!getRes.ok) return 0;
    const rows = await getRes.json();
    return rows?.[0]?.count ?? 0;
  } catch (e) {
    console.warn('[Usage] getUsageCount failed:', e.message);
    return 0;
  }
}

// ── Create a Stripe Checkout session for Pro upgrade ──────────────────────
app.post('/api/create-checkout-session', async (req, res) => {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Must be signed in to upgrade' });
  }
  const token = authHeader.slice(7);
  try {
    const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { 'Authorization': `Bearer ${token}`, 'apikey': process.env.SUPABASE_SERVICE_ROLE_KEY }
    });
    if (!userRes.ok) return res.status(401).json({ error: 'Invalid session' });
    const userData = await userRes.json();
    const userId = userData?.id;
    const userEmail = userData?.email;
    if (!userId) return res.status(401).json({ error: 'Invalid session' });

    const { origin, plan } = req.body;
    const tier = plan === 'premium' ? 'premium' : 'pro';
    const priceId = tier === 'premium' ? process.env.STRIPE_PREMIUM_PRICE_ID : process.env.STRIPE_PRICE_ID;
    const fallback = 'https://truetradeai.com';
    let baseUrl = fallback;
    if (origin) {
      try {
        const parsed = new URL(origin);
        const candidate = parsed.origin;
        if (candidate && candidate !== 'null' && (candidate.startsWith('https://') || candidate.startsWith('http://'))) {
          baseUrl = candidate;
        } else {
          console.warn(`[Checkout Session] Non-HTTP origin "${candidate}" — using fallback`);
        }
      } catch {
        console.warn(`[Checkout Session] Invalid origin received: "${origin}" — using fallback`);
      }
    }
    const successUrl = `${baseUrl}?upgrade=success`;
    const cancelUrl = `${baseUrl}?upgrade=cancelled`;

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      customer_email: userEmail,
      client_reference_id: userId,
      metadata: { userId, tier },
      subscription_data: { metadata: { userId, tier } },
      success_url: successUrl,
      cancel_url: cancelUrl
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error('[Checkout Session] Error:', err.message);
    console.error('[Checkout Session] Stack:', err.stack);
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
});

// Standalone Grok X-Sentiment (its own gated feature, separate from /api/analyze).
async function callGrokXSentiment(ticker) {
  const xSentimentPrompt = `Search X (Twitter) for the most recent posts and discussion about ${ticker} stock. Based ONLY on what people are actually saying on X right now, gauge retail/social sentiment.

Respond ONLY with a valid JSON object — no markdown, no explanation, no backticks. Use exactly these fields:
{
  "sentimentScore": <number 0-100, where 0=extremely bearish social mood, 50=mixed/neutral, 100=extremely bullish social mood>,
  "summary": <2 sentences in plain language describing what people on X are actually saying right now about this stock and why sentiment leans the way it does. No jargon.>
}`;
  const response = await fetch('https://api.x.ai/v1/responses', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.GROK_API_KEY}` },
    body: JSON.stringify({
      model: 'grok-4-1-fast-non-reasoning',
      input: [{ role: 'user', content: xSentimentPrompt }],
      tools: [{ type: 'x_search' }],
      max_turns: 1
    })
  });
  const data = await response.json();
  if (data.error) throw new Error(data.error.message || 'Grok X-Sentiment request failed');
  const outputText = data.output?.flatMap(item => item.content || [])?.filter(c => c.type === 'output_text' || c.text)?.map(c => c.text)?.join('') || '';
  if (!outputText) throw new Error('Grok X-Sentiment returned no text content');
  const stripped = outputText.replace(/```json|```/g, '').trim();
  return JSON.parse(extractJSON(stripped));
}

// POST /api/x-sentiment — gated, daily-capped feature (Free 0 / Pro 2 / Premium 4)
app.post('/api/x-sentiment', async (req, res) => {
  const { ticker } = req.body;
  if (!ticker) return res.status(400).json({ error: 'ticker required' });
  const tier = await getUserTier(req.headers['authorization']);
  const userId = await getUserId(req.headers['authorization']);
  const limit = TIER_XSENT_LIMIT[tier];
  if (!limit || limit <= 0) {
    return res.status(403).json({ error: 'tier_locked', message: 'X-Sentiment is a Pro feature — upgrade to unlock it.', tier, xSentRemaining: 0 });
  }
  const usage = await checkAndIncrementUsage(`xsent:${getRequestIdentifier(req, userId)}`, limit);
  if (!usage.allowed) {
    return res.status(429).json({ error: 'xsent_limit_reached', message: `You've used all ${limit} X-Sentiment checks for today on the ${tier} plan.`, tier, xSentRemaining: 0 });
  }
  try {
    const result = await callGrokXSentiment(String(ticker).toUpperCase());
    res.json({ score: result.sentimentScore ?? 50, summary: result.summary || null, tier, xSentRemaining: usage.remaining });
  } catch (e) {
    console.error(`[x-sentiment] ${ticker} failed:`, e.message);
    res.status(500).json({ error: e.message, tier });
  }
});

// ── Shared analyst system prompt + detailed (paid) prompt builder ──────────
// Hoisted so both /api/analyze and the single-model /api/analyze-model endpoint
// use the exact same prompt (no divergence).
const SYSTEM_PROMPT = `You are a senior equity research analyst at a top-tier investment bank with 20 years of experience. You provide rigorous, data-driven stock analysis. You always search for the most recent news, earnings reports, analyst upgrades/downgrades, and sector developments before forming your view. Your analysis is balanced — you identify both genuine opportunities and real risks. You never give generic responses. Every insight must be specific to this company right now.`;

function buildProShortPrompt(ticker) {
  return `Analyze ${ticker} as a stock investment based on current market conditions, recent news, and fundamentals. Consider the current broader market environment and any recent significant price moves.

Respond ONLY with a valid JSON object — no markdown, no explanation, no backticks. Use exactly these fields:
{
  "bullScore": <number 0-100, overall bull conviction — be honest and critical>,
  "bearScore": <number 0-100, overall bear conviction>,
  "verdict": <one of: "Strong Buy", "Bullish", "Lean Buy", "Neutral", "Lean Sell", "Bearish", "Strong Sell">,
  "confidence": <number 0-100, how confident you are>,
  "bullScore1W": <number 0-100, bull conviction for next 7 days ONLY — weight recent price momentum, current market sentiment, and short-term macro events. Be skeptical if the stock has run hard recently>,
  "bullScore1M": <number 0-100, bull conviction for next 30 days>,
  "bullScore1Y": <number 0-100, bull conviction for next 12 months — weight fundamentals and long-term outlook>,
  "reasoning": <3-4 sentences explaining what you weighted most and why you landed where you did. Write for a smart retail investor with no finance jargon — explain any technical term in plain words the moment you use it. Be specific to this stock right now, not generic boilerplate.>
}`;
}

// Run ONLY the Claude slot for a ticker with a specific model. Mirrors the
// callClaude() inside /api/analyze (Brave live search + detailed pro prompt),
// standalone so a Haiku↔Fable 5 swap can refresh just that card.
async function runSingleClaude(ticker, useFableModel) {
  const modelId = useFableModel ? 'claude-fable-5' : 'claude-haiku-4-5-20251001';
  let searchBlock = '';
  try {
    searchBlock = await braveSearch(`${ticker} stock news today`);
  } catch (e) {
    console.warn(`[analyze-model] Brave search failed for ${ticker}: ${e.message} — proceeding without`);
  }
  const result = await callAnthropicMessages(
    modelId,
    SYSTEM_PROMPT,
    withLiveSearch(ticker, searchBlock, buildProShortPrompt(ticker)),
    'pro' // Fable/single-model refresh is paid-only; use the detailed token budget
  );
  return { ...result, model: 'Claude' };
}

// POST /api/analyze-model — re-run a single model card (currently only the Claude
// slot, for a Haiku↔Fable 5 swap). Applies the same Fable daily-cap + silent
// Haiku fallback as /api/analyze, but does NOT touch the daily *analysis* cap —
// this is a scoped single-model refresh, not a new full analysis.
app.post('/api/analyze-model', async (req, res) => {
  const { ticker, model } = req.body || {};
  if (!ticker) return res.status(400).json({ error: 'ticker required' });
  if (model && model !== 'claude') return res.status(400).json({ error: 'unsupported_model' });
  const tier = await getUserTier(req.headers['authorization']);
  const userId = await getUserId(req.headers['authorization']);
  const fableLimit = TIER_FABLE_LIMIT[tier] || 0;
  const fableId = `fable:${getRequestIdentifier(req, userId)}`;
  const wantsFable = req.body?.useFable === true && tier !== 'free' && fableLimit > 0;
  let useFableModel = false;
  let fableRemaining;
  if (wantsFable) {
    const fableUsage = await checkAndIncrementUsage(fableId, fableLimit);
    useFableModel = fableUsage.allowed;
    fableRemaining = fableUsage.remaining;
  } else {
    fableRemaining = Math.max(0, fableLimit - await getUsageCount(fableId));
  }
  try {
    const result = await runSingleClaude(String(ticker).toUpperCase(), useFableModel);
    res.json({
      model: 'Claude',
      bullScore: result.bullScore ?? 50,
      reasoning: result.reasoning || null,
      confidence: result.confidence ?? null,
      bullScore1W: result.bullScore1W ?? null,
      bullScore1M: result.bullScore1M ?? null,
      bullScore1Y: result.bullScore1Y ?? null,
      claudeModel: useFableModel ? 'Claude Fable 5' : 'Claude Haiku 4.5',
      fableUsed: useFableModel,
      fableRemaining,
      fableLimit,
      tier
    });
  } catch (e) {
    console.error(`[analyze-model] ${ticker} failed:`, e.message);
    res.status(500).json({ error: e.message, tier });
  }
});

app.post('/api/analyze', async (req, res) => {
  const { ticker } = req.body;
  if (!ticker) return res.status(400).json({ error: 'ticker required' });

  const tier = await getUserTier(req.headers['authorization']);
  const userId = await getUserId(req.headers['authorization']);

  // ── Daily analysis cap (all tiers: free 3 / pro 10 / premium 20) — BEFORE any AI calls ──
  const analysisLimit = TIER_ANALYSIS_LIMIT[tier];
  const usage = await checkAndIncrementUsage(getRequestIdentifier(req, userId), analysisLimit);
  if (!usage.allowed) {
    return res.status(429).json({
      error: 'Daily limit reached',
      message: `You've used all ${analysisLimit} analyses for today on the ${tier} plan.${tier === 'premium' ? ' Try again tomorrow.' : ' Upgrade for a higher daily limit, or try again tomorrow.'}`,
      usageRemaining: 0,
      tier
    });
  }
  const usageRemaining = usage.remaining;

  // ── Claude slot model selection (Haiku default, Fable 5 as a daily-capped swap) ──
  // Free tier is ALWAYS Haiku regardless of any client-sent preference (defensive —
  // never trust the frontend). Paid tiers may swap to Fable 5 up to their daily cap;
  // once the cap is hit we silently fall back to Haiku instead of erroring.
  const fableLimit = TIER_FABLE_LIMIT[tier] || 0;
  const fableId = `fable:${getRequestIdentifier(req, userId)}`;
  const wantsFable = req.body?.useFable === true && tier !== 'free' && fableLimit > 0;
  let useFableModel = false;
  let fableRemaining;
  if (wantsFable) {
    const fableUsage = await checkAndIncrementUsage(fableId, fableLimit);
    useFableModel = fableUsage.allowed;      // false once today's cap is reached
    fableRemaining = fableUsage.remaining;   // remaining after this use, or 0 if capped
  } else {
    // Not consuming a Fable use — just report how many are left today.
    fableRemaining = Math.max(0, fableLimit - await getUsageCount(fableId));
  }
  const claudeModelId = useFableModel ? 'claude-fable-5' : 'claude-haiku-4-5-20251001';
  const claudeModelName = useFableModel ? 'Claude Fable 5' : 'Claude Haiku 4.5';

  const systemPrompt = SYSTEM_PROMPT;

  const geminiPrompt = `Search the web for the latest information on ${ticker} and analyze it as a stock investment. Find the most current live market data available.

Respond ONLY with a valid JSON object — no markdown, no explanation, no backticks. Use exactly these fields:
{
  "companyName": <full company name e.g. "Apple Inc.">,
  "currentPrice": <current stock price as a number>,
  "peRatio": <trailing P/E ratio as a number, or null if not available>,
  "marketCap": <market cap as a formatted string e.g. "$3.2T" or "$450B">,
  "week52Low": <52-week low price as a number>,
  "week52High": <52-week high price as a number>,
  "bullScore": <number 0-100, your honest bull conviction>,
  "bearScore": <number 0-100, your honest bear conviction>,
  "verdict": <one of: "Strong Buy", "Bullish", "Lean Buy", "Neutral", "Lean Sell", "Bearish", "Strong Sell">,
  "bullCase": <2-3 specific sentences on the strongest bull argument RIGHT NOW>,
  "bearCase": <2-3 specific sentences on the most serious bear risk RIGHT NOW>,
  "topCatalyst": <single most important upcoming catalyst>,
  "topRisk": <single most important near-term risk>,
  "confidence": <number 0-100, how confident you are in this analysis>,
  "sector": <the stock's sector e.g. "Technology", "Healthcare", "Energy">,
  "industry": <the specific industry e.g. "Semiconductors", "Drug Manufacturers", "Consumer Electronics">,
  "description": <2 sentence company description — what they do and why they matter>,
  "riskProfile": <number 1-10, where 1=very stable blue chip, 10=highly speculative>,
  "bullCatalysts": <array of 3-4 objects with fields: text (string, the catalyst itself, 1 sentence), date (string like "Jul 2026"), status ("upcoming" if future, "prior" if already happened), detail (string, 2-3 sentences elaborating on THIS SPECIFIC catalyst only — why it matters and what would need to happen for it to play out, plain language, explain any technical term the moment you use it)>,
  "bearRisks": <array of 3-4 objects with fields: text (string, the risk itself, 1 sentence), detail (string, 2-3 sentences elaborating on THIS SPECIFIC risk only — why it matters and what could trigger it, plain language, explain any technical term the moment you use it)>,
  "news": <array of 3-4 objects — ONLY from last 60 days. Fields: title (string), date (string like "Jun 2026"), tag (one of EARNINGS/NEWS/EVENT/DIVIDEND), detail (string, 2-3 sentences elaborating on THIS SPECIFIC news item only — what happened, why it matters to investors, plain language, explain any technical term the moment you use it)>,
  "bullScore1W": <number 0-100, bull conviction for next 7 days ONLY. Weight heavily: recent price momentum (has it run hard already?), this week's macro events, market sentiment right now, short-term overbought/oversold conditions. Be skeptical of stocks up 15%+ in the last 30 days>,
  "bullScore1M": <number 0-100, bull conviction for next 30 days. Weight: upcoming earnings, sector rotation, news cycle, medium-term trend, whether recent price move is sustainable>,
  "bullScore1Y": <number 0-100, bull conviction for next 12 months. Weight: fundamentals, competitive moat, macro tailwinds, long-term valuation vs growth potential>,
  "earningsDate": <next scheduled earnings date as a string e.g. "Jul 24, 2026", or "Unknown">,
  "analystPriceTarget": <average Wall Street analyst price target as a number, or null>,
  "dividendYield": <dividend yield as a string e.g. "1.8%" or "None">,
  "analystBuy": <percentage of analysts with Buy rating, 0-100>,
  "analystHold": <percentage of analysts with Hold rating, 0-100>,
  "analystSell": <percentage of analysts with Sell rating, 0-100>,
  "stockSentimentScore": <number 0-100 where 0=extremely oversold, 50=neutral, 100=extremely overbought. Evaluate THIS SPECIFIC STOCK independently — based on its own RSI, price vs its 50/200-day moving averages, and recent price momentum. Do NOT anchor to the sector score. A stock can be oversold in a hot sector or overbought in a cold one — reflect that reality>,
  "sectorSentimentScore": <number 0-100, same scale but evaluate the BROADER SECTOR independently — based on sector ETF momentum, recent sector-wide fund flows, and macro tailwinds/headwinds. Reflect the sector as a whole, not this individual stock. These two scores should often differ significantly>,
  "entrySignal": <one of: "Strong Entry", "Good Entry", "Decent Entry", "Wait", "Avoid" — be critical and honest. Consider: has the stock run hard recently? Is the sector overbought? Are there near-term macro risks? Default toward "Wait" if the stock is up 15%+ in the last 30 days without a clear near-term catalyst. "Strong Entry" should be rare>,
  "sentimentAnalysis": <2-3 sentences explaining the stock and sector sentiment positions and what they mean for entry timing>,
  "reasoning": <2-3 sentences on what YOU weighted most in your analysis and why you landed at your verdict — be specific to this stock right now, not generic>
}`;

  const shortPrompt = `Analyze ${ticker} as a stock investment based on current market conditions, recent news, and fundamentals. Consider the current broader market environment and any recent significant price moves.

Respond ONLY with a valid JSON object — no markdown, no explanation, no backticks. Use exactly these fields:
{
  "bullScore": <number 0-100, overall bull conviction — be honest and critical>,
  "bearScore": <number 0-100, overall bear conviction>,
  "verdict": <one of: "Strong Buy", "Bullish", "Lean Buy", "Neutral", "Lean Sell", "Bearish", "Strong Sell">,
  "confidence": <number 0-100, how confident you are>,
  "bullScore1W": <number 0-100, bull conviction for next 7 days ONLY — weight recent price momentum, current market sentiment, and short-term macro events. Be skeptical if the stock has run hard recently>,
  "bullScore1M": <number 0-100, bull conviction for next 30 days>,
  "bullScore1Y": <number 0-100, bull conviction for next 12 months — weight fundamentals and long-term outlook>
}`;

  const proShortPrompt = buildProShortPrompt(ticker);

  const gptClaudePrompt = tier !== 'free' ? proShortPrompt : shortPrompt;

  // One shared Brave search per analysis (identical query for all three models),
  // injected into GPT / Claude / Grok. Fetching once keeps us under Brave's Free
  // tier (1 req/sec + monthly cap) and avoids 3x consumption. On any failure we
  // fall back to running the models without injected results.
  const searchPromise = braveSearch(`${ticker} stock news today`)
    .then(block => { console.log(`[Brave] Live search OK for ${ticker} — injecting ${block.length} chars into GPT/Claude/Grok`); return block; })
    .catch(err => { console.warn(`[Brave] Live search FAILED for ${ticker}: ${err.message} — proceeding WITHOUT injected results (models answer from training data)`); return ''; });

  async function callGemini() {
    async function geminiRequest(modelName, useSearch) {
      const body = {
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: [{ parts: [{ text: geminiPrompt }] }],
        generationConfig: { temperature: 0.2, maxOutputTokens: 16384 }
      };
      if (useSearch) body.tools = [{ google_search: {} }];
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${process.env.GEMINI_API_KEY}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
      );
      return await response.json();
    }

    function extractText(data) {
      const candidate = data.candidates?.[0];
      const finishReason = candidate?.finishReason;
      if (finishReason && finishReason !== 'STOP') {
        console.warn(`[Gemini] ${ticker} finished with reason: ${finishReason} (likely truncated)`);
      }
      return candidate?.content?.parts?.filter(p => p.text).map(p => p.text).join('') || '';
    }

    function isHighDemandError(errMsg) {
      return typeof errMsg === 'string' && errMsg.toLowerCase().includes('high demand');
    }

    let data = await geminiRequest('gemini-3.1-flash-lite', true);

    if (data.error) {
      if (isHighDemandError(data.error.message)) {
        console.warn(`[Gemini] flash-lite overloaded for ${ticker}, falling back to gemini-3-flash-preview...`);
        data = await geminiRequest('gemini-3-flash-preview', true);
        if (data.error) {
          console.error(`[Gemini] Fallback model also errored for ${ticker}:`, data.error.message);
          throw new Error(data.error.message);
        }
      } else {
        console.error(`[Gemini] API error for ${ticker}:`, data.error.message);
        throw new Error(data.error.message);
      }
    }

    let text = extractText(data);

    // IMPORTANT: We deliberately do NOT retry without google_search here.
    // Without live search, Gemini answers from training data alone, which has
    // produced confidently wrong prices and stale (sometimes 2024-dated) news/dates.
    // Wrong data is worse than no data for a financial product — fail honestly instead.
    if (!text) {
      console.error(`[Gemini] Empty response for ${ticker} (search grounding returned nothing). NOT falling back to no-search mode — failing honestly instead of risking stale/wrong data.`);
      throw new Error('Gemini search grounding returned no content — live data unavailable for this ticker right now');
    }

    const stripped = text
      .replace(/<tool_code>[\s\S]*?<\/tool_code>/g, '')
      .replace(/```json|```/g, '').trim();

    try {
      return { ...JSON.parse(extractJSON(stripped)), model: 'Gemini' };
    } catch (parseErr) {
      console.error(`[Gemini] JSON parse failed for ${ticker}. Raw text (first 800 chars):`, stripped.slice(0, 800));
      throw new Error(`Gemini JSON parse failed: ${parseErr.message}`);
    }
  }

  async function callGPT() {
    const searchBlock = await searchPromise;
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        max_tokens: tier !== 'free' ? 450 : 250,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: withLiveSearch(ticker, searchBlock, gptClaudePrompt) }
        ]
      })
    });
    const data = await response.json();
    if (data.error) throw new Error(data.error.message);
    const text = data.choices?.[0]?.message?.content || '';
    const stripped = text.replace(/```json|```/g, '').trim();
    return { ...JSON.parse(extractJSON(stripped)), model: 'GPT-4o' };
  }

  async function callClaude(modelId) {
    const searchBlock = await searchPromise;
    const result = await callAnthropicMessages(
      modelId,
      systemPrompt,
      withLiveSearch(ticker, searchBlock, gptClaudePrompt),
      tier
    );
    return { ...result, model: 'Claude' };
  }

  async function callPerplexity() {
    if (tier === 'free') return null;
    const response = await fetch('https://api.perplexity.ai/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.PERPLEXITY_API_KEY}` },
      body: JSON.stringify({
        model: 'sonar',
        max_tokens: 450,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: proShortPrompt }
        ]
      })
    });
    const data = await response.json();
    if (data.error) throw new Error(data.error.message);
    const text = data.choices?.[0]?.message?.content || '';
    const stripped = text.replace(/```json|```/g, '').trim();
    return { ...JSON.parse(extractJSON(stripped)), model: 'Perplexity' };
  }

  async function callGrok() {
    if (tier === 'free') return null;
    const searchBlock = await searchPromise;
    const response = await fetch('https://api.x.ai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.GROK_API_KEY}` },
      body: JSON.stringify({
        model: 'grok-4-1-fast-non-reasoning',
        max_tokens: 450,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: withLiveSearch(ticker, searchBlock, proShortPrompt) }
        ]
      })
    });
    const data = await response.json();
    if (data.error) throw new Error(data.error.message);
    const text = data.choices?.[0]?.message?.content || '';
    const stripped = text.replace(/```json|```/g, '').trim();
    return { ...JSON.parse(extractJSON(stripped)), model: 'Grok' };
  }

  try {
    const [gemini, gpt, claude, perplexity, grok] = await Promise.allSettled([
      callGemini(),
      callGPT(),
      callClaude(claudeModelId),
      callPerplexity(),
      callGrok()
    ]);

    const results = [
      gemini.status === 'fulfilled' ? gemini.value : { error: gemini.reason?.message, bullScore: 50, bearScore: 50, model: 'Gemini' },
      gpt.status    === 'fulfilled' ? gpt.value    : { error: gpt.reason?.message,    bullScore: 50, bearScore: 50, model: 'GPT-4o' },
      claude.status === 'fulfilled' ? claude.value : { error: claude.reason?.message, bullScore: 50, bearScore: 50, model: 'Claude' },
      perplexity.status === 'fulfilled' ? perplexity.value : { error: perplexity.reason?.message, bullScore: 50, bearScore: 50, model: 'Perplexity' },
      grok.status   === 'fulfilled' ? grok.value   : { error: grok.reason?.message,   bullScore: 50, bearScore: 50, model: 'Grok' }
    ].filter(r => r !== null);

    results.forEach(r => {
      if (r.error) console.error(`[${r.model}] FAILED for ${ticker}: ${r.error}`);
    });

    const valid = results.filter(r => !r.error);
    const avgBull = valid.length
      ? Math.round(valid.reduce((a, b) => a + b.bullScore, 0) / valid.length)
      : 50;
    const avgConfidence = valid.length
      ? Math.round(valid.reduce((a, b) => a + (b.confidence || 70), 0) / valid.length)
      : 70;

    const best = valid.find(r => r.model === 'Gemini') || valid[0] || null;

    res.json({
      ticker,
      tier,
      usageRemaining,
      claudeModel:          claudeModelName,
      fableUsed:            useFableModel,
      fableRemaining,
      fableLimit,
      companyName:          best?.companyName        || ticker,
      currentPrice:         best?.currentPrice       || null,
      peRatio:              best?.peRatio            || null,
      marketCap:            best?.marketCap          || null,
      week52Low:            best?.week52Low          || null,
      week52High:           best?.week52High         || null,
      consensus: { bullScore: avgBull, bearScore: 100 - avgBull, confidence: avgConfidence },
      models: results,
      sector:               best?.sector             || null,
      industry:             best?.industry           || null,
      description:          best?.description        || null,
      riskProfile:          best?.riskProfile        || 5,
      bullCatalysts:        best?.bullCatalysts       || [],
      bearRisks:            best?.bearRisks          || [],
      news:                 best?.news               || [],
      bullScore1W: valid.length ? Math.round(valid.reduce((a, b) => a + (b.bullScore1W ?? b.bullScore), 0) / valid.length) : (best?.bullScore1W ?? avgBull),
      bullScore1M: valid.length ? Math.round(valid.reduce((a, b) => a + (b.bullScore1M ?? b.bullScore), 0) / valid.length) : (best?.bullScore1M ?? avgBull),
      bullScore1Y: valid.length ? Math.round(valid.reduce((a, b) => a + (b.bullScore1Y ?? b.bullScore), 0) / valid.length) : (best?.bullScore1Y ?? avgBull),
      earningsDate:         best?.earningsDate        || null,
      analystPriceTarget:   best?.analystPriceTarget  || null,
      dividendYield:        best?.dividendYield       || null,
      analystBuy:           best?.analystBuy          ?? null,
      analystHold:          best?.analystHold         ?? null,
      analystSell:          best?.analystSell         ?? null,
      stockSentimentScore:  best?.stockSentimentScore ?? 50,
      sectorSentimentScore: best?.sectorSentimentScore ?? 50,
      entrySignal:          best?.entrySignal         || null,
      sentimentAnalysis:    best?.sentimentAnalysis   || null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(port, () => console.log(`TruthTradeAI backend running on port ${port}`));
