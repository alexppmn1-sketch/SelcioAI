// Reliable smart-routing chat API
export const config = { runtime: 'edge' };

export default async function handler(req) {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS'
      }
    });
  }
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  let body;
  try { body = await req.json(); } catch { return jsonError('Invalid JSON'); }
  const { messages } = body;
  if (!messages || !Array.isArray(messages)) return jsonError('Invalid messages');

  const GROQ_KEY = process.env.GROQ_API_KEY;
  const CEREBRAS_KEY = process.env.CEREBRAS_API_KEY;
  const TAVILY_KEY = process.env.TAVILY_API_KEY;

  if (!GROQ_KEY && !CEREBRAS_KEY) return jsonError('No API keys configured');

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const write = (obj) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
      const done = () => { controller.enqueue(encoder.encode('data: [DONE]\n\n')); controller.close(); };

      try {
        const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
        const userText = typeof lastUserMsg?.content === 'string' ? lastUserMsg.content : '';

        // Web search (optional, won't block if fails)
        let augmentedMessages = messages;
        if (TAVILY_KEY && userText && needsSearch(userText)) {
          write({ searching: true });
          try {
            const sr = await Promise.race([
              tavilySearch(userText, TAVILY_KEY),
              new Promise((_, rej) => setTimeout(() => rej(new Error('search timeout')), 8000))
            ]);
            if (sr?.results?.length) {
              const sources = sr.results.slice(0, 5).map(r => ({ title: r.title, url: r.url }));
              write({ sources });
              let ctx = '\n\n[WEB SEARCH RESULTS]:\n';
              sr.results.slice(0, 5).forEach((r, i) => {
                ctx += `\n[${i+1}] ${r.title}\nURL: ${r.url}\nContent: ${r.content}\n`;
              });
              ctx += '\nUse the above to answer accurately. Include relevant URLs as markdown links [text](url) when helpful.';
              augmentedMessages = messages.map((m, i) =>
                (i === messages.length - 1 && m.role === 'user')
                  ? { ...m, content: (typeof m.content === 'string' ? m.content : '') + ctx }
                  : m
              );
            }
          } catch (e) { /* skip search */ }
        }

        // Route: hard → Qwen3 235B (Cerebras), easy → Llama 3.3 (Groq)
        const isHard = isHardTask(userText);
        const providers = [];
        if (isHard && CEREBRAS_KEY) {
          providers.push({ name: 'cerebras', key: CEREBRAS_KEY, model: 'qwen-3-235b-a22b-instruct-2507',
            url: 'https://api.cerebras.ai/v1/chat/completions' });
        }
        if (GROQ_KEY) {
          providers.push({ name: 'groq', key: GROQ_KEY, model: 'llama-3.3-70b-versatile',
            url: 'https://api.groq.com/openai/v1/chat/completions' });
        }
        if (!isHard && CEREBRAS_KEY) {
          providers.push({ name: 'cerebras', key: CEREBRAS_KEY, model: 'qwen-3-235b-a22b-instruct-2507',
            url: 'https://api.cerebras.ai/v1/chat/completions' });
        }

        if (providers.length === 0) {
          write({ error: 'No providers available' });
          done();
          return;
        }

        let succeeded = false;
        let lastError = '';

        for (const p of providers) {
          try {
            await streamFromProvider(p, augmentedMessages, write);
            succeeded = true;
            break;
          } catch (e) {
            lastError = e.message;
            console.error(`Provider ${p.name} failed:`, e.message);
          }
        }

        if (!succeeded) write({ error: `All providers failed: ${lastError}` });
        done();
      } catch (e) {
        write({ error: e.message });
        done();
      }
    }
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    }
  });
}

function jsonError(msg) {
  return new Response(JSON.stringify({ error: msg }), {
    status: 400,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
  });
}

async function streamFromProvider(provider, messages, write) {
  const r = await fetch(provider.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${provider.key}`
    },
    body: JSON.stringify({
      model: provider.model,
      messages,
      max_tokens: 1024,
      temperature: 0.7,
      stream: true
    })
  });

  if (!r.ok) {
    const txt = await r.text().catch(() => '');
    throw new Error(`${provider.name}: ${r.status} ${txt.slice(0, 100)}`);
  }

  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const raw = line.slice(6).trim();
      if (raw === '[DONE]' || !raw) continue;
      try {
        const j = JSON.parse(raw);
        const delta = j.choices?.[0]?.delta?.content;
        if (delta) write({ token: delta });
      } catch {}
    }
  }
}

function isHardTask(text) {
  if (!text) return false;
  const q = text.toLowerCase();
  if (text.length > 350) return true;
  if (text.includes('```')) return true;
  if (/\b(function|class|def|var|let|const|import|export|return)\b/.test(text)) return true;
  if (/[∫∑√π≠≤≥±∞∂]/.test(text)) return true;

  const hard = [
    'код','code','programming','программирование',
    'javascript','python','typescript','java','c++','rust','golang','php','swift','sql','html','css','react','vue','angular',
    'function','класс','algorithm','алгоритм','debug','рефактор','refactor','optimize','скрипт',
    'database','postgres','mongo','docker','linux','bash','git','regex',
    'реши','solve','calculate','посчитай','вычисли','уравнение','equation','интеграл','производн',
    'matrix','матрица','vector','probability','вероятность','statistic','formula','theorem',
    'проанализир','analyze','анализ','объясни почему','сравни','compare','докажи','prove',
    'рассужд','поэтапно','step by step','подробно','исследуй','research','разбер','break down',
    'архитектур','стратеги','напиши статью','эссе','essay','сочинение','рассказ','диссертац','диплом','реферат'
  ];

  return hard.some(k => q.includes(k));
}

function needsSearch(query) {
  const k = [
    'погода','weather','прогноз','сегодня','today','сейчас','now','завтра','tomorrow',
    'новости','news','последние','latest','курс','price','цена','rate','биткоин','bitcoin',
    'расписание','матч','счёт','где','address','рейс','flight','трафик',
    '2024','2025','2026','найди','find','поищи','search'
  ];
  const q = query.toLowerCase();
  return k.some(w => q.includes(w));
}

async function tavilySearch(query, apiKey) {
  const r = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: apiKey, query, search_depth: 'basic', max_results: 5,
      include_answer: false, include_raw_content: false
    })
  });
  return r.json();
}
