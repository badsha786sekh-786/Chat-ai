// Cloudflare Worker + Durable Object (Pantry ki zaroorat nahi).
// Durable Object chat ko yaad rakhta hai aur khud hi baatcheet chalata hai, chahe koi device khula ho ya na ho.
// Env var chahiye: GROQ_API_KEY   (optional: ADMIN_PASSWORD, GROQ_MODEL)
import { DurableObject } from 'cloudflare:workers';

const NAMES = ['Aria', 'Veer'];
const LANGS = {
  hinglish: 'Hinglish (Roman script mein Hindi + thoda English, jaise dost baat karte hain)',
  hindi: 'shuddh Hindi, sirf Devanagari lipi mein',
  english: 'simple casual English',
};
const MAX_MSGS = 60;
const fresh = () => ({ status: 'stopped', topic: '', lang: 'hinglish', messages: [], next: 0, gen: 0, fails: 0, error: null });
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

export class ChatRoom extends DurableObject {
  async load() {
    if (!this.s) this.s = { ...fresh(), ...(await this.ctx.storage.get('s')) };
    return this.s;
  }
  save() { return this.ctx.storage.put('s', this.s); }

  view(s) {
    return { status: s.status, topic: s.topic, lang: s.lang, messages: s.messages, error: s.error, locked: !!this.env.ADMIN_PASSWORD };
  }

  async fetch(request) {
    const s = await this.load();
    const path = new URL(request.url).pathname;
    if (path.endsWith('/poll')) return json(this.view(s));

    if (path.endsWith('/control') && request.method === 'POST') {
      const body = await request.json();
      if (this.env.ADMIN_PASSWORD && body.password !== this.env.ADMIN_PASSWORD) return json({ error: 'Galat password' }, 401);
      const { action } = body;
      if (action === 'start') {
        s.topic = (body.topic || '').trim().slice(0, 200) || 'zindagi, technology aur future';
        s.lang = LANGS[body.lang] ? body.lang : 'hinglish';
        s.messages = []; s.next = 0; s.status = 'running'; s.gen++; s.fails = 0; s.error = null;
        await this.ctx.storage.setAlarm(Date.now() + 50);
      } else if (action === 'pause' && s.status === 'running') {
        s.status = 'paused'; s.gen++;
        await this.ctx.storage.deleteAlarm();
      } else if (action === 'resume' && s.status === 'paused') {
        s.status = 'running'; s.gen++; s.fails = 0; s.error = null;
        await this.ctx.storage.setAlarm(Date.now() + 50);
      } else if (action === 'stop') {
        s.status = 'stopped'; s.gen++; s.error = null;
        await this.ctx.storage.deleteAlarm();
      } else if (action === 'say' && s.status !== 'stopped') {
        const text = String(body.text || '').trim().slice(0, 300);
        if (text) {
          const name = String(body.name || '').trim().slice(0, 20) || 'Insaan';
          s.messages.push({ id: Date.now() + '-' + s.messages.length, speaker: 2, name, text });
          s.messages = s.messages.slice(-MAX_MSGS);
          if (s.status === 'running') {            // AI turant is insaan ko jawab de
            s.gen++;
            await this.ctx.storage.setAlarm(Date.now() + 50);
          }
        }
      }
      await this.save();
      return json(this.view(s));
    }
    return json({ error: 'Not found' }, 404);
  }

  // Har message ke baad alarm lagta hai, wahi agla message banata hai
  async alarm() {
    const s = await this.load();
    if (s.status !== 'running') return;
    const gen = s.gen;
    try {
      const text = await this.generate(s);
      if (s.status !== 'running' || s.gen !== gen) return;   // beech mein pause/stop hua
      s.messages.push({ id: Date.now() + '-' + s.messages.length, speaker: s.next, name: NAMES[s.next], text });
      s.messages = s.messages.slice(-MAX_MSGS);
      s.next = 1 - s.next; s.fails = 0; s.error = null;
      await this.save();
      await this.ctx.storage.setAlarm(Date.now() + Math.min(20000, 2000 + text.length * 70));
    } catch (e) {
      if (s.status !== 'running' || s.gen !== gen) return;
      s.error = e.retryMs ? `Groq limit lagi hai, ${Math.ceil(e.retryMs / 1000)} sec baad dobara koshish hogi. ` + e.message : e.message;
      if (e.retryMs) await this.ctx.storage.setAlarm(Date.now() + e.retryMs);   // limit: intezaar, band nahi
      else {
        s.fails++;
        if (s.fails >= 5) s.status = 'paused';                    // 5 baar lagatar fail: ruk jao
        else await this.ctx.storage.setAlarm(Date.now() + 20000);
      }
      await this.save();
    }
  }

