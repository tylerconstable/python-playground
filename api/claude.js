// Proxy: accepts Anthropic-format requests, calls OpenAI, returns Anthropic-format responses.

const MODEL_MAP = {
  'claude-haiku-4-5-20251001':  'gpt-4o-mini',
  'claude-3-5-haiku-20241022':  'gpt-4o-mini',
  'claude-sonnet-4-6':          'gpt-4o',
  'claude-sonnet-4-20250514':   'gpt-4o',
  'claude-opus-4-6':            'gpt-4o',
};

function buildMessages(body) {
  const messages = [];
  if (body.system) messages.push({ role: 'system', content: body.system });
  for (const msg of (body.messages || [])) {
    if (typeof msg.content === 'string') {
      messages.push({ role: msg.role, content: msg.content });
    } else if (Array.isArray(msg.content)) {
      const content = msg.content.map(block => {
        if (block.type === 'text') return { type: 'text', text: block.text };
        if (block.type === 'image') {
          const { media_type, data } = block.source;
          return { type: 'image_url', image_url: { url: `data:${media_type};base64,${data}`, detail: 'high' } };
        }
        return block;
      });
      messages.push({ role: msg.role, content });
    }
  }
  return messages;
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(200).end();
  }
  if (req.method !== 'POST') return res.status(405).json({ error: { message: 'Method not allowed' } });

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: { message: 'OPENAI_API_KEY not configured' } });

  try {
    const body = req.body;
    const messages = buildMessages(body);
    const model = MODEL_MAP[body.model] || 'gpt-4o-mini';

    // ── Streaming ──────────────────────────────────
    if (body.stream) {
      const upstream = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({ model, messages, max_tokens: body.max_tokens || 1024, stream: true }),
      });

      if (!upstream.ok) {
        const err = await upstream.json();
        return res.status(upstream.status).json({ error: { message: err.error?.message || JSON.stringify(err) } });
      }

      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('X-Accel-Buffering', 'no');

      const reader = upstream.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
      res.end();
      return;
    }

    // ── Non-streaming ──────────────────────────────
    const upstream = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({ model, messages, max_tokens: body.max_tokens || 1024 }),
    });

    const data = await upstream.json();
    if (!upstream.ok) {
      return res.status(upstream.status).json({ error: { message: data.error?.message || JSON.stringify(data) } });
    }

    const text = data.choices?.[0]?.message?.content || '';
    return res.status(200).json({ content: [{ type: 'text', text }] });

  } catch (err) {
    return res.status(500).json({ error: { message: err.message } });
  }
}

export const config = { api: { bodyParser: { sizeLimit: '25mb' } } };
