// Smart auto-routing: hard tasks → Qwen3 235B (Cerebras), easy tasks → Llama 3.3 70B (Groq)
export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(200).end();
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const { messages } = req.body;
  if (!messages || !Array.isArray(messages)) {
    res.write(`data: ${JSON.stringify({ error: 'Invalid request' })}\n\n`);
    return res.end();
  }

  const GROQ_KEY = process.env.GROQ_API_KEY;
  const CEREBRAS_KEY = process.env.CEREBRAS_API_KEY;
  const TAVILY_KEY = process.env.TAVILY_API_KEY;

  if (!GROQ_KEY && !CEREBRAS_KEY) {
    res.write(`data: ${JSON.stringify({ error: 'No API keys configured' })}\n\n`);
    return res.end();
  }

  const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
  const userText = typeof lastUserMsg?.content === 'string' ? lastUserMsg.content : '';

  // ── Web search via Tavily ──
  let searchContext = '';
  let searchSources = [];
  if (TAVILY_KEY && userText && needsSearch(userText)) {
    res.write(`data: ${JSON.stringify({ searching: true })}\n\n`);
    try {
      const result = await tavilySearch(userText, TAVILY_KEY);
      if (result.results?.length) {
        searchContext = '\n\n[WEB SEARCH RESULTS - use this real-time data]:\n';
        result.results.slice(0, 5).forEach((r, i) => {
          searchContext += `\n[${i+1}] ${r.title}\nURL: ${r.url}\nContent: ${r.content}\n`;
          searchSources.push({ title: r.title, url: r.url });
        });
        searchContext += '\n[END SEARCH RESULTS]\nUse the above to answer accurately. Include relevant URLs as markdown links [text](url) when helpful.';
      }
    } catch (e) {}
  }

  let augmentedMessages = messages.map((m, i) => {
    if (i === messages.length - 1 && m.role === 'user' && searchContext) {
      return { ...m, content: (typeof m.content === 'string' ? m.content : '') + searchContext };
    }
    return m;
  });

  if (searchSources.length > 0) {
    res.write(`data: ${JSON.stringify({ sources: searchSources })}\n\n`);
  }

  // ── Smart routing: classify the task ──
  const isHard = isHardTask(userText);

  // Build provider chain based on classification
  let providers;
  if (isHard && CEREBRAS_KEY) {
    // Hard task — try Qwen3 235B first, fallback to Llama
    providers = [
      { name: 'cerebras-qwen', key: CEREBRAS_KEY,
        url: 'https://api.cerebras.ai/v1/chat/completions',
        model: 'qwen-3-235b-a22b-instruct-2507' },
      { name: 'groq-llama', key: GROQ_KEY,
        url: 'https://api.groq.com/openai/v1/chat/completions',
        model: 'llama-3.3-70b-versatile' }
    ];
  } else {
    // Easy task — Llama is plenty
    providers = [
      { name: 'groq-llama', key: GROQ_KEY,
        url: 'https://api.groq.com/openai/v1/chat/completions',
        model: 'llama-3.3-70b-versatile' },
      { name: 'cerebras-qwen', key: CEREBRAS_KEY,
        url: 'https://api.cerebras.ai/v1/chat/completions',
        model: 'qwen-3-235b-a22b-instruct-2507' }
    ];
  }

  // Filter out providers without keys
  providers = providers.filter(p => p.key);

  let succeeded = false;
  let lastError = null;

  for (const provider of providers) {
    try {
      const ok = await streamFromProvider(provider, augmentedMessages, res);
      if (ok) { succeeded = true; break; }
    } catch (e) {
      lastError = e.message;
      continue;
    }
  }

  if (!succeeded) {
    res.write(`data: ${JSON.stringify({ error: lastError || 'All providers failed' })}\n\n`);
  }
  res.end();
}