  async generate(s) {
    const me = NAMES[s.next], other = NAMES[1 - s.next];
    const system =
      `Tum ${me} ho, ek AI. Tum ${other} (ek aur AI) se baat kar rahe ho. Topic: "${s.topic}". ` +
      `Bhasha: ${LANGS[s.lang]}. Sirf 1-2 chhote sentences bolo, natural bolchal ki tarah. ` +
      `Sirf apna dialogue likho, naam ya prefix mat likho. Har baar kuch naya jodo: raay, sawal ya example. Baat ko dohrao mat. ` +
      `Beech mein koi insaan bhi apna message likh sakta hai (uske naam ke saath aayega). Aisa ho to pehle us insaan ko seedha jawab do, phir baat aage badhao.`;
    const history = s.messages.slice(-16).map((m) => ({ role: m.speaker === s.next ? 'assistant' : 'user', content: m.speaker === 2 ? `${m.name} (insaan): ${m.text}` : m.text }));
    if (!history.length || history[history.length - 1].role === 'assistant') {
      history.push({ role: 'user', content: history.length ? 'Aage badho.' : `Baat shuru karo topic par: ${s.topic}` });
    }
    const call = (model) => fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.env.GROQ_API_KEY}` },
      body: JSON.stringify({
        model,
        messages: [{ role: 'system', content: system }, ...history],
        temperature: 0.9,
        max_tokens: /gpt-oss/.test(model) ? 400 : 120,
        ...(/gpt-oss/.test(model) ? { reasoning_effort: 'low' } : {}),
      }),
    });

    // Har model ki alag limit hoti hai: ek ki limit lage to agle model par chale jao
    const models = await this.getModels();
    this.cool = this.cool || {};
    let lastErr = '', soonest = Infinity;
    for (const model of models) {
      const until = this.cool[model] || 0;
      if (Date.now() < until) { soonest = Math.min(soonest, until); continue; }
      const r = await call(model);
      if (r.ok) {
        const text = ((await r.json()).choices[0].message.content || '').trim();
        if (text) return text;
        lastErr = `${model}: khali jawab`;
        continue;
      }
      const body = (await r.text()).slice(0, 220);
      lastErr = `Groq ${r.status} (${model}): ${body}`;
      if (r.status === 429) {
        const ms = this.retryMs(body);
        this.cool[model] = Date.now() + ms; soonest = Math.min(soonest, Date.now() + ms);
      } else if (r.status === 404 || r.status === 400) {
        this.cool[model] = Date.now() + 3600000;                 // is model ko 1 ghante ke liye chhod do
      } else {
        throw new Error(lastErr);                                // key galat etc.
      }
    }
    const err = new Error(lastErr || 'Koi model available nahi');
    if (soonest < Infinity) err.retryMs = Math.max(20000, Math.min(soonest - Date.now(), 600000));
    throw err;
  }

  // Groq ke error text se "try again in 5m30s" nikalta hai
  retryMs(text) {
    const m = /try again in (?:(\d+)h)?(?:(\d+)m)?(?:([\d.]+)s)?/i.exec(text);
    if (!m) return 5 * 60000;
    const ms = ((+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0)) * 1000;
    return Math.min(Math.max(ms + 2000, 10000), 24 * 3600000);
  }

  // Aapki key par jo chat models available hain, sabse achhe pehle
  async getModels() {
    if (this.models && Date.now() - this.modelsAt < 3600000) return this.models;
    const r = await fetch('https://api.groq.com/openai/v1/models', { headers: { Authorization: `Bearer ${this.env.GROQ_API_KEY}` } });
    if (!r.ok) throw new Error(`Groq models list error ${r.status} (API key check karo)`);
    const ids = (await r.json()).data.map((m) => m.id);
    const chat = ids.filter((id) => !/whisper|tts|guard|embed|compound|orpheus|playai|safeguard|prompt/i.test(id));
    const prefer = [this.env.GROQ_MODEL, 'llama-3.1-8b-instant', 'llama-3.3-70b-versatile', 'meta-llama/llama-4-scout-17b-16e-instruct',
      'openai/gpt-oss-20b', 'openai/gpt-oss-120b', 'qwen/qwen3-32b'].filter(Boolean);
    const ordered = [...prefer.filter((p) => chat.includes(p)), ...chat.filter((c) => !prefer.includes(c))];
    if (!ordered.length) throw new Error('Is key par koi chat model nahi mila. Available: ' + (ids.join(', ') || 'koi nahi'));
    this.models = ordered; this.modelsAt = Date.now();
    return ordered;
  }
}

export default {
  async fetch(request, env) {
    if (!env.GROQ_API_KEY) return json({ error: 'GROQ_API_KEY set nahi hai' }, 500);
    try {
      const stub = env.CHAT.get(env.CHAT.idFromName('main'));
      return await stub.fetch(request);
    } catch (e) {
      return json({ error: e.message }, 500);
    }
  },
};
