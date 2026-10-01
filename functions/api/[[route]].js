// Cloudflare Pages Function: /api/poll  and  /api/control
// Env vars (Cloudflare dashboard): GROQ_API_KEY, PANTRY_ID, ADMIN_PASSWORD (optional), GROQ_MODEL (optional)

const NAMES = ['Aria', 'Veer'];
const LANGS = {
  hinglish: 'Hinglish (Roman script mein Hindi + thoda English, jaise dost baat karte hain)',
  hindi: 'shuddh Hindi, sirf Devanagari lipi mein',
  english: 'simple casual English',
};
const MAX_MSGS = 60;

const fresh_state = () => ({ status: 'stopped', topic: '', lang: 'hinglish', messages: [], next: 0, nextAt: 0, lease: 0 });
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

const basketUrl = (env) => `https://getpantry.cloud/apiv1/pantry/${env.PANTRY_ID}/basket/aichat`;

let memo = null, memoAt = 0;   // chhota cache: Pantry par bar-bar request na jaye
async function load(env, fresh = false) {
  if (!fresh && memo && Date.now() - memoAt < 2500) return structuredClone(memo);
  let r;
  for (let i = 0; i < 3; i++) {                       // 429 aaye to thoda ruk ke dobara try
    r = await fetch(basketUrl(env), { cf: { cacheTtl: 0 } });
    if (r.status !== 429) break;
    await new Promise((res) => setTimeout(res, 700 * (i + 1)));
  }
  if (r.status === 400 || r.status === 404) return fresh_state();   // basket abhi bana nahi
  if (r.status === 429 && memo) return structuredClone(memo);       // purana state dikha do
  if (!r.ok) throw new Error(`Pantry error ${r.status}`);
  memo = { ...fresh_state(), ...(await r.json()) }; memoAt = Date.now();
  return structuredClone(memo);
}
async function save(env, s) {
  // POST = poora basket replace karta hai (PUT merge karta hai, wo hume nahi chahiye)
  const r = await fetch(basketUrl(env), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(s) });
  if (!r.ok) throw new Error(`Pantry save error ${r.status}`);
  memo = structuredClone(s); memoAt = Date.now();
}

async function generate(env, s) {
  const me = NAMES[s.next], other = NAMES[1 - s.next];
  const system =
    `Tum ${me} ho, ek AI. Tum ${other} (ek aur AI) se baat kar rahe ho. Topic: "${s.topic}". ` +
    `Bhasha: ${LANGS[s.lang]}. Sirf 1-2 chhote sentences bolo, natural bolchal ki tarah. ` +
    `Sirf apna dialogue likho, naam ya prefix mat likho. Har baar kuch naya jodo: raay, sawal ya example. Baat ko dohrao mat.`;
  const history = s.messages.slice(-16).map((m) => ({ role: m.speaker === s.next ? 'assistant' : 'user', content: m.text }));
  if (!history.length || history[history.length - 1].role === 'assistant') {
    history.push({ role: 'user', content: history.length ? 'Aage badho.' : `Baat shuru karo topic par: ${s.topic}` });
  }
  const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.GROQ_API_KEY}` },
    body: JSON.stringify({
      model: env.GROQ_MODEL || 'llama-3.3-70b-versatile',
      messages: [{ role: 'system', content: system }, ...history],
      temperature: 0.9,
      max_tokens: 120,
    }),
  });
  if (!r.ok) throw new Error(`Groq error ${r.status}: ${(await r.text()).slice(0, 150)}`);
  return (await r.json()).choices[0].message.content.trim();
}

const view = (s, env) => ({
  status: s.status, topic: s.topic, lang: s.lang, messages: s.messages, locked: !!env.ADMIN_PASSWORD,
});

// Poll: sab devices yahi call karte hain. Agar agli baari aa chuki hai to ek device naya message bana deta hai.
async function poll(env) {
  let s = await load(env);
  const now = Date.now();
  let error = null;
  if (s.status === 'running' && now >= s.nextAt && now > s.lease) {
    s = await load(env, true);
    if (!(s.status === 'running' && Date.now() >= s.nextAt && Date.now() > s.lease)) return { ...view(s, env), error };
    s.lease = now + 20000;                 // "main bana raha hun" — baaki devices ruk jayein
    await save(env, s);
    try {
      const text = await generate(env, s);
      const latest = await load(env, true);       // beech mein pause/stop hua to message discard
      if (latest.status === 'running' && latest.topic === s.topic && latest.messages.length === s.messages.length) {
        latest.messages.push({ id: now + '-' + latest.messages.length, speaker: latest.next, name: NAMES[latest.next], text });
        latest.messages = latest.messages.slice(-MAX_MSGS);
        latest.next = 1 - latest.next;
        latest.nextAt = Date.now() + Math.min(20000, 2000 + text.length * 70);
        latest.lease = 0;
        await save(env, latest);
        s = latest;
      } else {
        latest.lease = 0;
        await save(env, latest);
        s = latest;
      }
    } catch (e) {
      s = await load(env, true);
      s.status = 'paused'; s.lease = 0;
      await save(env, s);
      error = e.message;
    }
  }
  return { ...view(s, env), error };
}

async function control(env, body) {
  if (env.ADMIN_PASSWORD && body.password !== env.ADMIN_PASSWORD) return json({ error: 'Galat password' }, 401);
  const s = await load(env, true);
  const { action } = body;
  if (action === 'start') {
    s.topic = (body.topic || '').trim().slice(0, 200) || 'zindagi, technology aur future';
    s.lang = LANGS[body.lang] ? body.lang : 'hinglish';
    s.messages = []; s.next = 0; s.status = 'running'; s.nextAt = 0; s.lease = 0;
  } else if (action === 'pause' && s.status === 'running') {
    s.status = 'paused';
  } else if (action === 'resume' && s.status === 'paused') {
    s.status = 'running'; s.nextAt = 0; s.lease = 0;
  } else if (action === 'stop') {
    s.status = 'stopped';
  }
  await save(env, s);
  return json(view(s, env));
}

export async function onRequest({ request, env }) {
  try {
    if (!env.PANTRY_ID || !env.GROQ_API_KEY) return json({ error: 'PANTRY_ID ya GROQ_API_KEY set nahi hai' }, 500);
    const path = new URL(request.url).pathname;
    if (path.endsWith('/poll')) return json(await poll(env));
    if (path.endsWith('/control') && request.method === 'POST') return control(env, await request.json());
    return json({ error: 'Not found' }, 404);
  } catch (e) {
    return json({ error: e.message }, 500);
  }
}