// ── HARD TASK DETECTION ──
function isHardTask(text) {
  if (!text) return false;
  const q = text.toLowerCase();

  // Length-based: long queries usually need bigger model
  if (text.length > 350) return true;

  // Code-related keywords
  const codeKeywords = [
    'code','код','напиши код','write code','programming','программирование',
    'javascript','python','typescript','java','c++','c#','rust','golang',' go ',
    'php','swift','kotlin','ruby','sql','html','css','react','vue','angular',
    'function','функция','класс','class','algorithm','алгоритм',
    'debug','дебаг','отлад','рефактор','refactor','оптимизир','optimize',
    'компилир','скрипт','script','api','sdk','framework','библиотек',
    'database','база данных','sql ','nosql','postgres','mongo','redis',
    'docker','kubernetes','linux','bash','shell','git','github',
    'регулярк','regex','xml','json','rest','graphql',
    'фронтенд','frontend','бэкенд','backend','full-stack','fullstack',
    'devops','компонент','component','хук','hook','async','await','promise'
  ];

  // Math & logic
  const mathKeywords = [
    'реши','solve','calculate','посчитай','вычисли',
    'уравнение','equation','интеграл','integral','производн','derivative',
    'matrix','матрица','vector','вектор','probability','вероятность',
    'statistic','статистик','formula','формула','теорем','theorem',
    'геометр','geometry','тригономет','trigonom','логарифм','logarithm',
    'дифференц','differential','предел','limit','sin(','cos(','tan(','log(',
    'sqrt','sum(','π','∫','∑','√','x²','x^','derivative'
  ];

  // Reasoning / analysis
  const reasonKeywords = [
    'проанализир','analyze','analysis','анализ','объясни почему','explain why',
    'сравни','compare','comparison','докажи','prove','аргумент','argument',
    'reasoning','рассужд','логически','logically','поэтапно','step by step',
    'детально','in detail','подробно','thoroughly','исследуй','research',
    'разбер','break down','стратеги','strategy','план','plan','архитектур'
  ];

  // Writing & content
  const writingKeywords = [
    'напиши статью','write article','эссе','essay',
    'сочинение','composition','рассказ','story','story for',
    'диссертац','thesis','диплом','реферат','научн','scientific',
    'длинн','long','large','подроб','detail','технич','technical','exhaustive'
  ];

  // Translation (longer ones)
  const translationKeywords = [
    'переведи','translate','translation','перевести'
  ];

  const allHard = [
    ...codeKeywords,
    ...mathKeywords,
    ...reasonKeywords,
    ...writingKeywords
  ];

  // Code blocks in user message — definitely code task
  if (text.includes('```') || /\b(function|class|def|var|let|const|import|export|return)\b/.test(text)) return true;

  // Math notation
  if (/[∫∑√π≠≤≥±∞∂]/.test(text)) return true;
  if (/\d+\s*[\^*/+\-]\s*\d+\s*[=<>]/.test(text)) return true;

  // Translation: only "hard" if long
  for (const k of translationKeywords) {
    if (q.includes(k) && text.length > 100) return true;
  }

  // Match any hard keyword
  return allHard.some(k => q.includes(k));
}

// ── STREAMING FROM PROVIDER ──
async function streamFromProvider(provider, messages, res) {
  const r = await fetch(provider.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${provider.key}`,
    },
    body: JSON.stringify({
      model: provider.model,
      messages,
      max_tokens: 1024,
      temperature: 0.7,
      stream: true
    })
  });

  if (r.status === 429) throw new Error(`${provider.name}: rate limited`);
  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`${provider.name}: ${r.status}`);
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
      if (line.startsWith('data: ')) {
        const raw = line.slice(6).trim();
        if (raw === '[DONE]') { res.write('data: [DONE]\n\n'); continue; }
        try {
          const json = JSON.parse(raw);
          const delta = json.choices?.[0]?.delta?.content;
          if (delta) res.write(`data: ${JSON.stringify({ token: delta })}\n\n`);
        } catch {}
      }
    }
  }
  return true;
}

function needsSearch(query) {
  const keywords = [
    'погода','weather','прогноз','forecast',
    'сегодня','today','сейчас','now','вчера','yesterday','завтра','tomorrow',
    'новости','news','последние','latest','текущий','current',
    'курс','price','цена','rate','акции','stock','биткоин','bitcoin','крипто','crypto','доллар','евро',
    'расписание','schedule','матч','match','счёт','score','игра','game',
    'где','where','адрес','address','сайт','website','ресторан','restaurant','кафе','cafe',
    'рейс','flight','трафик','traffic','пробки',
    '2024','2025','2026','вышел','released','произошло','happened',
    'найди','find','поищи','search','покажи','show me',
    'кто такой','who is','что такое','what is','когда','when',
    'список','list','топ','top','лучшие','best'
  ];
  const q = query.toLowerCase();
  return keywords.some(k => q.includes(k));
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
