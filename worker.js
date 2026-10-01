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
      s.fails++; s.error = e.message;
      if (s.fails >= 5) s.status = 'paused';                  // 5 baar lagatar fail: ruk jao
      else await this.ctx.storage.setAlarm(Date.now() + 20000); // warna 20 sec baad dobara try
      await this.save();
    }
  }

  async generate(s) {
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
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.env.GROQ_API_KEY}` },
      body: JSON.stringify({
        model: this.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
        messages: [{ role: 'system', content: system }, ...history],
        temperature: 0.9,
        max_tokens: 120,
      }),
    });
    if (!r.ok) throw new Error(`Groq error ${r.status}: ${(await r.text()).slice(0, 150)}`);
    return (await r.json()).choices[0].message.content.trim();
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
